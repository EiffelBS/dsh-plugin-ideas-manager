/**
 * The activity log as the ledger writes it (idea #92, part B): one entry per
 * meaningful verb, the actor vocabulary, the run-driven entries, the schema
 * migration of a document written before the field existed, and the survival of
 * the whole log across a restart.
 */

import { tmpdir } from 'node:os'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IDEAS_SCHEMA_VERSION, type IdeasAction } from '../src/protocol.ts'
import { IDEA_EVENT_LIMIT } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'

let dir: string

function freshDir(): string {
  dir = join(tmpdir(), `ideas-activity-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

const createAction = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'create' as const,
  id,
  input: { title: 'An idea', body: 'Body', ...extra },
})

/** The activity log of one idea, as plain `{verb, actor, summary}` triples. */
function logOf(ledger: IdeasHostLedger, ideaId: string): Array<{ verb: string; actor: string; summary: string }> {
  return (ledger.idea(ideaId)?.events ?? []).map(entry => ({
    verb: entry.verb,
    actor: entry.actor,
    summary: entry.summary,
  }))
}

describe('ledger activity log', () => {
  it('records the capture and reads a browser write as the human', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1', { workspaceId: 'ws1' }))
    expect(logOf(ledger, 'idea-1')).toEqual([
      { verb: 'create', actor: 'human', summary: 'Captured as #1 in ws1' },
    ])
    ledger.dispose()
  })

  it('attributes a session write to the asserted initiator', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    ledger.applyRequest(
      'req-2',
      { kind: 'triage', ideaId: 'idea-1', patch: { value: 3, effort: 1 } },
      { initiator: 'plugin:ideas-manager:ai-capture' },
    )
    const entries = logOf(ledger, 'idea-1')
    expect(entries[1]?.actor).toBe('agent:plugin:ideas-manager:ai-capture')
    expect(entries[1]?.verb).toBe('triage')
    expect(entries[1]?.summary).toContain('value 3')
    expect(entries[1]?.summary).toContain('effort 1')
    ledger.dispose()
  })

  it('names the FIELD an update touched, never its value', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    ledger.applyRequest('req-2', { kind: 'update', ideaId: 'idea-1', patch: { title: 'A very private new title' } })
    const entry = logOf(ledger, 'idea-1')[1]
    expect(entry?.verb).toBe('update')
    expect(entry?.summary).toBe('Edited title')
    expect(entry?.summary).not.toContain('private')
    ledger.dispose()
  })

  it('walks the review gate: follow-up writes both the parent and the child', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    ledger.applyRequest('req-2', { kind: 'move', ideaId: 'idea-1', status: 'underReview' })
    ledger.applyRequest('req-3', {
      kind: 'followUp',
      ideaId: 'idea-1',
      input: { title: 'Remaining slice', body: 'What is left' },
    })
    expect(logOf(ledger, 'idea-1').map(entry => entry.verb)).toEqual(['create', 'move', 'review'])
    const child = ledger.snapshot().ideas.find(idea => idea.followUpOfId === 'idea-1')
    expect(child).toBeDefined()
    expect(logOf(ledger, child!.id)).toEqual([
      { verb: 'create', actor: 'human', summary: 'Created as the follow-up of #1' },
    ])
    ledger.dispose()
  })

  it('records a decline with its reason, and a replay records nothing', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    ledger.applyRequest('req-2', { kind: 'decline', ideaId: 'idea-1', decision: 'Superseded by the runtime' })
    ledger.applyRequest('req-2', { kind: 'decline', ideaId: 'idea-1', decision: 'Superseded by the runtime' })
    expect(logOf(ledger, 'idea-1')).toHaveLength(2)
    expect(logOf(ledger, 'idea-1')[1]?.summary).toBe('Declined — Superseded by the runtime')
    ledger.dispose()
  })

  it('records a run-owned transition under the run actor', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    ledger.applyRequest(
      'req-2',
      { kind: 'move', ideaId: 'idea-1', status: 'underReview' },
      { actor: 'run' },
    )
    expect(logOf(ledger, 'idea-1')[1]?.actor).toBe('run')
    ledger.dispose()
  })

  it('records a host-internal entry outside any verb, and no-ops on a blank one', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    expect(ledger.recordEvent('idea-1', 'launch', 'Execution started on the task card')).toBe(true)
    const revision = ledger.snapshot().revision
    expect(ledger.recordEvent('idea-1', 'launch', '   ')).toBe(false)
    expect(ledger.recordEvent('unknown', 'launch', 'nope')).toBe(false)
    expect(ledger.snapshot().revision).toBe(revision)
    expect(logOf(ledger, 'idea-1')[1]).toEqual({
      verb: 'launch',
      actor: 'run',
      summary: 'Execution started on the task card',
    })
    ledger.dispose()
  })

  it('stays silent on a display-only reorder', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    ledger.applyRequest('req-2', createAction('idea-2'))
    ledger.applyRequest('req-3', { kind: 'reorder', orderedIds: ['idea-2', 'idea-1'] } as unknown as IdeasAction)
    expect(logOf(ledger, 'idea-1')).toHaveLength(1)
    expect(logOf(ledger, 'idea-2')).toHaveLength(1)
    ledger.dispose()
  })

  it('survives a restart with the whole log intact', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('req-1', createAction('idea-1'))
    first.recordEvent('idea-1', 'launch', 'Execution started on the fresh session')
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    expect(logOf(second, 'idea-1')).toHaveLength(2)
    second.applyRequest('req-2', { kind: 'move', ideaId: 'idea-1', status: 'archived' })
    expect(logOf(second, 'idea-1')).toHaveLength(3)
    second.dispose()
  })
})

describe('the activity-log schema migration', () => {
  /** A ledger document written by a version that knew nothing about events. */
  function writePreLogDocument(): void {
    writeFileSync(join(freshDir(), 'ledger-v2.json'), JSON.stringify({
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 4,
      ideaSequence: 7,
      importedSources: [],
      requestCache: {},
      ideas: [{
        id: 'legacy',
        title: 'Captured long ago',
        body: 'Body',
        status: 'open',
        createdAt: 1,
        updatedAt: 2,
        ideaNumber: 7,
      }],
    }), 'utf8')
  }

  it('loads a document without an events field and creates the log on the next write', () => {
    writePreLogDocument()
    const ledger = new IdeasHostLedger({ dir })
    // Nothing is invented for the past: the row simply has no log yet.
    expect(ledger.idea('legacy')?.events).toBeUndefined()
    expect(ledger.snapshot().revision).toBe(4)

    ledger.applyRequest('req-1', { kind: 'move', ideaId: 'legacy', status: 'archived' })
    expect(logOf(ledger, 'legacy')).toEqual([
      { verb: 'move', actor: 'human', summary: 'Moved open → archived' },
    ])
    ledger.dispose()
  })

  it('repairs a damaged log on load rather than failing the whole document', () => {
    const home = freshDir()
    writeFileSync(join(home, 'ledger-v2.json'), JSON.stringify({
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 2,
      ideaSequence: 1,
      importedSources: [],
      requestCache: {},
      ideas: [{
        id: 'legacy',
        title: 'T',
        body: 'B',
        status: 'open',
        createdAt: 1,
        updatedAt: 2,
        events: [
          { at: 1, verb: 'create', actor: 'human', summary: 'Captured as #1' },
          'not an entry',
          { at: 3, verb: 'decline', actor: 'human', summary: '   ' },
          { at: 4, verb: 'move', actor: 'human', summary: 'Moved open → archived', extra: true },
        ],
      }],
    }), 'utf8')

    const ledger = new IdeasHostLedger({ dir: home })
    expect(logOf(ledger, 'legacy')).toEqual([
      { verb: 'create', actor: 'human', summary: 'Captured as #1' },
      { verb: 'move', actor: 'human', summary: 'Moved open → archived' },
    ])
    ledger.dispose()
  })

  it('does not rewrite the stored document until something actually changes', () => {
    const home = freshDir()
    const file = join(home, 'ledger-v2.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 1,
      ideaSequence: 0,
      importedSources: [],
      requestCache: {},
      ideas: [],
    }), 'utf8')
    const before = readFileSync(file, 'utf8')
    const ledger = new IdeasHostLedger({ dir: home })
    expect(readFileSync(file, 'utf8')).toBe(before)
    ledger.dispose()
  })

  it('bounds a log that outgrew the cap', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    for (let index = 0; index < IDEA_EVENT_LIMIT + 10; index += 1) {
      ledger.recordEvent('idea-1', 'move', `Move number ${index}`)
    }
    const log = ledger.idea('idea-1')?.events ?? []
    expect(log).toHaveLength(IDEA_EVENT_LIMIT)
    expect(log[0]?.summary).toBe('Move number 10')
    expect(log[IDEA_EVENT_LIMIT - 1]?.summary).toBe(`Move number ${IDEA_EVENT_LIMIT + 9}`)
    ledger.dispose()
  })
})