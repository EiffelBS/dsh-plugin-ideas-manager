/**
 * Idea #66 v2 (direct-session execution) — host-side tests.
 *
 * The card backend is the default; this covers the fallback for a Host that
 * serves no task-board plugin (or a deployment that turned the mirror off):
 * a FRESH session is created, named, given the chosen model and prompted with
 * the very same `runPromptOf` the card would carry, and the run is settled by
 * the poll from the session roster — which is what makes the launch survive a
 * closed browser tab and a Host restart.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdea, type IdeaRecord } from '../src/core/ideas.ts'
import { IdeasHostService } from '../src/host-service.ts'
import { runPromptOf } from '../src/run-prompt.ts'
import { SessionLaunchError, SessionRunner, type HostSessionGateway } from '../src/session-runner.ts'
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
  const dir = mkdtempSync(join(tmpdir(), 'ideas-session-test-'))
  dirs.push(dir)
  return dir
}

interface RpcCall {
  namespace: string
  method: string
  args: Record<string, unknown>
}

/**
 * Scripted gateway: records every call and answers per method. A `failure`
 * entry makes that method reject, the way a booting or unavailable runtime
 * would.
 */
class FakeGateway implements HostSessionGateway {
  calls: RpcCall[] = []
  sessionId = 'session-1'
  roster: Array<{ sessionId: string; running: boolean }> = []
  failure = new Map<string, unknown>()

  async invoke(request: { namespace: string; method: string; args?: unknown }): Promise<unknown> {
    const key = `${request.namespace}.${request.method}`
    this.calls.push({ namespace: request.namespace, method: request.method, args: (request.args ?? {}) as Record<string, unknown> })
    if (this.failure.has(key)) throw this.failure.get(key)
    if (key === 'session.create') return { sessionId: this.sessionId }
    if (key === 'session.list') return { items: this.roster }
    return { ok: true }
  }

  get methods(): string[] {
    return this.calls.map(call => call.method)
  }
}

/** A task-board that answers every probe as "the plugin is not installed". */
class DeadTaskBoard implements TaskBoardTransport {
  async getState() {
    return { status: 404, body: { error: 'not found' } }
  }

  async postAction() {
    return { status: 503, body: { error: 'task board unavailable' } }
  }
}

const T0 = Date.parse('2026-09-26T08:00:00.000Z')

function idea(overrides: Partial<IdeaRecord> = {}): IdeaRecord {
  return {
    ...createIdea({
      title: 'Run from idea',
      body: 'Launch the execution from the board.',
      workspaceId: 'ws-1',
    }, T0, 'idea-1'),
    ...overrides,
  }
}

describe('SessionRunner.launchIdea', () => {
  it('creates, names, pins the model and prompts, in that order', async () => {
    const gateway = new FakeGateway()
    const runner = new SessionRunner(gateway)

    const sessionId = await runner.launchIdea(idea(), 'deepseek/deepseek-chat')

    expect(sessionId).toBe('session-1')
    expect(gateway.methods).toEqual(['create', 'rename', 'selectModel', 'prompt'])
    expect(gateway.calls[0]?.args).toEqual({ request: { workspaceId: 'ws-1' } })
    expect(gateway.calls[1]?.args).toEqual({ request: { sessionId: 'session-1', title: 'Run from idea' } })
    expect(gateway.calls[2]?.args).toEqual({ request: { sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-chat' } })
  })

  it('splits only on the first slash and tolerates a bare model id', async () => {
    const gateway = new FakeGateway()
    await new SessionRunner(gateway).launchIdea(idea(), 'deepseek/deepseek-chat/reasoner')
    expect(gateway.calls[2]?.args).toEqual({ request: { sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-chat/reasoner' } })

    const bare = new FakeGateway()
    await new SessionRunner(bare).launchIdea(idea(), 'local-model')
    expect(bare.calls[2]?.args).toEqual({ request: { sessionId: 'session-1', model: 'local-model' } })
  })

  it('skips the model pin entirely when none was chosen', async () => {
    const gateway = new FakeGateway()
    await new SessionRunner(gateway).launchIdea(idea())
    expect(gateway.methods).toEqual(['create', 'rename', 'prompt'])

    const blank = new FakeGateway()
    await new SessionRunner(blank).launchIdea(idea(), '   ')
    expect(blank.methods).toEqual(['create', 'rename', 'prompt'])
  })

  it('queues the very prompt the card backend would carry', async () => {
    const gateway = new FakeGateway()
    const card = idea()
    await new SessionRunner(gateway).launchIdea(card)

    // No model was picked, so the prompt is the third and last call.
    const args = gateway.calls[2]?.args as { request: { mode: string; requestId: string; content: Array<{ type: string; text: string }> } }
    expect(args.request.mode).toBe('queue')
    expect(args.request.requestId).toMatch(/^ideas-/)
    expect(args.request.content).toEqual([{ type: 'text', text: runPromptOf(card) }])
  })

  it('refuses an idea with no workspace before touching the host', async () => {
    const gateway = new FakeGateway()
    await expect(new SessionRunner(gateway).launchIdea(idea({ workspaceId: undefined })))
      .rejects.toThrow('idea has no workspace to run in')
    expect(gateway.calls).toHaveLength(0)
  })

  it('reports the host reason, and the session, when a step fails', async () => {
    const created = new FakeGateway()
    created.failure.set('session.create', new Error('workspace not found: ws-1'))
    const createError = await new SessionRunner(created).launchIdea(idea()).catch((error: unknown) => error)
    expect(createError).toBeInstanceOf(SessionLaunchError)
    expect((createError as SessionLaunchError).message).toBe('session create failed: workspace not found: ws-1')
    expect((createError as SessionLaunchError).sessionId).toBeUndefined()

    const prompting = new FakeGateway()
    prompting.failure.set('session.prompt', { code: 'session-busy' })
    const promptError = await new SessionRunner(prompting).launchIdea(idea()).catch((error: unknown) => error)
    expect((promptError as Error).message).toBe('session run failed: session-busy')
    // The run was already accepted into this session: the caller needs the id.
    expect((promptError as SessionLaunchError).sessionId).toBe('session-1')
  })

  it('fails when the host returns no session id', async () => {
    const gateway = new FakeGateway()
    gateway.sessionId = ''
    await expect(new SessionRunner(gateway).launchIdea(idea()))
      .rejects.toThrow('session create failed: the host returned no session id')
  })
})

describe('SessionRunner.listRunning', () => {
  it('reads the roster as sessionId -> running', async () => {
    const gateway = new FakeGateway()
    gateway.roster = [{ sessionId: 'a', running: true }, { sessionId: 'b', running: false }]
    const roster = await new SessionRunner(gateway).listRunning()
    expect(roster.get('a')).toBe(true)
    expect(roster.get('b')).toBe(false)
  })

  it('uses the _request wire key this method declares (and the others do not)', async () => {
    const gateway = new FakeGateway()
    await new SessionRunner(gateway).listRunning()
    expect(gateway.calls[0]?.args).toEqual({ _request: {} })
  })

  it('tolerates a malformed roster instead of throwing', async () => {
    const gateway = new FakeGateway()
    gateway.failure.delete('session.list')
    const runner = new SessionRunner(gateway)
    const empty = new FakeGateway()
    empty.failure.set('session.list', undefined)
    await expect(runner.listRunning()).resolves.toBeInstanceOf(Map)
  })
})

describe('direct-session launch and settle (host service)', () => {
  /** A card-less service: the mirror is off, exactly like a Host with no task-board. */
  function startedService(): { service: IdeasHostService; gateway: FakeGateway } {
    const gateway = new FakeGateway()
    const service = new IdeasHostService({ dir: freshDir(), autoMirror: false, sessions: new SessionRunner(gateway) })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    return { service, gateway }
  }

  it('runs the idea in a fresh session and records the run', async () => {
    const { service, gateway } = startedService()
    gateway.roster = [{ sessionId: 'session-1', running: true }]

    const result = await service.launchIdea('idea-1', 'deepseek/deepseek-chat', 'req-1')

    expect(result).toEqual({ ok: true, runId: 'session-1', runStatus: 'running' })
    // No card exists, so the response carries no taskId at all.
    expect(result.taskId).toBeUndefined()
    const record = service.snapshot().ideas[0]
    expect(record?.runStatus).toBe('running')
    expect(record?.runSessionId).toBe('session-1')
    expect(record?.taskBoardId).toBeUndefined()
    service.dispose()
  })

  it('replays a request id without starting a second session', async () => {
    const { service, gateway } = startedService()
    await service.launchIdea('idea-1', undefined, 'req-1')
    const creates = gateway.methods.filter(method => method === 'create').length
    const replay = await service.launchIdea('idea-1', undefined, 'req-1')
    expect(replay.runId).toBe('session-1')
    expect(gateway.methods.filter(method => method === 'create').length).toBe(creates)
    service.dispose()
  })

  it('settles done and opens the review gate, with no card anywhere', async () => {
    const { service, gateway } = startedService()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    await service.launchIdea('idea-1')

    await service.pollRunTransitions()
    expect(service.snapshot().ideas[0]?.status).toBe('open')

    gateway.roster = [{ sessionId: 'session-1', running: false }]
    await service.pollRunTransitions()
    const settled = service.snapshot().ideas[0]
    expect(settled?.runStatus).toBe('done')
    expect(settled?.status).toBe('underReview')
    // The session id is released once the run is settled.
    expect(settled?.runSessionId).toBeUndefined()
    service.dispose()
  })

  it('settles failed when the session disappears under us', async () => {
    const { service, gateway } = startedService()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    await service.launchIdea('idea-1')

    gateway.roster = []
    await service.pollRunTransitions()
    const settled = service.snapshot().ideas[0]
    expect(settled?.runStatus).toBe('failed')
    // A failed run delivered nothing: the idea stays in the backlog, exactly
    // like the card backend's "Task failed" badge.
    expect(settled?.status).toBe('open')
    service.dispose()
  })

  it('settles nothing while the roster is unknown (a booting runtime)', async () => {
    const { service, gateway } = startedService()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    await service.launchIdea('idea-1')
    gateway.failure.set('session.list', new Error('service unavailable'))

    await service.pollRunTransitions()
    expect(service.snapshot().ideas[0]?.runStatus).toBe('running')
    service.dispose()
  })

  it('re-attaches to a run still in flight after a host restart', async () => {
    const dir = freshDir()
    const first = new FakeGateway()
    first.roster = [{ sessionId: 'session-1', running: true }]
    const before = new IdeasHostService({ dir, autoMirror: false, sessions: new SessionRunner(first) })
    before.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await before.launchIdea('idea-1')
    before.dispose()

    // A fresh service over the same ledger: the in-memory tracker is empty and
    // must be rebuilt from the persisted `running` + `runSessionId` pair.
    const second = new FakeGateway()
    second.roster = [{ sessionId: 'session-1', running: false }]
    const after = new IdeasHostService({ dir, autoMirror: false, sessions: new SessionRunner(second) })
    await after.pollRunTransitions()
    expect(after.snapshot().ideas[0]?.runStatus).toBe('done')
    expect(after.snapshot().ideas[0]?.status).toBe('underReview')
    after.dispose()
  })

  it('reads the roster at most once per tick, whatever the run count', async () => {
    const { service, gateway } = startedService()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    service.apply('create-2', { kind: 'create', id: 'idea-2', input: { title: 'T2', body: 'B2', workspaceId: 'ws-1' } })
    await service.launchIdea('idea-1')
    await service.launchIdea('idea-2')
    const before = gateway.methods.filter(method => method === 'list').length
    await service.pollRunTransitions()
    expect(gateway.methods.filter(method => method === 'list').length).toBe(before + 1)
    service.dispose()
  })

  it('falls back to a session when the card board turns out to be absent', async () => {
    // The mirror was wired at boot, but the task-board plugin is gone by the
    // time the human clicks: the launch must still run, not dead-end on a 503.
    const gateway = new FakeGateway()
    gateway.roster = [{ sessionId: 'session-1', running: true }]
    const taskBoard = new DeadTaskBoard()
    const service = new IdeasHostService({
      dir: freshDir(),
      mirror: new TaskBoardMirror({ transport: taskBoard }),
      sessions: new SessionRunner(gateway),
    })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })

    const result = await service.launchIdea('idea-1')
    expect(result).toEqual({ ok: true, runId: 'session-1', runStatus: 'running' })
    expect(service.snapshot().ideas[0]?.runSessionId).toBe('session-1')
    service.dispose()
  })

  it('still refuses loudly when neither backend can run the idea', async () => {
    const service = new IdeasHostService({ dir: freshDir(), autoMirror: false })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws-1' } })
    await expect(service.launchIdea('idea-1')).rejects.toThrow('task-board mirror is disabled')
    service.dispose()
  })
})
