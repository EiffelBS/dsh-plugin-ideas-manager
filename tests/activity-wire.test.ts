/**
 * The activity log across the wire: the envelope keeps the
 * initiator that decides WHO the log names, the list projection keeps the log
 * off the cards, and `import`/`export` round-trip it.
 */

import { describe, expect, it } from 'vitest'
import {
  buildIdeasReadSnapshot,
  parseActionEnvelope,
  toListRow,
  type IdeasAction,
} from '../src/protocol.ts'
import { IDEA_EVENT_LIMIT, createIdea, type IdeaEvent } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const T0 = Date.parse('2026-09-16T08:00:00.000Z')

const events: IdeaEvent[] = [
  { at: T0, verb: 'create', actor: 'human', summary: 'Captured as #1' },
  { at: T0 + 1000, verb: 'decline', actor: 'human', summary: 'Declined — not worth it' },
]

describe('the action envelope', () => {
  const action: IdeasAction = { kind: 'move', ideaId: 'a', status: 'archived' }

  it('carries the initiator through the parse', () => {
    const parsed = parseActionEnvelope({ requestId: 'r1', action, initiator: 'plugin:ideas-manager:ai-capture' })
    expect(parsed?.initiator).toBe('plugin:ideas-manager:ai-capture')
    expect(parsed?.action).toEqual(action)
  })

  it('still refuses a malformed or unknown envelope', () => {
    expect(parseActionEnvelope({ requestId: '', action })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action, initiator: '   ' })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action, extra: true })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'nope' } })).toBeUndefined()
  })

  it('trims an initiator and omits it when absent', () => {
    expect(parseActionEnvelope({ requestId: 'r1', action, initiator: ' padded ' })?.initiator).toBe('padded')
    expect(parseActionEnvelope({ requestId: 'r1', action })?.initiator).toBeUndefined()
  })
})

describe('the bounded read projection', () => {
  const idea = { ...createIdea({ title: 'T', body: 'B', summary: 'S' }, T0, 'a'), events }

  it('omits the log from the list row', () => {
    expect(toListRow(idea)).not.toHaveProperty('events')
    expect(toListRow(idea)).toHaveProperty('bodyExcerpt')
  })

  it('serves the log only when the caller selects it', () => {
    const snapshot = { schemaVersion: 1 as const, revision: 1, ideas: [idea] }
    const without = buildIdeasReadSnapshot(snapshot, { fields: ['summary'] })
    expect(without.ideas[0]).not.toHaveProperty('events')
    expect(without.meta.omittedFields).toContain('events')

    const with_ = buildIdeasReadSnapshot(snapshot, { fields: ['summary', 'events'] })
    expect(with_.ideas[0]?.events).toEqual(events)
  })
})

describe('the export/import round-trip', () => {
  const home = (): { dir: string; ledger: IdeasHostLedger } => {
    const dir = join(tmpdir(), `ideas-events-rt-${process.pid}-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    return { dir, ledger: new IdeasHostLedger({ dir }) }
  }

  it('carries the log from a live ledger into a fresh one', () => {
    const source = home()
    source.ledger.applyRequest(
      'r1',
      { kind: 'create', id: 'idea-1', input: { title: 'Kept', body: 'Body' } },
      { initiator: 'plugin:ideas-manager:ai-capture' },
    )
    source.ledger.applyRequest('r2', { kind: 'decline', ideaId: 'idea-1', decision: 'Superseded' })
    const exported = source.ledger.snapshot()
    source.ledger.dispose()

    const target = home()
    target.ledger.applyRequest('r1', { kind: 'import', sourceId: 'snapshot', ideas: exported.ideas })
    const restored = target.ledger.idea('idea-1')
    expect(restored?.events).toHaveLength(2)
    expect(restored?.events?.[0]?.actor).toBe('agent:plugin:ideas-manager:ai-capture')
    expect(restored?.events?.[1]?.summary).toBe('Declined — Superseded')
    target.ledger.dispose()
    rmSync(target.dir, { recursive: true, force: true })
    rmSync(source.dir, { recursive: true, force: true })
  })

  it('accepts a log, repairs a damaged one, and drops an unusable one through import', () => {
    const { dir, ledger } = home()
    const base = createIdea({ title: 'Imported', body: 'B' }, T0, 'imp-1')
    ledger.applyRequest('r1', {
      kind: 'import',
      sourceId: 's1',
      ideas: [{ ...base, events }] as unknown as IdeasAction extends { ideas: infer R } ? R : never,
    })
    expect(ledger.idea('imp-1')?.events).toEqual(events)

    // A damaged field costs the FIELD, not the row: the ledger's own row repair
    // drops an unusable log and imports the idea. (The wire gate is stricter and
    // refuses the whole row — see the protocol suite.)
    ledger.applyRequest('r2', {
      kind: 'import',
      sourceId: 's2',
      ideas: [{ ...createIdea({ title: 'Damaged', body: 'B' }, T0, 'imp-2'), events: 'nope' } as never],
    })
    expect(ledger.idea('imp-2')?.events).toBeUndefined()

    // A document with MORE than the bound is repaired down to the last 50.
    const oversized = Array.from({ length: IDEA_EVENT_LIMIT + 10 }, (_unused, index) => ({
      at: index, verb: 'move', actor: 'human', summary: `Move ${index}`,
    }))
    ledger.applyRequest('r3', {
      kind: 'import',
      sourceId: 's3',
      ideas: [{ ...createIdea({ title: 'Long', body: 'B' }, T0, 'imp-3'), events: oversized } as never],
    })
    expect(ledger.idea('imp-3')?.events).toHaveLength(IDEA_EVENT_LIMIT)
    ledger.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})