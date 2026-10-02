/**
 * Native panel registration for the Ideas board.
 *
 * The board is an official-style center-column panel, not a DOM takeover: it
 * contributes a row into the sidebar shell's own global panel list
 * (`sidebar.panellist`) and its page into the layout's keyed `main` slot. The
 * shell then owns the row box, the label, the font, the active highlight, the
 * collapsed rail and the panel switch, exactly as it does for Plugins, Task
 * Board and Skill Center.
 *
 * This replaces a raw injected `<button>` plus a self-owned visibility flag.
 * That arrangement is why Ideas behaved like a toggle — selecting another panel
 * never closed it, because the shell did not know the row existed — and why its
 * label and glyph did not match the shipped rows. With the seats, the shell is
 * the single source of panel truth, so the eviction broadcasts the old path
 * needed (ideas <-> taskboard <-> ssh) are gone with it.
 *
 * Both registrations go through `ctx.slots.inject`, which fires only once the
 * owning shell entry has declared the seat: load order between this plugin and
 * ui-layout / ui-sidebar does not matter, and a shell that cannot serve the
 * seats simply leaves Ideas absent instead of failing the boot.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { IdeasClient } from './ideas-client.ts';
/**
 * The sidebar row glyph the shell asks for, at its own size and active state.
 * The shell owns the button, the label, the tooltip and the rail geometry;
 * this component draws only the glyph, like every other panel row.
 *
 * The glyph carries `data-dsh-panel-entry` because it is the only DOM this
 * plugin owns inside that shell-owned row: the L2 contract (skins) resolves
 * which row belongs to which plugin through it, the shell stamping no
 * per-entry hook of its own.
 *
 * A non-zero review count adds a small pill to the glyph's top-right corner
 * (`overflow: visible` lets it paint outside the 16px box, which is how a
 * badged nav icon is expected to look). The shell's panel-row contract has no
 * badge seat and takes no badge prop, so the glyph is the honest place to put
 * it rather than taking the row's DOM back.
 * @param props - the shell's icon share: square edge and selection state.
 * @returns the decorative ideas glyph.
 */
export declare function IdeasPanelIcon({ size, active }: {
    size: number;
    active: boolean;
}): import("react").JSX.Element;
/**
 * The main-slot page. The layout mounts it only while the board is the
 * selected panel, so the conversation keeps the center column untouched the
 * rest of the time, and the wrapper carries the pinned `data-dsh-ideas-view`
 * semantic anchor the stylesheet and the L2 skin contract key on.
 *
 * Mount/unmount is also how the client learns the panel is shown or hidden:
 * `panelShown` / `panelHidden` mirror it onto `boardOpen`, which gates the
 * background poll (a closed board holds no connections and no traffic).
 * @param props - this entry's injected face: the ideas client.
 * @returns the board page.
 */
export declare function IdeasPanel({ client }: {
    client: IdeasClient;
}): import("react").JSX.Element;
/**
 * Register the board's sidebar row and center-column page.
 *
 * A shell that declares neither seat leaves Ideas simply absent, which is the
 * documented degradation — but silence is a bad diagnostic, so an unclaimed
 * seat is logged once rather than leaving the board to "just not be there".
 * @param ctx - client root context (services: slots).
 * @param client - the ideas client the panel renders.
 * @returns a disposer releasing both registrations and the watchdog.
 */
export declare function registerIdeasPanel(ctx: ClientContext, client: IdeasClient): () => void;
