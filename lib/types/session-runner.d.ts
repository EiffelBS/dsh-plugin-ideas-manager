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
    constructor(gateway: HostSessionGateway);
    private invoke;
    /**
     * Start the idea's execution in a FRESH session of its workspace: create,
     * name it after the idea, pin the chosen model, queue the run prompt.
     * Returns the session id the run executes in.
     *
     * @throws {SessionLaunchError} when the Host refuses any step. The message
     *   is the Host's own, so the modal shows what actually refused.
     */
    launchIdea(idea: IdeaRecord, model?: string): Promise<string>;
    /**
     * The session roster as `sessionId -> running`. One RPC per settle tick,
     * shared by every tracked run, exactly like the card backend reads the card
     * statuses in one call. Throws when the roster is unknown (a booting or
     * unavailable runtime): the caller then keeps the runs `running` rather than
     * inventing a settle.
     */
    listRunning(): Promise<ReadonlyMap<string, boolean>>;
}
