/**
 * Idea #66 (launch an idea's execution) — host-side tests.
 *
 * Covers the three things the launch flow rests on: the bridge's `run` verb
 * (model-only patch first, then the bare `run`, errors relayed from the
 * task-board's own `body.error`), the service's `launchIdea` on the per-idea
 * mirror chain (with its replay window), and the generic `runStatus` lifecycle
 * the run poll feeds and the ledger persists.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdea } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import {
  IdeasHostService,
  TaskBoardMirrorDisabledError,
} from '../src/host-service.ts'
import { runPromptOf } from '../src/run-prompt.ts'
import { parseActionEnvelope, parseLaunchBody } from '../src/protocol.ts'
import {
  TaskBoardMirror,
  TaskBoardUnavailableError,
  type TaskBoardAction,
  type TaskBoardActionEnvelope,
  type TaskBoardTransport,
} from '../src/taskboard-bridge.ts'

const T0 = Date.parse('2026-09-26T08:00:00.000Z')
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
  const dir = join(tmpdir(), `ideas-launch-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

/** Scripted transport: one canned answer per posted action kind. */
class FakeTaskBoard implements TaskBoardTransport {
  posts: TaskBoardActionEnvelope[] = []
  stateStatus = 200
  stateTasks: Array<{ id: string; status: string }> = []
  /** Per-kind canned answer; default 200 with no body. */
  answers = new Map<string, { status: number; body?: unknown }>()
  async getState() {
    return {
      status: this.stateStatus,
      ...(this.stateStatus === 200 ? { body: { schemaVersion: 3, revision: 1, tasks: this.stateTasks } } : {}),
    }
  }

  async postAction(envelope: TaskBoardActionEnvelope) {
    this.posts.push(envelope)
    return this.answers.get(envelope.action.kind) ?? { status: 200 }
  }

  get actions(): TaskBoardAction[] {
    return this.posts.map(entry => entry.action)
  }
}

function idea(overrides: Record<string, unknown> = {}): ReturnType<typeof createIdea> {
  return {
    ...createIdea({
      title: 'Run from idea',
      body: 'Launch the execution from the board.',
      workspaceId: 'dsh-plugin-ideas-manager',
      tags: [{ name: 'ideas-manager' }, { name: 'work', promptPrefix: 'Implement the launch.' }],
    }, T0, 'idea-1'),
    ...overrides,
  }
}

describe('shared run prompt', () => {
  it('joins the tag prompt lines and falls back to the mission prompt', () => {
    expect(runPromptOf(idea())).toBe('Implement the launch.')
    expect(runPromptOf(idea({ tags: [{ name: 'plain' }], ideaNumber: 66 })))
      .toContain('You are implementing the idea below #66')
  })

  it('is the very prompt the mirrored card carries (one source, two backends)', async () => {
    const taskBoard = new FakeTaskBoard()
    const mirror = new TaskBoardMirror({ transport: taskBoard })
    const card = idea()
    await mirror.mirrorCreate(card)
    const input = (taskBoard.actions[0] as { input: { prompt: string } }).input
    expect(input.prompt).toBe(runPromptOf(card))
  })
})

describe('TaskBoardMirror.launchTask', () => {
  it('patches the model alone, then posts a bare run', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
    const mirror = new TaskBoardMirror({ transport: taskBoard })

    const taskId = await mirror.launchTask(idea({ taskBoardId: 'idea-idea-1' }), 'deepseek/deepseek-chat')

    expect(taskId).toBe('idea-idea-1')
    expect(taskBoard.actions).toEqual([
      { kind: 'update', taskId, patch: { model: 'deepseek/deepseek-chat' } },
      { kind: 'run', taskId },
    ])
  })

  it('never sends content fields with the model (an executed card would refuse)', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'done' }]
    const mirror = new TaskBoardMirror({ transport: taskBoard })

    await mirror.launchTask(idea({ taskBoardId: 'idea-idea-1' }), 'deepseek/deepseek-chat')

    const patch = (taskBoard.actions[0] as unknown as { patch: Record<string, unknown> }).patch
    expect(Object.keys(patch)).toEqual(['model'])
  })

  it('posts the run alone when no model was chosen', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'todo' }]
    const mirror = new TaskBoardMirror({ transport: taskBoard })

    await mirror.launchTask(idea({ taskBoardId: 'idea-idea-1' }))
    await mirror.launchTask(idea({ taskBoardId: 'idea-idea-1' }), '   ')

    expect(taskBoard.actions).toEqual([
      { kind: 'run', taskId: 'idea-idea-1' },
      { kind: 'run', taskId: 'idea-idea-1' },
    ])
  })

  it('adopts the card created for an unbound idea instead of minting a second one', async () => {
    const taskBoard = new FakeTaskBoard()
    const mirror = new TaskBoardMirror({ transport: taskBoard })

    const taskId = await mirror.launchTask(idea())

    expect(taskId).toBe('idea-idea-1')
    expect(taskBoard.actions.map(action => action.kind)).toEqual(['create', 'move', 'run'])
  })

  it('rebuilds a card deleted out-of-band, still on the deterministic id', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'someone-else', status: 'backlog' }]
    const mirror = new TaskBoardMirror({ transport: taskBoard })

    const taskId = await mirror.launchTask(idea({ taskBoardId: 'idea-idea-1' }))

    expect(taskId).toBe('idea-idea-1')
    expect((taskBoard.actions[0] as { id: string }).id).toBe('idea-idea-1')
  })

  it("surfaces the task-board's own gate message", async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'running' }]
    taskBoard.answers.set('run', { status: 400, body: { error: 'task is already running or missing' } })
    const mirror = new TaskBoardMirror({ transport: taskBoard })

    await expect(mirror.launchTask(idea({ taskBoardId: 'idea-idea-1' })))
      .rejects.toThrow(/task is already running or missing/)
  })

  it('relays a bare-string and a code-only refusal too', async () => {
    const bare = new FakeTaskBoard()
    bare.answers.set('run', { status: 400, body: 'archived task is read-only' })
    await expect(new TaskBoardMirror({ transport: bare }).launchTask(idea()))
      .rejects.toThrow(/archived task is read-only/)

    const coded = new FakeTaskBoard()
    coded.answers.set('run', { status: 409, body: { code: 'confirmation-required' } })
    await expect(new TaskBoardMirror({ transport: coded }).launchTask(idea()))
      .rejects.toThrow(/confirmation-required/)
  })

  it('throws TaskBoardUnavailableError when the plugin is not there', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateStatus = 404
    const mirror = new TaskBoardMirror({ transport: taskBoard })

    await expect(mirror.launchTask(idea())).rejects.toBeInstanceOf(TaskBoardUnavailableError)
    expect(taskBoard.posts).toHaveLength(0)
  })
})

describe('launch body contract', () => {
  it('parses a minimal body and normalizes a blank model to absent', () => {
    expect(parseLaunchBody({ ideaId: ' idea-1 ', model: '  ' })).toEqual({ ideaId: 'idea-1' })
    expect(parseLaunchBody({ requestId: 'r1', ideaId: 'idea-1', model: 'p/m' }))
      .toEqual({ requestId: 'r1', ideaId: 'idea-1', model: 'p/m' })
  })

  it('rejects a missing ideaId, a null model and unknown keys', () => {
    expect(parseLaunchBody({})).toBeUndefined()
    expect(parseLaunchBody({ ideaId: '   ' })).toBeUndefined()
    expect(parseLaunchBody({ ideaId: 'idea-1', model: null })).toBeUndefined()
    expect(parseLaunchBody({ ideaId: 'idea-1', model: 3 })).toBeUndefined()
    expect(parseLaunchBody({ ideaId: 'idea-1', extra: true })).toBeUndefined()
  })

  it('never accepts runStatus from an idea verb (host-written system field)', () => {
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'update', ideaId: 'idea-1', patch: { runStatus: 'running' } } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', runStatus: 'done' } } })).toBeUndefined()
  })

  it('imports a legal run status and refuses an unknown one', () => {
    const legal = parseActionEnvelope({
      requestId: 'r1',
      action: {
        kind: 'import',
        sourceId: 'src-1',
        ideas: [{ id: 'idea-1', title: 'I', body: 'B', status: 'open', createdAt: 1, updatedAt: 2, runStatus: 'done', runSessionId: 'sess-1' }],
      },
    })
    const row = legal?.action.kind === 'import' ? legal.action.ideas[0] : undefined
    expect(row?.runStatus).toBe('done')
    expect(row?.runSessionId).toBe('sess-1')

    expect(parseActionEnvelope({
      requestId: 'r2',
      action: {
        kind: 'import',
        sourceId: 'src-1',
        ideas: [{ id: 'idea-2', title: 'I', body: 'B', status: 'open', createdAt: 1, updatedAt: 2, runStatus: 'RUNNING' }],
      },
    })).toBeUndefined()
  })
})

describe('ledger run fields', () => {
  it('round-trips runStatus and runSessionId across a restart, idempotently', () => {
    const dir = freshDir()
    const first = new IdeasHostLedger({ dir })
    first.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })

    expect(first.setRunStatus('idea-1', 'running')).toBe(true)
    // No-op on an unchanged stamp: an idle poll must not churn the revision.
    const revision = first.snapshot().revision
    expect(first.setRunStatus('idea-1', 'running')).toBe(false)
    expect(first.snapshot().revision).toBe(revision)
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    const restored = second.snapshot().ideas[0]
    expect(restored?.runStatus).toBe('running')
    expect(second.setRunStatus('idea-1', 'done')).toBe(true)
    expect(second.snapshot().ideas[0]?.runStatus).toBe('done')
    // Clearing drops the key entirely, like a cleared taskBoardStatus.
    expect(second.setRunStatus('idea-1', undefined)).toBe(true)
    expect(second.snapshot().ideas[0]?.runStatus).toBeUndefined()
    expect(second.setRunStatus('unknown-idea', 'running')).toBe(false)
    second.dispose()
  })

  it('drops a hand-edited unknown persisted run status', () => {
    const dir = freshDir()
    const first = new IdeasHostLedger({ dir })
    first.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    first.dispose()
    // Simulate a corrupted ledger row written by an external tool.
    const file = join(dir, 'ledger-v2.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { ideas: Array<Record<string, unknown>> }
    raw.ideas[0]!.runStatus = 'cancelled'
    writeFileSync(file, JSON.stringify(raw))

    const second = new IdeasHostLedger({ dir })
    expect(second.snapshot().ideas[0]?.runStatus).toBeUndefined()
    second.dispose()
  })
})

describe('IdeasHostService.launchIdea', () => {
  it('launches the bound card, stamps the run, and returns the neutral result', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
    const service = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport: taskBoard }) })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws' } })
    await service.flushMirror()
    taskBoard.posts = []

    const result = await service.launchIdea('idea-1', 'deepseek/deepseek-chat')

    expect(result).toEqual({ ok: true, runId: 'idea-idea-1', taskId: 'idea-idea-1', runStatus: 'running' })
    expect(taskBoard.actions).toEqual([
      { kind: 'update', taskId: 'idea-idea-1', patch: { model: 'deepseek/deepseek-chat' } },
      { kind: 'run', taskId: 'idea-idea-1' },
    ])
    const stored = service.snapshot().ideas[0]
    expect(stored?.runStatus).toBe('running')
    expect(stored?.taskBoardId).toBe('idea-idea-1')
    service.dispose()
  })

  it('replays the first outcome for the same request id without re-running', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
    const service = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport: taskBoard }) })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws' } })
    await service.flushMirror()
    taskBoard.posts = []

    const first = await service.launchIdea('idea-1', undefined, 'launch-1')
    const second = await service.launchIdea('idea-1', undefined, 'launch-1')

    expect(second).toEqual(first)
    expect(taskBoard.actions).toEqual([{ kind: 'run', taskId: 'idea-idea-1' }])
    service.dispose()
  })

  it('serializes the launch on the idea mirror chain (no duplicate card)', async () => {
    const taskBoard = new FakeTaskBoard()
    const service = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport: taskBoard }) })
    // Capture and launch submitted together: the launch must land after the
    // create bound the card, so both target the same deterministic id.
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws' } })
    const launched = service.launchIdea('idea-1')
    await service.flushMirror()
    await launched

    const created = taskBoard.actions.filter(action => action.kind === 'create')
    expect(created).toHaveLength(1)
    expect(service.snapshot().ideas[0]?.taskBoardId).toBe('idea-idea-1')
    expect(taskBoard.actions.at(-1)).toEqual({ kind: 'run', taskId: 'idea-idea-1' })
    service.dispose()
  })

  it('refuses an unknown idea, a disabled mirror, and a disabled plugin', async () => {
    const taskBoard = new FakeTaskBoard()
    const service = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport: taskBoard }) })
    await expect(service.launchIdea('nope')).rejects.toThrow('idea not found')

    const off = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport: taskBoard }), autoMirror: false })
    off.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    await expect(off.launchIdea('idea-1')).rejects.toBeInstanceOf(TaskBoardMirrorDisabledError)
    off.dispose()
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    await service.flushMirror()
    service.setActive(false)
    await expect(service.launchIdea('idea-1')).rejects.toThrow('ideas plugin is disabled')
    service.dispose()
  })

  it('rejects with the task-board message and leaves no run stamp behind', async () => {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'running' }]
    taskBoard.answers.set('run', { status: 400, body: { error: 'task is already running or missing' } })
    const service = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport: taskBoard }) })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws' } })
    await service.flushMirror()

    await expect(service.launchIdea('idea-1')).rejects.toThrow(/already running/)
    expect(service.snapshot().ideas[0]?.runStatus).toBeUndefined()
    service.dispose()
  })
})

describe('run poll lifecycle', () => {
  /** Idea + card id bound, with the card status driven by the fake board. */
  async function startedService(status: string): Promise<{ service: IdeasHostService; taskBoard: FakeTaskBoard }> {
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status }]
    const service = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport: taskBoard }) })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws' } })
    await service.flushMirror()
    return { service, taskBoard }
  }

  it('follows running -> done and opens the review gate', async () => {
    const { service, taskBoard } = await startedService('running')
    await service.launchIdea('idea-1')
    expect(service.snapshot().ideas[0]?.runStatus).toBe('running')

    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'running' }]
    await service.pollRunTransitions()
    expect(service.snapshot().ideas[0]?.runStatus).toBe('running')
    expect(service.snapshot().ideas[0]?.status).toBe('open')

    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'done' }]
    await service.pollRunTransitions()
    const settled = service.snapshot().ideas[0]
    expect(settled?.runStatus).toBe('done')
    expect(settled?.taskBoardStatus).toBe('done')
    expect(settled?.status).toBe('underReview')
    // The status observation is a read: no mirror write is involved.
    expect(taskBoard.posts.filter(entry => entry.action.kind === 'run')).toHaveLength(1)
    service.dispose()
  })

  it('records a failed run and leaves the idea open', async () => {
    const { service, taskBoard } = await startedService('backlog')
    await service.launchIdea('idea-1')
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'failed' }]
    await service.pollRunTransitions()

    const failed = service.snapshot().ideas[0]
    expect(failed?.runStatus).toBe('failed')
    expect(failed?.status).toBe('open')
    service.dispose()
  })

  it('clears a stale run stamp when the card sits outside a run again', async () => {
    const { service, taskBoard } = await startedService('running')
    await service.launchIdea('idea-1')
    expect(service.snapshot().ideas[0]?.runStatus).toBe('running')

    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
    await service.pollRunTransitions()
    expect(service.snapshot().ideas[0]?.runStatus).toBeUndefined()
    service.dispose()
  })

  it('settles a run started on an idea that already left the backlog', async () => {
    const { service, taskBoard } = await startedService('backlog')
    await service.launchIdea('idea-1')
    // First run: the card reaches done and the review gate opens.
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'done' }]
    await service.pollRunTransitions()
    expect(service.snapshot().ideas[0]?.status).toBe('underReview')

    // A relaunch over the API (the button is hidden there, the route is not)
    // must still settle instead of freezing on `running` forever.
    await service.launchIdea('idea-1')
    expect(service.snapshot().ideas[0]?.runStatus).toBe('running')
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'done' }]
    await service.pollRunTransitions()
    const settled = service.snapshot().ideas[0]
    expect(settled?.runStatus).toBe('done')
    // The closed column is never re-moved by the poll.
    expect(settled?.status).toBe('underReview')
    service.dispose()
  })

  it('never starts watching a closed card that carries no run', async () => {
    const { service, taskBoard } = await startedService('backlog')
    // Closed BEFORE any launch: a card nobody ever ran must stay unwatched.
    service.apply('archive-1', { kind: 'move', ideaId: 'idea-1', status: 'archived' })
    // The archive schedules a mirror op that binds the card id — a real ledger
    // commit, so it must land BEFORE the revision this test watches.
    await service.flushMirror()
    const revision = service.snapshot().revision

    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'running' }]
    await service.pollRunTransitions()
    await service.pollRunTransitions()

    expect(service.snapshot().revision).toBe(revision)
    expect(service.snapshot().ideas[0]?.runStatus).toBeUndefined()
    expect(service.snapshot().ideas[0]?.taskBoardStatus).toBeUndefined()
    service.dispose()
  })

  it('does not churn the revision while the observation is unchanged', async () => {    const { service } = await startedService('running')
    await service.launchIdea('idea-1')
    // First poll publishes the card observation itself (a real change).
    await service.pollRunTransitions()
    const settled = service.snapshot().revision
    await service.pollRunTransitions()
    await service.pollRunTransitions()
    expect(service.snapshot().revision).toBe(settled)
    service.dispose()
  })
})
