/**
 * Ideas host routes: GET /api/ideas/state, POST /api/ideas/action,
 * POST /api/ideas/launch (idea #66), and the SSE /api/ideas/events stream,
 * all behind the loopback + browser same-origin fence. Follows the
 * dsh-task-board route discipline (same error ids, same body limits, same
 * guard semantics) without importing any of its code.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { TaskBoardMirrorDisabledError, type IdeasHostService } from './host-service.ts'
import { TaskBoardUnavailableError } from './taskboard-bridge.ts'
import { decodeRequestBody, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import {
  buildIdeasReadSnapshot,
  parseActionEnvelope,
  parseIdeasReadQuery,
  parseLaunchBody,
  parseSettingsBody,
  toListSnapshot,
  IDEAS_API_PREFIX,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
} from './protocol.ts'

const ACTION_LIMIT = 64 * 1024
const IMPORT_LIMIT = 2 * 1024 * 1024
const HEARTBEAT_MS = 15_000
/** Launch model target cap: `provider/model`, the task-board's own shape. */
const LAUNCH_MODEL_MAX_LENGTH = 256

/**
 * Browser-signal tripwire, NOT an authority check: a bare curl sends neither
 * header and is refused, but a curl with a forged Origin passes this too.
 * The real boundary is the loopback socket + Host + origin-equality checks in
 * isTrustedIdeasRequest below; do not rely on this marker alone.
 */
function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

/**
 * Ideas route fence. Direct desktop access uses the loopback socket + Host
 * guard and additionally requires a browser same-origin marker: a bare local
 * curl without any browser signal cannot exercise the agent control plane.
 */
export function isTrustedIdeasRequest(req: IncomingMessage): boolean {
  if (!browserSameOriginMarker(req)) return false
  return isLoopbackRequest(req)
}

/**
 * Read and decode the request body. The decode is robust (see
 * {@link decodeRequestBody}): a valid UTF-8 body is decoded byte-for-byte as
 * before, while a raw ANSI-codepage body (the PowerShell 5.1 string-body trap)
 * is re-decoded as windows-1252 instead of being corrupted to U+FFFD. The
 * received byte count is returned so the caller can cap on wire bytes rather
 * than the (re-encoded) length of the decoded text.
 */
async function readBody(req: IncomingMessage): Promise<{ raw: string; value: unknown; byteLength: number }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > IMPORT_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = decodeRequestBody(Buffer.concat(chunks))
  return { raw, value: JSON.parse(raw), byteLength: size }
}

/**
 * Settings seam the config route calls in-process — the DSH settings RPC
 * domain does not serve third-party namespaces to configuration clients (the
 * Side card lesson), so the plugin exposes its own fenced route instead. The
 * getter form lets the routes mount before `ctx.inject(['settings'])` fills
 * the face, and a deployment without a settings service answers
 * `available: false` forever (the client keeps the spelled defaults).
 */
export interface IdeasConfigPort {
  /** Current resolved view (clamped value + revision fence). */
  read(): IdeasSettingsView
  /** Merge an already-clamped patch; rejects with code SETTINGS_CONFLICT on a stale revision. */
  write(patch: IdeasSettingsPatch, expectedRevision: number | undefined): Promise<IdeasSettingsView>
}

export function makeIdeasRoutes(
  service: IdeasHostService,
  configPort?: () => IdeasConfigPort | undefined,
): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isTrustedIdeasRequest(req)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' }, { 'cache-control': 'no-store' })
    return false
  }
  const state: WebRoute = {
    kind: 'exact',
    path: `${IDEAS_API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      // idea #34: ?view=list serves the deferred-body projection (list fields
      // + a short excerpt) so a 140-card board poll stays a fraction of the
      // full payload. The DEFAULT stays the full snapshot: backups and
      // tooling (restore-3080-ideas, migration scripts) read GET /state and
      // must keep seeing bodies.
      //
      // idea #65: view=summary|detail is a separate additive contract with
      // workspace/id/number/status filters, field selection, pagination, and
      // explicit truncation metadata. It never mutates or caches the ledger.
      const params = new URL(req.url ?? '/', 'http://loopback').searchParams
      const view = params.get('view')
      if (view === 'summary' || view === 'detail') {
        const query = parseIdeasReadQuery(params)
        if (query === undefined) {
          writeJson(res, 400, { ok: false, error: 'invalid-query' }, { 'cache-control': 'no-store' })
          return
        }
        writeJson(res, 200, buildIdeasReadSnapshot(service.snapshot(), query), { 'cache-control': 'no-store' })
        return
      }
      writeJson(res, 200, view === 'list' ? toListSnapshot(service.snapshot()) : service.snapshot(), { 'cache-control': 'no-store' })
    },
  }
  const ideaBody: WebRoute = {
    kind: 'exact',
    path: `${IDEAS_API_PREFIX}/idea`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      const id = new URL(req.url ?? '/', 'http://loopback').searchParams.get('id')
      if (id === null || id === '') return writeJson(res, 400, { ok: false, error: 'id-required' }, { 'cache-control': 'no-store' })
      const record = service.idea(id)
      if (record === undefined) return writeJson(res, 404, { ok: false, error: 'not-found' }, { 'cache-control': 'no-store' })
      writeJson(res, 200, record, { 'cache-control': 'no-store' })
    },
  }
  const action: WebRoute = {
    kind: 'exact',
    path: `${IDEAS_API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: 'json-required' }, { 'cache-control': 'no-store' })
      }
      try {
        const body = await readBody(req)
        const parsed = parseActionEnvelope(body.value)
        if (parsed === undefined) return writeJson(res, 400, { ok: false, error: 'invalid-action' }, { 'cache-control': 'no-store' })
        if (parsed.action.kind !== 'import' && body.byteLength > ACTION_LIMIT) {
          return writeJson(res, 413, { ok: false, error: 'body-too-large' }, { 'cache-control': 'no-store' })
        }
        const result = service.apply(parsed.requestId, parsed.action, parsed.initiator)
        writeJson(res, 200, result.export === undefined
          ? result.state
          : { ok: true, export: result.export }, { 'cache-control': 'no-store' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message }, { 'cache-control': 'no-store' })
      }
    },
  }
  const events: WebRoute = {
    kind: 'exact',
    path: `${IDEAS_API_PREFIX}/events`,
    handler: (req, res): void => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!guard(req, res)) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const push = (): void => {
        const payload = service.eventPayload()
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
      const close = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      req.once('close', close)
      res.once('close', close)
      push()
    },
  }
  const config: WebRoute = {
    kind: 'exact',
    path: `${IDEAS_API_PREFIX}/config`,
    handler: async (req, res): Promise<void> => {
      const deny = (status: number, error: string): void => {
        writeJson(res, status, { ok: false, error }, { 'cache-control': 'no-store' })
      }
      if (req.method !== 'GET' && req.method !== 'POST') return deny(405, 'method-not-allowed')
      if (!guard(req, res)) return
      const port = configPort?.()
      if (req.method === 'GET') {
        // Reads always answer: a deployment without the settings service
        // reports `available: false` and the client keeps the defaults.
        writeJson(res, 200, port?.read() ?? { available: false, value: IDEAS_SETTINGS_DEFAULTS }, { 'cache-control': 'no-store' })
        return
      }
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return deny(415, 'json-required')
      let body: { raw: string; value: unknown; byteLength: number }
      try {
        body = await readBody(req)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return deny(message === 'body-too-large' ? 413 : 400, message)
      }
      if (body.byteLength > ACTION_LIMIT) return deny(413, 'body-too-large')
      const parsed = parseSettingsBody(body.value)
      if (parsed === undefined) return deny(400, 'invalid-patch')
      if (port === undefined) return deny(503, 'settings-unavailable')
      try {
        const view = await port.write(parsed.patch, parsed.expectedRevision)
        writeJson(res, 200, view, { 'cache-control': 'no-store' })
      } catch (error) {
        const conflict = typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
        const message = error instanceof Error ? error.message : String(error)
        deny(conflict ? 409 : 400, conflict ? 'settings-conflict' : message)
      }
    },
  }
  /**
   * Launch the idea's execution (idea #66). A DEDICATED route, not an
   * `IdeasAction` verb (decision D1): a launch is not a ledger mutation — it
   * must not consume the persisted action dedupe cache, and its answer is a
   * small `{ok, runId, runStatus}` instead of a whole board snapshot. The
   * requestId is still accepted and honours a replay inside a short window.
   *
   * Status mapping (every failure is visible, never swallowed — the run gates
   * are the interesting part of this flow):
   *  400 invalid-launch / the backend's own refusal message,
   *  404 not-found, 409 taskboard-mirror-disabled, 413/415/405 discipline.
   */
  const launch: WebRoute = {
    kind: 'exact',
    path: `${IDEAS_API_PREFIX}/launch`,
    handler: async (req, res): Promise<void> => {
      const deny = (status: number, error: string): void => {
        writeJson(res, status, { ok: false, error }, { 'cache-control': 'no-store' })
      }
      if (req.method !== 'POST') return deny(405, 'method-not-allowed')
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return deny(415, 'json-required')
      let body: { raw: string; value: unknown; byteLength: number }
      try {
        body = await readBody(req)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return deny(message === 'body-too-large' ? 413 : 400, message)
      }
      if (body.byteLength > ACTION_LIMIT) return deny(413, 'body-too-large')
      const parsed = parseLaunchBody(body.value)
      if (parsed === undefined) return deny(400, 'invalid-launch')
      if (parsed.model !== undefined && parsed.model.length > LAUNCH_MODEL_MAX_LENGTH) return deny(400, 'model-too-long')
      try {
        const result = await service.launchIdea(parsed.ideaId, parsed.model, parsed.requestId)
        writeJson(res, 200, result, { 'cache-control': 'no-store' })
      } catch (error) {
        if (error instanceof TaskBoardMirrorDisabledError) return deny(409, 'taskboard-mirror-disabled')
        if (error instanceof TaskBoardUnavailableError) return deny(503, 'taskboard-unavailable')
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'idea not found') return deny(404, 'not-found')
        // Anything else is the chosen backend's own gate message (the card
        // backend relays it from body.error, the session backend composes
        // `session create failed: …`), or an ideas-disabled state.
        deny(message === 'ideas plugin is disabled' ? 409 : 400, message)
      }
    },
  }
  return [state, ideaBody, action, events, config, launch]
}
