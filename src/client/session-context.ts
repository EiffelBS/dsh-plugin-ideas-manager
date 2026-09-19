/**
 * Session-aware capture context (T3): resolve which DSH workspace the current
 * session belongs to, so a new idea capture defaults to the project being
 * discussed instead of landing generic.
 *
 * The resolution mirrors the shell's own "active workspace" rule
 * (@linxin666/dsh-web-all git-graph auto-isolation and the task-board family):
 *
 *   sessions.list.getSnapshot().current            -> the current session id
 *   workspaces.list.getSnapshot().items[].sessionIds.includes(current)
 *                                                    -> that session's workspace
 *   workspaces.list.getSnapshot().recentWorkspaceId -> fallback when no session
 *                                                      is bound to a workspace yet
 *
 * Both services are consumed defensively (duck-typed and optional): when they
 * are absent the resolver returns undefined and the board keeps its current
 * capture default (board scope, else generic). The settings namespace is
 * untouched — this is a read-only context hint, never a workspace mutation.
 */

import { workspaceLabel, type WorkspaceViewLite } from './workspaces.ts'

/** One workspace item of the shell "workspaces" service snapshot. */
interface DshWorkspaceItem {
  workspaceId: string
  title: string
  path?: string
  /** Sessions header-validated as members of this workspace. */
  sessionIds?: readonly string[]
}

/** Minimal face of the shell "sessions" service (see the task-board family). */
export interface DshSessionsService {
  list: {
    getSnapshot(): { current?: string; byId?: Record<string, { cwd?: string }> }
    subscribe(listener: () => void): () => void
  }
}

/** Minimal face of the shell "workspaces" service snapshot (extends the picker face). */
export interface DshWorkspacesSnapshotService {
  list: {
    getSnapshot(): { items?: readonly DshWorkspaceItem[]; recentWorkspaceId?: string }
    subscribe(listener: () => void): () => void
  }
}

/** Live active-workspace source: the resolved workspace of the current session. */
export interface ActiveWorkspaceSource {
  /** The resolved workspace, or undefined (unknown session / no registry). */
  current(): WorkspaceViewLite | undefined
  /** React to later session switches or registry changes. */
  subscribe(listener: () => void): () => void
  /** Release the follow subscriptions and listeners. */
  dispose(): void
}

/** Cordis service name exposing the session list (same name as the task-board family). */
export const SESSIONS_SERVICE = 'sessions'

/**
 * Resolve the workspace of the current session from two shell snapshots.
 * Pure and unit-testable: returns undefined when nothing binds a session to a
 * workspace (or the registry does not know the ids yet).
 */
export function resolveActiveWorkspace(
  currentSessionId: string | undefined,
  items: readonly DshWorkspaceItem[] | undefined,
  recentWorkspaceId: string | undefined,
): WorkspaceViewLite | undefined {
  if (currentSessionId !== undefined && currentSessionId !== '') {
    for (const item of items ?? []) {
      if (item.sessionIds?.includes(currentSessionId) === true) {
        return { workspaceId: item.workspaceId, title: workspaceLabel(item) }
      }
    }
  }
  if (recentWorkspaceId !== undefined && recentWorkspaceId !== '') {
    for (const item of items ?? []) {
      if (item.workspaceId === recentWorkspaceId) {
        return { workspaceId: item.workspaceId, title: workspaceLabel(item) }
      }
    }
  }
  return undefined
}

/**
 * Optional active-workspace adapter: watches the session + workspaces streams
 * and re-resolves the current workspace on every change. Degrades to
 * undefined on any failure (read-only; the board stays fully functional).
 */
export class DshActiveWorkspaceSource implements ActiveWorkspaceSource {
  private currentWorkspace: WorkspaceViewLite | undefined
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribes: Array<() => void> = []

  constructor(sessions: DshSessionsService, workspaces: DshWorkspacesSnapshotService) {
    const replace = (): void => {
      try {
        const sessionsSnapshot = sessions.list.getSnapshot()
        const workspacesSnapshot = workspaces.list.getSnapshot()
        this.currentWorkspace = resolveActiveWorkspace(
          sessionsSnapshot.current,
          workspacesSnapshot.items,
          workspacesSnapshot.recentWorkspaceId,
        )
      } catch {
        // A read failure degrades to "unknown active workspace".
        this.currentWorkspace = undefined
      }
      this.notify()
    }
    for (const service of [sessions, workspaces]) {
      try {
        this.unsubscribes.push(service.list.subscribe(replace))
      } catch {
        // A failing follow stream degrades to the static snapshot above.
      }
    }
    replace()
  }

  current(): WorkspaceViewLite | undefined {
    return this.currentWorkspace === undefined ? undefined : { ...this.currentWorkspace }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      try { unsubscribe() } catch {
        // Best-effort teardown.
      }
    }
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Defensively resolve the session + workspaces services from a client context.
 * Returns undefined when either service is absent or malformed, so callers
 * keep the pre-T3 capture default (board scope, else generic).
 */
export function resolveActiveWorkspaceSource(ctx: {
  get(name: string): unknown
}): DshActiveWorkspaceSource | undefined {
  try {
    const sessions = ctx.get(SESSIONS_SERVICE)
    if (typeof sessions !== 'object' || sessions === null) return undefined
    const sessionsList = (sessions as { list?: unknown }).list
    if (typeof sessionsList !== 'object' || sessionsList === null) return undefined
    const sessionsFace = sessionsList as { getSnapshot?: unknown; subscribe?: unknown }
    if (typeof sessionsFace.getSnapshot !== 'function' || typeof sessionsFace.subscribe !== 'function') return undefined

    const workspaces = ctx.get('workspaces')
    if (typeof workspaces !== 'object' || workspaces === null) return undefined
    const workspacesList = (workspaces as { list?: unknown }).list
    if (typeof workspacesList !== 'object' || workspacesList === null) return undefined
    const workspacesFace = workspacesList as { getSnapshot?: unknown; subscribe?: unknown }
    if (typeof workspacesFace.getSnapshot !== 'function' || typeof workspacesFace.subscribe !== 'function') return undefined

    return new DshActiveWorkspaceSource(
      sessions as unknown as DshSessionsService,
      workspaces as unknown as DshWorkspacesSnapshotService,
    )
  } catch {
    return undefined
  }
}