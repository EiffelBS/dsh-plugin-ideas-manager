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
 *    to decide on. Best-effort like the rest of this file;
 *  - every call names the Peer it speaks for. A Host that enforces the rule
 *    refuses a call that names none, so this backend owns exactly ONE
 *    in-process owner Peer, created from the Host connection service, and
 *    hands its identity to every `session/*` request. One peer per backend
 *    (per service), never disposed by us: the Context that read
 *    `createPeer` disposes it when the plugin goes away, and a disposed peer
 *    answers `gateway/peer-disposed` for the rest of its life.
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
        /** The Peer this call speaks for; required by Hosts that enforce it. */
        peer?: HostPeerFace;
        signal?: AbortSignal;
    }): Promise<unknown>;
}
/** The principal this plugin speaks as when it starts a run on the author's behalf. */
export interface HostPeerPrincipal {
    readonly kind: 'owner';
}
/** The live Peer slice the gateway reads — every call touches `peer.signal`. */
export interface HostPeerFace {
    readonly signal: AbortSignal;
}
/**
 * The slice of the Host connection service this backend uses, duck-typed on
 * purpose (the face is a cordis SERVICE read through `ctx.get('connection')`,
 * never an import). The documented contract: `createPeer(options)` creates one
 * in-process Peer owned by the Context that read this service, disposed with
 * that Context and not before.
 */
export interface HostConnectionFace {
    createPeer?(options: {
        readonly principal: HostPeerPrincipal;
    }): HostPeerFace;
}
/** Resolves a host service face AT CALL TIME — cordis answers `undefined` until
 *  the owning fiber is active, so this is a function, never a captured object. */
export type HostServiceReader = (name: string) => unknown;
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
    /** Reads host services at CALL time (`ctx.get(name)`) — never a captured face. */
    private readonly readService?;
    constructor(gateway: HostSessionGateway, dispatch?: HostCommandDispatcher | undefined, 
    /** Reads host services at CALL time (`ctx.get(name)`) — never a captured face. */
    readService?: HostServiceReader | undefined);
    /** The ONE owner peer this backend speaks as. Created on first use, never disposed here. */
    private peer;
    /** Set only when the mount probe proves this host will not accept a named peer. */
    private peerRefused;
    /** One diagnostic per kind: a warning that repeats teaches the reader to ignore it. */
    private warnedNoConnection;
    private warnedNoPeer;
    /**
     * The Peer this backend speaks as, created ONCE from the Host connection
     * service through its documented face (`createPeer({ principal })`), disposed
     * WITH the Context that read that service — so we never dispose it here and
     * it is never disposed before the end of that context. A peer answers every
     * call by its `signal`, so a face without one is not usable: that case says
     * so once and leaves direct launch to fail on the host's own rule, not on a
     * silent default we cannot supply.
     */
    private ownerPeer;
    /**
     * Ask the host ONCE, at mount, whether it takes a named Peer. The probe is
     * `session/list` — a read that creates nothing and mutates nothing. A host
     * below the peer rule ignores an extra field on the request, so naming a peer
     * there costs nothing; a host that requires one is satisfied by the peer this
     * backend now owns. Only a refusal that NAMES the peer flips the decision,
     * and it is memoized for every later call: a launch that keeps sending a
     * peer the host has already refused would fail on every step.
     */
    probePeer(): Promise<void>;
    /**
     * One gateway call, named with this backend's own Peer. The peer is attached at
     * THE ONE point where request arguments are built (see `invokeWireArgs`), so no
     * endpoint can be added to this file without carrying it: a missing peer is not
     * a degraded feature, it is every call failing before any session exists.
     */
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
