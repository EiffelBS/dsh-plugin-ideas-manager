/**
 * Delivery note harvest (idea #91) — host-side tests.
 *
 * Three outcomes are the whole contract, and this suite pins each one:
 *  1. HARVEST SUCCESS: a direct run settles and its last assistant message
 *     becomes the idea's `deliveryNote`;
 *  2. HARVEST FAILURE: the RPC refuses (or the journal is unreadable) — the
 *     run still settles `done`, the review gate still opens, and nothing is
 *     invented;
 *  3. CARD-BACKEND FALLBACK: a card that runs through the task-board exposes
 *     no session of its own, so the note comes from the session its last
 *     execution recorded — and a card that exposes no such pointer leaves the
 *     note EMPTY rather than guessing.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdea, DELIVERY_NOTE_MAX_BYTES, type IdeaRecord } from '../src/core/ideas.ts'
import { cardSessionOf, deliveryNoteOfRecords } from '../src/delivery-note.ts'
import { IdeasHostService } from '../src/host-service.ts'
import { SessionRunner, type HostSessionGateway } from '../src/session-runner.ts'
import { TaskBoardMirror, type TaskBoardTransport } from '../src/taskboard-bridge.ts'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string
    try { rmSync(dir, { recursive: true, force: true }) } catch {
      // Best-effort cleanup.
    }
  }
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideas-note-test-'))
  dirs.push(dir)
  return dir
}

/** One `session/page` record carrying an assistant message with the given text. */
function assistantRecord(text: string, seq: number): unknown {
  return {
    type: 'event',
    event: { type: 'assistant/message', seq, time: seq, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } },
  }
}

/** A user turn record, so a page can prove it skips non-assistant events. */
function userRecord(seq: number): unknown {
  return {
    type: 'event',
    event: { type: 'user/message', seq, time: seq, data: { turn: 0, step: 0, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } } },
  }
}

/**
 * Scripted gateway: answers `session/list` with a roster, `session/projections`
 * with a cursor and `session/page` with a fixed record list. A `failure` entry
 * makes that method reject the way an unavailable runtime would.
 */
class FakeGateway implements HostSessionGateway {
  calls: string[] = []
  roster: Array<{ sessionId: string; running: boolean }> = []
  records: unknown[] = []
  asOfSeq = 3
  failure = new Map<string, unknown>()

  async invoke(request: { namespace: string; method: string; args?: unknown }): Promise<unknown> {
    const key = `${request.namespace}.${request.method}`
    this.calls.push(request.method)
    if (this.failure.has(key)) throw this.failure.get(key)
    if (key === 'session.list') return { items: this.roster }
    if (key === 'session.projections') return { asOfSeq: this.asOfSeq }
    if (key === 'session.page') return { records: this.records, hasMore: false }
    return { sessionId: 'session-1' }
  }
}

/**
 * Scripted transport: one canned snapshot, one canned answer per posted kind.
 * The snapshot carries the deterministic mirror card id (`idea-<ideaId>`) in a
 * `done` state, which is what the under-review poll reads.
 */
class ScriptedTaskBoard implements TaskBoardTransport {
  posts: string[] = []
  executions: unknown[] = []

  async getState() {
    return {
      status: 200,
      body: {
        schemaVersion: 3,
        revision: 1,
        board: { sessionDefaultPermission: 'workspace-write' },
        tasks: [{
          id: 'idea-idea-1',
          status: 'done',
          title: 'T',
          permission: 'workspace-write',
          executions: this.executions,
        }],
      },
    }
  }

  async postAction(envelope: { action: { kind: string } }) {
    this.posts.push(envelope.action.kind)
    return { status: 200 }
  }
}

const T0 = Date.parse('2026-10-01T08:00:00.000Z')

function idea(overrides: Partial<IdeaRecord> = {}): IdeaRecord {
  return {
    ...createIdea({ title: 'Ship the review gate', body: 'B.', workspaceId: 'ws-1' }, T0, 'idea-1'),
    ...overrides,
  }
}

/** Let the fire-and-forget harvest (and the poll it rides on) settle. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

describe('deliveryNoteOfRecords', () => {
  it('takes the LAST assistant message, not the first one', () => {
    const note = deliveryNoteOfRecords([
      assistantRecord('Let me check the schema first.', 0),
      userRecord(1),
      assistantRecord('Implemented the harvest in src/delivery-note.ts; tests pass.', 2),
    ])
    expect(note).toBe('Implemented the harvest in src/delivery-note.ts; tests pass.')
  })

  it('joins the text blocks of one message and ignores reasoning and tool calls', () => {
    const note = deliveryNoteOfRecords([{
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 0,
        time: 0,
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'First half.' },
              { type: 'reasoning', text: 'internal thinking, never quoted' },
              { type: 'tool-call', id: 't1', name: 'read' },
              { type: 'text', text: 'Second half.' },
            ],
          },
        },
      },
    }])
    expect(note).toBe('First half.\n\nSecond half.')
  })

  it('bounds the note instead of storing whatever the model said', () => {
    const note = deliveryNoteOfRecords([assistantRecord('x'.repeat(DELIVERY_NOTE_MAX_BYTES * 2), 0)])
    expect(note).toBeDefined()
    expect(new TextEncoder().encode(note!).byteLength).toBeLessThanOrEqual(DELIVERY_NOTE_MAX_BYTES + 4)
    expect(note?.endsWith('…')).toBe(true)
  })

  it('never cuts a multi-byte character in half', () => {
    // Each 'é' is 2 UTF-8 bytes, so a byte-wise cut at an odd offset would
    // split one and produce a replacement character.
    const note = deliveryNoteOfRecords([assistantRecord('é'.repeat(DELIVERY_NOTE_MAX_BYTES), 0)])
    expect(note).not.toContain('�')
    expect(new TextEncoder().encode(note!).byteLength).toBeLessThanOrEqual(DELIVERY_NOTE_MAX_BYTES + 4)
  })

  it('returns nothing — never a guess — for a page with no assistant turn', () => {
    expect(deliveryNoteOfRecords([userRecord(0)])).toBeUndefined()
    expect(deliveryNoteOfRecords([])).toBeUndefined()
    expect(deliveryNoteOfRecords(undefined)).toBeUndefined()
    expect(deliveryNoteOfRecords([{ type: 'event', event: { type: 'tool/result', seq: 0, data: {} } }])).toBeUndefined()
  })
})

describe('cardSessionOf', () => {
  it('resolves the session of the last execution', () => {
    expect(cardSessionOf({
      id: 'idea-1',
      executions: [
        { sessionId: 'session-old', startedAt: 1, endedAt: 2, result: 'succeeded' },
        { sessionId: 'session-new', startedAt: 3, endedAt: 4, result: 'succeeded' },
      ],
    })).toBe('session-new')
  })

  it('has no pointer when the board exposes no executions, or none usable', () => {
    expect(cardSessionOf(undefined)).toBeUndefined()
    expect(cardSessionOf({ id: 'idea-1' })).toBeUndefined()
    expect(cardSessionOf({ id: 'idea-1', executions: 'nope' })).toBeUndefined()
    expect(cardSessionOf({ id: 'idea-1', executions: [{ sessionId: '  ' }] })).toBeUndefined()
  })
})

describe('delivery note on a settled direct run', () => {
  it('harvest success: stores the run last assistant message on the idea', async () => {
    const gateway = new FakeGateway()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    gateway.records = [
      assistantRecord('Working on it.', 0),
      assistantRecord('Done: the delivery note lands on the review gate.', 2),
    ]
    const service = new IdeasHostService({
      dir: freshDir(),
      autoMirror: false,
      sessions: new SessionRunner(gateway),
    })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')

    // The run stops: the next poll settles it done and opens the review gate.
    gateway.roster = [{ sessionId: 'session-1', running: false }]
    await service.pollRunTransitions()
    await drain()

    const settled = service.snapshot().ideas[0]
    expect(settled?.runStatus).toBe('done')
    expect(settled?.status).toBe('underReview')
    expect(settled?.deliveryNote).toBe('Done: the delivery note lands on the review gate.')
    // The harvest reads the journal through the same session namespace the
    // backend already speaks, and pages BACKWARDS from the projection cursor.
    expect(gateway.calls).toContain('projections')
    expect(gateway.calls).toContain('page')
    service.dispose()
  })

  it('harvest failure: a refused read still settles done and invents nothing', async () => {
    const gateway = new FakeGateway()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    const service = new IdeasHostService({
      dir: freshDir(),
      autoMirror: false,
      sessions: new SessionRunner(gateway),
    })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')

    // The Host refuses the journal read after the run finished.
    gateway.roster = [{ sessionId: 'session-1', running: false }]
    gateway.failure.set('session.projections', new Error('rpc down'))
    await service.pollRunTransitions()
    await drain()

    const settled = service.snapshot().ideas[0]
    expect(settled?.runStatus).toBe('done')
    expect(settled?.status).toBe('underReview')
    expect(settled?.deliveryNote).toBeUndefined()
    service.dispose()
  })

  it('a run that produced no assistant turn settles with no note at all', async () => {
    const gateway = new FakeGateway()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    gateway.records = [userRecord(0)]
    const service = new IdeasHostService({
      dir: freshDir(),
      autoMirror: false,
      sessions: new SessionRunner(gateway),
    })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')

    gateway.roster = [{ sessionId: 'session-1', running: false }]
    await service.pollRunTransitions()
    await drain()

    expect(service.snapshot().ideas[0]?.status).toBe('underReview')
    expect(service.snapshot().ideas[0]?.deliveryNote).toBeUndefined()
    service.dispose()
  })

  it('a vanished session (null baseline) is treated as silence, not a failure', async () => {
    const gateway = new FakeGateway()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    const service = new IdeasHostService({
      dir: freshDir(),
      autoMirror: false,
      sessions: new SessionRunner(gateway),
    })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')
    gateway.roster = [{ sessionId: 'session-1', running: false }]
    await service.pollRunTransitions()
    await drain()

    expect(service.snapshot().ideas[0]?.status).toBe('underReview')
    expect(service.snapshot().ideas[0]?.deliveryNote).toBeUndefined()
    service.dispose()
  })
})

describe('delivery note on a settled card run', () => {
  /** A service whose single mirrored card is `done`, with these executions. */
  function cardService(executions: unknown[], gateway?: FakeGateway): IdeasHostService {
    const board = new ScriptedTaskBoard()
    board.executions = executions
    return new IdeasHostService({
      dir: freshDir(),
      autoMirror: true,
      mirror: new TaskBoardMirror({ transport: board }),
      ...(gateway === undefined ? {} : { sessions: new SessionRunner(gateway) }),
    })
  }

  it('falls back to the session its last execution recorded', async () => {
    const gateway = new FakeGateway()
    gateway.records = [assistantRecord('Card backend: everything is green.', 0)]
    const service = cardService(
      [
        { sessionId: 'session-old', startedAt: 1, endedAt: 2, result: 'succeeded' },
        { sessionId: 'session-new', startedAt: 3, endedAt: 4, result: 'succeeded' },
      ],
      gateway,
    )
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')
    await service.pollRunTransitions()
    await drain()

    const settled = service.snapshot().ideas[0]
    expect(settled?.status).toBe('underReview')
    expect(settled?.deliveryNote).toBe('Card backend: everything is green.')
    service.dispose()
  })

  it('no-session fallback: a card with no executions settles with NO note', async () => {
    const gateway = new FakeGateway()
    gateway.records = [assistantRecord('never harvested', 0)]
    const service = cardService([], gateway)
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')
    await service.pollRunTransitions()
    await drain()

    const settled = service.snapshot().ideas[0]
    // The gate opened, and the note is EMPTY — the board never asks the
    // gateway for a session it was not given, and never writes a placeholder.
    expect(settled?.status).toBe('underReview')
    expect(settled?.deliveryNote).toBeUndefined()
    expect(gateway.calls).not.toContain('page')
    service.dispose()
  })

  it('no-session fallback: a card backend with no gateway at all still settles', async () => {
    const service = cardService([{ sessionId: 'session-new' }])
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')
    await service.pollRunTransitions()
    await drain()

    expect(service.snapshot().ideas[0]?.status).toBe('underReview')
    expect(service.snapshot().ideas[0]?.deliveryNote).toBeUndefined()
    service.dispose()
  })
})

describe('deliveryNote persistence', () => {
  it('is host-written: the update verb refuses it, and re-setting it is a no-op', async () => {
    const service = new IdeasHostService({ dir: freshDir(), autoMirror: false })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })

    const refused = service.apply('update-1', {
      kind: 'update',
      ideaId: 'idea-1',
      patch: { deliveryNote: 'written by a human' } as never,
    })
    expect(refused.state.ideas[0]?.deliveryNote).toBeUndefined()

    const revision = service.snapshot().revision
    expect(service.ledger.setDeliveryNote('idea-1', 'Harvested by the host.')).toBe(true)
    expect(service.snapshot().revision).toBe(revision + 1)
    expect(service.snapshot().ideas[0]?.deliveryNote).toBe('Harvested by the host.')

    // Re-harvesting the same answer must not churn the ledger revision.
    expect(service.ledger.setDeliveryNote('idea-1', 'Harvested by the host.')).toBe(false)
    expect(service.snapshot().revision).toBe(revision + 1)

    // And an unknown idea is refused, never created.
    expect(service.ledger.setDeliveryNote('nope', 'x')).toBe(false)
    service.dispose()
  })
})