/**
 * Host ledger persistence tests: restart-safety (file survives a new
 * instance), request-id dedupe across instances, corruption quarantine,
 * row repair, and the process lock.
 */

import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdea } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'

let dir: string

function freshDir(): string {
  dir = join(tmpdir(), `ideas-ledger-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

const createAction = (id: string, title = 'Idea title') => ({
  kind: 'create' as const,
  id,
  input: { title, body: 'Body' },
})

describe('IdeasHostLedger persistence', () => {
  it('persists a create across instances (restart-safe) and continues the revision', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('req-1', createAction('idea-1'))
    expect(first.snapshot().revision).toBe(1)
    expect(first.snapshot().ideas).toHaveLength(1)
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    expect(second.snapshot().revision).toBe(1)
    expect(second.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1'])
    second.applyRequest('req-2', createAction('idea-2'))
    expect(second.snapshot().revision).toBe(2)
    second.dispose()
  })

  it('does not replay a mutating action after a restart (persisted request cache)', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('req-1', createAction('idea-1'))
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    const replay = second.applyRequest('req-1', createAction('idea-1'))
    expect(replay.state.ideas).toHaveLength(1)
    expect(replay.state.revision).toBe(1)
    expect(second.snapshot().ideas).toHaveLength(1)
    second.dispose()
  })

  it('rejects a reused request id carrying a different action', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    expect(() => ledger.applyRequest('req-1', createAction('idea-1', 'Different')))
      .toThrowError(/reused with a different action/)
    ledger.dispose()
  })

  it('quarantines a corrupt document and starts empty', () => {
    const dirHere = freshDir()
    writeFileSync(join(dirHere, 'ledger-v2.json'), '{ not json !!!', 'utf8')
    const ledger = new IdeasHostLedger({ dir: dirHere })
    expect(ledger.snapshot().revision).toBe(0)
    expect(ledger.snapshot().ideas).toHaveLength(0)
    ledger.dispose()
    const quarantined = readdirSync(dirHere).filter(name => name.includes('corrupt'))
    expect(quarantined.length).toBeGreaterThan(0)
  })

  it('repairs malformed persisted rows on load', () => {
    const dirHere = freshDir()
    const now = Date.now()
    const row = { ...createIdea({ title: ' Broken ', body: ' x ' }, now, 'idea-9'), status: 'bogus', tags: [{ name: '' }, { name: 'ok' }, { name: 'ok' }] }
    writeFileSync(join(dirHere, 'ledger-v2.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      ideas: [row],
      importedSources: [],
      recentRequests: [],
    }), 'utf8')
    const ledger = new IdeasHostLedger({ dir: dirHere })
    const idea = ledger.snapshot().ideas[0]!
    expect(idea.status).toBe('open')
    expect(idea.title).toBe('Broken')
    expect(idea.tags?.map(tag => tag.name)).toEqual(['ok'])
    expect(ledger.snapshot().revision).toBe(3)
    ledger.dispose()
  })

  it('keeps an empty ledger file and releases the lock on dispose', () => {
    const dirHere = freshDir()
    const first = new IdeasHostLedger({ dir: dirHere })
    expect(existsSync(join(dirHere, 'ledger-v2.json'))).toBe(true)
    expect(existsSync(join(dirHere, 'ledger-v2.lock'))).toBe(true)
    first.dispose()
    expect(existsSync(join(dirHere, 'ledger-v2.lock'))).toBe(false)
    const second = new IdeasHostLedger({ dir: dirHere })
    second.dispose()
  })

  it('refuses a second live instance on the same ledger', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    try {
      expect(() => new IdeasHostLedger({ dir })).toThrowError(/already owned by process/)
    } finally {
      first.dispose()
    }
  })

  it('leaves no tmp file behind after a commit', () => {
    const dirHere = freshDir()
    const ledger = new IdeasHostLedger({ dir: dirHere })
    ledger.applyRequest('req-1', createAction('idea-1'))
    const remaining = readdirSync(dirHere).filter(name => name.includes('.tmp-'))
    expect(remaining).toHaveLength(0)
    ledger.dispose()
  })
})