/**
 * Contract-detection tests for createIdeasConfigPort — the double path that
 * keeps the Settings section working on both host generations:
 *
 *  - 0.1.5-like host: the settings service carries `register`; the legacy
 *    namespace path runs exactly as in 0.3.3 (register / describe / update
 *    keyed by namespace) and no plugin-owned document is ever touched;
 *  - 0.1.7-like host: the SettingsForms refactor left the service WITHOUT
 *    `register`; nothing from the refactored contract may be called, the port
 *    falls back to the plugin-owned versioned document, and boot logs stay
 *    clean (no "settings namespace registration failed").
 *
 * The revision fence of the fallback port is exercised end to end here (the
 * HTTP mapping of a stale revision lives in settings-routes.test.ts).
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdeasConfigPort, IDEAS_SETTINGS_NAMESPACE } from '../src/host-settings.ts'
import { IDEAS_SETTINGS_DEFAULTS } from '../src/protocol.ts'

let dir = ''

afterEach(() => {
  vi.restoreAllMocks()
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

/** Scratch document path for one test. */
function scratch(): string {
  dir = join(tmpdir(), `ideas-settings-wiring-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'ideas-manager-settings.json')
}

/** 0.1.5-like service: legacy namespace API, recording every call. */
function legacyHost(descriptor?: { ns: string; value: unknown; revision: number }): {
  settings: unknown
  registerCalls: Array<{ ns: string; applies: unknown }>
  updateCalls: Array<{ ns: string; patch: unknown; expectedRevision: number | undefined }>
  describeCalls: Array<unknown>
} {
  const registerCalls: Array<{ ns: string; applies: unknown }> = []
  const updateCalls: Array<{ ns: string; patch: unknown; expectedRevision: number | undefined }> = []
  const describeCalls: Array<unknown> = []
  const settings = {
    register: (ns: string, _schema: unknown, options?: { applies?: unknown }): void => {
      registerCalls.push({ ns, applies: options?.applies })
    },
    describe: (options: unknown): Array<{ ns: string; value: unknown; revision: number }> => {
      describeCalls.push(options)
      return descriptor === undefined ? [] : [descriptor]
    },
    update: async (ns: string, patch: object, expectedRevision?: number): Promise<void> => {
      updateCalls.push({ ns, patch, expectedRevision })
    },
  }
  return { settings, registerCalls, updateCalls, describeCalls }
}

/** 0.1.7-like service: SettingsForms without `register`; any call is a bug. */
function refactorHost(): { settings: unknown; touched: string[] } {
  const touched: string[] = []
  const settings = {
    // The refactored contract: present, but with a different shape. The
    // plugin must not call any of it (forms derive from its Config schema).
    describe: (): never => { touched.push('describe'); throw new Error('describe must not be called') },
    update: (): Promise<never> => { touched.push('update'); return Promise.reject(new Error('update must not be called')) },
    replace: (): Promise<never> => { touched.push('replace'); return Promise.reject(new Error('replace must not be called')) },
    configure: (): (() => void) => { touched.push('configure'); return () => {} },
    writable: true,
  }
  return { settings, touched }
}

describe('0.1.5-like host (settings.register present)', () => {
  it('registers the legacy namespace and reads/writes through it, never touching a plugin file', async () => {
    const file = scratch()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = legacyHost({ ns: IDEAS_SETTINGS_NAMESPACE, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 4 }, revision: 3 })

    const port = createIdeasConfigPort(host.settings, { file })
    expect(port).toBeDefined()
    expect(host.registerCalls).toEqual([{ ns: 'ideas', applies: 'live' }])
    expect(error).not.toHaveBeenCalled()

    // Read: descriptor keyed by .ns, value sanitized, revision carried.
    expect(port?.read()).toEqual({
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 4 },
      revision: 3,
    })

    // Write: namespace-keyed update with the caller's fence, then a fresh view.
    const view = await port?.write({ tagRows: 2 }, 3)
    expect(host.updateCalls).toEqual([{ ns: 'ideas', patch: { tagRows: 2 }, expectedRevision: 3 }])
    expect(view).toEqual({ available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 4 }, revision: 3 })

    // Strictly identical behaviour on 0.1.5: no plugin-owned document exists.
    expect(existsSync(file)).toBe(false)
  })

  it('serves the defaults while the namespace holds no descriptor', () => {
    scratch()
    const port = createIdeasConfigPort(legacyHost().settings)
    expect(port?.read()).toEqual({ available: true, value: IDEAS_SETTINGS_DEFAULTS })
  })

  it('keeps the port unset when registration fails, logging the historical message', () => {
    const file = scratch()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settings = { register: (): never => { throw new Error('corrupt stored section') } }

    expect(createIdeasConfigPort(settings, { file })).toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toBe('[dsh-plugin-ideas-manager] settings namespace registration failed')
    expect(existsSync(file)).toBe(false)
  })
})

describe('0.1.7-like host (SettingsForms, no register)', () => {
  it('falls back to the plugin-owned document and never calls the refactored contract', async () => {
    const file = scratch()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = refactorHost()

    const port = createIdeasConfigPort(host.settings, { file })
    expect(port).toBeDefined()
    // Boot log clean: the 0.1.7 regression was exactly this line.
    expect(error).not.toHaveBeenCalled()

    // Reads answer with the defaults until the first write (no document yet).
    expect(port?.read()).toEqual({ available: true, value: IDEAS_SETTINGS_DEFAULTS })

    const written = await port?.write({ tagRows: 5 }, undefined)
    expect(written).toEqual({ available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 5 }, revision: 1 })
    expect(port?.read()).toEqual(written)
    expect(existsSync(file)).toBe(true)

    // Nothing from the refactored service was touched.
    expect(host.touched).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it('enforces the revision fence across two readers of the same document', async () => {
    const file = scratch()
    const port = createIdeasConfigPort(refactorHost().settings, { file })
    expect(port).toBeDefined()

    await port?.write({ tagRows: 3 }, undefined) // revision 1
    const readerA = port?.read()
    const readerB = port?.read()
    expect(readerA?.revision).toBe(1)
    expect(readerB?.revision).toBe(1)

    // First writer wins: the document moves to revision 2.
    const first = await port?.write({ tagRows: 4 }, readerA?.revision)
    expect(first?.revision).toBe(2)

    // Second writer still holds revision 1: refused with the coded conflict,
    // and the document keeps the first writer's value.
    await expect(port?.write({ tagRows: 5 }, readerB?.revision)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
    const after = port?.read()
    expect(after?.revision).toBe(2)
    expect(after?.value.tagRows).toBe(4)
  })
})

describe('contract detection', () => {
  it('answers no port for a deployment without a settings service', () => {
    scratch()
    expect(createIdeasConfigPort(undefined)).toBeUndefined()
    expect(createIdeasConfigPort(null)).toBeUndefined()
  })

  it('treats a non-function register as the refactored contract', async () => {
    const file = scratch()
    const settings = { register: undefined, describe: undefined }
    const port = createIdeasConfigPort(settings, { file })
    expect(port).toBeDefined()
    expect(port?.read().available).toBe(true)
    await expect(port?.write({ confirmLifecycle: true }, undefined)).resolves.toMatchObject({ revision: 1 })
  })
})
