/**
 * Shell panel navigation — the one cross-plugin call the layout exposes.
 *
 * `ctx.get("layout").selectPanel(panelId)` is the sanctioned way for a plugin
 * to bring a global center panel to the front: the shell's own sidebar rows use
 * it, and so do the TaskBoard, Skill Explorer and SSH shortcuts. It THROWS when
 * the main key is not registered, so every call here is wrapped — a deployment
 * that serves no such panel must degrade to "the button did nothing", never to
 * a dead click or a plugin-wide exception.
 *
 * Two things this file exists to get right, both learned the hard way:
 *
 * 1. The layout is a cordis SERVICE, reached through `ctx.get("layout")`, not
 *    through a `ctx.layout` property: cordis refuses an undeclared property
 *    read, and a service we never declared in `inject` is not a property at
 *    all. Reading the property therefore throws, and a resolver that trusted it
 *    produced a navigator that silently did nothing.
 * 2. The face is resolved DEFENSIVELY rather than declared in `inject`:
 *    declaring a service the deployment may not have would keep the WHOLE
 *    plugin from booting (board, settings section and exports) over a panel
 *    that is only ever a convenience.
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
 * Build a navigator over the layout service, or undefined when this
 * deployment has none.
 * @param ctx - the client root context.
 * @returns the navigator, or undefined when no layout service is reachable.
 */
export declare function resolvePanelNavigator(ctx: unknown): PanelNavigator | undefined;
