/**
 * Additive sync routes: explicit confirmation, strict package validation, normal
 * refusal mapping, and the frozen state/action wire contract.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes } from '../src/host-routes.ts'
import { IDEAS_API_PREFIX } from '../src/protocol.ts'
import { IDEAS_SYNC_FORMAT, IDEAS_SYNC_VERSION, type IdeasSyncPackage } from '../src/sync.ts'

let dir = ''
let server: Server | undefined
let service: IdeasHostService | undefined

afterEach(async () => {
  const open = server
  server = undefined
  if (open !== undefined) await new Promise<void>(resolve => { open.close(() => { resolve() }) })
  service?.dispose()
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

async function serve(): Promise<{ base: string; service: IdeasHostService; workspaceId: string }> {
  dir = join(tmpdir(), `ideas-sync-route-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir })
  const workspaceId = randomUUID()
  service.apply('create-1', {
    kind: 'create',
    id: 'idea-1',
    input: { title: 'First idea', body: 'B', workspaceId },
  })
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
  return { base: `http://127.0.0.1:${address.port}`, service, workspaceId }
}

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

const SYNC = `${IDEAS_API_PREFIX}/sync`
const WORKSPACES = `${SYNC}/workspaces`
const EXPORT = `${SYNC}/export`
const PLAN = `${SYNC}/plan`
const IMPORT = `${SYNC}/import`

function foreignPackage(syncKey = 'sync_foreign1'): IdeasSyncPackage {
  return {
    format: IDEAS_SYNC_FORMAT,
    version: IDEAS_SYNC_VERSION,
    deviceId: 'device-foreign',
    snapshotId: 'snapshot-foreign',
    baseSnapshotId: null,
    createdAt: 1,
    workspace: { syncKey, sourceWorkspaceId: 'workspace-foreign' },
    ideas: [{ id: 'foreign', title: 'Foreign', body: 'B', status: 'open', createdAt: 1, updatedAt: 1 }],
  }
}

describe('GET /api/ideas/sync', () => {
  it('lists known workspaces without inventing a mapping', async () => {
    const { base, workspaceId } = await serve()
    const response = await get(`${base}${SYNC}`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      ok: boolean
      deviceId: string
      workspaces: Array<{ workspaceId: string; ideaCount: number; confirmed: boolean; syncKey?: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.deviceId).not.toBe('')
    expect(body.workspaces).toEqual([{ workspaceId, ideaCount: 1, confirmed: false }])
  })

  it('keeps the fence and method discipline', async () => {
    const { base } = await serve()
    expect((await get(`${base}${SYNC}`, false)).status).toBe(403)
    expect((await post(`${base}${SYNC}`, {})).status).toBe(405)
  })
})

describe('POST /api/ideas/sync/workspaces', () => {
  it('requires literal confirmation, then mints and persists a key', async () => {
    const { base, workspaceId } = await serve()
    expect((await post(`${base}${WORKSPACES}`, { workspaceId })).status).toBe(400)
    expect((await post(`${base}${WORKSPACES}`, { workspaceId, confirm: false })).status).toBe(400)
    const emptyWorkspace = randomUUID()
    const empty = await post(`${base}${WORKSPACES}`, { workspaceId: emptyWorkspace, confirm: true })
    expect(empty.status).toBe(200)
    expect((await empty.json() as { mapping: { workspaceId: string } }).mapping.workspaceId).toBe(emptyWorkspace)

    const response = await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; mapping: { syncKey: string; workspaceId: string; baseSnapshotId: null } }
    expect(body.ok).toBe(true)
    expect(body.mapping.workspaceId).toBe(workspaceId)
    expect(body.mapping.syncKey).toMatch(/^sync_[0-9a-f-]{36}$/)
    expect(body.mapping.baseSnapshotId).toBeNull()

    const overview = await (await get(`${base}${SYNC}`)).json() as { workspaces: Array<{ workspaceId: string; confirmed: boolean; syncKey: string }> }
    expect(overview.workspaces.find(row => row.workspaceId === workspaceId)).toMatchObject({ confirmed: true, syncKey: body.mapping.syncKey })
    expect(overview.workspaces.find(row => row.workspaceId === emptyWorkspace)).toMatchObject({ confirmed: true, ideaCount: 0 })
  })

  it('replaces an existing key only through an explicit replaceExisting confirmation', async () => {
    const { base, workspaceId } = await serve()
    await post(`${base}${WORKSPACES}`, { workspaceId, syncKey: 'sync_existing', confirm: true })
    const refused = await post(`${base}${WORKSPACES}`, { workspaceId, syncKey: 'sync_incoming', confirm: true })
    expect(refused.status).toBe(409)
    expect((await refused.json() as { error: string }).error).toBe('sync-workspace-conflict')
    expect((await post(`${base}${WORKSPACES}`, {
      workspaceId, syncKey: 'sync_incoming', confirm: true, replaceExisting: 'true',
    })).status).toBe(400)
    const replaced = await post(`${base}${WORKSPACES}`, {
      workspaceId, syncKey: 'sync_incoming', confirm: true, replaceExisting: true,
    })
    expect(replaced.status).toBe(200)
    const body = await replaced.json() as { ok: boolean; mapping: { syncKey: string; baseSnapshotId: null; snapshots: unknown[] } }
    expect(body).toMatchObject({ ok: true, mapping: { syncKey: 'sync_incoming', baseSnapshotId: null, snapshots: [] } })
    const overview = await (await get(`${base}${SYNC}`)).json() as { workspaces: Array<{ workspaceId: string; syncKey: string }> }
    expect(overview.workspaces.find(row => row.workspaceId === workspaceId)?.syncKey).toBe('sync_incoming')
  })

  it('keeps the fence, method, content-type and body discipline', async () => {
    const { base, workspaceId } = await serve()
    expect((await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true }, false)).status).toBe(403)
    expect((await get(`${base}${WORKSPACES}`)).status).toBe(405)
    expect((await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true }, true, null)).status).toBe(415)
    expect((await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true, extra: 1 })).status).toBe(400)
  })
})

describe('POST /api/ideas/sync/plan', () => {
  it('plans without writing, reports explicit conflicts, and applies only resolved decisions', async () => {
    const { base, service: host, workspaceId } = await serve()
    await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true })
    const pkg = (await (await post(`${base}${EXPORT}`, { workspaceId })).json() as { package: IdeasSyncPackage }).package
    pkg.ideas[0]!.title = 'Different title'
    const before = host.snapshot()
    const response = await post(`${base}${PLAN}`, { package: pkg })
    expect(response.status).toBe(200)
    const planned = await response.json() as { ok: boolean; plan: { ready: boolean; mode: string; conflicts: Array<{ conflictId: string }> } }
    expect(planned.ok).toBe(true)
    expect(planned.plan.mode).toBe('two-way')
    expect(planned.plan.ready).toBe(false)
    expect(planned.plan.conflicts.length).toBeGreaterThan(0)
    expect(host.snapshot()).toEqual(before)

    const unresolved = await post(`${base}${IMPORT}`, { package: pkg })
    expect(unresolved.status).toBe(409)
    const refusal = await unresolved.json() as { error: string; plan: { conflicts: Array<{ conflictId: string }> } }
    expect(refusal.error).toBe('sync-idea-conflict')
    expect(refusal.plan.conflicts.length).toBeGreaterThan(0)
    expect(host.snapshot()).toEqual(before)
    const resolutions = refusal.plan.conflicts.map(conflict => ({ conflictId: conflict.conflictId, choice: 'local' }))
    const applied = await post(`${base}${IMPORT}`, { package: pkg, resolutions })
    expect(applied.status).toBe(200)
    expect(host.snapshot().ideas[0]?.title).toBe('First idea')
  })

  it('keeps the fence and strict body discipline', async () => {
    const { base, workspaceId } = await serve()
    expect((await post(`${base}${PLAN}`, { package: foreignPackage() }, false)).status).toBe(403)
    expect((await get(`${base}${PLAN}`)).status).toBe(405)
    expect((await post(`${base}${PLAN}`, { package: foreignPackage() }, true, null)).status).toBe(415)
    expect((await post(`${base}${PLAN}`, { package: foreignPackage(), extra: true })).status).toBe(400)
    expect((await post(`${base}${PLAN}`, {
      package: foreignPackage(),
      resolutions: [{ conflictId: 'one', choice: 'local' }, { conflictId: 'one', choice: 'remote' }],
    })).status).toBe(400)
    await post(`${base}${WORKSPACES}`, { workspaceId, syncKey: 'sync_foreign1', confirm: true })
    const unknown = await post(`${base}${IMPORT}`, {
      package: foreignPackage(),
      resolutions: [{ conflictId: 'not-a-conflict', choice: 'local' }],
    })
    expect(unknown.status).toBe(409)
    expect((await unknown.json() as { error: string }).error).toBe('sync-resolution-invalid')
  })
})

describe('POST /api/ideas/sync/export and /api/ideas/sync/import', () => {
  it('refuses export until the workspace is confirmed, then round-trips its own package', async () => {
    const { base, workspaceId } = await serve()
    expect((await post(`${base}${EXPORT}`, { workspaceId })).status).toBe(409)

    const mapped = await (await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true })).json() as {
      mapping: { syncKey: string }
    }
    const exported = await post(`${base}${EXPORT}`, { workspaceId })
    expect(exported.status).toBe(200)
    const pkg = (await exported.json() as { ok: boolean; package: IdeasSyncPackage }).package
    expect(pkg.workspace.syncKey).toBe(mapped.mapping.syncKey)
    expect(pkg.ideas.map(idea => idea.id)).toEqual(['idea-1'])
    expect(pkg.ideas[0]).not.toHaveProperty('ideaNumber')
    expect(pkg.ideas[0]).not.toHaveProperty('workspaceId')

    const imported = await post(`${base}${IMPORT}`, { package: pkg })
    expect(imported.status).toBe(200)
    const importedBody = await imported.json() as { ok: boolean; imported: number; skipped: number; displaced?: Record<string, unknown> }
    expect(importedBody).toMatchObject({ ok: true, imported: 0, skipped: 1 })
    expect(importedBody.displaced).toBeDefined()
    expect(importedBody.displaced).not.toHaveProperty('path')
  })

  it('refuses an unconfirmed package and a package carrying live execution fields', async () => {
    const { base, workspaceId } = await serve()
    const unconfirmed = await post(`${base}${IMPORT}`, { package: foreignPackage() })
    expect(unconfirmed.status).toBe(409)
    expect((await unconfirmed.json() as { error: string }).error).toBe('sync-workspace-unconfirmed')

    await post(`${base}${WORKSPACES}`, { workspaceId, syncKey: 'sync_foreign1', confirm: true })
    const pkg = foreignPackage()
    pkg.ideas[0] = { ...pkg.ideas[0]!, runStatus: 'running', runSessionId: 'session-foreign' } as typeof pkg.ideas[number]
    const invalid = await post(`${base}${IMPORT}`, { package: pkg })
    expect(invalid.status).toBe(400)
    expect((await invalid.json() as { error: string }).error).toBe('invalid-sync-package')
  })

  it('keeps the fence, method, content-type and strict-body discipline', async () => {
    const { base, workspaceId } = await serve()
    expect((await post(`${base}${EXPORT}`, { workspaceId }, false)).status).toBe(403)
    expect((await get(`${base}${EXPORT}`)).status).toBe(405)
    expect((await post(`${base}${EXPORT}`, { workspaceId }, true, null)).status).toBe(415)
    expect((await post(`${base}${EXPORT}`, { workspaceId, extra: 1 })).status).toBe(400)
    expect((await post(`${base}${IMPORT}`, {}, false)).status).toBe(403)
    expect((await get(`${base}${IMPORT}`)).status).toBe(405)
    expect((await post(`${base}${IMPORT}`, {}, true, null)).status).toBe(415)
    expect((await post(`${base}${IMPORT}`, { package: foreignPackage(), extra: 1 })).status).toBe(400)
  })

  it('refuses every sync operation while the plugin is disabled', async () => {
    const { base, service: host, workspaceId } = await serve()
    host.setActive(false)
    expect((await get(`${base}${SYNC}`)).status).toBe(409)
    expect((await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true })).status).toBe(409)
    expect((await post(`${base}${EXPORT}`, { workspaceId })).status).toBe(409)
    expect((await post(`${base}${PLAN}`, { package: foreignPackage() })).status).toBe(409)
    expect((await post(`${base}${IMPORT}`, { package: foreignPackage() })).status).toBe(409)
  })
})

describe('preview revision fence', () => {
  it('rejects a stale preview and apply without writing a snapshot or changing the board', async () => {
    const { base, service: host, workspaceId } = await serve()
    await post(`${base}${WORKSPACES}`, { workspaceId, confirm: true })
    const pkg = (await (await post(`${base}${EXPORT}`, { workspaceId })).json() as { package: IdeasSyncPackage }).package
    pkg.ideas[0]!.title = 'Incoming title'
    const preview = await post(`${base}${PLAN}`, { package: pkg })
    expect(preview.status).toBe(200)
    const planned = await preview.json() as { revision: number; plan: { ready: boolean; conflicts: Array<{ conflictId: string }> } }
    expect(planned.revision).toBe(host.snapshot().revision)

    host.apply('after-preview', {
      kind: 'create',
      id: 'idea-after-preview',
      input: { title: 'Created after preview', body: 'B', workspaceId },
    })
    const before = host.snapshot()
    const snapshotsBefore = host.ledger.snapshots().map(snapshot => snapshot.name)

    const stalePlan = await post(`${base}${PLAN}`, { package: pkg, expectedRevision: planned.revision })
    expect(stalePlan.status).toBe(409)
    expect((await stalePlan.json() as { error: string }).error).toBe('sync-preview-stale')

    const resolutions = planned.plan.conflicts.map(conflict => ({ conflictId: conflict.conflictId, choice: 'remote' }))
    const staleApply = await post(`${base}${IMPORT}`, { package: pkg, resolutions, expectedRevision: planned.revision })
    expect(staleApply.status).toBe(409)
    expect((await staleApply.json() as { error: string }).error).toBe('sync-preview-stale')
    expect(host.snapshot()).toEqual(before)
    expect(host.ledger.snapshots().map(snapshot => snapshot.name)).toEqual(snapshotsBefore)
  })

  it('rejects a malformed revision fence', async () => {
    const { base } = await serve()
    for (const expectedRevision of [-1, 1.5, '1']) {
      const response = await post(`${base}${PLAN}`, { package: foreignPackage(), expectedRevision })
      expect(response.status).toBe(400)
    }
  })
})

describe('the frozen wire remains unchanged', () => {
  it('does not add keys to state/action responses or verbs to the action envelope', async () => {
    const { base } = await serve()
    const state = await (await get(`${base}${IDEAS_API_PREFIX}/state`)).json() as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])

    const created = await post(`${base}${IDEAS_API_PREFIX}/action`, {
      requestId: 'r1',
      action: { kind: 'create', id: 'idea-2', input: { title: 'T', body: 'B' } },
    })
    expect(created.status).toBe(200)
    expect(Object.keys(await created.json() as Record<string, unknown>).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])
    expect((await post(`${base}${IDEAS_API_PREFIX}/action`, {
      requestId: 'r2',
      action: { kind: 'syncExport', workspaceId: 'workspace-a' },
    })).status).toBe(400)
    expect((await post(`${base}${IDEAS_API_PREFIX}/action`, {
      requestId: 'r3',
      action: { kind: 'confirmSyncKey', workspaceId: 'workspace-a' },
    })).status).toBe(400)
  })
})
