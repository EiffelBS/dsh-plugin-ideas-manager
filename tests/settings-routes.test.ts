/**
 * Config route tests (GET/POST /api/ideas/config) driven against a real
 * loopback server, same discipline as the task-board bridge tests: the
 * browser-signal + loopback fence, always-answer reads (available:false
 * without the settings face), clamped writes through the port with the
 * revision fence, the 409 settings-conflict mapping, and the strict parser
 * errors (400/413/415/405).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes, type IdeasConfigPort } from '../src/host-routes.ts'
import { IdeasSettingsStore } from '../src/host-settings.ts'
import {
  IDEAS_API_PREFIX,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasSettingsView,
} from '../src/protocol.ts'

let dir = ''
let server: Server | undefined
let service: IdeasHostService | undefined

afterEach(async () => {
  const openServer = server
  server = undefined
  if (openServer !== undefined) {
    await new Promise<void>(resolve => { openServer.close(() => { resolve() }) })
  }
  // Dispose BEFORE rm: the ledger holds its lock file (Windows cannot delete
  // an open file) — same discipline as the host-ledger tests.
  service?.dispose()
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

function freshService(): IdeasHostService {
  dir = join(tmpdir(), `ideas-config-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir, autoMirror: false })
  return service
}

/** Serve the plugin routes on a real loopback socket. */
async function serve(configPort?: () => IdeasConfigPort | undefined): Promise<string> {
  const routes = makeIdeasRoutes(freshService(), configPort)
  const open = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void Promise.resolve(route.handler(req as IncomingMessage, res as ServerResponse)).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => { open.listen(0, '127.0.0.1', () => { resolve() }) })
  server = open
  const address = open.address()
  if (address === null || typeof address === 'string') throw new Error('no listen address')
  return `http://127.0.0.1:${address.port}`
}

/** Browser fetch with the same-origin marker the fence requires. */
function get(url: string, marker: boolean): Promise<Response> {
  return fetch(url, { headers: marker ? { 'sec-fetch-site': 'same-origin' } : {} })
}

function post(url: string, body: unknown, marker = true): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(marker ? { 'sec-fetch-site': 'same-origin' } : {}) },
    body: JSON.stringify(body),
  })
}

/** In-memory port recording the writes (optionally throwing a coded error). */
function fakePort(fail?: 'conflict', stored?: { tagRows: number }): { port: IdeasConfigPort; writes: Array<{ patch: { tagRows?: number }; expectedRevision: number | undefined }> } {
  const writes: Array<{ patch: { tagRows?: number }; expectedRevision: number | undefined }> = []
  const current = stored ?? { tagRows: 3 }
  const view = (revision: number): IdeasSettingsView => ({
    available: true,
    value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: current.tagRows },
    revision,
  })
  const port: IdeasConfigPort = {
    read: () => view(4),
    write: async (patch, expectedRevision) => {
      writes.push({ patch, expectedRevision })
      if (fail === 'conflict') {
        const error = new Error('namespace moved')
        ;(error as { code?: string }).code = 'SETTINGS_CONFLICT'
        throw error
      }
      if (patch.tagRows !== undefined) current.tagRows = patch.tagRows
      return view(5)
    },
  }
  return { port, writes }
}

describe('GET /api/ideas/config', () => {
  it('refuses a request without a browser same-origin marker', async () => {
    const base = await serve()
    const response = await get(`${base}${IDEAS_API_PREFIX}/config`, false)
    expect(response.status).toBe(403)
  })

  it('answers available:false with the spelled defaults when no settings face exists', async () => {
    const base = await serve()
    const response = await get(`${base}${IDEAS_API_PREFIX}/config`, true)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ available: false, value: IDEAS_SETTINGS_DEFAULTS })
  })

  it('serves the registered view (value + revision fence)', async () => {
    const { port } = fakePort(undefined, { tagRows: 5 })
    const base = await serve(() => port)
    const response = await get(`${base}${IDEAS_API_PREFIX}/config`, true)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 5 },
      revision: 4,
    })
  })

  it('rejects other methods with 405', async () => {
    const base = await serve()
    const response = await fetch(`${base}${IDEAS_API_PREFIX}/config`, {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(response.status).toBe(405)
  })
})

describe('POST /api/ideas/config', () => {
  it('clamps the write and carries the revision fence to the port', async () => {
    const { port, writes } = fakePort()
    const base = await serve(() => port)
    const response = await post(`${base}${IDEAS_API_PREFIX}/config`, { patch: { tagRows: 99 }, expectedRevision: 4 })
    expect(response.status).toBe(200)
    expect(writes).toEqual([{ patch: { tagRows: 5 }, expectedRevision: 4 }])
    expect(await response.json()).toEqual({
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 5 },
      revision: 5,
    })
  })

  it('reports 503 settings-unavailable without a settings face', async () => {
    const base = await serve()
    const response = await post(`${base}${IDEAS_API_PREFIX}/config`, { patch: { tagRows: 2 } })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'settings-unavailable' })
  })

  it('maps a stale-revision refusal to 409 settings-conflict', async () => {
    const { port } = fakePort('conflict')
    const base = await serve(() => port)
    const response = await post(`${base}${IDEAS_API_PREFIX}/config`, { patch: { tagRows: 2 }, expectedRevision: 1 })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: 'settings-conflict' })
  })

  it('rejects a malformed patch with 400 invalid-patch', async () => {
    const { port } = fakePort()
    const base = await serve(() => port)
    for (const body of [{ patch: { tagRows: '4' } }, { patch: { nope: 1 } }, { patch: {}, extra: true }, 'x']) {
      const response = await post(`${base}${IDEAS_API_PREFIX}/config`, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, error: 'invalid-patch' })
    }
  })

  it('requires a JSON content type (415) and stays behind the fence (403)', async () => {
    const base = await serve()
    const noType = await fetch(`${base}${IDEAS_API_PREFIX}/config`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: 'patch',
    })
    expect(noType.status).toBe(415)
    const fenced = await fetch(`${base}${IDEAS_API_PREFIX}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: {} }),
    })
    expect(fenced.status).toBe(403)
  })
})

describe('POST /api/ideas/config against the plugin-owned store (0.1.7 path)', () => {
  it('serves the store revision over HTTP and maps a stale one to 409 settings-conflict', async () => {
    const storeFile = join(tmpdir(), `ideas-config-store-${process.pid}-${randomUUID()}.json`)
    const port = new IdeasSettingsStore({ file: storeFile })
    try {
      const base = await serve(() => port)

      // No document yet: defaults, no fence, still editable.
      const initial = await get(`${base}${IDEAS_API_PREFIX}/config`, true)
      expect(initial.status).toBe(200)
      expect(await initial.json()).toEqual({ available: true, value: IDEAS_SETTINGS_DEFAULTS })

      // First write creates the document (revision 1) through the wire.
      const first = await post(`${base}${IDEAS_API_PREFIX}/config`, { patch: { tagRows: 5 } })
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({
        available: true,
        value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 5 },
        revision: 1,
      })

      // A writer still holding a stale view is refused with the 409 code.
      const stale = await post(`${base}${IDEAS_API_PREFIX}/config`, { patch: { tagRows: 2 }, expectedRevision: 0 })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toEqual({ ok: false, error: 'settings-conflict' })
      expect(port.read().value.tagRows).toBe(5)

      // The current revision writes through.
      const current = await post(`${base}${IDEAS_API_PREFIX}/config`, { patch: { tagRows: 2 }, expectedRevision: 1 })
      expect(current.status).toBe(200)
      expect(await current.json()).toMatchObject({ revision: 2, value: { tagRows: 2 } })
    } finally {
      try { rmSync(storeFile, { force: true }) } catch {
        // Best-effort cleanup.
      }
    }
  })
})
