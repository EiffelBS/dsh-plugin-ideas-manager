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

/** The slice of the shell `agents` service this uses. */
interface AgentsFace {
  get?: (sessionId: string) => unknown
}

/**
 * The slice of the shell `commands` service this uses. The fourth parameter is
 * the `AbortSignal` the shell began requiring; it is declared so a regression is
 * a type error here rather than a TypeError inside the host.
 */
interface CommandsFace {
  execute?: (
    agent: unknown,
    line: string,
    submittedAttachments: readonly unknown[],
    signal: AbortSignal,
  ) => Promise<{ result?: unknown } | undefined>
}

/** Dispatch one Host command line into a session; resolves its result. */
export type CommandDispatcher = (sessionId: string, line: string) => Promise<unknown>

/**
 * Build the dispatcher from whatever faces the shell served, or `undefined` when
 * it served none it can use. `undefined` is a legitimate answer — the caller then
 * leaves direct sessions at the Host's own default permission — but the caller
 * is expected to SAY so, because a launch that silently runs fenced is worse
 * than one that refuses.
 */
export function createCommandDispatcher(agents: unknown, commands: unknown): CommandDispatcher | undefined {
  const agentFace = agents as AgentsFace | undefined
  const commandFace = commands as CommandsFace | undefined
  const agentGet = agentFace?.get
  const commandExecute = commandFace?.execute
  if (typeof agentGet !== 'function' || typeof commandExecute !== 'function') return undefined
  // One never-aborted signal for the dispatcher's lifetime: the caller awaits it
  // inline while launching, and a command that needs cancelling is the shell's
  // business, not this plugin's.
  const signal = new AbortController().signal
  return async (sessionId, line) => {
    const agent = agentGet.call(agentFace, sessionId)
    if (agent === undefined) throw new Error('execution session is not available')
    // FOUR arguments: the shell reads `signal.aborted` before anything else.
    return (await commandExecute.call(commandFace, agent, line, [], signal))?.result
  }
}
