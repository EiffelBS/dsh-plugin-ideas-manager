/**
 * Display-settings client tests: the graceful-degradation ladder (capability
 * absent / load failure / unavailable -> spelled defaults, never a throw),
 * the revision-fenced save, and configError surfacing for the settings row.
 */

import { describe, expect, it, vi } from 'vitest'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SETTINGS_DEFAULTS,
  IDEAS_SCHEMA_VERSION,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsView,
} from '../src/protocol.ts'

const SNAPSHOT: IdeasListSnapshot = { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }

/** Transport WITH the optional config capability (records every call). */
class ConfigTransport implements IdeasHostTransport {
  configCalls = 0
  saved: Array<{ patch: { tagRows?: number }; expectedRevision: number | undefined }> = []
  loaded: IdeasSettingsView = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 5 }, revision: 2 }
  saved_view: IdeasSettingsView | undefined
  failLoad: unknown | undefined
  failSave: unknown | undefined

  async state(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  async action(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }

  async config(): Promise<IdeasSettingsView> {
    this.configCalls += 1
    if (this.failLoad !== undefined) throw this.failLoad
    return this.loaded
  }

  async saveConfig(patch: { tagRows?: number }, expectedRevision?: number): Promise<IdeasSettingsView> {
    this.saved.push({ patch, expectedRevision })
    if (this.failSave !== undefined) throw this.failSave
    this.saved_view = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: patch.tagRows ?? IDEAS_SETTINGS_DEFAULTS.tagRows },
      revision: (this.loaded.revision ?? 0) + 1,
    }
    return this.saved_view
  }
}

/** Transport WITHOUT the optional capability (pre-config Host / other fakes). */
class LegacyTransport implements IdeasHostTransport {
  async state(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  async action(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
}

describe('IdeasClient display settings', () => {
  it('adopts the loaded view and notifies subscribers', async () => {
    const transport = new ConfigTransport()
    const client = new IdeasClient(transport, undefined)
    const listener = vi.fn()
    client.subscribe(listener)
    expect(client.configLoaded).toBe(false)
    await client.loadConfig()
    expect(transport.configCalls).toBe(1)
    expect(client.configLoaded).toBe(true)
    expect(client.config.available).toBe(true)
    expect(client.config.value.tagRows).toBe(5)
    expect(client.config.revision).toBe(2)
    expect(listener).toHaveBeenCalled()
  })

  it('marks the load as settled even without the capability (board apply-once guard)', async () => {
    const client = new IdeasClient(new LegacyTransport(), undefined)
    expect(client.configLoaded).toBe(false)
    await client.loadConfig()
    expect(client.configLoaded).toBe(true)
    expect(client.config.available).toBe(false)
  })

  it('start() loads the config alongside the initial refresh', async () => {
    const transport = new ConfigTransport()
    const client = new IdeasClient(transport, undefined)
    client.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.configCalls).toBe(1)
    client.dispose()
  })

  it('keeps the spelled defaults when the transport lacks the capability', async () => {
    const client = new IdeasClient(new LegacyTransport(), undefined)
    await client.loadConfig()
    expect(client.config).toEqual({ available: false, value: IDEAS_SETTINGS_DEFAULTS })
    // A save attempt degrades to the localized wire code, never a throw.
    await client.saveConfig({ tagRows: 5 })
    expect(client.configError).toBe('settings-unavailable')
    expect(client.config.value.tagRows).toBe(IDEAS_SETTINGS_DEFAULTS.tagRows)
  })

  it('keeps the spelled defaults when the load fails (older Host, fence, ...)', async () => {
    const transport = new ConfigTransport()
    transport.failLoad = new Error('ideas request failed: 404')
    const client = new IdeasClient(transport, undefined)
    await expect(client.loadConfig()).resolves.toBeUndefined()
    expect(client.config).toEqual({ available: false, value: IDEAS_SETTINGS_DEFAULTS })
    expect(client.configError).toBeUndefined()
  })

  it('saves with the view revision fence and adopts the fresh view', async () => {
    const transport = new ConfigTransport()
    const client = new IdeasClient(transport, undefined)
    await client.loadConfig()
    await client.saveConfig({ tagRows: 4 })
    expect(transport.saved).toEqual([{ patch: { tagRows: 4 }, expectedRevision: 2 }])
    expect(client.config.value.tagRows).toBe(4)
    expect(client.config.revision).toBe(3)
    expect(client.configError).toBeUndefined()
    expect(client.configPending).toBe(false)
  })

  it('surfaces a failed save as configError and keeps the stored value', async () => {
    const transport = new ConfigTransport()
    transport.failSave = new Error('settings-conflict')
    const client = new IdeasClient(transport, undefined)
    await client.loadConfig()
    await client.saveConfig({ tagRows: 2 })
    expect(client.configError).toBe('settings-conflict')
    // The value never moved: the settings row reverts for free.
    expect(client.config.value.tagRows).toBe(5)
    expect(client.configPending).toBe(false)
  })

  it('refuses to save while the deployment reports no settings surface', async () => {
    const transport = new ConfigTransport()
    const client = new IdeasClient(transport, undefined)
    // Before any load: available is false by default.
    await client.saveConfig({ tagRows: 2 })
    expect(transport.saved).toHaveLength(0)
    expect(client.configError).toBe('settings-unavailable')
  })
})
