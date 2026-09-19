/**
 * Board tab model: the fixed tab set of the ideas panel and its persistence.
 * The active tab survives page reloads through a storage pair (localStorage on
 * the page, an injectable seam in tests). Anything wrong on the way back —
 * unknown tab, unreadable storage, non-parseable value — degrades to the
 * default tab without throwing.
 */
/** The panel tabs, in display order. */
export declare const BOARD_TABS: readonly ["overview", "priorities", "delivered"];
/** One panel tab id. */
export type BoardTab = (typeof BOARD_TABS)[number];
/** Default tab shown when nothing is persisted. */
export declare const DEFAULT_TAB: BoardTab;
/** Storage key of the persisted active tab. */
export declare const ACTIVE_TAB_STORAGE_KEY = "dsh.ideas.activeTab";
/** Narrow an unknown value to a board tab. */
export declare function isBoardTab(value: unknown): value is BoardTab;
/** The storage seam the persistence helpers read (localStorage-compatible). */
export interface TabStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
/** Read the persisted active tab; any hiccup falls back to the default. */
export declare function readActiveTab(storage: TabStorage | undefined): BoardTab;
/** Persist the active tab; storage failures are ignored (never throw). */
export declare function writeActiveTab(storage: TabStorage | undefined, tab: BoardTab): void;
