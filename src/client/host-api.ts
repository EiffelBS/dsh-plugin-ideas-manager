/**
 * Browser transport for the /api/ideas Host API. Same-origin fetch with the
 * loopback guards (the Host fence requires browser same-origin markers, which
 * plain fetch sends automatically), plus an SSE subscription for revision
 * pushes. Mirrors the dsh-task-board host-api discipline.
 */

import {
  IDEAS_API_PREFIX,
  type IdeasAction,
  type IdeasActionEnvelope,
  type IdeasEventPayload,
  type IdeasSnapshot,
} from '../protocol.ts'

const REQUEST_TIMEOUT_MS = 15_000

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
  subscribe(listener: (event?: IdeasEventPayload) => void): () => void
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

  subscribe(listener: (event?: IdeasEventPayload) => void): () => void {
    const events = new EventSource(`${IDEAS_API_PREFIX}/events`)
    events.onmessage = (message: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(message.data) as IdeasEventPayload
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.revision !== 'number') throw new Error('invalid event frame')
        listener(parsed)
      } catch {
        listener()
      }
    }
    const onVisible = (): void => { if (document.visibilityState === 'visible') listener() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      events.close()
    }
  }
}
