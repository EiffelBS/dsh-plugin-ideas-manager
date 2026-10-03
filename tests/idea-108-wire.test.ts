/**
 * Virtualization changes nothing on the wire (idea #108).
 *
 * Windowing is a client concern: the board decides which cards to mount, the
 * Host never hears about it. The strongest proof is not a timing measurement
 * but a structural one - the same route serving the same bytes - so this suite
 * drives a REAL loopback Host, exactly like `idea-95-backup-routes.test.ts`,
 * and pins what a virtualized board must not move:
 *
 *  - the default (full) `GET /api/ideas/state` still answers exactly
 *    `{schemaVersion, revision, ideas}` with full bodies;
 *  - the `POST /api/ideas/action` envelope is still strictly `{requestId,
 *    action, initiator}` and still speaks the documented verbs only - no
 *    `virtualize`, no `window`, no `viewport`;
 *  - `import` / `export` round-trip every field the ledger holds, which is
 *    asserted rather than assumed: idea #108 added nothing to `IdeaRecord`, and
 *    a future field that forgot the round trip would have to break THIS.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes } from '../src/host-routes.ts'
import { IDEAS_API_PREFIX, IDEAS_SCHEMA_VERSION } from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

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
  try {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup.
  }
  dir = ''
})

let dir = ''

async function serve(): Promise<{ base: string; service: IdeasHostService }> {
  dir = join(tmpdir(), `ideas-108-wire-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir })
  service.apply('seed-1', {
    kind: 'create',
    id: 'idea-1',
    input: {
      title: 'First idea',
      body: 'A body the full snapshot must still carry in full.',
      workspaceId: 'ws',
      tags: [{ name: 'perf' }],
    },
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
  return { base: `http://127.0.0.1:${address.port}`, service }
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  })
}

const get = (url: string): Promise<Response> =>
  fetch(url, { headers: { 'sec-fetch-site': 'same-origin' } })

describe('the frozen wire is untouched by windowing', () => {
  it('keeps the action envelope and the default state response exactly as they were', async () => {
    const { base } = await serve()

    // The default full snapshot still answers the three documented keys only,
    // and still carries the whole body - the list projection that a windowed
    // board polls with is opt-in and never the default.
    const state = await (await get(`${base}${IDEAS_API_PREFIX}/state`)).json() as {
      schemaVersion: number
      revision: number
      ideas: Array<IdeaRecord & { bodyExcerpt?: string }>
    }
    expect(Object.keys(state).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])
    expect(state.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    expect(state.ideas[0]!.body).toBe('A body the full snapshot must still carry in full.')
    expect(state.ideas[0]!.bodyExcerpt, 'the default response grew a projection field').toBeUndefined()

    // No new verb: windowing is not something an agent can ask the Host for.
    for (const kind of ['virtualize', 'window', 'viewport', 'setWindow']) {
      const refused = await post(`${base}${IDEAS_API_PREFIX}/action`, {
        requestId: `r-${kind}`,
        action: { kind, ideaId: 'idea-1' },
      })
      expect(refused.status, `${kind} was accepted as a verb`).toBe(400)
    }

    // The envelope is still exactly three keys.
    const extraKey = await post(`${base}${IDEAS_API_PREFIX}/action`, {
      requestId: 'r-extra',
      action: { kind: 'create', id: 'idea-2', input: { title: 'T', body: 'B' } },
      window: { start: 0, end: 20 },
    })
    expect(extraKey.status, 'the envelope accepted a fourth key').toBe(400)

    // ...and the documented verbs still work, answering the same envelope.
    const created = await post(`${base}${IDEAS_API_PREFIX}/action`, {
      requestId: 'r-ok',
      action: { kind: 'create', id: 'idea-3', input: { title: 'T', body: 'B' } },
    })
    expect(created.status).toBe(200)
    expect(Object.keys(await created.json() as Record<string, unknown>).sort())
      .toEqual(['ideas', 'revision', 'schemaVersion'])
  })

  it('round-trips every ledger field through import, because windowing added none', async () => {
    const { base, service: host } = await serve()

    // A record carrying every field the ledger holds, which is what an export /
    // import pair has to bring back.
    const full: IdeaRecord = {
      id: 'idea-full',
      ideaNumber: 99,
      title: 'Everything at once',
      body: 'B',
      summary: 'S',
      status: 'archived',
      createdAt: 1_000,
      updatedAt: 2_000,
      rank: 3,
      value: 4,
      effort: 2,
      rationale: 'because',
      tags: [{ name: 'perf', promptPrefix: 'run the perf gate' }],
      workspaceId: 'ws',
      deliveredAt: 3_000,
      archivedAt: 2_500,
      relatesTo: ['idea-1'],
      blocks: [],
      events: [{ at: 2_000, verb: 'update', actor: 'human', summary: 'edited' }],
    }
    host.apply('seed-full', { kind: 'import', sourceId: 'test', ideas: [full] })
    const before = host.snapshot().ideas.find(idea => idea.id === 'idea-full')!

    // Export the portable document, wipe the board, import it back.
    const exported = await post(`${base}${IDEAS_API_PREFIX}/backup`, { reason: 'export' })
    expect(exported.status).toBe(200)
    const listed = await (await get(`${base}${IDEAS_API_PREFIX}/backup`)).json() as { snapshots: Array<{ name: string }> }
    const document = await (await get(`${base}${IDEAS_API_PREFIX}/backup/content?name=${listed.snapshots[0]!.name}`)).text()

    host.apply('wipe-1', { kind: 'delete', ideaId: 'idea-full' })
    const restored = await post(`${base}${IDEAS_API_PREFIX}/backup/restore`, { document })
    expect(restored.status).toBe(200)

    const after = host.snapshot().ideas.find(idea => idea.id === 'idea-full')!
    // Nothing was dropped on the way through: windowing has no idea to carry.
    expect(after).toEqual(before)
    expect(JSON.parse(document).ideas.find((idea: IdeaRecord) => idea.id === 'idea-full')).toEqual(before)
  })
})

describe('a list projection is still what a windowed board polls with', () => {
  it('serves ?view=list without a body, and the default view still without the excerpt', async () => {
    const { base } = await serve()
    const lean = await (await get(`${base}${IDEAS_API_PREFIX}/state?view=list`)).json() as {
      ideas: Array<IdeaRecord & { bodyExcerpt: string }>
    }
    expect(lean.ideas[0]!.body).toBeUndefined()
    expect(typeof lean.ideas[0]!.bodyExcerpt).toBe('string')

    // And the full view carries no excerpt: the two projections stay distinct,
    // which is what keeps a default-state backup readable by the old tooling.
    const full = await (await get(`${base}${IDEAS_API_PREFIX}/state`)).json() as {
      ideas: Array<IdeaRecord & { bodyExcerpt?: string }>
    }
    expect(full.ideas[0]!.bodyExcerpt).toBeUndefined()
    expect(full.ideas[0]!.body).toBeDefined()
  })
})