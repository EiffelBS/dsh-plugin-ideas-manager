/**
 * Browser transport for the /api/ideas Host API. Same-origin fetch with the
 * loopback guards (the Host fence requires browser same-origin markers, which
 * plain fetch sends automatically), plus a short-poll subscription standing
 * in for the former SSE stream (see `subscribe` for the connection-pool
 * rationale). Mirrors the dsh-task-board host-api discipline.
 */

import {
  IDEAS_API_PREFIX,
  type IdeasAction,
  type IdeasActionEnvelope,
  type IdeasEventPayload,
  type IdeasSnapshot,
} from '../protocol.ts'

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
  state(): Promise<IdeasSnapshot>
  action(action: IdeasAction, initiator?: string): Promise<IdeasSnapshot>
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
}

export class HttpIdeasHostTransport implements IdeasHostTransport {
  async state(): Promise<IdeasSnapshot> {
    return await this.request(`${IDEAS_API_PREFIX}/state`, { cache: 'no-store' })
  }

  async action(action: IdeasAction, initiator?: string): Promise<IdeasSnapshot> {
    return await this.post(uuid(), action, initiator)
  }

  private async post(requestId: string, action: IdeasAction, initiator?: string): Promise<IdeasSnapshot> {
    const envelope: IdeasActionEnvelope = { requestId, action, ...(initiator === undefined || initiator === '' ? {} : { initiator }) }
    return await this.request(`${IDEAS_API_PREFIX}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
  }

  private async request(url: string, init: RequestInit): Promise<IdeasSnapshot> {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    try {
      return await readJson<IdeasSnapshot>(await fetch(url, { ...init, signal: controller.signal }))
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
