/**
 * DSH_HOME resolution for the ideas Host half, following the dsh-task-board
 * family discipline: the environment override wins, the platform home
 * fallback follows.
 */
/**
 * Resolve the DSH home directory.
 * @param env - process environment to read DSH_HOME from.
 * @param home - platform home directory fallback (test seam).
 * @returns the absolute DSH home path.
 */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv, home?: string): string;
/** Resolve the DSH home directory from the live environment. */
export declare function dshHome(): string;
