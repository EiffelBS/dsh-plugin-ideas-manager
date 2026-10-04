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
export declare const IDEAS_PANEL_ID = "ideas";
/** The panel id the TaskBoard plugin registers (0.4.x, `TASK_BOARD_PANEL_ID`). */
export declare const TASK_BOARD_PANEL_ID = "task-board";
/** Select-or-clear a global center panel. */
export interface PanelNavigator {
    /**
     * Select a registered main panel; `null` returns to the conversation.
     * Never throws: a refusal is logged and swallowed, since every caller is a
     * convenience affordance on top of an error the user is already reading.
     */
    select(panelId: string | null): void;
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
export declare function resolvePanelNavigator(ctx: unknown): PanelNavigator | undefined;
