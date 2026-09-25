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
  toListSnapshot,
  type IdeasAction,
  type IdeasActionEnvelope,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasReadQuery,
  type IdeasReadSnapshot,
  type IdeasSnapshot,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
  type LaunchResponse,
} from '../protocol.ts'
import type { IdeaRecord } from '../core/ideas.ts'

const REQUEST_TIMEOUT_MS = 15_000
/** Poll cadence replacing the SSE subscription (see subscribe doc). */
const SUBSCRIBE_POLL_MS = 2_500

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `ideas request failed: ${response.status}`)
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
