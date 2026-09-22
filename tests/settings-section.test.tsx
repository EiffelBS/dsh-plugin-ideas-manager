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
  type IdeasEventPayload,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
  type IdeasSnapshot,
} from '../src/protocol.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SNAPSHOT: IdeasSnapshot = { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }

class ConfigTransport implements IdeasHostTransport {
  saved: IdeasSettingsPatch[] = []
  loaded: IdeasSettingsView = { available: true, value: { tagRows: 3 }, revision: 1 }
  failSave: unknown | undefined

  async state(): Promise<IdeasSnapshot> { return SNAPSHOT }
  async action(): Promise<IdeasSnapshot> { return SNAPSHOT }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> { return this.loaded }
  async saveConfig(patch: IdeasSettingsPatch, _expectedRevision?: number): Promise<IdeasSettingsView> {
    this.saved.push(patch)
    if (this.failSave !== undefined) throw this.failSave
    this.loaded = { available: true, value: { tagRows: patch.tagRows ?? 3 }, revision: this.loaded.revision! + 1 }
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
    document.documentElement.style.removeProperty('--dsh-ideas-tag-chip-rows')
  })

  it('writes the clamped row budget onto the document', () => {
    applyTagChipRows(3)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-chip-rows')).toBe('3')
    applyTagChipRows(99)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-chip-rows')).toBe('5')
    applyTagChipRows(0)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-chip-rows')).toBe('1')
    applyTagChipRows(Number.NaN)
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-chip-rows')).toBe('3')
  })
})

describe('registerIdeasSettingsSection', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--dsh-ideas-tag-chip-rows')
  })

  it('wires the style even without a slots registry (graceful degradation)', () => {
    const client = makeClient()
    const off = registerIdeasSettingsSection({}, client)
    expect(typeof off).toBe('function')
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-chip-rows')).toBe('3')
    off()
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
    expect(options).toMatchObject({ name: 'settings.section', id: 'ideas', order: 200 })
    expect((options.label as () => string)()).toBe(t('settings.nav'))
    expect((options.inject as () => { client: IdeasClient })()).toEqual({ client })
    expect(typeof component).toBe('function')
    expect(typeof off).toBe('function')
    off()
  })

  it('keeps the style subscriber alive across config loads until disposed', async () => {
    const transport = new ConfigTransport()
    transport.loaded = { available: true, value: { tagRows: 5 }, revision: 2 }
    const client = makeClient(transport)
    const off = registerIdeasSettingsSection({}, client)
    await client.loadConfig()
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-chip-rows')).toBe('5')
    off()
    // After dispose the subscriber no longer pushes updates.
    transport.loaded = { available: true, value: { tagRows: 1 }, revision: 3 }
    await client.loadConfig()
    expect(document.documentElement.style.getPropertyValue('--dsh-ideas-tag-chip-rows')).toBe('5')
  })
})

describe('IdeasSettingsSection page', () => {
  let host: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    document.documentElement.style.removeProperty('--dsh-ideas-tag-chip-rows')
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
    transport.loaded = { available: false, value: { tagRows: 3 } }
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
    ] as const) {
      expect(typeof fr[key]).toBe('string')
      expect(typeof en[key]).toBe('string')
      expect(fr[key]).not.toBe('')
      expect(en[key]).not.toBe('')
    }
  })
})
