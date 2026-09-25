// @vitest-environment jsdom
/**
 * Idea #66 client tests: the launch VISIBILITY matrix (pure predicate, so the
 * whole status x task-status x workspace x availability grid is checked without
 * a DOM), the backend resolution, and the board flow itself — the green button,
 * the model modal, the wire call carrying `provider/model`, and a refusal that
 * keeps the modal open with the reason visible instead of vanishing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import {
  canLaunch,
  HostLaunchBackend,
  modelTargetIdOf,
  resolveLaunchBackend,
  type LaunchTarget,
} from '../src/client/launch.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type LaunchResponse,
} from '../src/protocol.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const target = (overrides: Partial<LaunchTarget> = {}): LaunchTarget => ({
  id: 'idea-1',
  status: 'open',
  workspaceId: 'ws1',
  taskBoardId: 'idea-idea-1',
  taskBoardStatus: 'backlog',
  ...overrides,
})

describe('launch visibility', () => {
  it('is offered on an open, workspace-bound, launchable card', () => {
    expect(canLaunch(target())).toBe(true)
    expect(canLaunch(target({ taskBoardStatus: 'todo' }))).toBe(true)
    // Decision D4: a failed run must stay relaunchable from our own board.
    expect(canLaunch(target({ taskBoardStatus: 'failed' }))).toBe(true)
    // A card the poll has not seen yet must not wait for a tick to be usable.
    expect(canLaunch(target({ taskBoardStatus: undefined }))).toBe(true)
  })

  it('is hidden while the card runs, is done, or is archived', () => {
    expect(canLaunch(target({ taskBoardStatus: 'running' }))).toBe(false)
    expect(canLaunch(target({ runStatus: 'running' }))).toBe(false)
    expect(canLaunch(target({ taskBoardStatus: 'done' }))).toBe(false)
    expect(canLaunch(target({ taskBoardStatus: 'archived' }))).toBe(false)
  })

  it('needs a workspace, but NOT a card', () => {
    expect(canLaunch(target({ workspaceId: undefined }))).toBe(false)
    expect(canLaunch(target({ workspaceId: '' }))).toBe(false)
    // No mirrored card is the normal state of a board on a Host that serves no
    // task-board plugin: the direct-session backend runs it without one.
    expect(canLaunch(target({ taskBoardId: undefined }))).toBe(true)
    // A card that EXISTS still constrains the decision: a running or done card
    // is the run of record, and a second invisible session next to it is a lie.
    expect(canLaunch(target({ taskBoardId: 'task-1', taskBoardStatus: 'running' }))).toBe(false)
    expect(canLaunch(target({ taskBoardId: 'task-1', taskBoardStatus: 'done' }))).toBe(false)
  })

  it('is hidden on every non-open column', () => {
    for (const status of ['underReview', 'archived', 'declined'] as const) {
      expect(canLaunch(target({ status }))).toBe(false)
    }
  })
})

describe('launch backend resolution', () => {
  const noLaunch: IdeasHostTransport = {
    state: async () => { throw new Error('unused') },
    action: async () => { throw new Error('unused') },
    subscribe: () => () => {},
  }
  const withLaunch: IdeasHostTransport = {
    ...noLaunch,
    launch: async () => ({ ok: true, runId: 'idea-idea-1', taskId: 'idea-idea-1', runStatus: 'running' }),
  }

  it('resolves the host backend when the host exposes the route', async () => {
    expect((await resolveLaunchBackend(target(), withLaunch))?.id).toBe('host')
  })

  it('resolves nothing without the capability (an older host shows no button)', async () => {
    expect(await resolveLaunchBackend(target(), noLaunch)).toBeUndefined()
    expect(await new HostLaunchBackend(noLaunch).available(target())).toBe(false)
  })

  it('resolves nothing for a card that cannot be launched', async () => {
    expect(await resolveLaunchBackend(target({ status: 'archived' }), withLaunch)).toBeUndefined()
    expect(await resolveLaunchBackend(target({ taskBoardStatus: 'done' }), withLaunch)).toBeUndefined()
    expect(await resolveLaunchBackend(target({ runStatus: 'running' }), withLaunch)).toBeUndefined()
  })

  it('qualifies a picked model as provider/model and drops an empty pick', () => {
    expect(modelTargetIdOf({ provider: 'deepseek', model: 'deepseek-chat', label: 'x' })).toBe('deepseek/deepseek-chat')
    expect(modelTargetIdOf(undefined)).toBeUndefined()
  })

  it('passes the target id straight to the host route', async () => {
    const seen: Array<string | undefined> = []
    const backend = new HostLaunchBackend({
      ...noLaunch,
      launch: async (_id: string, model?: string) => {
        seen.push(model)
        return { ok: true, runId: 'r', runStatus: 'running' }
      },
    })
    await backend.launch(target(), { provider: 'deepseek', model: 'deepseek-chat', label: 'x' })
    await backend.launch(target())
    expect(seen).toEqual(['deepseek/deepseek-chat', undefined])
  })
})

describe('IdeasClient.launchIdea', () => {
  it('surfaces the host refusal on the error bar and rethrows it', async () => {
    const client = new IdeasClient({
      state: async () => snapshot(),
      action: async () => snapshot(),
      subscribe: () => () => {},
      launch: async () => { throw new Error('task is already running or missing') },
    }, undefined)

    await expect(client.launchIdea('idea-1')).rejects.toThrow(/already running/)
    expect(client.error).toMatch(/already running/)
  })

  it('reports an older host without the launch route', async () => {
    const client = new IdeasClient({
      state: async () => snapshot(),
      action: async () => snapshot(),
      subscribe: () => () => {},
    }, undefined)

    await expect(client.launchIdea('idea-1')).rejects.toThrow('launch-unavailable')
  })
})

/* --- board flow --- */

function snapshot(): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { id: 'launchable', title: 'Launchable', status: 'open', rank: 1, bodyExcerpt: 'a', createdAt: 1, updatedAt: 100, workspaceId: 'ws1', taskBoardId: 'task-1', taskBoardStatus: 'backlog' },
      { id: 'running', title: 'Running', status: 'open', rank: 2, bodyExcerpt: 'b', createdAt: 1, updatedAt: 100, workspaceId: 'ws1', taskBoardId: 'task-2', taskBoardStatus: 'running' },
      { id: 'unbound', title: 'Unbound', status: 'open', rank: 3, bodyExcerpt: 'c', createdAt: 1, updatedAt: 100, workspaceId: 'ws1' },
      { id: 'no-workspace', title: 'Generic', status: 'open', rank: 4, bodyExcerpt: 'd', createdAt: 1, updatedAt: 100, taskBoardId: 'task-4', taskBoardStatus: 'backlog' },
      // A direct-session run in flight: no card, a run stamp, and the session
      // the Host is executing it in.
      { id: 'executing', title: 'Executing', status: 'open', rank: 5, bodyExcerpt: 'e', createdAt: 1, updatedAt: 100, workspaceId: 'ws1', runStatus: 'running', runSessionId: 'session-7' },
      { id: 'settled', title: 'Settled', status: 'open', rank: 6, bodyExcerpt: 'f', createdAt: 1, updatedAt: 100, workspaceId: 'ws1', runStatus: 'done', taskBoardStatus: 'failed' },
    ],
  }
}

class FakeTransport implements IdeasHostTransport {
  launches: Array<{ ideaId: string; model: string | undefined }> = []
  failure: string | undefined
  async state(): Promise<IdeasListSnapshot> { return snapshot() }
  async action(): Promise<IdeasListSnapshot> { return snapshot() }
  async launch(ideaId: string, model?: string): Promise<LaunchResponse> {
    this.launches.push({ ideaId, model })
    if (this.failure !== undefined) throw new Error(this.failure)
    return { ok: true, runId: `card-${ideaId}`, taskId: `card-${ideaId}`, runStatus: 'running' }
  }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
})
afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  host.remove()
})

async function renderBoard(transport: IdeasHostTransport = new FakeTransport()): Promise<FakeTransport> {
  client = new IdeasClient(transport, undefined)
  client.snapshot = snapshot()
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
  return transport as FakeTransport
}

/** Re-render with a client field that is not reactive on its own. */
function rerender(): void {
  act(() => { root?.render(<IdeasBoard client={client} />) })
}

function launchButtonIn(ideaId: string): HTMLElement | null {
  return host.querySelector(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-launch]`)
}

function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('board launch affordance', () => {
  it('shows the button on every card a launch can actually start', async () => {
    await renderBoard()
    expect(launchButtonIn('launchable')).not.toBeNull()
    expect(launchButtonIn('running')).toBeNull()
    // No mirrored card is the normal state of a board with no task-board
    // plugin: the direct-session backend runs the idea without one.
    expect(launchButtonIn('unbound')).not.toBeNull()
    // No workspace, no run — ever: neither backend has a directory to work in.
    expect(launchButtonIn('no-workspace')).toBeNull()
  })

  it('opens the model modal and posts provider/model on confirm', async () => {
    const transport = await renderBoard()
    click(launchButtonIn('launchable') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    const submit = host.querySelector('[data-dsh-ideas-launch-submit]') as HTMLElement | null
    expect(submit).not.toBeNull()

    // No catalog in this harness: the modal keeps the explicit "session
    // default" choice, so the model key is omitted on the wire.
    await act(async () => { click(submit as HTMLElement) })
    expect(transport.launches).toEqual([{ ideaId: 'launchable', model: undefined }])
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[data-dsh-ideas-launch-submit]')).toBeNull()
  })

  it('keeps the modal open and shows the reason when the host refuses', async () => {
    const transport = new FakeTransport()
    transport.failure = 'task is already running or missing'
    await renderBoard(transport)
    click(launchButtonIn('launchable') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    const submit = host.querySelector('[data-dsh-ideas-launch-submit]') as HTMLElement
    await act(async () => { click(submit); await Promise.resolve() })

    expect(host.querySelector('[data-dsh-ideas-launch-submit]')).not.toBeNull()
    expect(host.textContent).toContain('task is already running or missing')
  })

  it('preselects the current session model and posts it as provider/model', async () => {
    const transport = await renderBoard()
    // The very picker the capture and re-analyze modals use: the catalog is
    // loaded once and preselected with the HOST SESSION's model.
    client.sessionLauncher = {
      launch: async () => ({ accepted: true }),
      launchReanalyze: async () => ({ accepted: true }),
      listModels: async () => [
        { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek · Chat' },
        { provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek · Reasoner' },
      ],
      currentModel: async () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }),
    }
    await act(async () => { await Promise.resolve() })

    click(launchButtonIn('launchable') as HTMLElement)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const modelSelect = host.querySelector('#dsh-ideas-model') as HTMLSelectElement
    expect(modelSelect.value).toBe('DeepSeek · Reasoner')

    const submit = host.querySelector('[data-dsh-ideas-launch-submit]') as HTMLElement
    await act(async () => { click(submit) })
    expect(transport.launches).toEqual([{ ideaId: 'launchable', model: 'deepseek/deepseek-reasoner' }])
  })
})

describe('board run visibility (idea #66)', () => {
  function badgeIn(ideaId: string): HTMLElement | null {
    return host.querySelector(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-task-running]`)
  }

  function sessionLinkIn(ideaId: string): HTMLElement | null {
    return host.querySelector(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-open-session]`)
  }

  it('marks an in-flight run on the card, whatever the backend', async () => {
    await renderBoard()
    // The direct-session run carries no card at all: the badge is the ONLY
    // trace that a launch is in flight.
    expect(badgeIn('executing')).not.toBeNull()
    // A card someone started from the task-board itself still reads as in
    // flight here, even before the poll folds it into runStatus.
    expect(badgeIn('running')).not.toBeNull()
    // Nothing is in flight on the others.
    expect(badgeIn('launchable')).toBeNull()
    expect(badgeIn('unbound')).toBeNull()
    expect(badgeIn('settled')).toBeNull()
  })

  it('jumps into the run session from the card', async () => {
    const opened: string[] = []
    await renderBoard()
    client.sessionOpener = { open: (id: string) => { opened.push(id) } }
    rerender()

    const link = sessionLinkIn('executing')
    expect(link).not.toBeNull()
    click(link as HTMLElement)
    expect(opened).toEqual(['session-7'])
  })

  it('renders no link without a sessions service, and never on a settled run', async () => {
    await renderBoard()
    // No opener resolved (no shell sessions service): the badge stays, the
    // affordance simply does not exist - never a broken button.
    expect(sessionLinkIn('executing')).toBeNull()
    expect(badgeIn('executing')).not.toBeNull()
    // A settled run keeps no session link: the run is over, its session is
    // not the thing the human needs.
    expect(sessionLinkIn('settled')).toBeNull()
  })
})
