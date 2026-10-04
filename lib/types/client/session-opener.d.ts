/**
 * Session opener (idea #66): the one way back into the conversation a card was
 * worked on.
 *
 * The Host settles a run on its own (the launch records the session it ran in,
 * whether that was a mirrored card or a fresh direct session), but the human
 * still has to be able to LOOK at it. A row of ideas saying "running" does not
 * show a token stream — it only says a run exists. This resolves the shell's
 * navigation face so a card carrying a `runSessionId` can jump straight to the
 * conversation, with no new surface to learn and no tab to open.
 *
 * TWO NAMES, because the plugin declares compatibility from DSH 0.1.5-rc.1 and
 * the way to show a session has moved: `uiWorkspace.openSession(id)` is the
 * documented navigation face (`@deepseek-ai/dsh-client-ui-workspace`), and
 * `sessions.open(id)` is probed second for an older host that served it. Both
 * are feature-detected, so a deployment with neither renders no link rather than
 * a broken button — and the caller WARNS in that case, because a link missing
 * because the name is wrong looks exactly like a link missing because the
 * deployment does not support it, and only one of those is a bug.
 *
 * Services are read through `ctx.get(name)`, never as a property: cordis refuses
 * an undeclared property read, and a resolver that trusted one produced a
 * navigator that silently did nothing (see `panel-navigation.ts` for the same
 * lesson). The property read survives only as a second chance for a context
 * whose service really is a property — a test double, an older shell.
 */
/** Opens a run's session in the shell. */
export interface SessionOpener {
    open(sessionId: string): void;
}
/**
 * Resolve the opener from a client context, or undefined when the page serves no
 * usable navigation face. Never throws: an undeclared property read is caught
 * exactly like an absent service.
 *
 * @param ctx - the client root context.
 * @returns the opener, or undefined when no navigation face is reachable.
 */
export declare function resolveSessionOpener(ctx: unknown): SessionOpener | undefined;
/**
 * What this page CAN do to show a session — the honest companion to a missing
 * link.
 *
 * A dead feature that says only "no navigation face" is unactionable: the
 * reader has no way to tell a wrong name from an unsupported deployment, and the
 * answer is sitting in the context, enumerable. cordis's reflection service
 * holds every declared context property BY NAME (`ctx.reflect.props`), so the
 * diagnostic reads that, resolves each value, and names the methods that could
 * open or focus something. It is bounded and sorted: a console line a developer
 * can act on, not a page dump.
 *
 * @returns `name.method` pairs, empty when the context cannot be enumerated.
 */
export declare function navigationFaces(ctx: unknown): string[];
