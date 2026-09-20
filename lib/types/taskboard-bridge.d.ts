/**
 * P2 TaskBoard bridge: OPTIONAL one-way mirror from the ideas ledger to the
 * dsh-task-board plugin, discovered at runtime — never a hard import. The
 * ideas Host calls its OWN origin's /api/task-board routes over loopback with
 * the family same-origin markers, exactly like a browser tab would, so the
 * bridge works whenever the task-board plugin is registered on the same
 * process and degrades to silent no-ops when it is not.
 *
 * Mapping (frozen design decision): idea create -> task create + move to
 * `backlog` (the card is `read-only`); idea update -> task update; idea
 * decline / move-to-archived -> task archive; idea restore -> task restore;
 * idea delete -> no-op (the card outlives the idea — closing the loop to
 * `done` is a manual run, never automated). Every failure is logged and the
 * ideas ledger stays the source of truth: the mirror never rolls back a
 * committed idea mutation.
 */
import type { IdeaRecord } from './core/ideas.ts';
export declare const TASK_BOARD_API_PREFIX = "/api/task-board";
/** Read-only permission stamped on every mirrored card. */
declare const MIRROR_TASK_PERMISSION: "read-only";
/** Local mirror of the task-board action union (never imported from the package). */
export type TaskBoardAction = {
    kind: 'create';
    id: string;
    input: TaskBoardNewTaskInput;
} | {
    kind: 'update';
    taskId: string;
    patch: TaskBoardTaskPatch;
} | {
    kind: 'move';
    taskId: string;
    status: 'backlog';
} | {
    kind: 'archive';
    taskId: string;
} | {
    kind: 'restore';
    taskId: string;
};
/** Local mirror of the task-board action envelope. */
export interface TaskBoardActionEnvelope {
    requestId: string;
    action: TaskBoardAction;
}
/** Local mirror of NewTaskInput — only the fields the ideas mirror sets. */
export interface TaskBoardNewTaskInput {
    title: string;
    description: string;
    prompt: string;
    workspaceId?: string;
    permission?: typeof MIRROR_TASK_PERMISSION;
    tags?: {
        name: string;
        promptPrefix?: string;
    }[];
}
/** Local mirror of the task update patch — only the fields ideas control. */
export interface TaskBoardTaskPatch {
    title?: string;
    description?: string;
    prompt?: string;
    workspaceId?: string | null;
    tags?: {
        name: string;
        promptPrefix?: string;
    }[] | null;
}
/** Local mirror of a task-board task row — only the fields the poll reads. */
export interface TaskBoardTaskLite {
    id: string;
    status: string;
}
/** A self-request result: HTTP status plus an optional parsed JSON body. */
export interface TaskBoardHttpResult {
    status: number;
    body?: unknown;
}
/** Injectable HTTP surface for the bridge (tests substitute a fake). */
export interface TaskBoardTransport {
    /** Feature-detect probe: GET /api/task-board/state. */
    getState(): Promise<TaskBoardHttpResult>;
    /** Mirror write: POST /api/task-board/action. */
    postAction(envelope: TaskBoardActionEnvelope): Promise<TaskBoardHttpResult>;
}
/**
 * Real transport: one loopback self-request per call to the Host's own
 * origin, carrying the browser same-origin markers so the task-board route
 * fence (socket + Host + Origin equality) accepts it without a token.
 */
export declare class HttpTaskBoardTransport implements TaskBoardTransport {
    private readonly getBase;
    /**
     * @param getBase - lazily resolved origin (http://127.0.0.1:port); the
     *   listen port is only known once the web server has bound its socket.
     */
    constructor(getBase: () => string);
    getState(): Promise<TaskBoardHttpResult>;
    postAction(envelope: TaskBoardActionEnvelope): Promise<TaskBoardHttpResult>;
    private exchange;
}
/** Mirror options; every seam is injectable for tests. */
export interface TaskBoardMirrorOptions {
    transport: TaskBoardTransport;
    now?: () => number;
    /** Log line sink; defaults to console.error (best-effort noise is fine). */
    log?: (message: string) => void;
}
/**
 * The one-way mirror. Availability is feature-detected on first use and
 * re-probed after a failure/absence with a bounded backoff. All methods throw
 * on transport failure — the service catches, logs, and never rolls back.
 */
export declare class TaskBoardMirror {
    private readonly options;
    private readonly log;
    private readonly now;
    private available;
    private lastProbeAt;
    constructor(options: TaskBoardMirrorOptions);
    /**
     * Feature-detect the task-board plugin. Positive probes are cached; a
     * failure is retried at most once per backoff window.
     */
    availableNow(): Promise<boolean>;
    /**
     * Resolve the bound task id, creating + moving the card to backlog when the
     * idea is not yet mirrored (the ladder used by update/decline too, so a
     * bridge activated after an idea's creation still catches it up).
     * @returns the task id to bind on the idea.
     */
    ensureTask(idea: IdeaRecord): Promise<string>;
    /**
     * Read the current status of every task card: task id -> status. Returns
     * undefined when the task-board is absent or the snapshot is malformed —
     * the under-review poll treats that as "nothing to do" (best-effort, like
     * the rest of the bridge).
     */
    fetchTaskStatuses(): Promise<Map<string, string> | undefined>;
    /** Idea create -> task create (read-only, backlog) + move to backlog. */
    mirrorCreate(idea: IdeaRecord): Promise<string>;
    /** Idea update -> task update; self-heals an unbound idea by creating it first. */
    mirrorUpdate(idea: IdeaRecord): Promise<string>;
    /** Idea decline / move-to-archived -> task archive. */
    mirrorArchive(idea: IdeaRecord): Promise<string>;
    /** Idea restore -> task restore (no-op when the idea was never bound). */
    mirrorRestore(idea: IdeaRecord): Promise<void>;
    /** The task-board plugin is not registered or did not answer. */
    get isUnavailable(): boolean;
    private createCard;
    private taskPatch;
    /** The executable prompt = the tag prompt lines, one per line. */
    private taskPrompt;
    private post;
}
/** Thrown when the task-board plugin is absent; the service logs and moves on. */
export declare class TaskBoardUnavailableError extends Error {
    constructor();
}
export {};
