/**
 * Idea #107 — the default launch model per workspace, host side.
 *
 * The feature is a FALLBACK ORDER and nothing else: the run's explicit choice,
 * then the workspace's default, then whatever the chosen backend defaults to
 * (the behaviour that predates the field). Everything asserted here exists to
 * pin one of those three steps, and the tests are written so that each one
 * fails if the order inverts.
 *
 * The three that matter most:
 *  - the SAME default reaches BOTH backends (a card task patch and a fresh
 *    session's `selectModel`), so the feature cannot be half-delivered;
 *  - a workspace carrying no default posts EXACTLY the wire pre-#107 posted,
 *    because step 3 has to stay inert;
 *  - a default that no longer resolves FAILS LOUDLY on both backends, with no
 *    silent retry without the model — the refusal a human can act on is the
 *    whole contract of "never fall back silently".
 */

import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import {
  TaskBoardMirror,
  type TaskBoardActionEnvelope,
  type TaskBoardTransport,
} from '../src/taskboard-bridge.ts'
import { SessionRunner, SessionLaunchError, type HostSessionGateway } from '../src/session-runner.ts'
import { sanitizeSettings, toListSnapshot, parseActionEnvelope, parseLaunchBody, parseSettingsBody, IDEAS_SCHEMA_VERSION, IDEAS_SETTINGS_DEFAULTS, type IdeasSettingsValue } from '../src/protocol.ts'

let dir = ''

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

/** In-memory task-board: a mutable card list plus canned per-verb answers. */
class FakeTaskBoard implements TaskBoardTransport {
  posts: TaskBoardActionEnvelope[] = []
  stateStatus = 200
  stateTasks: Array<{ id: string; status: string }> = []
  answers = new Map<string, { status: number; body?: unknown }>()

  async getState() {
    return { status: this.stateStatus, body: { schemaVersion: 3, revision: 1, tasks: this.stateTasks } }
  }

  async postAction(envelope: TaskBoardActionEnvelope) {
    this.posts.push(envelope)
    return this.answers.get(envelope.action.kind) ?? { status: 200 }
  }
}

/** Scripted session gateway: records every call, can refuse one method. */
class FakeGateway implements HostSessionGateway {
  calls: Array<{ method: string; args: Record<string, unknown> }> = []
  failure = new Map<string, unknown>()

  async invoke(request: { namespace: string; method: string; args?: unknown }): Promise<unknown> {
    const key = `${request.namespace}.${request.method}`
    this.calls.push({ method: request.method, args: (request.args ?? {}) as Record<string, unknown> })
    if (this.failure.has(key)) throw this.failure.get(key)
    if (key === 'session.create') return { sessionId: 'session-1' }
    if (key === 'session.list') return { items: [] }
    return { ok: true }
  }

  /** The selectModel payload, or undefined when the run pinned no model. */
  selectModelArgs(): Record<string, unknown> | undefined {
    return this.calls.find(call => call.method === 'selectModel')?.args.request as Record<string, unknown> | undefined
  }
}

/**
 * A service whose settings reader answers a map of workspace -> model.
 *
 * The reader is what the boot wiring binds to the config port; going through
 * `setSettingsReader` (rather than reaching into the store) is the point: the
 * fallback is resolved through the SAME public seam the permission uses, so a
 * settings write lands on the next launch with no restart.
 */
async function serve(options: {
  launchModels?: Record<string, string>
  directRunPermission?: string
  withMirror?: boolean
  autoMirror?: boolean
  boardAbsent?: boolean
  dispatch?: (sessionId: string, line: string) => Promise<unknown>
} = {}): Promise<{ service: IdeasHostService; taskBoard: FakeTaskBoard; gateway: FakeGateway }> {
  dir = join(tmpdir(), `ideas-107-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const taskBoard = new FakeTaskBoard()
  // Both ideas already own their deterministic card, so every launch in these
  // tests takes the CARD path unless a case says otherwise.
  taskBoard.stateTasks = [
    { id: 'idea-idea-1', status: 'backlog' },
    { id: 'idea-idea-2', status: 'backlog' },
  ]
  // `boardAbsent` reproduces a board that is gone: the mirror object exists but
  // its availability probe never succeeds, which is the state launchTask
  // refuses with — the one case where a launch falls back to a session.
  if (options.boardAbsent === true) taskBoard.stateStatus = 404
  const gateway = new FakeGateway()
  const service = new IdeasHostService({
    dir,
    mirror: options.withMirror === false ? undefined : new TaskBoardMirror({ transport: taskBoard }),
    autoMirror: options.autoMirror ?? true,
    sessions: new SessionRunner(gateway, options.dispatch),
  })
  const value: IdeasSettingsValue = sanitizeSettings({
    ...IDEAS_SETTINGS_DEFAULTS,
    ...(options.launchModels === undefined ? {} : { launchModelByWorkspace: options.launchModels }),
    ...(options.directRunPermission === undefined ? {} : { directRunPermission: options.directRunPermission }),
  })
  service.setSettingsReader(() => value)
  service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws1' } })
  service.apply('create-2', { kind: 'create', id: 'idea-2', input: { title: 'T2', body: 'B2', workspaceId: 'ws2' } })
  await service.flushMirror()
  taskBoard.posts = []
  return { service, taskBoard, gateway }
}

/** The model patches the card backend pinned, in order. */
function pinnedModels(taskBoard: FakeTaskBoard): Array<string | undefined> {
  return taskBoard.posts
    .filter(entry => entry.action.kind === 'update')
    .map(entry => (entry.action as { patch?: { model?: string } }).patch?.model)
}

describe('the fallback order (idea #107)', () => {
  it('1. the run\'s explicit choice outranks the workspace default', async () => {
    const { service, taskBoard } = await serve({ launchModels: { ws1: 'p/default' } })

    await service.launchIdea('idea-1', 'p/explicit')

    expect(pinnedModels(taskBoard)).toEqual(['p/explicit'])
    expect(taskBoard.posts.map(entry => entry.action.kind)).toEqual(['update', 'run'])
  })

  it('2. the workspace default applies when the run pins none', async () => {
    const { service, taskBoard } = await serve({ launchModels: { ws1: 'p/default' } })

    await service.launchIdea('idea-1')

    // The card patch stays MODEL-ONLY: widening it would be refused by the
    // task-board on a card that has already run, which is exactly the freeze
    // this feature must not break.
    expect(taskBoard.posts.map(entry => entry.action)).toEqual([
      { kind: 'update', taskId: 'idea-idea-1', patch: { model: 'p/default' } },
      { kind: 'run', taskId: 'idea-idea-1' },
    ])
  })

  it('3. an empty string is no choice at all, so the default still applies', async () => {
    const { service, taskBoard } = await serve({ launchModels: { ws1: 'p/default' } })

    await service.launchIdea('idea-1', '')

    expect(pinnedModels(taskBoard)).toEqual(['p/default'])
  })

  it('4. a workspace with no default posts the wire pre-#107 posted', async () => {
    const { service, taskBoard } = await serve({ launchModels: { ws1: 'p/default' } })

    // ws2 carries none: this MUST be the bare `run` of the previous release.
    await service.launchIdea('idea-2')

    expect(taskBoard.posts.map(entry => entry.action)).toEqual([{ kind: 'run', taskId: 'idea-idea-2' }])
  })

  it('5. an unset setting is inert (no settings service, no reader at all)', async () => {
    dir = join(tmpdir(), `ideas-107-${process.pid}-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const taskBoard = new FakeTaskBoard()
    taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
    const service = new IdeasHostService({ dir, mirror: new TaskBoardMirror({ transport: taskBoard }) })
    service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws1' } })
    await service.flushMirror()
    taskBoard.posts = []

    await service.launchIdea('idea-1')

    expect(taskBoard.posts.map(entry => entry.action)).toEqual([{ kind: 'run', taskId: 'idea-idea-1' }])
  })

  it('is resolved per idea, not per board: two workspaces, two answers', async () => {
    const { service, taskBoard } = await serve({ launchModels: { ws1: 'p/one', ws3: 'p/three' } })

    await service.launchIdea('idea-1')
    await service.launchIdea('idea-2')

    expect(pinnedModels(taskBoard)).toEqual(['p/one'])
  })
})

describe('the same default must reach BOTH backends', () => {
  it('pins it on the card, as a model-only patch before the run', async () => {
    const { service, taskBoard } = await serve({ launchModels: { ws1: 'deepseek/deepseek-chat' } })

    const result = await service.launchIdea('idea-1')

    expect(result.taskId).toBe('idea-idea-1')
    expect(taskBoard.posts.map(entry => entry.action)).toEqual([
      { kind: 'update', taskId: 'idea-idea-1', patch: { model: 'deepseek/deepseek-chat' } },
      { kind: 'run', taskId: 'idea-idea-1' },
    ])
  })

  it('pins it on the fresh session through selectModel, with no card at all', async () => {
    const { service, taskBoard, gateway } = await serve({
      launchModels: { ws1: 'deepseek/deepseek-chat' },
      withMirror: false,
      autoMirror: false,
    })

    const result = await service.launchIdea('idea-1')

    expect(result.taskId).toBeUndefined()
    expect(gateway.selectModelArgs()).toEqual({
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(taskBoard.posts).toHaveLength(0)
  })

  it('pins it on the session the card path falls back to when the board is gone', async () => {
    const { service, taskBoard, gateway } = await serve({ launchModels: { ws1: 'deepseek/deepseek-chat' }, boardAbsent: true })
    // The board turned out to be absent AT CLICK TIME: the card cannot run, so
    // the session does — and the SAME resolved model has to travel with it, or
    // a backend fallback would silently change the model under the human.

    const result = await service.launchIdea('idea-1')

    expect(result.taskId).toBeUndefined()
    expect(gateway.selectModelArgs()).toEqual({
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(taskBoard.posts).toHaveLength(0)
  })
})

describe('a default that no longer resolves fails LOUDLY', () => {
  it('on the card backend: the task-board refusal is relayed, never retried', async () => {
    const { service, taskBoard } = await serve({ launchModels: { ws1: 'p/gone' } })
    taskBoard.answers.set('update', { status: 400, body: { error: 'unknown model: p/gone' } })

    await expect(service.launchIdea('idea-1')).rejects.toThrow(/unknown model: p\/gone/)

    // No silent second attempt: the run must not quietly start on another model.
    expect(taskBoard.posts.filter(entry => entry.action.kind === 'run')).toHaveLength(0)
    expect(pinnedModels(taskBoard)).toEqual(['p/gone'])
  })

  it('on the direct-session backend: the selectModel rejection is the launch refusal', async () => {
    const { service, gateway } = await serve({
      launchModels: { ws1: 'p/gone' },
      withMirror: false,
      autoMirror: false,
    })
    gateway.failure.set('session.selectModel', new Error('unknown model p/gone'))

    await expect(service.launchIdea('idea-1')).rejects.toBeInstanceOf(SessionLaunchError)

    // The prompt was never queued, so no run exists at all.
    expect(gateway.calls.some(call => call.method === 'prompt')).toBe(false)
    expect(service.idea('idea-1')?.runStatus).toBeUndefined()
  })
})

describe('the default is a setting, never idea data', () => {
  it('stays out of the idea record and of the frozen full snapshot', async () => {
    const { service } = await serve({ launchModels: { ws1: 'p/default' } })
    const idea = service.idea('idea-1')
    expect(idea).toBeDefined()
    // Nothing named "model" may appear on a row: the board adopts whatever the
    // Host serves on its 2.5 s poll, and a per-idea copy would be written
    // straight back over the choice the human just made.
    expect(Object.keys(idea as unknown as Record<string, unknown>).filter(key => /model/i.test(key))).toEqual([])
    const snapshot = service.snapshot()
    expect(JSON.stringify(snapshot)).not.toContain('p/default')
  })

  it('does not travel with the ledger, and import/export stay byte-identical', async () => {
    const { service } = await serve({ launchModels: { ws1: 'p/default' } })
    // The portable document is the ledger: a profile preference is stored with
    // the profile, exactly like `language` or `cardDensity`, so an exported
    // board neither carries nor invents a launch default.
    const before = JSON.stringify(service.snapshot())
    service.apply('export-1', { kind: 'export', workspaceId: 'ws1' })
    const after = JSON.stringify(service.snapshot())
    expect(after).toBe(before)
  })

  it('reads the setting at LAUNCH time, so a change lands on the next run', async () => {
    const { service, taskBoard } = await serve({ launchModels: {} })
    let live: IdeasSettingsValue = sanitizeSettings({})
    service.setSettingsReader(() => live)

    await service.launchIdea('idea-2')
    expect(pinnedModels(taskBoard)).toHaveLength(0)

    // The settings document moves (what the config route does on a write).
    live = sanitizeSettings({ launchModelByWorkspace: { ws2: 'p/late' } })
    await service.launchIdea('idea-2')
    expect(pinnedModels(taskBoard)).toEqual(['p/late'])
  })
})

describe('the direct-launch permission still reaches the fresh session', () => {
  // Idea #107 generalized the settings seam: the service used to read ONE
  // string (`setRunPermission`) and now reads the whole settings VALUE
  // (`setSettingsReader`) for both preferences. This is the regression guard for
  // the pre-existing half of that seam — the permission must arrive through the
  // SAME reader as the model, or a read-only deployment would silently get
  // workspace-write runs.
  it('dispatches /permission from the settings value, before the prompt', async () => {
    const dispatched: Array<[string, string]> = []
    const { service, gateway } = await serve({
      launchModels: { ws1: 'deepseek/deepseek-chat' },
      directRunPermission: 'read-only',
      withMirror: false,
      autoMirror: false,
      dispatch: async (sessionId, line) => { dispatched.push([sessionId, line]) },
    })

    await service.launchIdea('idea-1')

    expect(dispatched).toEqual([['session-1', '/permission read-only']])
    // And it is dispatched BEFORE the prompt, while both preferences came out
    // of the one reader: the model is pinned and the sandbox is already in place.
    const order = gateway.calls.map(call => call.method)
    expect(order).toContain('selectModel')
    expect(order.indexOf('selectModel')).toBeLessThan(order.indexOf('prompt'))
  })

  it('defaults to workspace-write when the deployment stores nothing', async () => {
    const dispatched: Array<[string, string]> = []
    const { service } = await serve({
      withMirror: false,
      autoMirror: false,
      dispatch: async (sessionId, line) => { dispatched.push([sessionId, line]) },
    })

    await service.launchIdea('idea-1')

    // The documented default, not the Host's own: the run brief asks for
    // implementation, so a read-only direct run would answer with a plan.
    expect(dispatched).toEqual([['session-1', '/permission workspace-write']])
  })
})

describe('a workspace that no longer exists', () => {
  it('keeps the default it held — nothing prunes the map', async () => {
    // Deleting every idea of a workspace does not touch the settings document:
    // the map is keyed by a stable id, and a workspace the Host forgot is not a
    // reason to forget a preference.
    const { service } = await serve({ launchModels: { ws1: 'p/default' } })
    service.apply('delete-1', { kind: 'delete', ideaId: 'idea-1' })
    expect(service.idea('idea-1')).toBeUndefined()

    let live: IdeasSettingsValue = sanitizeSettings({ launchModelByWorkspace: { ws1: 'p/default' } })
    service.setSettingsReader(() => live)
    // The idea is gone, so there is nothing to launch — and the entry is still
    // there for the next idea captured into that workspace.
    expect(Object.keys(live.launchModelByWorkspace)).toEqual(['ws1'])
  })

  it('resolves to no default when the idea sits in another workspace', async () => {
    const { service, taskBoard } = await serve({ launchModels: { 'ws-that-is-gone': 'p/orphan' } })

    await service.launchIdea('idea-1')

    expect(taskBoard.posts.map(entry => entry.action)).toEqual([{ kind: 'run', taskId: 'idea-idea-1' }])
  })
})

/* --- the frozen wire did not move ---------------------------------------- */

describe('the frozen wire is untouched (idea #107 is additive elsewhere)', () => {
  it('still accepts exactly {requestId, action, initiator} on the action route', () => {
    const parsed = parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'update', ideaId: 'a', patch: { title: 'Alpha' } },
      initiator: 'agent:test',
    })
    expect(parsed?.action).toEqual({ kind: 'update', ideaId: 'a', patch: { title: 'Alpha' } })
    // The initiator still travels through verbatim (idea #92's rule), and no
    // fourth envelope key appeared.
    expect(parsed?.initiator).toBe('agent:test')
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'export' }, weight: 1 })).toBeUndefined()
  })

  it('refuses the default on an idea PATCH — the setting is not idea data', () => {
    // The load-bearing negative: if any of these spellings parsed, the board's
    // 2.5 s poll could write a launch default back over the human's choice, and
    // the row would start travelling with the portable ledger document.
    const patch = (value: unknown) => parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'update', ideaId: 'a', patch: value },
    })
    for (const key of ['launchModel', 'launchModelByWorkspace', 'model', 'defaultModel']) {
      expect(patch({ [key]: 'p/m' })).toBeUndefined()
    }
    // Nor on `create`, which is the other way a row could be born carrying it.
    expect(parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'create', id: 'a', input: { title: 'T', body: 'B', launchModel: 'p/m' } },
    })).toBeUndefined()
  })

  it('leaves the default full GET /state response byte-identical', async () => {
    const { service } = await serve({ launchModels: { ws1: 'p/default', ws2: 'p/two' } })
    const snapshot = service.snapshot()

    // The frozen response is these three keys — not a new one, even though the
    // Host now holds a per-workspace model map in memory.
    expect(Object.keys(snapshot).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])
    expect(snapshot.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    // IDEAS_SCHEMA_VERSION stays 1: the ledger schema did not gain a field.
    expect(IDEAS_SCHEMA_VERSION).toBe(1)
    // No row carries anything model-shaped, and the list projection the board
    // actually polls is free of it too.
    for (const idea of snapshot.ideas) {
      expect(Object.keys(idea).filter(key => /model/i.test(key))).toEqual([])
    }
    const wire = JSON.stringify(snapshot) + JSON.stringify(toListSnapshot(snapshot))
    expect(wire).not.toContain('launchModel')
    expect(wire).not.toContain('p/default')
    expect(wire).not.toContain('p/two')
  })

  it('leaves the launch BODY exactly {requestId?, initiator?, ideaId, model?}', () => {
    expect(parseLaunchBody({ ideaId: 'a' })).toEqual({ ideaId: 'a' })
    expect(parseLaunchBody({ ideaId: 'a', model: 'p/m' })).toEqual({ ideaId: 'a', model: 'p/m' })
    // `model` stays OPTIONAL and stays a plain string: the fallback is resolved
    // from the workspace when it is absent, not from a new body key.
    for (const extra of ['workspaceModel', 'launchModel', 'useWorkspaceDefault']) {
      expect(parseLaunchBody({ ideaId: 'a', [extra]: 'p/m' })).toBeUndefined()
    }
    expect(parseLaunchBody({ ideaId: 'a', model: null })).toBeUndefined()
  })

  it('adds its surface on the CONFIG route only, never as an action verb', () => {
    // `launchModel` is not a verb, and the settings family is not an action
    // kind: a POST /action carrying it is still `invalid-action` on the Host.
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'launchModel', ideaId: 'a' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'settings', patch: {} } })).toBeUndefined()
    // And it lives on the config body, which is a different route entirely.
    expect(parseSettingsBody({ patch: { launchModelByWorkspace: { ws1: 'p/m' } } })?.patch.launchModelByWorkspace)
      .toEqual({ ws1: 'p/m' })
  })
})
