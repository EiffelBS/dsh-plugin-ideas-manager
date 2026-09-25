/**
 * Direct-session execution backend (idea #66, v2) — the fallback for a Host
 * that serves NO task-board plugin.
 *
 * It speaks the same Host RPC dialect the task-board's own runner speaks
 * (`session/create`, `session/rename`, `session/selectModel`, `session/prompt`
 * and `session/list`), reached through the injected `typertGateway`, and
 * deliberately NOT through the browser: a direct run keeps going after the tab
 * is closed, so accepting it and settling it must live in the Host too.
 *
 * Scope, honestly stated:
 *  - one FRESH session per launch (the card backend's `reuseSession` has no
 *    equivalent here; `runSessionId` still records the session so a restarted
 *    Host re-attaches to a run already in flight);
 *  - the model is pinned per launch exactly like the card backend pins it on
 *    the task, and a REJECTED model fails the launch loudly rather than
 *    silently falling back (the human chose it explicitly in the modal);
 *  - the new session inherits the Host's default permission — unlike a card,
 *    there is no permission field to bind and no `confirmation-required` gate
 *    here, so the effective permission is whatever DSH gives a fresh session;
 *  - settling is read off the roster (`session/list` -> per-session `running`
 *    bit): a session that stops running settles `done`, one that disappears
 *    settles `failed`. A run that ends in an error therefore settles `done`
 *    too — the card backend's history scan distinguishes the two and this
 *    backend deliberately does not.
 */

import type { IdeaRecord } from './core/ideas.ts'
import { runPromptOf } from './run-prompt.ts'

/**
 * The slice of the Host `typertGateway` this backend uses. Duck-typed on
 * purpose: the gateway is an injected service (the task-board plugin declares
 * it in its own `inject`), so feature detection is "is the face there", never
 * a hard import of another plugin.
 */
export interface HostSessionGateway {
  invoke(request: {
    namespace: string
    method: string
    args?: unknown
    signal?: AbortSignal
  }): Promise<unknown>
}

/** Raised when the Host answers but the session could not be started. */
export class SessionLaunchError extends Error {
  constructor(
    message: string,
    /** The session the run was already accepted into, when known. */
    readonly sessionId: string | undefined,
  ) {
    super(message)
    this.name = 'SessionLaunchError'
  }
}

/**
 * Wire-shape quirk of the DSH RPC surface: `session/list` declares its
 * argument under `_request` while every other method used here declares it
 * under `request`. Getting this wrong fails at runtime with an opaque
 * "invalid request", so it lives in one place.
 */
function invokeWireArgs(namespace: string, method: string, request: unknown): unknown {
  if (namespace === 'session' && method === 'list') return { _request: request }
  return { request }
}

/** The readable part of a gateway failure, so the modal can show what refused. */
function sessionErrorOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown; code?: unknown }
    if (typeof record.message === 'string' && record.message.trim() !== '') return record.message.trim()
    if (typeof record.code === 'string' && record.code.trim() !== '') return record.code.trim()
  }
  if (typeof error === 'string' && error.trim() !== '') return error.trim()
  return 'session request failed'
}

/** One roster row: the only thing settling a direct run needs. */
interface SessionRosterItem {
  sessionId: string
  running: boolean
}

export class SessionRunner {
  constructor(private readonly gateway: HostSessionGateway) {}

  private invoke<T>(namespace: string, method: string, request: unknown): Promise<T> {
    return this.gateway.invoke({
      namespace,
      method,
      args: invokeWireArgs(namespace, method, request),
    }) as Promise<T>
  }

  /**
   * Start the idea's execution in a FRESH session of its workspace: create,
   * name it after the idea, pin the chosen model, queue the run prompt.
   * Returns the session id the run executes in.
   *
   * @throws {SessionLaunchError} when the Host refuses any step. The message
   *   is the Host's own, so the modal shows what actually refused.
   */
  async launchIdea(idea: IdeaRecord, model?: string): Promise<string> {
    const workspaceId = idea.workspaceId
    if (workspaceId === undefined || workspaceId === '') {
      throw new SessionLaunchError('idea has no workspace to run in', undefined)
    }
    let sessionId: string
    try {
      const created = await this.invoke<{ sessionId?: string }>('session', 'create', { workspaceId })
      const resolved = created?.sessionId
      if (typeof resolved !== 'string' || resolved === '') {
        throw new Error('the host returned no session id')
      }
      sessionId = resolved
    } catch (error) {
      throw new SessionLaunchError(`session create failed: ${sessionErrorOf(error)}`, undefined)
    }
    try {
      await this.invoke('session', 'rename', { sessionId, title: idea.title })
      const target = model?.trim()
      if (target !== undefined && target !== '') {
        const slash = target.indexOf('/')
        const provider = slash >= 0 ? target.slice(0, slash).trim() : undefined
        const modelId = slash >= 0 ? target.slice(slash + 1).trim() : target
        await this.invoke('session', 'selectModel', {
          sessionId,
          ...provider === undefined || provider === '' ? {} : { provider },
          model: modelId,
        })
      }
      await this.invoke('session', 'prompt', {
        sessionId,
        requestId: `ideas-${crypto.randomUUID()}`,
        mode: 'queue',
        content: [{ type: 'text', text: runPromptOf(idea) }],
      })
    } catch (error) {
      throw new SessionLaunchError(`session run failed: ${sessionErrorOf(error)}`, sessionId)
    }
    return sessionId
  }

  /**
   * The session roster as `sessionId -> running`. One RPC per settle tick,
   * shared by every tracked run, exactly like the card backend reads the card
   * statuses in one call. Throws when the roster is unknown (a booting or
   * unavailable runtime): the caller then keeps the runs `running` rather than
   * inventing a settle.
   */
  async listRunning(): Promise<ReadonlyMap<string, boolean>> {
    const response = await this.invoke<{ items?: SessionRosterItem[] }>('session', 'list', {})
    const items = response?.items
    if (!Array.isArray(items)) return new Map()
    const roster = new Map<string, boolean>()
    for (const item of items) {
      if (typeof item?.sessionId !== 'string' || item.sessionId === '') continue
      roster.set(item.sessionId, item.running === true)
    }
    return roster
  }
}
