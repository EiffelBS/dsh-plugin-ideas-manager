/**
 * P2 TaskBoard bridge: OPTIONAL one-way mirror from the ideas ledger to the
 * dsh-task-board plugin, discovered at runtime — never a hard import. The
 * ideas Host calls its OWN origin's /api/task-board routes over loopback with
 * the family same-origin markers, exactly like a browser tab would, so the
 * bridge works whenever the task-board plugin is registered on the same
 * process and degrades to silent no-ops when it is not.
 *
 * Mapping (frozen design decision): idea create -> task create + move to
 * `backlog` (the card carries the DEPLOYMENT's own session default, clamped to
 * `workspace-write` — see mirrorPermissionFor, never a hard-coded level, so a
 * mirrored card never outranks the default and never trips the task-board's
 * confirmation gate); idea update -> task update; idea
 * decline / move-to-archived -> task archive; idea restore -> task restore;
 * idea delete -> no-op (the card outlives the idea). Every failure is logged
 * and the ideas ledger stays the source of truth: the mirror never rolls back
 * a committed idea mutation. `done` is RUNNER-OWNED, and added the
 * one verb that reaches it: a launch is an explicit human action
 * (`launchTask`), never a side effect of an idea mutation.
 *
 * Duplicate guard ("update must never mean create"): card ids are
 * DETERMINISTIC (`idea-` + idea.id, see mirrorCardIdFor), a bound idea is
 * only ever re-created when a NON-EMPTY snapshot proves the card gone, and
 * every ensureTask decision is logged with ideaId + binding + snapshot size +
 * branch. A transiently empty/unreadable snapshot therefore keeps the binding
 * and attempts the patch instead of minting a second card, and re-running any
 * path re-touches the same card id instead of duplicating it.
 *
 * Weight contract: the card DESCRIPTION carries the idea's <= 300-char
 * `summary` (analyst-produced, derived excerpt otherwise) while the full
 * analysis rides the card PROMPT — the body is never stored twice in the
 * snapshot (see summaryDescriptionOf).
 */
import { type IdeaRecord } from './core/ideas.ts';
export declare const TASK_BOARD_API_PREFIX = "/api/task-board";
/** The permission presets a card accepts, in authority order. */
export declare const TASK_PERMISSIONS: readonly ["read-only", "workspace-write", "danger-full-access"];
/** One task-board permission preset id. */
export type TaskPermission = (typeof TASK_PERMISSIONS)[number];
/**
 * The permission a mirrored card is stamped with: the board's own
 * `sessionDefaultPermission` clamped to {@link MIRROR_PERMISSION_CEILING}, or
 * `read-only` when the board reports nothing usable.
 *
 * Two rules, one function:
 *
 *  - **Never above the deployment default.** The task-board refuses to run a
 *    card whose permission outranks the session default until a human confirms
 *    the binding (`confirmation-required`). A mirrored card stamped above that
 *    default turns every launch into a trip to the board — confirm, come back,
 *    resume. Following the default instead makes the gate structurally silent
 *    on every install: whatever the deployment is configured with is what idea
 *    cards get, with no second lever to keep in sync and no hard-coded
 *    constant to contradict the deployment.
 *  - **Never above `workspace-write`,** whatever the default says: an idea
 *    card is a workspace-scoped implementation brief, never a whole-machine
 *    pass. `danger-full-access` stays a deliberate, human-granted elevation.
 */
export declare function mirrorPermissionFor(boardDefault: unknown): TaskPermission;
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
}
/**
 * Start an execution of the card. The task-board accepts EXACTLY
 * `['kind','taskId']` on this kind — the model can NOT travel with the run
 * (it is a task field, pinned by the runner through `session.selectModel`),
 * so {@link TaskBoardMirror.launchTask} patches `model` first and posts the
 * bare `run` after it.
 */
 | {
    kind: 'run';
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
    permission?: TaskPermission;
    tags?: {
        name: string;
        promptPrefix?: string;
    }[];
    /** `provider/model` target id; absent = the launched session's own default. */
    model?: string;
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
    /**
     * The card's execution permission. NOT a content field either, so the same
     * reasoning as `model` applies: a permission-only patch stays legal on a
     * card that already ran, which is what lets a launch align a card minted
     * under an older deployment default.
     */
    permission?: TaskPermission;
    /**
     * `provider/model` target id. NOT a content field (`title`/`description`/
     * `prompt` are): a model-only patch stays editable after the first execution
     * and does not touch `permissionConfirmedAt`, which is what lets a launch
     * re-pin the model on a card that already ran.
     */
    model?: string;
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
 * Idempotence: re-running any mirror path targets the SAME card id
 * instead of minting a fresh `idea-${randomUUID()}` on every re-execution —
 * a re-analyze or a lost binding can no longer produce a second card. The
 * task-board host ledger REFUSES `create` of an existing id (HTTP 400
 * `task id already exists`), so callers pair this id with get-before-create:
 * consult the snapshot first and adopt an already-present card rather than
 * issuing the create.
 */
export declare function mirrorCardIdFor(idea: IdeaRecord): string;
/**
 * The TaskBoard card DESCRIPTION for an idea: the analyst's `summary`
 * (<= 300 chars) when present, otherwise a derived excerpt of the body.
 *
 * Weight contract (why this exists): the snapshot serves every card's
 * description AND prompt, and the prompt already carries the full body as the
 * run instruction — shipping the body again as the description DOUBLED the
 * state payload (190,947 bytes on production before this rule, 90% of it
 * description+prompt). The full analysis stays in the ledger (source of
 * truth) and in the prompt; the description becomes a readable blurb.
 */
export declare function summaryDescriptionOf(idea: IdeaRecord): string;
/**
 * Derived <= 300-char excerpt of an idea body: the first paragraph holding
 * actual content (pure heading blocks like a lone "## Context" are skipped),
 * markdown heading markers stripped, whitespace collapsed, cut at a word
 * boundary with an ASCII ellipsis when too long.
 */
export declare function deriveSummary(body: string): string;
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
    /** The unavailability already reported to the log; unset while healthy. */
    private unavailableReport;
    /** Board default read from the last snapshot; unset until one lands. */
    private boardDefaultPermission;
    /** Task rows of the last snapshot, read by the launch-time alignment. */
    private snapshotTasks;
    constructor(options: TaskBoardMirrorOptions);
    /**
     * Feature-detect the task-board plugin. Positive probes are cached; a
     * failure is retried at most once per backoff window.
     *
     * An unavailability is REPORTED, not repeated: the probe keeps its 30 s
     * cadence (so a task-board installed later is still picked up), but a state
     * that has not changed says nothing new. On a host without the task-board
     * plugin the old shape printed the same line every 30 s for the whole life
     * of the process — about 200 identical lines per 90-minute test session,
     * which buries every other line the plugin has. Silence is the correct
     * output for "still down"; a CHANGED status or a return to health is an
     * event and is logged once.
     */
    availableNow(): Promise<boolean>;
    /**
     * Log an unavailability once per STATE rather than once per probe. The key
     * is the reason, so a status that CHANGES (401 while the workspace
     * controller boots, then 404 because the plugin is gone) is still reported:
     * the second is not the same fact as the first.
     */
    private reportUnavailable;
    /**
     * Resolve the task id a mirror operation must target; the caller rebinds
     * the idea to the returned id. Decision ladder ("update must
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
     * Idea create -> task create (at the deployment's own permission, backlog) +
     * move to backlog. Routed through ensureTask so a create re-executed after a
     * lost bind adopts the card already on the board instead of duplicating it.
     */
    mirrorCreate(idea: IdeaRecord): Promise<string>;
    /** Idea update -> task update; self-heals an unbound idea by creating it first. */
    mirrorUpdate(idea: IdeaRecord): Promise<string>;
    /** Idea decline / move-to-archived -> task archive. */
    mirrorArchive(idea: IdeaRecord): Promise<string>;
    /** Idea restore -> task restore (no-op when the idea was never bound). */
    mirrorRestore(idea: IdeaRecord): Promise<void>;
    /**
     * Launch the idea's execution on its TaskBoard card: the human
     * trigger turns the board into a starting point of execution, not only a
     * capture target.
     *
     * Two writes, in this exact order and on the caller's serialized chain:
     *  1. `ensureTask` — reuses the whole duplicate guard, so the card is the
     *     deterministic `idea-<id>` one and is (re)created when it was deleted
     *     out-of-band. A launch is never a second card.
     *  2. `update{model?, permission?}` — a NON-CONTENT patch, and only when
     *     something actually has to change. Never `taskPatch()`: that sends
     *     title/description/prompt, which the task-board rejects with `task has
     *     already been executed` on any card that already ran. The permission is
     *     raised to the deployment default when the card was minted under an
     *     older, lower one (the cards 0.7.x created as `read-only`); a card the
     *     human deliberately raised is left alone, and an unreadable one is
     *     never written to. Nothing is raised above the deployment default, so
     *     the task-board's confirmation gate stays silent and the run starts on
     *     the first click.
     *  3. `run` — the bare envelope; the task-board pins the model on the fresh
     *     session and queues the shared run prompt.
     *
     * Throws `TaskBoardUnavailableError` when the plugin is absent and a plain
     * Error carrying the task-board's own `body.error` message on a gate refusal
     * (`task is already running or missing`, `archived task is read-only`,
     * `confirmation-required: ...`, `task board is disabled`) — the caller
     * surfaces it instead of swallowing it.
     *
     * @returns the launched task id.
     */
    launchTask(idea: IdeaRecord, model?: string): Promise<string>;
    /** The task-board plugin is not registered or did not answer. */
    get isUnavailable(): boolean;
    /**
     * The session id of a card's last execution, as of the snapshot the run poll
     * already read. Zero extra requests: the poll calls
     * {@link fetchTaskStatuses} once per tick and every read lands in
     * `rememberSnapshot`, so the pointer to the run's own output is already in
     * memory here.
     *
     * This is the card backend's half of the delivery note: the mirrored card
     * does not own a session this plugin can read, only the id of the one its
     * runner used, and the session backend then harvests from it. undefined
     * when the board exposes no such field (an older board, a card that never
     * ran) — the caller leaves the note empty rather than inventing one.
     */
    cardSessionOf(taskId: string): string | undefined;
    /**
     * Keep the two facts a create/launch needs out of the last snapshot: the
     * board's own session default (the level a mirrored card must never outrank)
     * and the per-card permission (to align a card minted under an older
     * default). Best-effort — a partial or unexpected body simply leaves the
     * fields unset, and every reader degrades to the conservative fallback.
     */
    private rememberSnapshot;
    /** The permission a card created right now would carry. */
    private mirrorPermission;
    /**
     * A card's own permission as of the snapshot just read, or undefined when
     * the card is absent from it or carries something unrecognised. Callers must
     * treat undefined as "do not touch" — an unreadable card is never a reason
     * to write to it.
     */
    private cardPermissionOf;
    /** One ensureTask decision, always visible in the service log. */
    private decision;
    /**
     * The executable prompt, shared with the direct-session launch backend
     * (see src/run-prompt.ts). `model` is intentionally NOT part of the card
     * content: the card is created with no model, so the run starts on the
     * session default unless a launch re-pins it through a model-only patch.
     * `permission` IS stamped, at the deployment default clamped to
     * `workspace-write` (see {@link mirrorPermissionFor}) — never a constant, so
     * the card can run at whatever the deployment is configured with.
     */
    private createCard;
    private taskPatch;
    /**
     * Post one action envelope and surface the task-board's own refusal.
     *
     * Error relay: the reply body used to be dropped and only the
     * status line read, which made every run gate opaque (`400 task is already
     * running or missing` looked exactly like a malformed request). The body
     * carries `{error}` and sometimes `{code}`; both are folded into the thrown
     * message so the launch route can hand a readable reason to the board.
     */
    private post;
}
/** Thrown when the task-board plugin is absent; the service logs and moves on. */
export declare class TaskBoardUnavailableError extends Error {
    constructor();
}
