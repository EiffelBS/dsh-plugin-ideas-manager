/**
 * Browser-signal tripwire regression tests (the DSH Desktop shell 403).
 *
 * The official DSH Desktop shell serves the Web GUI from `dsh-app://app/` and
 * re-issues the page's Host requests itself: `forwardWebRequest` deletes
 * `host`, `origin`, `cookie` and `sec-fetch-site` from the forwarded headers
 * and then attaches the Host's own browser-auth cookie. A request that arrives
 * with NEITHER `origin` NOR `sec-fetch-site` used to be refused outright, so
 * every `/api/ideas*` route answered `403 {"ok":false,"error":"forbidden"}`
 * inside the desktop app while working in a plain browser - the panel renders
 * that as its hostError ("Host operation failed: forbidden").
 *
 * The credential the shell attaches is the browser signal instead: a marker-less
 * request that still carries it is the desktop shell, a marker-less
 * credential-less request stays refused. The authority checks (loopback socket
 * + loopback Host + cross-site refusal) are unchanged and are covered here too.
 *
 * Case 1 is the fix; cases 2-4 and 6 are the reasons it is not a hole; case 5
 * is the pre-existing browser path that must keep working.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { isTrustedIdeasRequest, makeIdeasRoutes } from '../src/host-routes.ts'
import { IDEAS_API_PREFIX } from '../src/protocol.ts'

const STATE = `${IDEAS_API_PREFIX}/state?view=list`
const HOST_AUTH_COOKIE = 'dsh-auth-x=1'

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
  // an open file) - same discipline as the other route tests.
  service?.dispose()
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

function freshService(): IdeasHostService {
  dir = join(tmpdir(), `ideas-browser-auth-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir, autoMirror: false })
  return service
}

/**
 * Serve the plugin routes on a real loopback socket (pathname matching, query
 * stripped - the same rule the DSH webserver applies). Every ideas route goes
 * through the single fence in makeIdeasRoutes, so /state stands in for the
 * whole /api/ideas* family.
 */
async function serve(): Promise<number> {
  const routes = makeIdeasRoutes(freshService())
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
  return address.port
}

/**
 * Raw node:http GET, so the test can set `Cookie` and override `Host` exactly
 * like the desktop shell's forwarded request does (undici's fetch treats both
 * as forbidden header names).
 */
function get(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = httpRequest({ host: '127.0.0.1', port, path: STATE, method: 'GET', headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    call.on('error', reject)
    call.end()
  })
}

/** A synthetic IncomingMessage, for the socket half a loopback server cannot produce. */
function fakeRequest(headers: Record<string, string>, remoteAddress: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('browser same-origin marker (DSH Desktop shell)', () => {
  it('trusts a marker-less request that carries the Host browser-auth cookie', async () => {
    const port = await serve()
    const response = await get(port, { cookie: HOST_AUTH_COOKIE })
    expect(response.status).toBe(200)
  })

  it('trusts the cookie wherever it sits in the jar', async () => {
    const port = await serve()
    const response = await get(port, { cookie: `theme=dark; ${HOST_AUTH_COOKIE}; lang=en` })
    expect(response.status).toBe(200)
  })

  it('still refuses a marker-less and credential-less request', async () => {
    const port = await serve()
    const response = await get(port, {})
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: 'forbidden' })
  })

  it('still refuses an unrelated cookie', async () => {
    const port = await serve()
    const response = await get(port, { cookie: 'session=1' })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: 'forbidden' })
  })

  it('still refuses a cross-site request even with the Host credential', async () => {
    const port = await serve()
    const response = await get(port, { cookie: HOST_AUTH_COOKIE, 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
  })

  it('keeps the plain-browser path: a same-origin Origin on the Host authority', async () => {
    const port = await serve()
    const response = await get(port, { origin: `http://127.0.0.1:${port}` })
    expect(response.status).toBe(200)
  })

  it('keeps the authority checks under the new marker', async () => {
    const port = await serve()
    // Non-loopback Host authority, credential and markers both present.
    const response = await get(port, { host: 'evil.example.com', cookie: HOST_AUTH_COOKIE, 'sec-fetch-site': 'same-origin' })
    expect(response.status).toBe(403)

    // A remote socket cannot be produced by a loopback server, so the
    // remoteAddress half is asserted on the fence directly.
    expect(isTrustedIdeasRequest(fakeRequest({ host: `127.0.0.1:${port}`, cookie: HOST_AUTH_COOKIE }, '203.0.113.7'))).toBe(false)
    expect(isTrustedIdeasRequest(fakeRequest({ host: `127.0.0.1:${port}`, cookie: HOST_AUTH_COOKIE, 'sec-fetch-site': 'same-origin' }, '203.0.113.7'))).toBe(false)
    // Loopback socket, non-loopback Host authority.
    expect(isTrustedIdeasRequest(fakeRequest({ host: 'evil.example.com', cookie: HOST_AUTH_COOKIE }, '127.0.0.1'))).toBe(false)
    // And the desktop-shell shape itself stays trusted.
    expect(isTrustedIdeasRequest(fakeRequest({ host: `127.0.0.1:${port}`, cookie: HOST_AUTH_COOKIE }, '127.0.0.1'))).toBe(true)
  })

  it('refuses the cookie when the Origin names another authority', async () => {
    const port = await serve()
    const response = await get(port, { origin: 'http://evil.example.com', cookie: HOST_AUTH_COOKIE })
    expect(response.status).toBe(403)
  })
})
