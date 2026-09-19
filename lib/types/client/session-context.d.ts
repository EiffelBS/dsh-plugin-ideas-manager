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
import { type WorkspaceViewLite } from './workspaces.ts';
/** One workspace item of the shell "workspaces" service snapshot. */
interface DshWorkspaceItem {
    workspaceId: string;
    title: string;
    path?: string;
    /** Sessions header-validated as members of this workspace. */
    sessionIds?: readonly string[];
}
/** Minimal face of the shell "sessions" service (see the task-board family). */
export interface DshSessionsService {
    list: {
        getSnapshot(): {
            current?: string;
            byId?: Record<string, {
                cwd?: string;
            }>;
        };
        subscribe(listener: () => void): () => void;
    };
}
/** Minimal face of the shell "workspaces" service snapshot (extends the picker face). */
export interface DshWorkspacesSnapshotService {
    list: {
        getSnapshot(): {
            items?: readonly DshWorkspaceItem[];
            recentWorkspaceId?: string;
        };
        subscribe(listener: () => void): () => void;
    };
}
/** Live active-workspace source: the resolved workspace of the current session. */
export interface ActiveWorkspaceSource {
    /** The resolved workspace, or undefined (unknown session / no registry). */
    current(): WorkspaceViewLite | undefined;
    /** React to later session switches or registry changes. */
    subscribe(listener: () => void): () => void;
    /** Release the follow subscriptions and listeners. */
    dispose(): void;
}
/** Cordis service name exposing the session list (same name as the task-board family). */
export declare const SESSIONS_SERVICE = "sessions";
/**
 * Resolve the workspace of the current session from two shell snapshots.
 * Pure and unit-testable: returns undefined when nothing binds a session to a
 * workspace (or the registry does not know the ids yet).
 */
export declare function resolveActiveWorkspace(currentSessionId: string | undefined, items: readonly DshWorkspaceItem[] | undefined, recentWorkspaceId: string | undefined): WorkspaceViewLite | undefined;
/**
 * Optional active-workspace adapter: watches the session + workspaces streams
 * and re-resolves the current workspace on every change. Degrades to
 * undefined on any failure (read-only; the board stays fully functional).
 */
export declare class DshActiveWorkspaceSource implements ActiveWorkspaceSource {
    private currentWorkspace;
    private readonly listeners;
    private readonly unsubscribes;
    constructor(sessions: DshSessionsService, workspaces: DshWorkspacesSnapshotService);
    current(): WorkspaceViewLite | undefined;
    subscribe(listener: () => void): () => void;
    dispose(): void;
    private notify;
}
/**
 * Defensively resolve the session + workspaces services from a client context.
 * Returns undefined when either service is absent or malformed, so callers
 * keep the pre-T3 capture default (board scope, else generic).
 */
export declare function resolveActiveWorkspaceSource(ctx: {
    get(name: string): unknown;
}): DshActiveWorkspaceSource | undefined;
export {};
