/**
 * Sidebar entry injection — package-specific wiring over the shared core.
 *
 * The row is injected between the shell's New Session button (or the
 * task-board row, when that plugin is active) and the workspace browser; see
 * sidebar-entry-core.ts for the self-healing DOM logic. It is plain DOM (no
 * React tree); the board view it toggles is a separate React root mounted in
 * the center column (see board-mount.tsx).
 */
import type { IdeasClient } from './ideas-client.ts';
/** Stable data attribute identifying the injected entry row. */
export declare const ENTRY_SELECTOR = "[data-dsh-ideas-entry]";
/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param client - the ideas client the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export declare function mountSidebarEntry(client: IdeasClient): () => void;
