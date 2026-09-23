// @vitest-environment jsdom
/**
 * Board gear -> DSH Settings modal, section selection (0.4.0 fix).
 *
 * Reported in review: with the interface language pinned to French or
 * Chinese, the gear only OPENED the modal without selecting the Ideas
 * section, while English worked. Cause: the host resolves our `label()` thunk
 * when it builds the dialog, so the rendered nav row can carry the BOOT
 * language while the panel renders in the PINNED one - and the lookup
 * compared the row against the current label only.
 *
 * These tests drive the real board: a fake host trigger (aria-haspopup +
 * aria-label) opens a fake dialog whose nav row text is pinned per scenario,
 * and the row records whether it got selected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { classes } from '../src/client/style.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasEventPayload,
  type IdeasLanguage,
  type IdeasListSnapshot,
  type IdeasSettingsView,
} from '../src/protocol.ts'
import { en, setLanguageOverride } from '../src/client/locales.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const EMPTY: IdeasListSnapshot = { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }

class GearTransport implements IdeasHostTransport {
  constructor(public language: IdeasLanguage) {}
  async state(): Promise<IdeasListSnapshot> { return EMPTY }
  async action(): Promise<IdeasListSnapshot> { return EMPTY }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> {
    return { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, language: this.language }, revision: 1 }
  }
}

let host: HTMLDivElement
let root: Root | undefined
let trigger: HTMLButtonElement
let dialog: HTMLElement
let selected = 0
let triggerClicks = 0

/** Fake host chrome: a Settings trigger that opens a dialog with one nav row
 *  carrying `rowLabel` (the label the HOST would have rendered). */
function mountHostChrome(rowLabel: string): void {
  trigger = document.createElement('button')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-label', 'Settings')
  trigger.addEventListener('click', () => {
    triggerClicks += 1
    dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = document.createElement('nav')
    const row = document.createElement('button')
    row.textContent = rowLabel
    row.addEventListener('click', () => { selected += 1 })
    nav.append(row)
    dialog.append(nav)
    document.body.append(dialog)
  })
  document.body.append(trigger)
}

async function renderBoard(language: IdeasLanguage): Promise<void> {
  const client = new IdeasClient(new GearTransport(language), undefined)
  client.snapshot = EMPTY
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
  // Click the BOARD gear: it is the code under test - it finds the host
  // trigger, clicks it, then selects our nav row in the opened dialog.
  const gear = host.querySelector(`.${classes.settingsGear}`) as HTMLButtonElement
  expect(gear).not.toBeNull()
  await act(async () => { gear.click() })
  // The real handler polls with requestAnimationFrame until the row appears.
  for (let i = 0; i < 10 && selected === 0; i++) {
    await act(async () => { await new Promise(requestAnimationFrame) })
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
  selected = 0
  triggerClicks = 0
  setLanguageOverride('auto')
})
afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  dialog?.remove()
  dialog = undefined as unknown as HTMLElement
  trigger.remove()
  host.remove()
  setLanguageOverride('auto')
})

describe('board gear opens the Settings modal on the Ideas section in every language', () => {
  it('selects the section when the row label matches the current language (English)', async () => {
    mountHostChrome(en['settings.nav'])
    await renderBoard('en')
    expect(triggerClicks).toBe(1)
    expect(selected).toBe(1)
  })

  it('selects the section when the row kept the BOOT language and the interface is French', async () => {
    // The host built the dialog before the user pinned fr: the row says
    // "Ideas board" while the panel now renders French.
    mountHostChrome(en['settings.nav'])
    await renderBoard('fr')
    expect(triggerClicks).toBe(1)
    expect(selected).toBe(1)
  })

  it('selects the section when the row kept the BOOT language and the interface is Chinese', async () => {
    mountHostChrome(en['settings.nav'])
    await renderBoard('zh')
    expect(triggerClicks).toBe(1)
    expect(selected).toBe(1)
  })

  it('also matches a row rendered in the pinned language (both sides agree)', async () => {
    mountHostChrome('想法看板')
    await renderBoard('zh')
    expect(selected).toBe(1)
  })

  it('still degrades gracefully when the row is missing (modal opens, warn only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mountHostChrome('Some other plugin section')
      await renderBoard('fr')
      // A real 800 ms deadline is too slow for a test: the loop above gives up
      // after 10 frames, which is the same graceful outcome (no crash, no
      // selection) the user sees when the host moved the markup.
      expect(triggerClicks).toBe(1)
      expect(selected).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })
})
