/**
 * Board tab model: the fixed tab set of the ideas panel and its persistence.
 * The active tab survives page reloads through a storage pair (localStorage on
 * the page, an injectable seam in tests). Anything wrong on the way back —
 * unknown tab, unreadable storage, non-parseable value — degrades to the
 * default tab without throwing.
 */

/** The panel tabs, in display order. */
export const BOARD_TABS = ['overview', 'priorities'] as const

/** One panel tab id. */
export type BoardTab = (typeof BOARD_TABS)[number]

/** Default tab shown when nothing is persisted. */
export const DEFAULT_TAB: BoardTab = 'overview'

/** Storage key of the persisted active tab. */
export const ACTIVE_TAB_STORAGE_KEY = 'dsh.ideas.activeTab'

/** Narrow an unknown value to a board tab. */
export function isBoardTab(value: unknown): value is BoardTab {
  return typeof value === 'string' && (BOARD_TABS as readonly string[]).includes(value)
}

/** The storage seam the persistence helpers read (localStorage-compatible). */
export interface TabStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Read the persisted active tab; any hiccup falls back to the default. */
export function readActiveTab(storage: TabStorage | undefined): BoardTab {
  if (storage === undefined) return DEFAULT_TAB
  try {
    const raw = storage.getItem(ACTIVE_TAB_STORAGE_KEY)
    return raw !== null && isBoardTab(raw) ? raw : DEFAULT_TAB
  } catch {
    return DEFAULT_TAB
  }
}

/** Persist the active tab; storage failures are ignored (never throw). */
export function writeActiveTab(storage: TabStorage | undefined, tab: BoardTab): void {
  if (storage === undefined) return
  try {
    storage.setItem(ACTIVE_TAB_STORAGE_KEY, tab)
  } catch {
    // Private browsing, quota, or a disabled storage must not break the tabs.
  }
}