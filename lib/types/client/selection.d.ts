/**
 * Multi-select state for the ideas board (idea #94).
 *
 * The selection is **view state**. It lives in the board component, is never
 * sent to the Host and is never persisted: the 2.5 s poll keeps publishing
 * whatever the ledger holds and can therefore never overwrite (or resurrect) a
 * selection, exactly like the open-column display order of idea #71.
 *
 * Two rules make "all" unambiguous, which is the whole reason this is a module
 * rather than three `useState` calls:
 *
 *  - **A selection can only hold ids that are inside the current scope.** The
 *    scope is the active tab's filtered rows — workspace selector, conjunctive
 *    tag filter and header search, all shared by the three tabs. Every helper
 *    that can grow the set (`toggleSelection`, `extendSelection`,
 *    `selectAll`) is fed that ordered id list and refuses ids outside it, and
 *    `pruneSelection` is what the board runs whenever the scope changes. So a
 *    bulk action can never reach an idea the author cannot see, and an idea
 *    that scrolls out of the filter leaves the selection instead of lurking in
 *    it.
 *  - **The scope order is the display order**, so a shift-click range reads as
 *    the block of rows the author actually sees (four columns on the Overview,
 *    the ranked list on Priorities, the journal on Delivered), not an
 *    alphabetical or ledger-order range that would look arbitrary.
 *
 * Pure and framework-free, so the whole scope contract is unit-testable
 * without mounting the board.
 */
/** The active filter the selection is bound to (never stored anywhere). */
export interface SelectionScope {
    /** '' = all workspaces, a concrete workspace id, or the no-workspace sentinel. */
    workspaceFilter: string;
    /** Conjunctive tag filter (idea #36). */
    tags: readonly string[];
    /** Header text search. */
    query: string;
}
/** Selected idea ids plus the row a shift-click range grows from. */
export interface Selection {
    /** Selected ids, in selection order (not display order). */
    readonly ids: readonly string[];
    /** Last explicitly clicked row: the anchor of the next shift-click range. */
    readonly anchor: string | undefined;
}
/** The neutral selection: nothing selected, no anchor. */
export declare const EMPTY_SELECTION: Selection;
/** True when this idea is part of the selection. */
export declare function isSelected(selection: Selection, ideaId: string): boolean;
/** How many ideas are selected. */
export declare function selectionCount(selection: Selection): number;
/** True when the whole scope is selected (the "select everything" affordance). */
export declare function isWholeScopeSelected(selection: Selection, scopeIds: readonly string[]): boolean;
/**
 * Click: add the row when it is not selected, remove it when it is. An id
 * outside the scope is refused rather than silently selected (the board only
 * ever passes scoped ids, so this is the guard that keeps the rule true even if
 * a stale click arrives after the filter moved). The clicked row always becomes
 * the anchor.
 */
export declare function toggleSelection(selection: Selection, ideaId: string, scopeIds: readonly string[]): Selection;
/**
 * Shift-click: select the block of scope rows between the anchor and the
 * clicked row, inclusive, in display order. The range is **added** to whatever
 * was already selected (the usual multi-select behaviour: two shift-clicks
 * paint two blocks), and the clicked row becomes the new anchor so a further
 * shift-click re-grows from it. Without an anchor, or when the anchor left the
 * scope, the click degrades to a plain toggle.
 */
export declare function extendSelection(selection: Selection, ideaId: string, scopeIds: readonly string[]): Selection;
/** "Select everything in the current filter": exactly the scope, in scope order. */
export declare function selectAll(scopeIds: readonly string[]): Selection;
/** Drop the selection (the bar's Clear action). */
export declare function clearSelection(): Selection;
/**
 * Re-bind the selection to a scope that moved (a typed search, a toggled tag, a
 * changed workspace selector, a tab switch, a poll that brought in a new idea).
 * Ids that left the scope are dropped, order is preserved and the anchor
 * survives only while it is still selected-visible — so a bulk action can never
 * fire on an idea the current filter hides.
 */
export declare function pruneSelection(selection: Selection, scopeIds: readonly string[]): Selection;
/** The selected rows of a scope, in scope order (what a bulk action operates on). */
export declare function selectedRows<T extends {
    id: string;
}>(scopeRows: readonly T[], selection: Selection): T[];
