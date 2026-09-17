/**
 * DSH_HOME resolution for the ideas Host half, following the dsh-task-board
 * family discipline: the environment override wins, the platform home
 * fallback follows.
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * Resolve the DSH home directory.
 * @param env - process environment to read DSH_HOME from.
 * @param home - platform home directory fallback (test seam).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const trimmed = raw.trim()
    return isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed)
  }
  return join(home, '.dsh')
}

/** Resolve the DSH home directory from the live environment. */
export function dshHome(): string {
  return resolveDshHome()
}