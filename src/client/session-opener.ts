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

/**
 * One value out of a context by name, or undefined. Never throws.
 *
 * BOTH readings are tried, and that is not belt-and-braces: on a real cordis
 * context `ctx.get(name)` looks up a SERVICE, while `ctx[name]` goes through the
 * context proxy — which serves declared context PROPERTIES too (`events`,
 * `logger`, `reflect`, `registry` are properties, not services). A reader that
 * picks one therefore misses half the surface: the first version of this file
 * probed `ctx.get('reflect')` only, `get` existed, so the property fallback never
 * ran and the diagnostic reported an empty page.
 */
function readService(ctx: unknown, name: string): unknown {
  if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  const host = ctx as { get?: unknown } & Record<string, unknown>
  const viaAccessor = (): unknown => typeof host.get === 'function'
    ? (host.get as (service: string) => unknown).call(ctx, name)
    : undefined
  try {
    const found = viaAccessor()
    if (found !== undefined && found !== null) return found
  } catch {
    // An accessor that refuses the name: fall through to the property read.
  }
  try {
    return host[name]
  } catch {
    // An undeclared property read. Nothing here is worth an exception.
    return undefined
  }
}

/** One service out of a context by NAME, or undefined. Never throws. */
function readServiceFace(ctx: unknown, name: string): OpenableSessions | undefined {
  const candidate = readService(ctx, name)
  if (typeof candidate !== 'object' || candidate === null) return undefined
  return candidate as OpenableSessions
}

/** How many candidate faces the diagnostic is allowed to name. */
const FACES_REPORTED = 12

/**
 * What this page CAN do to show a session — the honest companion to a missing
 * link.
 *
 * A dead feature that says only "no navigation face" is unactionable: the
 * reader has no way to tell a wrong name from an unsupported deployment, and the
 * answer is sitting in the context, enumerable. The reflection layer holds every
 * declared context property BY NAME (`ctx.reflect.props`), so the diagnostic
 * reads that, resolves each value, and names the methods that could open or focus
 * something. It is bounded and sorted: a console line a developer can act on, not
 * a page dump. Empty means the context could not be enumerated — which is itself
 * a fact worth keeping: the plugin's client half may be running on a context
 * scoped to its own declared dependencies rather than the application root.
 *
 * @returns `name.method` pairs, empty when the context cannot be enumerated.
 */
export function navigationFaces(ctx: unknown): string[] {
  const props = (readService(ctx, 'reflect') as { props?: unknown } | undefined)?.props
  if (typeof props !== 'object' || props === null) return []
  const found: string[] = []
  for (const name of Object.keys(props as Record<string, unknown>)) {
    const value = readService(ctx, name)
    if (typeof value !== 'object' || value === null) continue
    const members = value as Record<string, unknown>
    for (const key of Object.keys(members)) {
      if (typeof members[key] !== 'function') continue
      if (!/open|focus|reveal|select|activate/i.test(key)) continue
      found.push(`${name}.${key}`)
    }
  }
  return found.sort().slice(0, FACES_REPORTED)
}
