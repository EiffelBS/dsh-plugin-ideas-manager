/**
 * React binding for the column windowing.
 *
 * `windowing.ts` owns the geometry; this file owns the three things only a DOM
 * can supply: the scroll offset, the measured heights, and the scroller's own
 * size. Everything else - which rows exist, what order they are in, what a drop
 * anchor means, what a selection range covers - is decided above this layer and
 * is deliberately NOT touched here.
 *
 * Two rules shape the code:
 *
 *  - **No layout read during render.** `clientHeight` forces layout, so the
 *    window is recomputed only where layout can legitimately change: when the
 *    scroller attaches, when it scrolls, when the row count moves and when the
 *    viewport resizes. A render reads the cached range.
 *  - **Stable ref callbacks.** A card ref is memoized per column and id, or
 *    React would detach and re-attach every mounted card on every poll, which
 *    would re-measure the whole column several times a second.
 *
 * One hook owns the WHOLE board rather than one hook per column: the set of
 * painted columns follows the `hideDeclinedColumn` setting, so a per-column
 * hook would be a different number of hooks from one render to the next.
 */
import type { IdeaStatus } from '../core/ideas.ts';
import type { IdeaListRow } from '../protocol.ts';
import { type WindowEntry } from './windowing.ts';
/** What the board needs from one windowed column. */
export interface VirtualColumn {
    /** The full column, in display order. Never windowed. */
    readonly rowCount: number;
    /** True when the column paints fewer rows than it holds. */
    readonly windowed: boolean;
    /** Rows to paint, each with the top its slot sits at. */
    readonly entries: readonly WindowEntry<IdeaListRow>[];
    /** Height of the scrollable spacer standing in for the unpainted rows. */
    readonly totalHeight: number;
    /** Attach to the scrolling element of the column. */
    readonly scrollerRef: (element: HTMLElement | null) => void;
    /** Attach to one rendered card wrapper. */
    readonly cardRef: (id: string) => (element: HTMLElement | null) => void;
    /** Scroll a row into the painted window; true when the column had to move. */
    readonly reveal: (id: string) => boolean;
}
/** The windowed columns plus the one scroll handler they share. */
export interface VirtualColumnsBinding {
    readonly columns: ReadonlyMap<IdeaStatus, VirtualColumn>;
    /** Attach to each column's scrolling element as its `onScroll`. */
    readonly onScroll: (event: {
        currentTarget: HTMLElement | null;
    }) => void;
}
/**
 * Window the kanban columns.
 *
 * @param rowsByStatus - the FULL display order of every column, computed once
 *   per paint by the board. This is also what the multi-select scope and the
 *   drop anchor are built from, so "what the column contains" keeps exactly one
 *   definition and windowing can never become a second, disagreeing one.
 * @param statuses - the columns actually painted, in board order. Pass a
 *   memoized array: the hook keys its effects on the content, not the identity.
 */
export declare function useVirtualColumns(rowsByStatus: Readonly<Record<IdeaStatus, IdeaListRow[]>>, statuses: readonly IdeaStatus[]): VirtualColumnsBinding;
