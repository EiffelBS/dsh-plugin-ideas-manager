/**
 * Shell panel navigation — the one cross-plugin call the layout exposes.
 *
 * `ctx.layout.selectPanel(panelId)` is the sanctioned way for a plugin to bring
 * a global center panel to the front (the shell's own sidebar rows use it, and
 * so does the TaskBoard shortcut). It THROWS when the main key is not
 * registered, so every call here is wrapped: a deployment that serves no such
 * panel must degrade to "the button did nothing", never to a dead click or a
 * plugin-wide exception.
 *
 * The face is resolved DEFENSIVELY instead of being declared in `inject`:
 * cordis refuses a property read that was not declared, and declaring a
 * service the deployment may not have would keep the WHOLE plugin from
 * booting (board, settings section and exports) over a panel that is optional.
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
 * Read `ctx.layout` off a client context without depending on its types (the
 * package is shell-provided, not a dependency of this plugin) and without
 * letting an undeclared property throw out of `apply`.
 * @param ctx - the client root context.
 * @returns the layout face, or undefined when the shell has no layout service.
 */
export declare function resolvePanelNavigator(ctx: unknown): PanelNavigator | undefined;
