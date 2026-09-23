// @vitest-environment jsdom
/**
 * Settings surface tests: the slots registration contract (graceful without
 * a slots registry, correct options with it), the tagRows -> CSS-variable
 * application (clamped, live on config changes), and the section page —
 * explicit title/description copy, disabled state when the deployment has no
 * settings surface, draft-commit-save flow, inline failure + free revert.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { IdeasClient } from '../src/client/ideas-client.ts'
import { IdeasClient as RealIdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  applyTagChipRows,
  IdeasSettingsSection,
  registerIdeasSettingsSection,
  type SettingsSlotsFace,
} from '../src/client/settings-section.tsx'
import { classes } from '../src/client/style.ts'
import { t, fr, en } from '../src/client/locales.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
} from '../src/protocol.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SNAPSHOT: IdeasListSnapshot = { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }

class ConfigTransport implements IdeasHostTransport {
  saved: IdeasSettingsPatch[] = []
  loaded: IdeasSettingsView = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 3 }, revision: 1 }
  failSave: unknown | undefined

  async state(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  async action(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> { return this.loaded }
  async saveConfig(patch: IdeasSettingsPatch, _expectedRevision?: number): Promise<IdeasSettingsView> {
    this.saved.push(patch)
    if (this.failSave !== undefined) throw this.failSave
    // Merge like the real settings service: the fresh view carries the whole
    // value (the section renders it back after a successful save).
    this.loaded = {
      available: true,
      value: { ...this.loaded.value, ...patch },
      revision: (this.loaded.revision ?? 0) + 1,
    }
    return this.loaded
  }
}

function makeClient(transport: ConfigTransport = new ConfigTransport()): IdeasClient {
  return new RealIdeasClient(transport, undefined)
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

describe('applyTagChipRows', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--dsh-ideas-tag-rows')
  })

  it('writes the clamped row budget onto the document', () => {
    applyTagChipRows(3)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('3')
    applyTagChipRows(99)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('5')
    applyTagChipRows(0)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('1')
    applyTagChipRows(Number.NaN)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('3')
  })
})

describe('registerIdeasSettingsSection', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--dsh-ideas-tag-rows')
  })

  it('wires the style even without a slots registry (graceful degradation)', () => {
    const client = makeClient()
    const off = registerIdeasSettingsSection({}, client)
    expect(typeof off).toBe('function')
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('3')
    off()
  })

  it('contains a THROWING slots getter (the undeclared-cordis-service case)', () => {
    // Regression (live bug): an undeclared cordis service getter throws
    // `cannot get property "slots" without inject` instead of returning
    // undefined — the helper must swallow it and keep the style wiring, so a
    // slots surprise can never cost the sidebar entry / board again.
    const originalError = console.error
    const spy = vi.fn()
    console.error = spy
    try {
      const hostile = {
        get slots(): never { throw new Error('cannot get property "slots" without inject') },
      }
      const client = makeClient()
      const off = registerIdeasSettingsSection(hostile, client)
      expect(typeof off).toBe('function')
      expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('3')
      expect(spy).toHaveBeenCalledTimes(1)
      off()
    } finally {
      console.error = originalError
    }
  })

  it('registers the section under the settings.section slot with clear options', () => {
    const client = makeClient()
    const injected = vi.fn(() => ({ client }))
    const register = vi.fn((..._args: unknown[]) => () => {})
    const inject = vi.fn((_name: string, factory: () => unknown) => {
      // The factory must yield the registration (the shell calls it when the
      // slot declaration lands).
      const disposer = factory()
      expect(typeof disposer).toBe('function')
      return () => {}
    })
    const slots: SettingsSlotsFace = { inject, register }
    const off = registerIdeasSettingsSection({ slots }, client)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]![0]).toBe('settings.section')
    expect(register).toHaveBeenCalledTimes(1)
    const [options, component] = register.mock.calls[0]! as unknown as [Record<string, unknown>, unknown]
    expect(options).toMatchObject({ name: 'settings.section', id: 'ideas', order: 60 })
    expect((options.label as () => string)()).toBe(t('settings.nav'))
    expect((options.inject as () => { client: IdeasClient })()).toEqual({ client })
    expect(typeof component).toBe('function')
    expect(typeof off).toBe('function')
    off()
  })

  it('keeps the style subscriber alive across config loads until disposed', async () => {
    const transport = new ConfigTransport()
    transport.loaded = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 5 }, revision: 2 }
    const client = makeClient(transport)
    const off = registerIdeasSettingsSection({}, client)
    await client.loadConfig()
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('5')
    off()
    // After dispose the subscriber no longer pushes updates.
    transport.loaded = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 1 }, revision: 3 }
    await client.loadConfig()
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-rows')).toBe('5')
  })
})

describe('IdeasSettingsSection page', () => {
  let host: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    document.documentElement.style.removeProperty('--dsh-ideas-tag-rows')
  })
  afterEach(() => {
    if (root !== undefined) {
      const mounted = root
      act(() => { mounted.unmount() })
    }
    root = undefined
    host.remove()
  })

  async function render(client: IdeasClient): Promise<void> {
    // Load first: the page renders the LOADED view (available + stored value);
    // the unavailable case configures its own transport view instead.
    await client.loadConfig()
    act(() => {
      root = createRoot(host)
      root.render(<IdeasSettingsSection client={client} />)
    })
  }

  const numberInput = (): HTMLInputElement => host.querySelector(`input.${classes.settingsNumber}`) as HTMLInputElement

  it('renders explicit title, description, range and default copy', async () => {
    await render(makeClient())
    expect(host.querySelector(`.${classes.settingsTitle}`)?.textContent).toBe(t('settings.title'))
    expect(host.querySelector(`.${classes.settingsIntro}`)?.textContent).toBe(t('settings.intro'))
    expect(host.querySelector(`.${classes.settingsRowTitle}`)?.textContent).toBe(t('settings.tagRows'))
    const desc = host.querySelector(`.${classes.settingsRowDesc}`)?.textContent ?? ''
    // The description must spell the range and the default (copy discipline).
    expect(desc).toContain('1')
    expect(desc).toContain('5')
    expect(desc).toContain('3')
    const input = numberInput()
    expect(input.value).toBe('3')
    expect(input.min).toBe('1')
    expect(input.max).toBe('5')
    expect(input.disabled).toBe(false)
    expect(host.querySelector(`.${classes.settingsNote}`)).toBeNull()
  })

  it('disables the control and explains when no settings surface exists', async () => {
    const transport = new ConfigTransport()
    // The deployment answers available:false (no settings service).
    transport.loaded = { available: false, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 3 } }
    const client = makeClient(transport)
    await render(client)
    expect(numberInput().disabled).toBe(true)
    expect(host.querySelector(`.${classes.settingsNote}`)?.textContent).toBe(t('settings.unavailable'))
  })

  it('commits the draft on Enter, saves clamped, and shows the fresh value', async () => {
    const transport = new ConfigTransport()
    const client = makeClient(transport)
    await render(client)
    const input = numberInput()
    await act(async () => {
      setNativeValue(input, '99')
      pressEnter(input)
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.saved).toEqual([{ tagRows: 5 }])
    expect(numberInput().value).toBe('5')
    expect(host.querySelector(`.${classes.settingsError}`)).toBeNull()
  })

  it('reverts to the stored value and shows the inline error on a failed save', async () => {
    const transport = new ConfigTransport()
    transport.failSave = new Error('settings-conflict')
    const client = makeClient(transport)
    await render(client)
    const input = numberInput()
    await act(async () => {
      setNativeValue(input, '5')
      pressEnter(input)
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    // Free revert: the stored value never moved.
    expect(numberInput().value).toBe('3')
    expect(host.querySelector(`.${classes.settingsError}`)?.textContent).toBe(t('settings.conflict'))
  })

  it('ships the settings copy in both locales', () => {
    for (const key of [
      'settings.nav', 'settings.title', 'settings.intro', 'settings.group',
      'settings.tagRows', 'settings.tagRowsDesc', 'settings.loading',
      'settings.unavailable', 'settings.saveFailed', 'settings.conflict',
      'settings.groupBehavior', 'settings.defaultTab', 'settings.defaultTabDesc',
      'settings.renderMarkdown', 'settings.renderMarkdownDesc',
      'settings.rememberScope', 'settings.rememberScopeDesc',
      'settings.confirmLifecycle', 'settings.confirmLifecycleDesc',
      'settings.hideDeclined', 'settings.hideDeclinedDesc',
      'settings.cardDensity', 'settings.cardDensityDesc',
      'settings.densityComfortable', 'settings.densityCompact',
      'card.confirmLifecycle',
    ] as const) {
      expect(typeof fr[key]).toBe('string')
      expect(typeof en[key]).toBe('string')
      expect(fr[key]).not.toBe('')
      expect(en[key]).not.toBe('')
    }
    // Vocabulary discipline: the EN copy says "tags", never the design jargon.
    expect(en['settings.tagRowsDesc']).toContain('rows of tags')
    expect(en['settings.tagRowsDesc']).not.toContain('chips')
  })

  it('renders both groups with every option row and its control', async () => {
    await render(makeClient())
    const groups = Array.from(host.querySelectorAll(`.${classes.settingsGroup}`))
    expect(groups.map(node => node.textContent)).toEqual([t('settings.group'), t('settings.groupBehavior')])
    const titles = Array.from(host.querySelectorAll(`.${classes.settingsRowTitle}`)).map(node => node.textContent)
    expect(titles).toEqual([
      t('settings.tagRows'),
      t('settings.cardDensity'),
      t('settings.renderMarkdown'),
      t('settings.defaultTab'),
      t('settings.rememberScope'),
      t('settings.confirmLifecycle'),
      t('settings.hideDeclined'),
    ])
    // One number row, two selects (density + open tab), four toggle switches.
    expect(host.querySelectorAll(`.${classes.settingsNumber}`)).toHaveLength(1)
    expect(host.querySelectorAll(`.${classes.settingsSelect}`)).toHaveLength(2)
    const checks = Array.from(host.querySelectorAll(`.${classes.settingsToggle}`)) as HTMLInputElement[]
    expect(checks.map(box => box.checked)).toEqual([true, false, false, false])
    for (const toggle of checks) {
      const heading = toggle.parentElement
      expect(heading?.classList.contains(classes.settingsRowHeading)).toBe(true)
      expect(heading?.querySelector(`.${classes.settingsRowTitle}`)).not.toBeNull()
      expect(heading?.nextElementSibling?.classList.contains(classes.settingsRowDesc)).toBe(true)
    }
  })

  it('saves a boolean option immediately on toggle', async () => {
    const transport = new ConfigTransport()
    const client = makeClient(transport)
    await render(client)
    const checks = Array.from(host.querySelectorAll(`.${classes.settingsToggle}`)) as HTMLInputElement[]
    // rememberScope (second switch) is off by default; toggle it ON.
    await act(async () => {
      checks[1]!.click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.saved).toEqual([{ rememberWorkspaceScope: true }])
    expect((Array.from(host.querySelectorAll(`.${classes.settingsToggle}`)) as HTMLInputElement[])[1]!.checked).toBe(true)
  })

  it('saves the card density select on change', async () => {
    const transport = new ConfigTransport()
    const client = makeClient(transport)
    await render(client)
    const selects = Array.from(host.querySelectorAll(`.${classes.settingsSelect}`)) as HTMLSelectElement[]
    expect(selects[0]!.value).toBe('comfortable')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(selects[0], 'compact')
      selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.saved).toEqual([{ cardDensity: 'compact' }])
    const fresh = host.querySelector(`.${classes.settingsSelect}`) as HTMLSelectElement
    expect(fresh.value).toBe('compact')
  })
})
