// @vitest-environment jsdom
/**
 * The default launch model per workspace, panel side.
 *
 * The point of the feature is that the modal STOPS ASKING, so the assertions
 * are about what the modal shows and, above all, about what it does NOT send:
 *
 *  - with a default, the picker is hidden, the model is NAMED, and the launch
 *    request pins NOTHING — the Host resolves the very same default one step
 *    later. Re-sending the id would claim a choice the human never made;
 *  - without a default the modal behaves exactly as before (the picker, the
 *    pick, the id on the wire), because step 3 of the fallback has to stay
 *    inert for a deployment that never used the feature;
 *  - setting, changing and forgetting are three distinct gestures, and each one
 *    writes the WHOLE map (the settings write replaces it), so a save never
 *    silently drops another workspace's default.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import {
  launchModelForWorkspace,
  withWorkspaceLaunchModel,
  withoutWorkspaceLaunchModel,
} from '../src/client/launch.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import type { ModelChoice } from '../src/client/session-queue.ts'
import {
  IDEAS_SCHEMA_VERSION,
  sanitizeSettings,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
  type LaunchResponse,
} from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CATALOG: ModelChoice[] = [
  { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek · Chat' },
  { provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek · Reasoner' },
]

/**
 * The same catalog, except the reasoner declares reasoning levels — the shape
 * the DSH model catalog serves (`reasoning.efforts` + `defaultEffort`). The
 * chat model declares none, so it is the "no selector" control.
 */
const REASONING_CATALOG: ModelChoice[] = [
  { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek · Chat' },
  {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    label: 'DeepSeek · Reasoner',
    reasoningEffort: 'high',
    reasoningEfforts: [
      { id: 'low', name: 'Low', description: 'Fast, shallow' },
      { id: 'high', name: 'High', description: 'Slow, thorough' },
    ],
  },
]

function snapshot(): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { id: 'launchable', title: 'Launchable', status: 'open', rank: 1, bodyExcerpt: 'a', createdAt: 1, updatedAt: 100, workspaceId: 'ws1', taskBoardId: 'task-1', taskBoardStatus: 'backlog' },
      { id: 'other-workspace', title: 'Elsewhere', status: 'open', rank: 2, bodyExcerpt: 'b', createdAt: 1, updatedAt: 100, workspaceId: 'ws2', taskBoardId: 'task-2', taskBoardStatus: 'backlog' },
    ],
  }
}

/** The same board plus one idea that has no TaskBoard card yet. */
function cardlessSnapshot(): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { id: 'cardless', title: 'Cardless', status: 'open', rank: 3, bodyExcerpt: 'c', createdAt: 1, updatedAt: 100, workspaceId: 'ws1' },
      ...snapshot().ideas,
    ],
  }
}

/** Transport that serves a mutable settings view and records every write. */
class FakeTransport implements IdeasHostTransport {
  launches: Array<{ ideaId: string; model: string | undefined; reasoningEffort?: string }> = []
  saved: IdeasSettingsPatch[] = []
  view: IdeasSettingsView
  failure: string | undefined
  /** What a settings WRITE answers with; a code like the Host's own. */
  saveError: string | undefined

  constructor(launchModels: Record<string, string> = {}, options: { available?: boolean } = {}) {
    this.view = {
      available: options.available ?? true,
      value: sanitizeSettings({ ...IDEAS_SETTINGS_DEFAULTS, launchModelByWorkspace: launchModels }),
      revision: 1,
    }
  }

  async state(): Promise<IdeasListSnapshot> { return snapshot() }
  async action(): Promise<IdeasListSnapshot> { return snapshot() }
  async config(): Promise<IdeasSettingsView> { return this.view }
  async saveConfig(patch: IdeasSettingsPatch, expectedRevision?: number): Promise<IdeasSettingsView> {
    this.saved.push(patch)
    if (this.saveError !== undefined) throw new Error(this.saveError)
    // The Host merges the patch over the stored document and bumps the fence;
    // a whole-map write therefore lands exactly as sent.
    const revision = (this.view.revision ?? 0) + 1
    this.view = {
      available: true,
      value: sanitizeSettings({ ...this.view.value, ...patch }),
      ...(expectedRevision === undefined ? {} : { revision }),
    }
    return this.view
  }
  async launch(ideaId: string, model?: string, reasoningEffort?: string): Promise<LaunchResponse> {
    this.launches.push({ ideaId, model, reasoningEffort })
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

async function renderBoard(
  transport: FakeTransport,
  catalog: ModelChoice[] = CATALOG,
  board: IdeasListSnapshot = snapshot(),
): Promise<void> {
  client = new IdeasClient(transport, undefined)
  client.snapshot = board
  // A model catalog, so the picker would be there if the modal wanted one.
  client.sessionLauncher = {
    launch: async () => ({ accepted: true }),
    launchReanalyze: async () => ({ accepted: true }),
    launchFindSimilar: async () => ({ accepted: true }),
    listModels: async () => catalog,
    currentModel: async () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }),
  }
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
  await act(async () => { await Promise.resolve() })
}

function launchButtonIn(ideaId: string): HTMLElement | null {
  return host.querySelector(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-launch]`)
}

async function openModal(ideaId = 'launchable'): Promise<void> {
  act(() => { (launchButtonIn(ideaId) as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function query<T extends Element>(selector: string): T | null {
  return host.querySelector(selector) as T | null
}

/** The stored map after the last settings write, or the initial one. */
function stored(transport: FakeTransport): Record<string, string> {
  return client.config.value.launchModelByWorkspace
}

describe('the pure map helpers', () => {
  it('reads a workspace default and answers undefined for every other case', () => {
    const models = { ws1: 'deepseek/deepseek-chat' }
    expect(launchModelForWorkspace(models, 'ws1')).toBe('deepseek/deepseek-chat')
    expect(launchModelForWorkspace(models, 'ws2')).toBeUndefined()
    expect(launchModelForWorkspace(models, undefined)).toBeUndefined()
    expect(launchModelForWorkspace(models, '')).toBeUndefined()
    expect(launchModelForWorkspace(undefined, 'ws1')).toBeUndefined()
    expect(launchModelForWorkspace({ ws1: '   ' }, 'ws1')).toBeUndefined()
  })

  it('never mutates the map it is handed, and keeps every other workspace', () => {
    const models = { ws1: 'p/one', ws2: 'p/two' }
    expect(withWorkspaceLaunchModel(models, 'ws3', 'p/three')).toEqual({ ws1: 'p/one', ws2: 'p/two', ws3: 'p/three' })
    expect(withWorkspaceLaunchModel(models, 'ws3', '  ')).toEqual(models)
    expect(withoutWorkspaceLaunchModel(models, 'ws1')).toEqual({ ws2: 'p/two' })
    // Forgetting the last one leaves an EMPTY map, not an absent field: that is
    // exactly the board that predates the feature.
    expect(withoutWorkspaceLaunchModel({ ws1: 'p/one' }, 'ws1')).toEqual({})
    expect(models).toEqual({ ws1: 'p/one', ws2: 'p/two' })
  })

  it('trims keys and targets like the Host-side sanitizer does', () => {
    // A map written here and a map read back through sanitizeLaunchModelByWorkspace
    // have to agree on the spelling, or a stored default would silently miss.
    expect(withWorkspaceLaunchModel(undefined, ' ws1 ', ' p/m ')).toEqual({ ws1: 'p/m' })
    expect(launchModelForWorkspace({ ws1: 'p/m' }, ' ws1 ')).toBe('p/m')
    expect(withoutWorkspaceLaunchModel({ 'ws1': 'p/m' }, ' ws1 ')).toEqual({})
  })
})

describe('a workspace with no default behaves exactly as before', () => {
  it('asks, and sends the picked model', async () => {
    const transport = new FakeTransport()
    await renderBoard(transport)
    await openModal()

    expect(query('#dsh-ideas-model')).not.toBeNull()
    expect(query('[data-dsh-ideas-launch-default]')).toBeNull()

    click(query('[data-dsh-ideas-launch-submit]') as HTMLElement)
    await act(async () => { await Promise.resolve() })
    expect(transport.launches).toEqual([{ ideaId: 'launchable', model: 'deepseek/deepseek-reasoner' }])
  })
})

describe('a workspace with a default stops asking', () => {
  it('names the model, hides the picker, and pins NOTHING on the wire', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/deepseek-chat' })
    await renderBoard(transport)
    await openModal()

    // The model is on screen, so the launch is never a leap of faith...
    expect(query('[data-dsh-ideas-launch-default]')?.textContent).toContain('DeepSeek · Chat')
    // ...and the picker is gone: nothing to choose, nothing to ask.
    expect(query('#dsh-ideas-model')).toBeNull()

    click(query('[data-dsh-ideas-launch-submit]') as HTMLElement)
    await act(async () => { await Promise.resolve() })
    // The request pins no model, so the Host resolves the same default itself.
    expect(transport.launches).toEqual([{ ideaId: 'launchable', model: undefined }])
  })

  it('is per workspace: another workspace\'s default never leaks in', async () => {
    const transport = new FakeTransport({ ws2: 'deepseek/deepseek-chat' })
    await renderBoard(transport)

    await openModal('launchable')
    expect(query('[data-dsh-ideas-launch-default]')).toBeNull()
    expect(query('#dsh-ideas-model')).not.toBeNull()

    await openModal('other-workspace')
    expect(query('[data-dsh-ideas-launch-default]')?.textContent).toContain('DeepSeek · Chat')
  })

  it('names the stored id when the catalog no longer knows the model', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/model-that-left' })
    await renderBoard(transport)
    await openModal()

    // A model the deployment dropped is shown as it is — never silently
    // replaced by another row, and never hidden. The launch itself will refuse
    // loudly (asserted host-side).
    expect(query('[data-dsh-ideas-launch-default]')?.textContent).toContain('deepseek/model-that-left')
    expect(query('#dsh-ideas-model')).toBeNull()
  })
})

describe('setting, changing and forgetting the default', () => {
  it('remembers the picked model for THIS workspace only, and launches nothing', async () => {
    const transport = new FakeTransport({ ws2: 'p/other' })
    await renderBoard(transport)
    await openModal()

    // Pick the model the session default is not, then remember it.
    const modelSelect = query<HTMLSelectElement>('#dsh-ideas-model') as HTMLSelectElement
    await act(async () => {
      modelSelect.value = 'DeepSeek · Chat'
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(query('[data-dsh-ideas-remember-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    expect(transport.saved).toEqual([
      { launchModelByWorkspace: { ws2: 'p/other', ws1: 'deepseek/deepseek-chat' } },
    ])
    // Remembering is not launching: the run is still the author's decision.
    expect(transport.launches).toEqual([])
    // And the modal now shows the stored default instead of the picker.
    expect(query('[data-dsh-ideas-launch-default]')?.textContent).toContain('DeepSeek · Chat')
    expect(query('#dsh-ideas-model')).toBeNull()
  })

  it('offers no remember button until a model is actually picked', async () => {
    const transport = new FakeTransport()
    await renderBoard(transport)
    await openModal()
    // The picker preselects the session's own model, which IS a pick: the
    // button exists and remembers exactly what is selected.
    expect(query('[data-dsh-ideas-remember-default]')).not.toBeNull()
    expect(query<HTMLSelectElement>('#dsh-ideas-model')?.value).toBe('DeepSeek · Reasoner')
  })

  it('reveals the picker over the default, preselected with it', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/deepseek-chat' })
    await renderBoard(transport)
    await openModal()

    click(query('[data-dsh-ideas-change-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    const modelSelect = query<HTMLSelectElement>('#dsh-ideas-model') as HTMLSelectElement
    expect(modelSelect.value).toBe('DeepSeek · Chat')
    // Saving the SAME model is a no-op and says so by being disabled.
    expect((query('[data-dsh-ideas-save-default]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('overrides the default for ONE run without changing what later runs use', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/deepseek-chat' })
    await renderBoard(transport)
    await openModal()
    click(query('[data-dsh-ideas-change-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    const modelSelect = query<HTMLSelectElement>('#dsh-ideas-model') as HTMLSelectElement
    await act(async () => {
      modelSelect.value = 'DeepSeek · Reasoner'
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    click(query('[data-dsh-ideas-launch-submit]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    // Step 1 of the fallback order: an explicit choice rides THIS run only.
    expect(transport.launches).toEqual([{ ideaId: 'launchable', model: 'deepseek/deepseek-reasoner' }])
    expect(transport.saved).toEqual([])
    expect(stored(transport)).toEqual({ ws1: 'deepseek/deepseek-chat' })
  })

  it('saves a changed default and collapses back to the stored line', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/deepseek-chat' })
    await renderBoard(transport)
    await openModal()
    click(query('[data-dsh-ideas-change-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    const modelSelect = query<HTMLSelectElement>('#dsh-ideas-model') as HTMLSelectElement
    await act(async () => {
      modelSelect.value = 'DeepSeek · Reasoner'
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(query('[data-dsh-ideas-save-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    expect(transport.saved).toEqual([
      { launchModelByWorkspace: { ws1: 'deepseek/deepseek-reasoner' } },
    ])
    expect(query('[data-dsh-ideas-launch-default]')?.textContent).toContain('DeepSeek · Reasoner')
    expect(query('#dsh-ideas-model')).toBeNull()
  })

  it('forgets a default, leaving an empty map when it was the last one', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/deepseek-chat' })
    await renderBoard(transport)
    await openModal()

    click(query('[data-dsh-ideas-forget-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    expect(transport.saved).toEqual([{ launchModelByWorkspace: {} }])
    // And the board is exactly the one that predates the feature: it asks again.
    expect(query('[data-dsh-ideas-launch-default]')).toBeNull()
    expect(query('#dsh-ideas-model')).not.toBeNull()
  })

  it('keeps the other workspaces when one is forgotten', async () => {
    const transport = new FakeTransport({ ws1: 'p/one', ws2: 'p/two' })
    await renderBoard(transport)
    await openModal()

    click(query('[data-dsh-ideas-forget-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    expect(transport.saved).toEqual([{ launchModelByWorkspace: { ws2: 'p/two' } }])
  })

  it('offers no forget button on a deployment with no settings surface', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/deepseek-chat' }, { available: false })
    await renderBoard(transport)
    await openModal()

    // The default is still NAMED (the client holds a view it cannot write), but
    // there is nothing to write it with, so the controls stay disabled rather
    // than pretending a save would land.
    expect(query('[data-dsh-ideas-launch-default]')?.textContent).toContain('DeepSeek · Chat')
    expect((query('[data-dsh-ideas-forget-default]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the picker open and shows the reason when a save is refused', async () => {
    const transport = new FakeTransport({ ws1: 'deepseek/deepseek-chat' })
    transport.saveError = 'settings-conflict'
    await renderBoard(transport)
    await openModal()
    click(query('[data-dsh-ideas-change-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    const modelSelect = query<HTMLSelectElement>('#dsh-ideas-model') as HTMLSelectElement
    await act(async () => {
      modelSelect.value = 'DeepSeek · Reasoner'
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(query('[data-dsh-ideas-save-default]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    // A refusal must not collapse the picker the author was editing, and must
    // say why rather than reverting silently.
    expect(query('#dsh-ideas-model')).not.toBeNull()
    expect(host.textContent).toContain('settings-conflict')
    // The stored default is untouched: the board still shows what is stored.
    expect(stored(transport)).toEqual({ ws1: 'deepseek/deepseek-chat' })
  })
})

describe('the reasoning effort selector', () => {
  it('offers the levels the model declares, preselected with its own default', async () => {
    const transport = new FakeTransport()
    await renderBoard(transport, REASONING_CATALOG, cardlessSnapshot())
    await openModal('cardless')

    const effort = query<HTMLSelectElement>('#dsh-ideas-reasoning-effort')
    expect(effort).not.toBeNull()
    // The catalog is the source of truth: exactly the levels it declared, plus
    // the explicit "no effort pinned" row — never a hardcoded list.
    expect(Array.from(effort!.options).map(option => option.value)).toEqual(['', 'low', 'high'])
    // The model's own `defaultEffort` is what the picker preselects.
    expect(effort!.value).toBe('high')
    // The chosen level's description is on screen, so the pick is informed.
    expect(host.textContent).toContain('Slow, thorough')
  })

  it('pins the preselected level on the launch, alongside the model', async () => {
    const transport = new FakeTransport()
    await renderBoard(transport, REASONING_CATALOG, cardlessSnapshot())
    await openModal('cardless')

    click(query('[data-dsh-ideas-launch-submit]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    expect(transport.launches).toEqual([
      { ideaId: 'cardless', model: 'deepseek/deepseek-reasoner', reasoningEffort: 'high' },
    ])
  })

  it('pins the level the human picked over the model default', async () => {
    const transport = new FakeTransport()
    await renderBoard(transport, REASONING_CATALOG, cardlessSnapshot())
    await openModal('cardless')

    const effort = query<HTMLSelectElement>('#dsh-ideas-reasoning-effort') as HTMLSelectElement
    await act(async () => {
      effort.value = 'low'
      effort.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(query('[data-dsh-ideas-launch-submit]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    expect(transport.launches).toEqual([
      { ideaId: 'cardless', model: 'deepseek/deepseek-reasoner', reasoningEffort: 'low' },
    ])
  })

  it('pins nothing when the human leaves the model default in place', async () => {
    const transport = new FakeTransport()
    await renderBoard(transport, REASONING_CATALOG, cardlessSnapshot())
    await openModal('cardless')

    const effort = query<HTMLSelectElement>('#dsh-ideas-reasoning-effort') as HTMLSelectElement
    await act(async () => {
      effort.value = ''
      effort.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(query('[data-dsh-ideas-launch-submit]') as HTMLElement)
    await act(async () => { await Promise.resolve() })

    // No effort on the wire at all: the session keeps the model's own default,
    // rather than the board pinning a level the human never chose.
    expect(transport.launches).toEqual([{ ideaId: 'cardless', model: 'deepseek/deepseek-reasoner' }])
  })

  it('shows no selector for a model that declares no reasoning', async () => {
    const transport = new FakeTransport()
    // The plain catalog carries no `reasoning` on either model.
    await renderBoard(transport, CATALOG, cardlessSnapshot())
    await openModal('cardless')

    expect(query('#dsh-ideas-model')).not.toBeNull()
    expect(query('#dsh-ideas-reasoning-effort')).toBeNull()
  })

  it('shows no selector on a card-backed idea, and pins no level', async () => {
    const transport = new FakeTransport()
    // A reasoning model AND a card: the mirror patch is model-only, so the
    // window must not offer a choice the run could not keep.
    await renderBoard(transport, REASONING_CATALOG, snapshot())
    await openModal('launchable')

    expect(query('#dsh-ideas-model')).not.toBeNull()
    expect(query('#dsh-ideas-reasoning-effort')).toBeNull()

    click(query('[data-dsh-ideas-launch-submit]') as HTMLElement)
    await act(async () => { await Promise.resolve() })
    expect(transport.launches).toEqual([{ ideaId: 'launchable', model: 'deepseek/deepseek-reasoner' }])
  })
})
