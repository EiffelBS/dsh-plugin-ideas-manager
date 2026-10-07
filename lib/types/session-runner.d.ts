/**
 * Direct-session execution backend — the fallback for a Host
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
 *  - the new session inherits the Host's default permission unless the caller
 *    pins one (`directRunPermission`, default `workspace-write`): the run
 *    prompt asks for implementation, so a fenced session would answer with a
 *    plan and settle `done` having written nothing. There is no permission
 *    field on `session/create` — the level is applied by dispatching the
 *    Host's own `/permission` command into the fresh session, exactly what the
 *    task-board's runner does on a card, and it is applied BEFORE the prompt is
 *    queued so the very first turn already carries the sandbox. A failed
 *    elevation fails the launch loudly rather than running fenced;
 *  - settling is read off the roster (`session/list` -> per-session `running`
 *    bit): a session that stops running settles `done`, one that disappears
 *    settles `failed`. A run that ends in an error therefore settles `done`
 *    too — the card backend's history scan distinguishes the two and this
 *    backend deliberately does not;
 *  - a finished run leaves a delivery note: `readDeliveryNote`
 *    walks back to its last assistant message so the review gate has something
 *    to decide on. Best-effort like the rest of this file.
 */
import type { IdeaRecord } from './core/ideas.ts';
/**
 * The slice of the Host `typertGateway` this backend uses. Duck-typed on
 * purpose: the gateway is an injected service (the task-board plugin declares
 * it in its own `inject`), so feature detection is "is the face there", never
 * a hard import of another plugin.
 */
export interface HostSessionGateway {
    invoke(request: {
        namespace: string;
        method: string;
        args?: unknown;
        signal?: AbortSignal;
    }): Promise<unknown>;
}
/**
 * Runs one command line in a live session — here, the Host's `/permission`
 * preset command. Duck-typed and optional: a Host that serves no command
 * service (or a dispatcher that refuses) simply leaves the session at the
 * Host's own default.
 */
export type HostCommandDispatcher = (sessionId: string, line: string) => Promise<unknown>;
/** Raised when the Host answers but the session could not be started. */
export declare class SessionLaunchError extends Error {
    /** The session the run was already accepted into, when known. */
    readonly sessionId: string | undefined;
    constructor(message: string, 
    /** The session the run was already accepted into, when known. */
    sessionId: string | undefined);
}
export declare class SessionRunner {
    private readonly gateway;
    private readonly dispatch?;
    constructor(gateway: HostSessionGateway, dispatch?: HostCommandDispatcher | undefined);
    private invoke;
    /**
     * Start the idea's execution in a FRESH session of its workspace: create,
     * name it after the idea, pin the chosen model, queue the run prompt.
     * Returns the session id the run executes in.
     *
     * @throws {SessionLaunchError} when the Host refuses any step. The message
     *   is the Host's own, so the modal shows what actually refused.
     */
    launchIdea(idea: IdeaRecord, model?: string, permission?: string, reasoningEffort?: string): Promise<string>;
    /**
     * The session roster as `sessionId -> running`. One RPC per settle tick,
     * shared by every tracked run, exactly like the card backend reads the card
     * statuses in one call. Throws when the roster is unknown (a booting or
     * unavailable runtime): the caller then keeps the runs `running` rather than
     * inventing a settle.
     */
    listRunning(): Promise<ReadonlyMap<string, boolean>>;
    /**
     * The delivery note of a finished run: the text of the session's
     * LAST assistant message, read back through the same `session` RPC surface
     * this backend already speaks.
     *
     * Two calls, because the history page is cursor-addressed and the cursor is
     * the projection watermark:
     *  1. `session/projections` — a non-activating read whose `asOfSeq` is the
     *     session's last committed event sequence;
     *  2. `session/page` at that sequence, one bounded window of the tail.
     *
     * Deliberately two steps and not a follow stream: a harvest must not hold a
     * live subscription open on the settle path of a run that already finished.
     *
     * Returns undefined — never a guess — when the session is gone, has no
     * assistant turn, or answers a shape this reader does not recognise. Throws
     * only on a transport refusal, which the caller catches: a harvest failure
     * must never fail the settle.
     *
     * @param sessionId - the session the run executed in.
     */
    readDeliveryNote(sessionId: string): Promise<string | undefined>;
}
