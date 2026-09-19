/**
 * /api/ideas protocol gate tests: the exactKeys discipline and the closed
 * action unions, mirroring the task-board family's protocol tests.
 */

import { describe, expect, it } from 'vitest'
import { parseActionEnvelope } from '../src/protocol.ts'

function envelope(action: unknown, requestId = 'req-1', extra: Record<string, unknown> = {}): unknown {
  return { requestId, action, ...extra }
}

describe('parseActionEnvelope', () => {
  it('parses a valid create envelope', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create',
      id: 'idea-1',
      input: { title: 'A', body: 'B' },
    }))
    expect(parsed).toEqual({
      requestId: 'req-1',
      action: { kind: 'create', id: 'idea-1', input: { title: 'A', body: 'B' } },
    })
  })

  it('accepts workspaceId, rank, value, effort and a well-formed tag list', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create',
      id: 'idea-2',
      input: {
        title: 'A',
        body: 'B',
        workspaceId: 'ws-1',
        rank: 3,
        value: 5,
        effort: 2,
        tags: [{ name: 'roadmap' }],
      },
    }))
    expect(parsed?.action.kind).toBe('create')
  })

  it('rejects a create input with unknown keys (exactKeys)', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create',
      id: 'idea-1',
      input: { title: 'A', body: 'B', evil: true },
    }))).toBeUndefined()
  })

  it('rejects a malformed tag list on create', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create',
      id: 'idea-1',
      input: { title: 'A', body: 'B', tags: [{ name: '' }] },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create',
      id: 'idea-1',
      input: { title: 'A', body: 'B', tags: [] },
    }))).toBeUndefined()
  })

  it('parses an update patch and accepts null tags to clear', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'update',
      ideaId: 'idea-1',
      patch: { title: 'Renamed', tags: null },
    }))
    expect(parsed?.action).toEqual({ kind: 'update', ideaId: 'idea-1', patch: { title: 'Renamed', tags: null } })
  })

  it('rejects an update patch with unknown keys', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'update',
      ideaId: 'idea-1',
      patch: { prompt: 'nope' },
    }))).toBeUndefined()
  })

  it('parses move only for open|archived targets', () => {
    expect(parseActionEnvelope(envelope({ kind: 'move', ideaId: 'idea-1', status: 'archived' }))?.action.kind).toBe('move')
    expect(parseActionEnvelope(envelope({ kind: 'move', ideaId: 'idea-1', status: 'declined' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'move', ideaId: 'idea-1', status: 'running' }))).toBeUndefined()
  })

  it('parses decline / restore / delete with an ideaId', () => {
    for (const kind of ['decline', 'restore', 'delete'] as const) {
      expect(parseActionEnvelope(envelope({ kind, ideaId: 'idea-1' }))?.action).toEqual({ kind, ideaId: 'idea-1' })
    }
    expect(parseActionEnvelope(envelope({ kind: 'delete', ideaId: '' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'delete' }))).toBeUndefined()
  })

  it('parses reorder with a non-empty id list', () => {
    expect(parseActionEnvelope(envelope({ kind: 'reorder', orderedIds: ['a', 'b'] }))?.action).toEqual({
      kind: 'reorder',
      orderedIds: ['a', 'b'],
    })
    expect(parseActionEnvelope(envelope({ kind: 'reorder', orderedIds: [] }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'reorder', orderedIds: ['a', 2] }))).toBeUndefined()
  })

  it('parses export with an optional workspaceId', () => {
    expect(parseActionEnvelope(envelope({ kind: 'export' }))?.action).toEqual({ kind: 'export' })
    expect(parseActionEnvelope(envelope({ kind: 'export', workspaceId: 'ws-1' }))?.action).toEqual({
      kind: 'export',
      workspaceId: 'ws-1',
    })
  })

  it('rejects an import carrying executable fields', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'import',
      sourceId: 'ot',
      ideas: [{
        id: 'x',
        title: 'T',
        body: 'B',
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
        command: 'rm -rf /',
      }],
    }))).toBeUndefined()
  })

  it('rejects a reusable requestId pattern: envelope-level exactKeys', () => {
    // The action object is missing its kind/ideaId split -> unknown key 'extra'.
    expect(parseActionEnvelope(envelope({ kind: 'delete', ideaId: 'idea-1', extra: 1 }))).toBeUndefined()
  })

  it('rejects an empty or oversized requestId', () => {
    expect(parseActionEnvelope(envelope({ kind: 'delete', ideaId: 'a' }, '  '))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'delete', ideaId: 'a' }, 'x'.repeat(257)))).toBeUndefined()
  })

  it('rejects an unknown kind', () => {
    expect(parseActionEnvelope(envelope({ kind: 'teleport' }))).toBeUndefined()
  })

  it('rejects an invalid initiator', () => {
    expect(parseActionEnvelope(envelope({ kind: 'delete', ideaId: 'a' }, 'req', { initiator: 42 }))).toBeUndefined()
  })

  it('parses a triage patch with scores, rationale and a target rank', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'triage',
      ideaId: 'idea-1',
      patch: { value: 3, effort: 1, rationale: 'Unblocks #2', rank: 2 },
    }))
    expect(parsed?.action).toEqual({
      kind: 'triage',
      ideaId: 'idea-1',
      patch: { value: 3, effort: 1, rationale: 'Unblocks #2', rank: 2 },
    })
    // A note-only triage (no opinion) is legal too.
    expect(parseActionEnvelope(envelope({ kind: 'triage', ideaId: 'idea-1', patch: {} }))?.action).toEqual({
      kind: 'triage',
      ideaId: 'idea-1',
      patch: {},
    })
  })

  it('rejects a triage patch with unknown keys or malformed values', () => {
    expect(parseActionEnvelope(envelope({ kind: 'triage', ideaId: 'idea-1', patch: { evil: true } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'triage', ideaId: 'idea-1', patch: { value: 'high' } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'triage', ideaId: 'idea-1', patch: { rationale: 42 } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'triage', ideaId: 'idea-1', patch: { value: NaN } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'triage', ideaId: 'idea-1' }))).toBeUndefined()
  })

  it('parses deliver and decline (decision optional but must be a string)', () => {
    expect(parseActionEnvelope(envelope({ kind: 'deliver', ideaId: 'idea-1' }))?.action).toEqual({ kind: 'deliver', ideaId: 'idea-1' })
    expect(parseActionEnvelope(envelope({ kind: 'deliver' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'decline', ideaId: 'idea-1' }))?.action).toEqual({ kind: 'decline', ideaId: 'idea-1' })
    expect(parseActionEnvelope(envelope({ kind: 'decline', ideaId: 'idea-1', decision: 'Covered by the audiocpp sidecar' }))?.action)
      .toEqual({ kind: 'decline', ideaId: 'idea-1', decision: 'Covered by the audiocpp sidecar' })
    expect(parseActionEnvelope(envelope({ kind: 'decline', ideaId: 'idea-1', decision: 42 }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'decline', ideaId: 'idea-1', extra: 1 }))).toBeUndefined()
  })

  it('accepts rationale on create input and update patches', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create',
      id: 'idea-1',
      input: { title: 'A', body: 'B', rationale: 'Top value' },
    }))?.action).toEqual({
      kind: 'create',
      id: 'idea-1',
      input: { title: 'A', body: 'B', rationale: 'Top value' },
    })
    expect(parseActionEnvelope(envelope({
      kind: 'update',
      ideaId: 'idea-1',
      patch: { rationale: 're-ranked after delivery' },
    }))?.action).toEqual({ kind: 'update', ideaId: 'idea-1', patch: { rationale: 're-ranked after delivery' } })
    expect(parseActionEnvelope(envelope({ kind: 'update', ideaId: 'idea-1', patch: { rationale: 42 } }))).toBeUndefined()
  })
})
