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

import { SESSIONS_SERVICE } from './session-queue.ts'

/** The slice of a shell navigation face this uses. */
interface OpenableSessions {
  openSession?(sessionId: string): void
  open?(sessionId: string): void
}

/** Opens a run's session in the shell. */
export interface SessionOpener {
  open(sessionId: string): void
}

/**
 * The faces that have carried "show this session", most current first. Ordered
 * so a host serving both uses the one its own UI navigates with.
 */
const OPENER_FACES: ReadonlyArray<{ service: string; method: 'openSession' | 'open' }> = [
  { service: 'uiWorkspace', method: 'openSession' },
  { service: SESSIONS_SERVICE, method: 'open' },
]

/**
 * Resolve the opener from a client context, or undefined when the page serves no
 * usable navigation face. Never throws: an undeclared property read is caught
 * exactly like an absent service.
 *
 * @param ctx - the client root context.
 * @returns the opener, or undefined when no navigation face is reachable.
 */
export function resolveSessionOpener(ctx: unknown): SessionOpener | undefined {
  for (const { service, method } of OPENER_FACES) {
    const face = readServiceFace(ctx, service)
    if (face === undefined) continue
    const open = face[method]
    if (typeof open !== 'function') continue
    const target = face
    return {
      open(sessionId: string): void {
        if (sessionId === '') return
        // Called on the face itself: a navigation service reads `this`.
        open.call(target, sessionId)
      },
    }
  }
  return undefined
}

/** One service out of a context by NAME, or undefined. Never throws. */
function readServiceFace(ctx: unknown, name: string): OpenableSessions | undefined {
  if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  const host = ctx as { get?: unknown } & Record<string, unknown>
  let candidate: unknown
  try {
    candidate = typeof host.get === 'function'
      ? (host.get as (service: string) => unknown).call(ctx, name)
      : host[name]
  } catch {
    // An undeclared property read, or an accessor that refuses the name.
    return undefined
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined
  return candidate as OpenableSessions
}
