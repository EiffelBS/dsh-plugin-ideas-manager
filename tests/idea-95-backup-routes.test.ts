/**
 * The backup route family (idea #95), driven against a real loopback server
 * like the launch-route suite: the browser-signal fence, the method /
 * content-type discipline, the strict bodies, and — the point of the whole
 * family — the ERROR MAPPING. A refused restore is a normal answer carrying the
 * Host's own sentence (409 a run in flight, 404 no such snapshot, 400 an
 * unusable document), never a silent 200 and never a 500.
 *
 * The last test pins the frozen wire: the new surface is ADDITIVE, so the action
 * envelope and the default state response must be exactly what they were.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes } from '../src/host-routes.ts'
import { IDEAS_BACKUP_DIR_NAME } from '../src/backup.ts'
import { IDEAS_API_PREFIX, IDEAS_SCHEMA_VERSION } from '../src/protocol.ts'

let dir = ''
let server: Server | undefined
let service: IdeasHostService | undefined

afterEach(async () => {
  const open = server
  server = undefined
  if (open !== undefined) {
    await new Promise<void>(resolve => { open.close(() => { resolve() }) })
  }
  // Dispose BEFORE rm: the ledger holds its lock file on Windows.
  service?.dispose()
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

async function serve(): Promise<{ base: string; service: IdeasHostService }> {
  dir = join(tmpdir(), `ideas-backup-route-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir })
  service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'First idea', body: 'B', workspaceId: 'ws' } })
  const routes = makeIdeasRoutes(service)
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
  return { base: `http://127.0.0.1:${address.port}`, service }
}

/** `contentType: null` means "send no content-type at all". */
function post(url: string, body: unknown, marker = true, contentType: string | null = 'application/json'): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      ...(contentType === null ? {} : { 'content-type': contentType }),
      ...(marker ? { 'sec-fetch-site': 'same-origin' } : {}),
    },
    body: JSON.stringify(body),
  })
}

const get = (url: string, marker = true): Promise<Response> =>
  fetch(url, { headers: marker ? { 'sec-fetch-site': 'same-origin' } : {} })

const BACKUP = `${IDEAS_API_PREFIX}/backup`
const CONTENT = `${IDEAS_API_PREFIX}/backup/content`
const RESTORE = `${IDEAS_API_PREFIX}/backup/restore`

describe('GET /api/ideas/backup', () => {
  it('serves the folder view and then the snapshot that was taken', async () => {
    const { base, service: host } = await serve()

    const before = await get(`${base}${BACKUP}`)
    expect(before.status).toBe(200)
    const empty = await before.json() as { ok: boolean; dir: string; retention: number; snapshots: unknown[]; running: number }
    expect(empty.ok).toBe(true)
    expect(empty.dir).toBe(join(dir, IDEAS_BACKUP_DIR_NAME))
    expect(empty.retention).toBe(10)
    expect(empty.snapshots).toEqual([])
    expect(empty.running).toBe(0)

    const taken = await post(`${base}${BACKUP}`, {})
    expect(taken.status).toBe(200)
    const body = await taken.json() as { ok: boolean; snapshot: { name: string; reason: string; foreign: boolean }; ideas: number; pruned: number }
    expect(body).toMatchObject({ ok: true, ideas: 1, pruned: 0 })
    expect(body.snapshot.reason).toBe('manual')
    expect(body.snapshot.foreign).toBe(false)

    const after = await (await get(`${base}${BACKUP}`)).json() as { snapshots: Array<{ name: string }>; running: number }
    expect(after.snapshots.map(entry => entry.name)).toEqual([body.snapshot.name])
    host.ledger.setRunStatus('idea-1', 'running')
    expect((await (await get(`${base}${BACKUP}`)).json() as { running: number }).running).toBe(1)
  })

  it('accepts only the export stamp a caller may choose', async () => {
    const { base } = await serve()
    const exported = await (await post(`${base}${BACKUP}`, { reason: 'export' })).json() as { snapshot: { reason: string } }
    expect(exported.snapshot.reason).toBe('export')
    // A caller can never file a displaced ledger as a routine snapshot.
    const forged = await (await post(`${base}${BACKUP}`, { reason: 'pre-restore' })).json() as { snapshot: { reason: string } }
    expect(forged.snapshot.reason).toBe('manual')
  })

  it('keeps the fence and the method discipline', async () => {
    const { base } = await serve()
    expect((await get(`${base}${BACKUP}`, false)).status).toBe(403)
    expect((await post(`${base}${BACKUP}`, {}, false)).status).toBe(403)
    expect((await fetch(`${base}${BACKUP}`, {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    })).status).toBe(405)
    expect((await post(`${base}${BACKUP}`, {}, true, null)).status).toBe(415)
  })
})

describe('GET /api/ideas/backup/content', () => {
  it('serves the snapshot document as a download', async () => {
    const { base } = await serve()
    const taken = await (await post(`${base}${BACKUP}`, { reason: 'export' })).json() as { snapshot: { name: string } }

    const response = await get(`${base}${CONTENT}?name=${taken.snapshot.name}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    // A browser stores the file under its own name, which is what makes the
    // download a restorable document rather than a report.
    expect(response.headers.get('content-disposition')).toContain(`attachment; filename="${taken.snapshot.name}"`)
    const body = await response.text()
    const document = JSON.parse(body) as { schemaVersion: number; ideas: unknown[] }
    expect(document.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    expect(document.ideas).toHaveLength(1)
    // It is the same file the folder holds, byte for byte.
    expect(body).toBe(readFileSync(join(dir, IDEAS_BACKUP_DIR_NAME, taken.snapshot.name), 'utf8'))
  })

  it('refuses a missing name, an unknown snapshot and a traversal', async () => {
    const { base } = await serve()
    expect((await get(`${base}${CONTENT}`)).status).toBe(400)
    expect((await get(`${base}${CONTENT}?name=nope.json`)).status).toBe(404)
    expect((await get(`${base}${CONTENT}?name=${encodeURIComponent('../../ledger-v2.json')}`)).status).toBe(404)
    expect((await post(`${base}${CONTENT}`, {}, true)).status).toBe(405)
  })
})

describe('POST /api/ideas/backup/restore', () => {
  it('restores a snapshot and names the snapshot holding the displaced board', async () => {
    const { base, service: host } = await serve()
    const taken = await (await post(`${base}${BACKUP}`, {})).json() as { snapshot: { name: string } }
    host.apply('create-2', { kind: 'create', id: 'idea-2', input: { title: 'Added later', body: 'B' } })

    const response = await post(`${base}${RESTORE}`, { name: taken.snapshot.name })

    expect(response.status).toBe(200)
    const outcome = await response.json() as { ok: boolean; ideas: number; source: string; displaced: { name: string; reason: string } }
    expect(outcome).toMatchObject({ ok: true, ideas: 1, source: taken.snapshot.name })
    expect(outcome.displaced.reason).toBe('pre-restore')
    expect(host.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1'])
  })

  it('restores an imported document (the portable move between machines)', async () => {
    const { base } = await serve()
    const document = JSON.stringify({
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 9,
      ideaSequence: 4,
      ideas: [{ id: 'foreign', title: 'Elsewhere', body: 'b', status: 'open', createdAt: 1, updatedAt: 1 }],
    })

    const response = await post(`${base}${RESTORE}`, { document })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, ideas: 1, source: 'the imported ledger' })
    expect((await (await get(`${base}${IDEAS_API_PREFIX}/state`)).json() as { ideas: Array<{ id: string }> }).ideas.map(idea => idea.id))
      .toEqual(['foreign'])
  })

  it('answers 409 with the running idea when a run is in flight', async () => {
    const { base, service: host } = await serve()
    const taken = await (await post(`${base}${BACKUP}`, {})).json() as { snapshot: { name: string } }
    host.ledger.setRunStatus('idea-1', 'running')

    const response = await post(`${base}${RESTORE}`, { name: taken.snapshot.name })

    expect(response.status).toBe(409)
    const refusal = await response.json() as { ok: boolean; error: string; message: string; running: Array<{ id: string }> }
    expect(refusal.ok).toBe(false)
    expect(refusal.error).toBe('restore-run-in-flight')
    expect(refusal.message).toContain('First idea')
    expect(refusal.running).toEqual([{ id: 'idea-1', ideaNumber: 1, title: 'First idea' }])
    // Refused means refused: the board did not move.
    expect(host.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1'])
  })

  it('answers 404 for an unknown snapshot and 400 for an unusable document', async () => {
    const { base } = await serve()
    const missing = await post(`${base}${RESTORE}`, { name: 'snapshot-1800000000000-deadbeef.json' })
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: string }).error).toBe('snapshot-not-found')

    const broken = await post(`${base}${RESTORE}`, { document: '{"schemaVersion": 7, "ideas": []}' })
    expect(broken.status).toBe(400)
    const refusal = await broken.json() as { error: string; message: string }
    expect(refusal.error).toBe('snapshot-schema')
    expect(refusal.message).toContain('schema 7')
  })

  it('quarantines a broken snapshot file instead of importing it', async () => {
    const { base } = await serve()
    const taken = await (await post(`${base}${BACKUP}`, {})).json() as { snapshot: { name: string } }
    writeFileSync(join(dir, IDEAS_BACKUP_DIR_NAME, taken.snapshot.name), '{ not json')

    const response = await post(`${base}${RESTORE}`, { name: taken.snapshot.name })

    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toBe('snapshot-unreadable')
    const view = await (await get(`${base}${BACKUP}`)).json() as { snapshots: unknown[] }
    expect(view.snapshots).toEqual([])
  })

  it('keeps the fence, the method, the content-type and the body discipline', async () => {
    const { base } = await serve()
    expect((await post(`${base}${RESTORE}`, { name: 'x.json' }, false)).status).toBe(403)
    expect((await get(`${base}${RESTORE}`)).status).toBe(405)
    expect((await post(`${base}${RESTORE}`, { name: 'x.json' }, true, null)).status).toBe(415)
    for (const body of [{}, { name: '   ' }, { name: 'x.json', document: '{}' }, { nope: 1 }]) {
      expect((await post(`${base}${RESTORE}`, body)).status).toBe(400)
    }
  })

  it('refuses while the plugin is disabled', async () => {
    const { base, service: host } = await serve()
    host.setActive(false)
    const response = await post(`${base}${RESTORE}`, { document: '{"schemaVersion":1,"revision":0,"ideas":[]}' })
    expect(response.status).toBe(409)
    expect((await get(`${base}${BACKUP}`)).status).toBe(409)
  })
})

describe('the frozen wire is untouched', () => {
  it('keeps the action envelope and the default state response exactly as they were', async () => {
    const { base } = await serve()

    // The default full snapshot still answers the three documented keys only.
    const state = await (await get(`${base}${IDEAS_API_PREFIX}/state`)).json() as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])

    // ...and the action envelope still speaks the documented verbs only: the
    // backup surface is a dedicated route, not a new verb.
    const created = await post(`${base}${IDEAS_API_PREFIX}/action`, {
      requestId: 'r1',
      action: { kind: 'create', id: 'idea-3', input: { title: 'T', body: 'B' } },
    })
    expect(created.status).toBe(200)
    expect(Object.keys(await created.json() as Record<string, unknown>).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])
    expect((await post(`${base}${IDEAS_API_PREFIX}/action`, { requestId: 'r2', action: { kind: 'snapshot' } })).status).toBe(400)
    expect((await post(`${base}${IDEAS_API_PREFIX}/action`, { requestId: 'r3', action: { kind: 'restoreSnapshot', name: 'x' } })).status).toBe(400)
  })
})