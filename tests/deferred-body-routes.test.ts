/**
 * Read-projection routes (idea #34) driven against a real loopback server,
 * same discipline as the config-route tests:
 *  - GET /api/ideas/state stays the FULL snapshot by default (the frozen
 *    backup/tooling contract - restore and migration scripts read bodies);
 *  - GET /api/ideas/state?view=list serves the deferred-body projection;
 *  - GET /api/ideas/idea?id= serves ONE full record (the deferred body
 *    behind edit / follow-up / re-analyze);
 *  - the same loopback + browser-signal fence as every other route.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes } from '../src/host-routes.ts'
import {
  BODY_EXCERPT_MAX_LENGTH,
  IDEAS_API_PREFIX,
  IDEAS_SCHEMA_VERSION,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

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
  // an open file) - same discipline as the config-route tests.
  service?.dispose()
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

function freshService(): IdeasHostService {
  dir = join(tmpdir(), `ideas-projection-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir, autoMirror: false })
  return service
}

/** Serve the plugin routes on a real loopback socket (pathname matching,
 *  query stripped - the same rule the DSH webserver applies). */
async function serve(): Promise<string> {
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
  return `http://127.0.0.1:${address.port}`
}

/** Browser fetch with the same-origin marker the fence requires. */
function get(url: string, marker = true): Promise<Response> {
  return fetch(url, { headers: marker ? { 'sec-fetch-site': 'same-origin' } : {} })
}

const LONG_BODY = 'The full analysis with **bold** parts.\n\n'.repeat(200)

/** Two ideas: one plain open card, one archived card carrying an audit. */
async function seed(host: IdeasHostService): Promise<void> {
  host.apply('seed-projection', {
    kind: 'import',
    sourceId: 'projection-fixture',
    ideas: [
      {
        id: 'proj-open',
        title: 'Open card',
        body: LONG_BODY,
        status: 'open',
        rank: 1,
        summary: 'short summary',
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_001,
      },
      {
        id: 'proj-arch',
        title: 'Archived card',
        body: 'Archived body text.',
        status: 'archived',
        rank: 1,
        archivedAt: 1_700_000_002,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_002,
        analysisAudit: { at: 1_700_000_003, title: 'prior title', body: 'prior body' },
      },
    ],
  })
}

describe('GET /api/ideas/state projection', () => {
  it('stays the FULL snapshot by default (frozen backup/tooling contract)', async () => {
    const base = await serve()
    await seed(service!)
    const response = await get(`${base}${IDEAS_API_PREFIX}/state`)
    expect(response.status).toBe(200)
    const payload = await response.json() as IdeasSnapshot
    expect(payload.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    expect(payload.ideas).toHaveLength(2)
    const open = payload.ideas.find(idea => idea.id === 'proj-open') as IdeaRecord
    // The ledger's import gate trims bodies (trailing newlines stripped).
    expect(open.body).toBe(LONG_BODY.trim())
    const archived = payload.ideas.find(idea => idea.id === 'proj-arch') as IdeaRecord
    expect(archived.analysisAudit?.body).toBe('prior body')
  })

  it('serves the deferred-body projection with ?view=list', async () => {
    const base = await serve()
    await seed(service!)
    const response = await get(`${base}${IDEAS_API_PREFIX}/state?view=list`)
    expect(response.status).toBe(200)
    const payload = await response.json() as IdeasSnapshot & { ideas: Array<Record<string, unknown>> }
    expect(payload.revision).toBeGreaterThan(0)
    expect(payload.ideas).toHaveLength(2)
    for (const row of payload.ideas) {
      expect('body' in row).toBe(false)
      expect('analysisAudit' in row).toBe(false)
      expect(typeof row.bodyExcerpt).toBe('string')
      expect((row.bodyExcerpt as string).length).toBeLessThanOrEqual(BODY_EXCERPT_MAX_LENGTH + 1)
    }
    const open = payload.ideas.find(row => row.id === 'proj-open')!
    expect(open.title).toBe('Open card')
    expect(open.summary).toBe('short summary')
    expect(open.rank).toBe(1)
    // Payload sanity: the projection is much smaller than the full snapshot.
    const listBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    expect(listBytes).toBeLessThan(Buffer.byteLength(LONG_BODY, 'utf8') + 4096)
  })

  it('keeps the loopback + browser-signal fence on both views', async () => {
    const base = await serve()
    await seed(service!)
    expect((await get(`${base}${IDEAS_API_PREFIX}/state?view=list`, false)).status).toBe(403)
    expect((await get(`${base}${IDEAS_API_PREFIX}/state`, false)).status).toBe(403)
    expect((await get(`${base}${IDEAS_API_PREFIX}/idea?id=proj-open`, false)).status).toBe(403)
  })
})

describe('GET /api/ideas/idea (deferred body)', () => {
  it('serves ONE full record, deep body included', async () => {
    const base = await serve()
    await seed(service!)
    const response = await get(`${base}${IDEAS_API_PREFIX}/idea?id=${encodeURIComponent('proj-open')}`)
    expect(response.status).toBe(200)
    const record = await response.json() as IdeaRecord
    expect(record.id).toBe('proj-open')
    expect(record.body).toBe(LONG_BODY.trim())
  })

  it('answers 404 for an unknown id, 400 without id, 405 on non-GET', async () => {
    const base = await serve()
    await seed(service!)
    const missing = await get(`${base}${IDEAS_API_PREFIX}/idea?id=nope`)
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: string }).error).toBe('not-found')

    const noId = await get(`${base}${IDEAS_API_PREFIX}/idea`)
    expect(noId.status).toBe(400)
    expect((await noId.json() as { error: string }).error).toBe('id-required')

    const post = await fetch(`${base}${IDEAS_API_PREFIX}/idea?id=proj-open`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(post.status).toBe(405)
  })
})
