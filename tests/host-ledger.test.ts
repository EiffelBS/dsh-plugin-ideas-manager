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

describe('IdeasHostLedger T1 lifecycle (triage / deliver / decline / numbering)', () => {
  it('assigns monotonic idea numbers that survive a restart (persisted sequence)', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('req-1', createAction('idea-1'))
    first.applyRequest('req-2', createAction('idea-2'))
    expect(first.snapshot().ideas.map(idea => idea.ideaNumber)).toEqual([1, 2])
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    second.applyRequest('req-3', createAction('idea-3'))
    expect(second.snapshot().ideas.map(idea => idea.ideaNumber)).toEqual([1, 2, 3])
    second.dispose()
  })

  it('triage stores the opinion and re-inserts the idea at the target rank', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a', 'A'))
    ledger.applyRequest('r2', createAction('idea-b', 'B'))
    ledger.applyRequest('r3', createAction('idea-c', 'C'))
    ledger.applyRequest('r4', {
      kind: 'triage',
      ideaId: 'idea-c',
      patch: { value: 3, effort: 1, rationale: 'Top value', rank: 1 },
    })
    const open = [...ledger.snapshot().ideas.filter(idea => idea.status === 'open')]
      .sort((x, y) => (x.rank ?? Number.MAX_SAFE_INTEGER) - (y.rank ?? Number.MAX_SAFE_INTEGER))
    expect(open.map(idea => idea.id)).toEqual(['idea-c', 'idea-a', 'idea-b'])
    expect(open[0]!.value).toBe(3)
    expect(open[0]!.effort).toBe(1)
    expect(open[0]!.rationale).toBe('Top value')
    // Every open idea now carries a concrete 1-based rank, not just the moved one.
    expect(open.map(idea => idea.rank)).toEqual([1, 2, 3])
    ledger.dispose()
  })

  it('triage appends when no rank is given and leaves delivered ideas in place', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a', 'A'))
    ledger.applyRequest('r2', createAction('idea-b', 'B'))
    ledger.applyRequest('r3', { kind: 'triage', ideaId: 'idea-a', patch: { value: 5 } })
    const open = [...ledger.snapshot().ideas.filter(idea => idea.status === 'open')]
      .sort((x, y) => (x.rank ?? Number.MAX_SAFE_INTEGER) - (y.rank ?? Number.MAX_SAFE_INTEGER))
    expect(open.map(idea => idea.id)).toEqual(['idea-b', 'idea-a'])
    // A note-only triage on a delivered idea updates the opinion without
    // re-ranking the closed columns.
    ledger.applyRequest('r4', { kind: 'deliver', ideaId: 'idea-b' })
    ledger.applyRequest('r5', { kind: 'triage', ideaId: 'idea-a', patch: { rationale: 'note only' } })
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-a')!.rationale).toBe('note only')
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-b')!.status).toBe('archived')
    // Ranks are column-major across the whole document: the open column comes
    // first (idea-a at 1), so the delivered idea continues at 2.
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-b')!.rank).toBe(2)
    ledger.dispose()
  })

  it('deliver archives an open idea and stamps deliveredAt; a closed idea is untouched', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'deliver', ideaId: 'idea-a' })
    const delivered = ledger.snapshot().ideas[0]!
    expect(delivered.status).toBe('archived')
    expect(delivered.deliveredAt).toBeDefined()
    expect(delivered.archivedAt).toBeDefined()
    const before = delivered.updatedAt
    ledger.applyRequest('r3', { kind: 'deliver', ideaId: 'idea-a' })
    expect(ledger.snapshot().ideas[0]!.updatedAt).toBe(before)
    ledger.dispose()
  })

  it('decline records the decision (a blank decision is dropped)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'decline', ideaId: 'idea-a', decision: 'Covered by the sidecar' })
    const declined = ledger.snapshot().ideas[0]!
    expect(declined.status).toBe('declined')
    expect(declined.decision).toBe('Covered by the sidecar')
    ledger.applyRequest('r3', createAction('idea-b'))
    ledger.applyRequest('r4', { kind: 'decline', ideaId: 'idea-b', decision: '   ' })
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-b')!.decision).toBeUndefined()
    ledger.dispose()
  })

  it('an update patch can re-justify a rationale (a blank rationale clears it)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'update', ideaId: 'idea-a', patch: { rationale: 'after delivery' } })
    expect(ledger.snapshot().ideas[0]!.rationale).toBe('after delivery')
    ledger.applyRequest('r3', { kind: 'update', ideaId: 'idea-a', patch: { rationale: '  ' } })
    expect(ledger.snapshot().ideas[0]!.rationale).toBeUndefined()
    ledger.dispose()
  })
})

describe('IdeasHostLedger under-review cycle (recette)', () => {
  it('move sends an idea into the underReview column (open -> underReview)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    const idea = ledger.snapshot().ideas[0]!
    expect(idea.status).toBe('underReview')
    expect(idea.archivedAt).toBeUndefined()
    expect(idea.deliveredAt).toBeUndefined()
    ledger.dispose()
  })

  it('recette OK (deliver) archives an under-review idea with the delivery stamp', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    ledger.applyRequest('r3', { kind: 'deliver', ideaId: 'idea-a' })
    const delivered = ledger.snapshot().ideas[0]!
    expect(delivered.status).toBe('archived')
    expect(delivered.deliveredAt).toBeDefined()
    expect(delivered.archivedAt).toBeDefined()
    ledger.dispose()
  })

  it('recette NOK (followUp) creates a linked open child and archives the parent atomically', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', { ...createAction('idea-a', 'Parent'), id: 'idea-a', input: { title: 'Parent', body: 'Parent summary', workspaceId: 'w1' } })
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    ledger.applyRequest('r3', {
      kind: 'followUp',
      ideaId: 'idea-a',
      input: { title: 'Rework the fade-out', body: 'Justification text\n\n---\n\n**Summary**\n\nParent summary' },
    })
    const ideas = ledger.snapshot().ideas
    expect(ideas).toHaveLength(2)
    const parent = ideas.find(idea => idea.id === 'idea-a')!
    const child = ideas.find(idea => idea.id !== 'idea-a')!
    expect(parent.status).toBe('archived')
    expect(parent.archivedAt).toBeDefined()
    expect(parent.deliveredAt).toBeUndefined()
    expect(child.status).toBe('open')
    expect(child.followUpOfId).toBe('idea-a')
    expect(child.workspaceId).toBe('w1')
    expect(child.title).toBe('Rework the fade-out')
    expect(child.body).toContain('Justification text')
    // The child continues the monotonic numbering sequence.
    expect(child.ideaNumber).toBe(2)
    ledger.dispose()
  })

  it('followUp requires an under-review parent (open is rejected)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    expect(() => ledger.applyRequest('r2', {
      kind: 'followUp',
      ideaId: 'idea-a',
      input: { title: 'Follow-up', body: 'Body' },
    })).toThrowError(/follow-up requires an under-review idea/)
    // The failed verb must not have mutated the ledger.
    expect(ledger.snapshot().ideas).toHaveLength(1)
    expect(ledger.snapshot().ideas[0]!.status).toBe('open')
    ledger.dispose()
  })

  it('followUp rejects a blank child title', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    expect(() => ledger.applyRequest('r3', {
      kind: 'followUp',
      ideaId: 'idea-a',
      input: { title: '   ', body: 'Body' },
    })).toThrowError(/title is required/)
    expect(ledger.snapshot().ideas).toHaveLength(1)
    expect(ledger.snapshot().ideas[0]!.status).toBe('underReview')
    ledger.dispose()
  })
})