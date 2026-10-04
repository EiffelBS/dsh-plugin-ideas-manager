/**
 * Shell panel navigation — the one cross-plugin call the layout exposes.
 *
 * `ctx.get("layout").selectPanel(panelId)` is the sanctioned way for a plugin
 * to bring a global center panel to the front: the shell's own sidebar rows use
 * it, and so do the TaskBoard, Skill Explorer and SSH shortcuts. `null` returns
 * the center column to the conversation — that is the "Back to chat" button. It
 * THROWS when a panel id is not registered, so every call here is wrapped: a
 * deployment that serves no such panel must degrade to "the button did nothing",
 * never to a dead click or a plugin-wide exception.
 *
 * Three things this file exists to get right, all learned the hard way:
 *
 * 1. The layout is a cordis SERVICE, reached through `ctx.get("layout")`, not
 *    through a `ctx.layout` property: cordis refuses an undeclared property
 *    read, and a service we never declared in `inject` is not a property at
 *    all. Reading the property therefore throws, and a resolver that trusted it
 *    produced a navigator that silently did nothing.
 * 2. The face is resolved at CALL time, never once at mount. `ctx.get(name)`
 *    answers `undefined` until the layout's own fiber is active, and the layout
 *    waits on `theme`/`locale`/`shortcuts` — a language pack fetched over the
 *    wire — while this plugin only waits on services the shell provides up
 *    front. A resolver that ran once, at `apply`, therefore saw no layout on a
 *    perfectly healthy page and cached that verdict for the whole session: the
 *    button stayed dead with nothing in the console. (The session link above
 *    this file's sibling, `session-opener.ts`, had the identical one-shot probe
 *    and needed the same repair; see commit `9e955e0`.)
 * 3. A face that resolves to nothing must SAY so. A navigator that is silently
 *    inert and a layout that silently refuses look identical from the outside,
 *    and only one of them is a bug — so both leave a distinct line in the
 *    console, once per page.
 */

/** The panel id shared by the Ideas sidebar row and its main-slot occupant. */
export const IDEAS_PANEL_ID = 'ideas'

/** The panel id the TaskBoard plugin registers (0.4.x, `TASK_BOARD_PANEL_ID`). */
export const TASK_BOARD_PANEL_ID = 'task-board'

/** Select-or-clear a global center panel. */
export interface PanelNavigator {
  /**
   * Select a registered main panel; `null` returns to the conversation.
   * Never throws: a refusal is logged and swallowed, since every caller is a
   * convenience affordance on top of an error the user is already reading.
   */
  select(panelId: string | null): void
}

/** The structural slice of the layout service this plugin uses. */
interface LayoutFace {
  selectPanel?(panelId: string | null): void
  /** The selection itself, read back to tell a refusal from a no-op. */
  panelInfo?: { getSnapshot?: () => { activePanelId?: unknown } }
}

/**
 * Build a navigator over the layout service.
 *
 * The navigator exists for every context-shaped host, and reads the layout on
 * every `select`: a host that serves no layout at all degrades inside the
 * click, loudly, instead of at mount — where the answer would have been a
 * verdict cached before the deployment had finished booting.
 *
 * @param ctx - the client root context.
 * @returns the navigator, or undefined when `ctx` is not a context at all.
 */
export function resolvePanelNavigator(ctx: unknown): PanelNavigator | undefined {
  if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  let face: LayoutFace | undefined
  // One diagnostic per page per kind: a warning that repeats teaches the reader
  // to ignore it, and both lines are the whole point of the exercise.
  let warnedNoFace = false
  let warnedNoEffect = false
  return {
    select(panelId: string | null): void {
      // Re-read until it resolves. Cached afterwards: the layout object is
      // stable for the page, and a `ctx.get` per click is not worth a lookup
      // that can only ever return the same answer.
      face ??= readLayoutFace(ctx)
      if (face === undefined) {
        if (warnedNoFace) return
        warnedNoFace = true
        console.warn(
          '[dsh-plugin-ideas-manager] no layout service on this page (tried ctx.get("layout")): ' +
          'the panel buttons ("Back to chat", "Open Task Board") will do nothing.',
        )
        return
      }
      try {
        // Optional call: through a cordis service proxy the method may be
        // absent, and a bare call would throw inside the click handler.
        face.selectPanel?.(panelId)
      } catch (error) {
        console.warn('[dsh-plugin-ideas-manager] panel selection refused:', error)
        return
      }
      // The write is synchronous and the store snapshot reads it back
      // synchronously, so this is a post-condition, not a poll: it separates
      // "the click never reached the layout" (no face, above) from "the layout
      // took the call and the column did not move".
      if (warnedNoEffect || !selectionTookEffect(face, panelId)) {
        if (warnedNoEffect) return
        warnedNoEffect = true
        console.warn(
          `[dsh-plugin-ideas-manager] layout.selectPanel(${JSON.stringify(panelId)}) did not change the ` +
          `selected panel: the center column is still showing ${JSON.stringify(activePanelIdOf(face))}.`,
        )
      }
    },
  }
}

/** Whether the layout now reports the panel the caller asked for. */
function selectionTookEffect(face: LayoutFace, panelId: string | null): boolean {
  const active = activePanelIdOf(face)
  // An older shell serves no selection source: there is nothing to assert, and
  // inventing a failure there would be the same silent lie in reverse.
  if (active === undefined) return true
  return active === panelId
}

/** The panel the layout currently shows, or undefined when it cannot say. */
function activePanelIdOf(face: LayoutFace): string | null | undefined {
  try {
    const active = face.panelInfo?.getSnapshot?.().activePanelId
    return typeof active === 'string' || active === null ? active : undefined
  } catch {
    return undefined
  }
}

/** The layout face behind a context, or undefined. Never throws. */
function readLayoutFace(ctx: unknown): LayoutFace | undefined {
  if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  const host = ctx as { get?: unknown; layout?: unknown }
  let candidate: unknown
  try {
    // The service accessor first — that is how every shipped panel reaches it.
    // A context whose `layout` really is a property (a test double, an older
    // shell) still works through the second read.
    candidate = typeof host.get === 'function'
      ? (host.get as (name: string) => unknown).call(ctx, 'layout')
      : host.layout
  } catch {
    // An undeclared property read, or a service accessor that refuses the name.
    return undefined
  }
  // A cordis service proxy is an object; a resolved service is an object too.
  if (typeof candidate !== 'object' || candidate === null) return undefined
  return candidate as LayoutFace
}