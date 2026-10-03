/**
 * Host command dispatch, as a pure function of the two shell faces it needs.
 *
 * The direct-session launch has to raise a session's permission BEFORE its first
 * turn runs, and `session/create` carries no permission field — so the level
 * travels as the Host's own `/permission <level>` command, dispatched INTO the
 * fresh session. That command rides the shell's `agents` + `commands` services
 * (the same two faces the task-board's runner drives).
 *
 * Extracted from the plugin entry so it can be tested without cordis, because
 * this boundary is where a silent version skew is most likely and most costly:
 * `commands.execute` is duck-typed, and a shell that adds a REQUIRED parameter
 * (it grew a fourth, the `AbortSignal`, in 2026-10) makes a three-argument call
 * throw a TypeError from the middle of the host — surfaced to the human as
 * "session permission failed: Cannot read properties of undefined". Passing the
 * signal is compatible in BOTH directions: an older three-parameter shell
 * ignores the extra argument.
 */
/** Dispatch one Host command line into a session; resolves its result. */
export type CommandDispatcher = (sessionId: string, line: string) => Promise<unknown>;
/**
 * Build the dispatcher from whatever faces the shell served, or `undefined` when
 * it served none it can use. `undefined` is a legitimate answer — the caller then
 * leaves direct sessions at the Host's own default permission — but the caller
 * is expected to SAY so, because a launch that silently runs fenced is worse
 * than one that refuses.
 */
export declare function createCommandDispatcher(agents: unknown, commands: unknown): CommandDispatcher | undefined;
