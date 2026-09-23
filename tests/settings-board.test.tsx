// @vitest-environment jsdom
/**
 * Board settings-application tests: the values pushed by the first config
 * load drive the board — the compact-density attribute on the root, the tab
 * opened at start, the remembered workspace scope, the Declined column
 * visibility, the markdown default and the in-place lifecycle confirmation
 * (the settings lot: defaultTab / renderMarkdown / rememberScope /
 * confirmLifecycle / hideDeclinedColumn / cardDensity). Defaults must change
 * NOTHING (every option falls back to today's behaviour).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { classes } from '../src/client/style.ts'
import { t } from '../src/client/locales.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  toListSnapshot,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsView,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function idea(partial: Partial<IdeaRecord> & { id: string; status: IdeaRecord['status'] }): IdeaRecord {
  return { title: partial.id, body: '', createdAt: 1, updatedAt: 1, ...partial }
}

/** One open + one declined card (ws1/ws2) + one archived card (ws1). */
function testSnapshot(): IdeasSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      idea({ id: 'open-ws1', title: 'Open one', status: 'open', workspaceId: 'ws1', tags: [{ name: 'alpha' }] }),
      idea({ id: 'open-ws2', title: 'Open two', status: 'open', workspaceId: 'ws2' }),
      idea({ id: 'arch-ws1', title: 'Archived one', status: 'archived', archivedAt: 10, workspaceId: 'ws1' }),
      idea({ id: 'decl-ws1', title: 'Declined one', status: 'declined', archivedAt: 20, workspaceId: 'ws1' }),
    ],
  }
}

/** Transport with the optional config capability; records lifecycle actions.
 *  Serves the LIST projection and the per-idea deferred body like the real
 *  transport (idea #34). */
class ConfigTransport implements IdeasHostTransport {
  actions: IdeasAction[] = []
  loaded: IdeasSettingsView = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS }, revision: 1 }

  async state(): Promise<IdeasListSnapshot> { return toListSnapshot(testSnapshot()) }
  async action(action: IdeasAction): Promise<IdeasListSnapshot> {
    this.actions.push(action)
    return toListSnapshot(testSnapshot())
  }
  async idea(id: string): Promise<IdeaRecord> {
    const found = testSnapshot().ideas.find(record => record.id === id)
    if (found === undefined) throw new Error('not-found')
    return found
  }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> { return this.loaded }
  async saveConfig(patch: Record<string, unknown>): Promise<IdeasSettingsView> {
    this.loaded = {
      available: true,
      value: { ...this.loaded.value, ...patch } as IdeasSettingsView['value'],
      revision: (this.loaded.revision ?? 0) + 1,
    }
    return this.loaded
  }
}

let host: HTMLDivElement
let root: Root | undefined

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

/** Mount the board with a snapshot, then settle the config load. */
async function renderBoard(transport: ConfigTransport): Promise<IdeasClient> {
  const client = new IdeasClient(transport, undefined)
  client.snapshot = toListSnapshot(testSnapshot())
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => {
    await client.loadConfig()
  })
  return client
}

const boardRoot = (): HTMLElement => host.querySelector(`.${classes.board}`) as HTMLElement
const tabButtons = (): HTMLElement[] => Array.from(host.querySelectorAll('[role="tab"]'))
const columns = (): HTMLElement[] => Array.from(host.querySelectorAll(`section.${classes.column}`))
/** Exact-text button lookup: an `includes('Deliver')` would also match the
 *  "Delivered" TAB button and click the wrong element. */
const buttonByText = (text: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button'))
    .find(button => (button.textContent ?? '').trim() === text)

describe('board settings application', () => {
  it('defaults change nothing: no density attribute, Overview open, four columns', async () => {
    await renderBoard(new ConfigTransport())
    expect(boardRoot().hasAttribute('data-dsh-ideas-density')).toBe(false)
    expect(tabButtons()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(columns()).toHaveLength(4)
    expect(host.querySelector(`.${classes.confirmLabel}`)).toBeNull()
  })

  it('applies the compact card density from the settings value', async () => {
    const transport = new ConfigTransport()
    transport.loaded = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, cardDensity: 'compact' },
      revision: 1,
    }
    await renderBoard(transport)
    expect(boardRoot().getAttribute('data-dsh-ideas-density')).toBe('compact')
  })

  it('opens the configured tab at start (option defaultTab)', async () => {
    const transport = new ConfigTransport()
    transport.loaded = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, defaultTab: 'delivered' },
      revision: 1,
    }
    await renderBoard(transport)
    const tabs = tabButtons()
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false')
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('[data-dsh-ideas-delivered]')).not.toBeNull()
  })

  it('restores the remembered workspace scope (option rememberWorkspaceScope)', async () => {
    const transport = new ConfigTransport()
    transport.loaded = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, rememberWorkspaceScope: true, workspaceScope: 'ws1' },
      revision: 1,
    }
    await renderBoard(transport)
    const scope = host.querySelector(`.${classes.workspaceSelect}`) as HTMLSelectElement
    expect(scope.value).toBe('ws1')
    // Only the ws1 card title renders (titles live in the card's clickable
    // div, not a <button> — query the whole board text).
    expect(host.textContent ?? '').toContain('Open one')
    expect(host.textContent ?? '').not.toContain('Open two')
  })

  it('persists a scope change while the option is on', async () => {
    const transport = new ConfigTransport()
    transport.loaded = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, rememberWorkspaceScope: true },
      revision: 1,
    }
    await renderBoard(transport)
    const scope = host.querySelector(`.${classes.workspaceSelect}`) as HTMLSelectElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(scope, 'ws2')
      scope.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    const last = transport.loaded
    expect(last.value.workspaceScope).toBe('ws2')
  })

  it('hides the Declined column when hideDeclinedColumn is on', async () => {
    const transport = new ConfigTransport()
    transport.loaded = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, hideDeclinedColumn: true },
      revision: 1,
    }
    await renderBoard(transport)
    // Open / Under review / Archived — the Declined section is gone.
    expect(columns()).toHaveLength(3)
    expect(buttonByText(t('card.decline'))).toBeDefined() // the action stays
  })

  it('asks for an in-place confirmation before Deliver when confirmLifecycle is on', async () => {
    const transport = new ConfigTransport()
    transport.loaded = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, confirmLifecycle: true },
      revision: 1,
    }
    await renderBoard(transport)
    const deliver = buttonByText(t('card.deliver'))
    expect(deliver).toBeDefined()
    // First click arms the confirmation; nothing is delivered yet.
    await act(async () => {
      (deliver as HTMLElement).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.actions).toHaveLength(0)
    expect(host.querySelector(`.${classes.confirmLabel}`)?.textContent).toBe(t('card.confirmLifecycle'))
    // Yes runs the verb (the action promise is flushed by the sleep).
    await act(async () => {
      (buttonByText(t('card.deleteYes')) as HTMLElement).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.actions).toHaveLength(1)
    expect(transport.actions[0]).toMatchObject({ kind: 'deliver' })
    expect(host.querySelector(`.${classes.confirmLabel}`)).toBeNull()
  })

  it('delivers in one click when the confirmation option is off (default)', async () => {
    const transport = new ConfigTransport()
    await renderBoard(transport)
    await act(async () => {
      (buttonByText(t('card.deliver')) as HTMLElement).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.actions).toHaveLength(1)
    expect(transport.actions[0]).toMatchObject({ kind: 'deliver' })
    expect(host.querySelector(`.${classes.confirmLabel}`)).toBeNull()
  })
})

describe('settings gear navigation (header)', () => {
  const gearButton = (): HTMLButtonElement | undefined =>
    host.querySelector(`.${classes.settingsGear}`) as HTMLButtonElement | null ?? undefined

  it('renders an icon-only gear button with the localized label', async () => {
    await renderBoard(new ConfigTransport())
    const gear = gearButton()
    expect(gear).toBeDefined()
    expect(gear?.getAttribute('aria-label')).toBe(t('board.settings'))
    expect(gear?.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it('clicks the nav row of an already-open settings dialog directly', async () => {
    await renderBoard(new ConfigTransport())
    // Simulate the host Settings modal already open on another section:
    // a role=dialog with a nav rail whose rows are plain buttons.
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = document.createElement('nav')
    const otherRow = document.createElement('button')
    otherRow.type = 'button'
    otherRow.textContent = 'Other section'
    const ourRow = document.createElement('button')
    ourRow.type = 'button'
    ourRow.textContent = t('settings.nav')
    let clicked = 0
    ourRow.addEventListener('click', () => { clicked++ })
    nav.append(otherRow, ourRow)
    dialog.appendChild(nav)
    document.body.appendChild(dialog)
    try {
      await act(async () => {
        gearButton()!.click()
        await new Promise(resolve => { setTimeout(resolve, 0) })
      })
      expect(clicked).toBe(1)
    } finally {
      dialog.remove()
    }
  })

  it('clicks the host trigger and selects our section once the dialog renders', async () => {
    await renderBoard(new ConfigTransport())
    // Simulate the closed host: only the settings trigger exists. The
    // dialog commits on a later frame (React), like the real shell.
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-label', 'Settings')
    let opened = false
    let rowClicked = 0
    trigger.addEventListener('click', () => {
      opened = true
      requestAnimationFrame(() => {
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        const nav = document.createElement('nav')
        const row = document.createElement('button')
        row.type = 'button'
        row.textContent = t('settings.nav')
        row.addEventListener('click', () => { rowClicked++ })
        nav.appendChild(row)
        dialog.appendChild(nav)
        document.body.appendChild(dialog)
      })
    })
    document.body.appendChild(trigger)
    try {
      await act(async () => {
        gearButton()!.click()
        // Let the rAF chain run (dialog commit, then the polling select).
        await new Promise(resolve => { setTimeout(resolve, 100) })
      })
      expect(opened).toBe(true)
      expect(rowClicked).toBe(1)
    } finally {
      trigger.remove()
      document.body.querySelector('[role="dialog"]')?.remove()
    }
  })

  it('warns gracefully when neither hook matches (trigger label moved)', async () => {
    await renderBoard(new ConfigTransport())
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => { warnings.push(String(message)) }
    try {
      await act(async () => {
        gearButton()!.click()
        await new Promise(resolve => { setTimeout(resolve, 0) })
      })
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some(text => text.includes('settings trigger not found'))).toBe(true)
  })
})
