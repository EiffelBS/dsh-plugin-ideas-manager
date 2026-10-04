/**
 * Session opener (idea #66): the one way back into an execution the board
 * started.
 *
 * The Host settles a run on its own (the launch records the session it ran in,
 * whether that was a mirrored card or a fresh direct session), but the human
 * still has to be able to LOOK at it. A row of ideas saying "running" does not
 * show a token stream — it only says a run exists. This resolves the shell's
 * navigation face so a card carrying a `runSessionId` can jump straight to the
 * conversation, with no new surface to learn and no tab to open.
 *
 * FEATURE-DETECTED over the faces that have actually carried this name, tried in
 * order, and degrading to undefined: a deployment that serves none renders no
 * link, never a broken button. The order matters — `uiWorkspace.openSession` is
 * the documented navigation face (`@deepseek-ai/dsh-client-ui-workspace`), and
 * `sessions.open` is kept only because a host may serve it. Asking for the wrong
 * NAME is not a feature that degrades, it is a feature that is simply dead:
 * which is why the caller warns when this returns undefined, and why the probe
 * covers both names rather than the one it used to assume.
 */
/** Opens a run's session in the shell. */
export interface SessionOpener {
    open(sessionId: string): void;
}
/**
 * Resolve the opener from a client context, or undefined when the page serves no
 * usable navigation face. Written as narrow runtime checks rather than a type
 * import: the face is optional by contract, not by version.
 */
export declare function resolveSessionOpener(ctx: unknown): SessionOpener | undefined;
