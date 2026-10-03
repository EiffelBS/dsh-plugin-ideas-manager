/**
 * Browser transport for the /api/ideas Host API. Same-origin fetch with the
 * loopback guards (the Host fence requires browser same-origin markers, which
 * plain fetch sends automatically), plus a short-poll subscription standing
 * in for the former SSE stream (see `subscribe` for the connection-pool
 * rationale). Mirrors the dsh-task-board host-api discipline.
 */

import {
  IDEAS_API_PREFIX,
  ideasReadSearchParams,
  ideasStatsSearchParams,
  toListSnapshot,
  type IdeasAction,
  type IdeasActionEnvelope,
  type IdeasBackupView,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasReadQuery,
  type IdeasReadSnapshot,
  type IdeasRestoreRequest,
  type IdeasRestoreResponse,
  type IdeasSnapshot,
  type IdeasSnapshotReason,
  type IdeasSnapshotTaken,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
  type IdeasStats,
  type IdeasStatsQuery,
  type LaunchResponse,
} from '../protocol.ts'
import type { IdeaRecord } from '../core/ideas.ts'

const REQUEST_TIMEOUT_MS = 15_000
/** Poll cadence replacing the SSE subscription (see subscribe doc). */
const SUBSCRIBE_POLL_MS = 2_500

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * The Host answered 404 WITHOUT a JSON body — i.e. no route of ours is
 * registered on the running instance.
 *
 * This is not a rare shape: the browser half is re-resolved per request while
 * the host half registers its routes at boot, so a plugin updated under a LIVE
 * instance serves the new panel against the old route table. The caller turns
 * this into a capability downgrade (see `IdeasClient.backupUnavailable`)
 * instead of showing a dead button, and the reader never sees a parser error.
 */
export class IdeasRouteMissingError extends Error {
  /** The status that proved it (always 404). */
  readonly status = 404

  constructor() {
    super('the running Host does not serve this route')
    this.name = 'IdeasRouteMissingError'
  }
}

/**
 * The error an answer that is not JSON at all deserves. A typed
 * {@link IdeasRouteMissingError} for a 404 (so the caller can downgrade
 * instead of reporting a failure), a plain status sentence otherwise.
 */
function unreadableAnswer(status: number): Error {
  return status === 404 ? new IdeasRouteMissingError() : new Error(`the Host answered ${status} without a readable body`)
}

/**
 * Decode one JSON answer, and never let the parser speak.
 *
 * `response.json()` throws a raw `SyntaxError` on a non-JSON body, which is how
 * a user ended up reading `Unexpected token 'o', "not found" is not valid JSON`
 * from the settings panel. The body is read as text and parsed defensively: a
 * JSON refusal keeps its own sentence, a missing route becomes a typed
 * {@link IdeasRouteMissingError}, and anything else is reported by status.
 */
async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: (T & { error?: string; message?: string }) | undefined
  try {
    body = text.trim() === '' ? undefined : JSON.parse(text) as T & { error?: string; message?: string }
  } catch {
    body = undefined
  }
  if (!response.ok) {
    if (body === undefined) throw unreadableAnswer(response.status)
    // A route that answers with a refusal carries BOTH a stable `error` code
    // and a Host-written `message`; the sentence is what the panel shows, so it
    // wins. Every other route sends no `message` and this is inert for them.
    if (body.error === undefined) throw new Error(`ideas request failed: ${response.status}`)
    throw new Error(typeof body.message === 'string' && body.message !== '' ? body.message : body.error)
  }
  if (body === undefined) throw unreadableAnswer(response.status)
  return body
}

export interface IdeasHostTransport {
  /**
   * Board state as the LIST projection (idea #34): list fields + a short
   * body excerpt, voluminous analyses deferred to `idea()` / `stateFull()`.
   */
  state(): Promise<IdeasListSnapshot>
  /**
   * Apply one action. The wire response stays the FULL snapshot (the
   * POST /api/ideas/action contract is frozen); the transport projects it
   * to the list view at the edge so the client only ever holds list rows.
   */
  action(action: IdeasAction, initiator?: string): Promise<IdeasListSnapshot>
  /**
   * Bounded filtered read (idea #65). Optional so older hosts and lightweight
   * test transports keep the pre-existing board controller contract intact.
   */
  read?(query?: IdeasReadQuery): Promise<IdeasReadSnapshot>
  /**
   * Full-body snapshot (no projection): the deep-search index and parity
   * with pre-idea#34 consumers. Optional - a transport without it keeps
   * excerpt-level search (see IdeasClient.ensureSearchIndex).
   */
  stateFull?(): Promise<IdeasSnapshot>
  /**
   * One full record (body + analysisAudit included): the deferred-body read
   * behind edit / follow-up / re-analyze. Optional like `config`.
   */
  idea?(id: string): Promise<IdeaRecord>
  /**
   * Subscribe to refresh opportunities. No SSE stream is opened: the browser
   * HTTP/1.1 connection pool is shared across tabs and capped (~6 per
   * origin), and each long-lived EventSource per tab (ideas, task-board, the
   * shell HMR /plugins/events) permanently occupies one slot. A second tab
   * then exhausts the pool and page reloads starve every fetch — the board
   * surfaces this as "Host request timed out after 15s". So the transport
   * polls `state` on a short timer instead, and only while the page is
   * visible and (when given) `isActive` reports the board open; each poll is
   * an ordinary short fetch that returns its connection to the pool.
   * @param listener - invoked on each refresh opportunity (no payload).
   * @param isActive - optional gate; when provided, polls only while it
   *   returns true (e.g. the board is open).
   * @returns a disposer stopping the polling.
   */
  subscribe(listener: (event?: IdeasEventPayload) => void, isActive?: () => boolean): () => void
  /**
   * Read the plugin display settings (tagRows...). Optional capability: a
   * transport without it — an older Host, a test fake — leaves the client on
   * the spelled defaults (see IdeasClient.loadConfig).
   */
  config?(): Promise<IdeasSettingsView>
  /** Persist a settings patch (revision-fenced); rejects with 'settings-conflict'. */
  saveConfig?(patch: IdeasSettingsPatch, expectedRevision?: number): Promise<IdeasSettingsView>
  /**
   * Start the idea's execution (idea #66). Optional capability: a transport
   * without it (an older host, a test fake) makes the board show no Launch
   * affordance at all. Rejects with the host's own message so the reason a run
   * was refused stays visible.
   */
  launch?(ideaId: string, model?: string): Promise<LaunchResponse>
  /**
   * The snapshot folder (idea #95). Optional capability, like `config`: a
   * transport without it simply shows no backup panel, and the board keeps
   * working — a deployment must never lose its ledger surface because an older
   * host does not know the route.
   */
  backups?(): Promise<IdeasBackupView>
  /** Take a snapshot of the whole board now. */
  takeSnapshot?(reason?: IdeasSnapshotReason): Promise<IdeasSnapshotTaken>
  /** Adopt a snapshot (`name`) or an imported document (`document`). */
  restoreSnapshot?(request: IdeasRestoreRequest): Promise<IdeasRestoreResponse>
  /**
   * URL of one snapshot's raw document, served as a download. A plain link, not
   * a blob: the bytes are the ledger's own and the browser stores them as the
   * file they are, so an export is restorable on the machine it lands on.
   */
  snapshotContentUrl?(name: string): string
  /**
   * The bounded backlog-health aggregate (idea #110). Optional capability, like
   * `backups`: a transport without it (an older Host, a test fake) shows no
   * Health tab content rather than an error, and the board itself is untouched.
   *
   * Never called on the 2.5 s poll — the health view asks for itself when it is
   * opened and when the ledger revision actually moves.
   */
  stats?(query?: IdeasStatsQuery): Promise<IdeasStats>
}

export class HttpIdeasHostTransport implements IdeasHostTransport {
  async state(): Promise<IdeasListSnapshot> {
    return await this.request<IdeasListSnapshot>(`${IDEAS_API_PREFIX}/state?view=list`, { cache: 'no-store' })
  }

  async stateFull(): Promise<IdeasSnapshot> {
    return await this.request<IdeasSnapshot>(`${IDEAS_API_PREFIX}/state`, { cache: 'no-store' })
  }

  async read(query: IdeasReadQuery = {}): Promise<IdeasReadSnapshot> {
    const view = query.view ?? 'summary'
    const params = ideasReadSearchParams({ ...query, view })
    return await this.request<IdeasReadSnapshot>(`${IDEAS_API_PREFIX}/state?${params.toString()}`, { cache: 'no-store' })
  }

  async idea(id: string): Promise<IdeaRecord> {
    return await this.request<IdeaRecord>(`${IDEAS_API_PREFIX}/idea?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
  }

  /**
   * The action wire is untouched (full snapshot, frozen contract); the
   * projection to list rows happens HERE so every client consumer - board,
   * priorities, delivered - works from the same deferred-body shape as the
   * lean `state()` poll.
   */
  async action(action: IdeasAction, initiator?: string): Promise<IdeasListSnapshot> {
    const full = await this.post(uuid(), action, initiator)
    return toListSnapshot(full)
  }

  async config(): Promise<IdeasSettingsView> {
    return await this.request(`${IDEAS_API_PREFIX}/config`, { cache: 'no-store' })
  }

  async backups(): Promise<IdeasBackupView> {
    return await this.request(`${IDEAS_API_PREFIX}/backup`, { cache: 'no-store' })
  }

  async takeSnapshot(reason: IdeasSnapshotReason = 'manual'): Promise<IdeasSnapshotTaken> {
    return await this.request<IdeasSnapshotTaken>(`${IDEAS_API_PREFIX}/backup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
  }

  async restoreSnapshot(request: IdeasRestoreRequest): Promise<IdeasRestoreResponse> {
    return await this.request<IdeasRestoreResponse>(`${IDEAS_API_PREFIX}/backup/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  snapshotContentUrl(name: string): string {
    return `${IDEAS_API_PREFIX}/backup/content?name=${encodeURIComponent(name)}`
  }

  /**
   * The health aggregate (idea #110): its own small GET, never folded into the
   * board poll. The scope mirrors the board's workspace selector — omitted for
   * every workspace, a blank value for the workspace-less group.
   */
  async stats(query: IdeasStatsQuery = {}): Promise<IdeasStats> {
    return await this.request<IdeasStats>(`${IDEAS_API_PREFIX}/state?${ideasStatsSearchParams(query).toString()}`, { cache: 'no-store' })
  }

  async saveConfig(patch: IdeasSettingsPatch, expectedRevision?: number): Promise<IdeasSettingsView> {
    return await this.request(`${IDEAS_API_PREFIX}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
    })
  }

  /**
   * The launch route (idea #66) is a dedicated POST, not an action verb: the
   * answer is a small `{ok, runId, runStatus}`, never a board snapshot, and it
   * must not consume the persisted action dedupe cache. `readJson` already
   * turns the host's `error` field into the rejection message.
   */
  async launch(ideaId: string, model?: string): Promise<LaunchResponse> {
    return await this.request<LaunchResponse>(`${IDEAS_API_PREFIX}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: uuid(),
        initiator: 'plugin:ideas-manager:launch',
        ideaId,
        // Omit the key for "inherit the session default": null is rejected by
        // the wire parser and an empty string is not the same request.
        ...(model === undefined || model === '' ? {} : { model }),
      }),
    })
  }

  private async post(requestId: string, action: IdeasAction, initiator?: string): Promise<IdeasSnapshot> {
    const envelope: IdeasActionEnvelope = { requestId, action, ...(initiator === undefined || initiator === '' ? {} : { initiator }) }
    return await this.request(`${IDEAS_API_PREFIX}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
  }

  private async request<T = IdeasSnapshot>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    try {
      return await readJson<T>(await fetch(url, { ...init, signal: controller.signal }))
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`ideas Host request timed out after ${REQUEST_TIMEOUT_MS / 1_000}s`)
      throw error
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }

  /**
   * Poll `state` instead of holding an EventSource. Rationale: the browser
   * caps HTTP/1.1 connections per origin (~6) across ALL tabs; each ongoing
   * SSE (ours, task-board's, the shell HMR's) pins one slot forever, so two
   * tabs exhaust the pool and a page reload starves every fetch — surfacing
   * as "Host request timed out after 15s" in a refresh loop. Polling keeps
   * every request short-lived and returns its slot to the pool.
   * @param listener - called whenever a refresh opportunity arrives.
   * @param isActive - when given, polls only while it returns true (board
   *   open); a closed board consumes no connections and no traffic.
   */
  subscribe(listener: (event?: IdeasEventPayload) => void, isActive?: () => boolean): () => void {
    let running = true
    const tick = (): void => {
      if (!running) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (isActive !== undefined && !isActive()) return
      listener()
    }
    const timer = globalThis.setInterval(tick, SUBSCRIBE_POLL_MS)
    const onVisible = (): void => {
      if (running && typeof document !== 'undefined' && document.visibilityState === 'visible') tick()
    }
    // document-less environments (unit tests, headless) skip the visibility
    // listener; the interval still drives the poll.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => {
      running = false
      globalThis.clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }
}
