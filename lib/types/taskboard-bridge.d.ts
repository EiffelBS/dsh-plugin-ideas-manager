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
 *
 * Duplicate guard (idea #35 — "update must never mean create"): card ids are
 * DETERMINISTIC (`idea-` + idea.id, see mirrorCardIdFor), a bound idea is
 * only ever re-created when a NON-EMPTY snapshot proves the card gone, and
 * every ensureTask decision is logged with ideaId + binding + snapshot size +
 * branch. A transiently empty/unreadable snapshot therefore keeps the binding
 * and attempts the patch instead of minting a second card, and re-running any
 * path re-touches the same card id instead of duplicating it.
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
/**
 * Deterministic TaskBoard card id for an idea: `idea-` + idea.id.
 *
 * Idempotence (idea #35): re-running any mirror path targets the SAME card id
 * instead of minting a fresh `idea-${randomUUID()}` on every re-execution —
 * a re-analyze or a lost binding can no longer produce a second card. The
 * task-board host ledger REFUSES `create` of an existing id (HTTP 400
 * `task id already exists`), so callers pair this id with get-before-create:
 * consult the snapshot first and adopt an already-present card rather than
 * issuing the create.
 */
export declare function mirrorCardIdFor(idea: IdeaRecord): string;
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
    private readonly maxResponseBytes;
    private readonly timeoutMs;
    /**
     * @param getBase - lazily resolved origin (http://127.0.0.1:port); the
     *   listen port is only known once the web server has bound its socket.
     * @param limits - test seams for the response cap and request timeout.
     */
    constructor(getBase: () => string, limits?: {
        maxResponseBytes?: number;
        timeoutMs?: number;
    });
    getState(): Promise<TaskBoardHttpResult>;
    postAction(envelope: TaskBoardActionEnvelope): Promise<TaskBoardHttpResult>;
    /**
     * One self-request. The promise SETTLES ON EVERY PATH — resolved with the
     * parsed reply, or rejected on overflow, early close, socket error, or
     * timeout. The former implementation destroyed an oversized response
     * without settling, which hung the caller forever and silently stalled the
     * under-review poll once the production snapshot passed 128 KiB.
     */
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
     * Resolve the task id a mirror operation must target; the caller rebinds
     * the idea to the returned id. Decision ladder (idea #35 — "update must
     * never mean create"), logged with ideaId + binding + snapshot size +
     * branch on every path so a duplicate can be discriminated after the fact:
     *
     * Bound idea:
     *  - snapshot unknown (task-board absent / malformed body) or EMPTY ->
     *    keep the binding and target it. An empty or unreadable snapshot never
     *    proves a deletion; the patch attempt that follows fails into the
     *    service log instead of being "healed" by a create. This closes the
     *    transient-snapshot duplicate factory.
     *  - bound id present -> patch it (the normal path).
     *  - bound id absent from a NON-EMPTY snapshot -> the card was deleted
     *    out-of-band: the sanctioned rebuild, using the DETERMINISTIC id and
     *    logged as a visible event (recreating an already-bound idea is never
     *    silent again).
     *
     * Unbound idea (fresh create, or a binding never written):
     *  - get-before-create: adopt the deterministic card when the snapshot
     *    already holds it (a previous create whose bind did not land), only
     *    otherwise create it. Self-heal of the legacy orphan case, no duplicate.
     *
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
    /**
     * Idea create -> task create (read-only, backlog) + move to backlog.
     * Routed through ensureTask so a create re-executed after a lost bind
     * adopts the card already on the board instead of duplicating it.
     */
    mirrorCreate(idea: IdeaRecord): Promise<string>;
    /** Idea update -> task update; self-heals an unbound idea by creating it first. */
    mirrorUpdate(idea: IdeaRecord): Promise<string>;
    /** Idea decline / move-to-archived -> task archive. */
    mirrorArchive(idea: IdeaRecord): Promise<string>;
    /** Idea restore -> task restore (no-op when the idea was never bound). */
    mirrorRestore(idea: IdeaRecord): Promise<void>;
    /** The task-board plugin is not registered or did not answer. */
    get isUnavailable(): boolean;
    /** One ensureTask decision, always visible in the service log (idea #35). */
    private decision;
    /**
     * Create the card at `taskId` (the DETERMINISTIC mirrorCardIdFor id — never
     * a fresh uuid) and move it to backlog. The id is passed in rather than
     * minted so no code path can accidentally re-introduce a random id.
     */
    private createCard;
    private taskPatch;
    /**
     * The executable prompt = the tag prompt lines, one per line; when no tag
     * carries a prompt line, a mission prompt derived from the card itself.
     * The fallback is mandatory: Task Board launches a run with
     * `task.prompt !== '' ? task.prompt : task.title` (the description is never
     * injected into the session), so an empty prompt would ship the card's bare
     * TITLE to the launched agent — unexploitable for the common idea whose tags
     * are all plain names. The body is the captured spec, so it becomes the run
     * instruction instead.
     */
    private taskPrompt;
    private post;
}
/** Thrown when the task-board plugin is absent; the service logs and moves on. */
export declare class TaskBoardUnavailableError extends Error {
    constructor();
}
export {};
