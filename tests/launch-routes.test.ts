/**
 * POST /api/ideas/launch route tests (idea #66), driven against a real
 * loopback server like the config-route suite: the browser-signal + loopback
 * fence, the 405/415/413 discipline, the strict body parser, and — the point of
 * the whole route — the ERROR MAPPING: every run gate refuses visibly
 * (409 mirror disabled, 503 task-board absent, 404 unknown idea, 400 the
 * task-board's own message) instead of being reduced to a silent no-op.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes } from '../src/host-routes.ts'
import {
  TaskBoardMirror,
  type TaskBoardActionEnvelope,
  type TaskBoardTransport,
} from '../src/taskboard-bridge.ts'
import { IDEAS_API_PREFIX } from '../src/protocol.ts'

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

/** In-memory task-board double: a mutable card list and canned refusals. */
class FakeTaskBoard implements TaskBoardTransport {
  posts: TaskBoardActionEnvelope[] = []
  stateStatus = 200
  stateTasks: Array<{ id: string; status: string }> = []
  answers = new Map<string, { status: number; body?: unknown }>()

  async getState() {
    return {
      status: this.stateStatus,
      ...(this.stateStatus === 200 ? { body: { schemaVersion: 3, revision: 1, tasks: this.stateTasks } } : {}),
    }
  }

  async postAction(envelope: TaskBoardActionEnvelope) {
    this.posts.push(envelope)
    return this.answers.get(envelope.action.kind) ?? { status: 200 }
  }
}

async function serve(options: { autoMirror?: boolean; withMirror?: boolean; stateStatus?: number } = {}): Promise<{ base: string; taskBoard: FakeTaskBoard; service: IdeasHostService }> {
  dir = join(tmpdir(), `ideas-launch-route-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const taskBoard = new FakeTaskBoard()
  taskBoard.stateStatus = options.stateStatus ?? 200
  taskBoard.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
  const mirror = new TaskBoardMirror({ transport: taskBoard })
  service = new IdeasHostService({
    dir,
    mirror: options.withMirror === false ? undefined : mirror,
    autoMirror: options.autoMirror ?? true,
  })
  service.apply('create-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ws' } })
  await service.flushMirror()
  taskBoard.posts = []

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
  return { base: `http://127.0.0.1:${address.port}`, taskBoard, service }
}

/** `contentType: null` means "send no content-type at all" (undici would add text/plain). */
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

const LAUNCH = `${IDEAS_API_PREFIX}/launch`

describe('POST /api/ideas/launch', () => {
  it('launches the idea and answers the neutral contract', async () => {
    const { base, taskBoard } = await serve()
    const response = await post(`${base}${LAUNCH}`, { requestId: 'r1', ideaId: 'idea-1', model: 'deepseek/deepseek-chat' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, runId: 'idea-idea-1', taskId: 'idea-idea-1', runStatus: 'running' })
    expect(taskBoard.posts.map(entry => entry.action)).toEqual([
      { kind: 'update', taskId: 'idea-idea-1', patch: { model: 'deepseek/deepseek-chat' } },
      { kind: 'run', taskId: 'idea-idea-1' },
    ])
  })

  it('omits the model on the wire when none was chosen', async () => {
    const { base, taskBoard } = await serve()
    const response = await post(`${base}${LAUNCH}`, { ideaId: 'idea-1' })
    expect(response.status).toBe(200)
    expect(taskBoard.posts.map(entry => entry.action)).toEqual([{ kind: 'run', taskId: 'idea-idea-1' }])
  })

  it('refuses a request without the browser same-origin marker', async () => {
    const { base, taskBoard } = await serve()
    const response = await post(`${base}${LAUNCH}`, { ideaId: 'idea-1' }, false)
    expect(response.status).toBe(403)
    expect(taskBoard.posts).toHaveLength(0)
  })

  it('keeps the method, content-type and size discipline', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}${LAUNCH}`, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(405)
    expect((await post(`${base}${LAUNCH}`, { ideaId: 'idea-1' }, true, null)).status).toBe(415)
    const oversized = { ideaId: 'idea-1', model: 'x'.repeat(64 * 1024 + 16) }
    expect((await post(`${base}${LAUNCH}`, oversized)).status).toBe(413)
  })

  it('rejects an invalid body without touching the task-board', async () => {
    const { base, taskBoard } = await serve()
    for (const body of [{}, { ideaId: '   ' }, { ideaId: 'idea-1', model: null }, { ideaId: 'idea-1', nope: 1 }]) {
      const response = await post(`${base}${LAUNCH}`, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, error: 'invalid-launch' })
    }
    expect(taskBoard.posts).toHaveLength(0)
  })

  it('answers 404 for an unknown idea', async () => {
    const { base } = await serve()
    const response = await post(`${base}${LAUNCH}`, { ideaId: 'ghost' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, error: 'not-found' })
  })

  it('answers 409 when the mirror is off and 503 when TaskBoard is absent', async () => {
    const off = await serve({ autoMirror: false })
    const disabled = await post(`${off.base}${LAUNCH}`, { ideaId: 'idea-1' })
    expect(disabled.status).toBe(409)
    expect(await disabled.json()).toEqual({ ok: false, error: 'taskboard-mirror-disabled' })

    // A probe that never answers leaves the mirror inactive: the launch
    // degrades to 503, never to a silent no-op (the create mirror no-op is
    // the normal autonomous state, but a REQUESTED run must be visible).
    const absent = await serve({ stateStatus: 404 })
    const refused = await post(`${absent.base}${LAUNCH}`, { ideaId: 'idea-1' })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ ok: false, error: 'taskboard-unavailable' })
  })

  it("relays the task-board's own refusal as the error message", async () => {
    const { base, taskBoard } = await serve()
    taskBoard.answers.set('run', { status: 400, body: { error: 'task is already running or missing' } })
    const response = await post(`${base}${LAUNCH}`, { ideaId: 'idea-1' })
    expect(response.status).toBe(400)
    // The wire keeps the bridge's full context (kind + status + the task-board
    // reason) — the board shows it verbatim, which is the whole point.
    const body = await response.json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('task is already running or missing')
  })

  it('replays the same request id without posting a second run', async () => {
    const { base, taskBoard } = await serve()
    const first = await post(`${base}${LAUNCH}`, { requestId: 'r-dup', ideaId: 'idea-1' })
    const second = await post(`${base}${LAUNCH}`, { requestId: 'r-dup', ideaId: 'idea-1' })
    expect(first.status).toBe(200)
    expect(await second.json()).toEqual(await first.clone().json())
    expect(taskBoard.posts.filter(entry => entry.action.kind === 'run')).toHaveLength(1)
  })
})
