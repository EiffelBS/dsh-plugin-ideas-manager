/**
 * Session opener (idea #66): the one way back into an execution the board
 * started.
 *
 * The Host settles a run on its own (the launch records the session it ran in,
 * whether that was a mirrored card or a fresh direct session), but the human
 * still has to be able to LOOK at it. A row of ideas saying "running" does not
 * show a token stream — it only says a run exists. This resolves the shell's
 * `sessions.open(id)` so a card carrying a `runSessionId` can jump straight to
 * the execution, with no new surface to learn and no tab to open.
 *
 * Like every other session face in this plugin it is FEATURE-DETECTED and
 * degrades to undefined: a deployment that serves no sessions service simply
 * renders no link, never a broken button.
 */
/** Opens a run's session in the shell. */
export interface SessionOpener {
    open(sessionId: string): void;
}
/**
 * Resolve the opener from a plugin context, or undefined when the shell serves
 * no usable `sessions` service. Written as a narrow runtime check rather than a
 * type import: the face is optional by contract, not by version.
 */
export declare function resolveSessionOpener(service: unknown): SessionOpener | undefined;
/** Extract the `sessions` service out of a plugin context, if it is there. */
export declare function sessionsServiceOf(ctx: {
    [key: string]: unknown;
}): unknown;
