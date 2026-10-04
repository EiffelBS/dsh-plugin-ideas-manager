/**
 * Column windowing for the kanban board.
 *
 * The board mounts one DOM subtree per card, and at the trigger this idea was
 * written for (~500 cards in the Open column) that is the whole cost: every
 * poll that changes the ledger re-renders every mounted card, and a real
 * browser then lays out and paints all of them. Windowing keeps only the cards
 * the reader can actually see mounted, with a scrollable spacer standing in for
 * the rest.
 *
 * Three decisions are load-bearing, and each one exists because the obvious
 * implementation quietly lies about what is on screen:
 *
 *  - **A variable-size cache seeded from a pure estimate, not from lazy
 *    measurement.** Cards are not a fixed height: the title wraps, the tags
 *    wrap, and the description is clamped to 2 (raw) or 3 (markdown) lines. A
 *    virtualizer that starts every row at 0 and measures as it scrolls has a
 *    wrong scrollbar on the first paint and a scroll position that moves under
 *    the pointer as rows resolve. `estimateIdeaCardHeight` is a **pure function
 *    of the row**, so the very first paint already has the right total height,
 *    and a later measurement only refines it.
 *  - **Refinement is anchored, never silent.** `measure()` returns how much
 *    everything ABOVE the anchored row grew or shrank, and the caller adds that
 *    to `scrollTop`. Without it, the row the reader is looking at slides away
 *    under the pointer every time a card above it is measured.
 *  - **A viewport that cannot be measured renders everything.** jsdom reports
 *    `clientHeight === 0`, and so does any DOM without layout. Windowing
 *    against an unknown viewport would paint a slice of the board and claim it
 *    is the board, so an unmeasurable viewport is answered with the whole list.
 *
 * Pure and framework-free on purpose (no DOM, no React): the whole geometry and
 * anchoring contract is unit-testable, and the React half only supplies
 * measurements and a scroll offset.
 */
/** Vertical gap between two cards, mirroring `.dsh-ideas-column-body { gap }`. */
export declare const IDEA_CARD_GAP_PX = 8;
/** Cards painted above and below the viewport, so a scroll never shows a hole. */
export declare const IDEA_WINDOW_OVERSCAN = 6;
/**
 * Open-column size at which the board prints the standing notice.
 * The notice is the honest interim signal that a column has grown past what a
 * glance can cover; it is NOT a claim that the board is slow (the window keeps
 * it responsive), it names the number so the reader knows what they are looking
 * at before they start scrolling.
 */
export declare const IDEA_OPEN_COLUMN_NOTICE_AT = 300;
/** Below this many rows a column is never windowed: the spacer buys nothing. */
export declare const IDEA_WINDOW_MIN_ROWS = 40;
/** What the estimator is allowed to read off a row. */
export interface WindowRow {
    readonly id: string;
    readonly title?: string;
    readonly bodyExcerpt?: string;
    readonly tags?: readonly {
        readonly name: string;
    }[];
    readonly value?: number;
    readonly effort?: number;
    readonly relatesTo?: readonly string[];
    readonly blocks?: readonly string[];
    readonly status?: string;
    readonly deliveryNote?: string;
    readonly workspaceId?: string;
    readonly ideaNumber?: number;
}
/** Tuning knobs of one window. */
export interface IdeaWindowOptions {
    /** Rows kept mounted above and below the viewport. */
    readonly overscan?: number;
    /** Characters that fit one rendered line; the React half refines it from the
     *  measured column width, which is why it is an option and not a constant. */
    readonly charsPerLine?: number;
}
/** The half-open `[start, end)` slice of rows to paint. */
export interface WindowRange {
    readonly start: number;
    readonly end: number;
}
/** A row to paint, with its absolute offset inside the scrollable spacer. */
export interface WindowEntry<T extends WindowRow> {
    readonly row: T;
    readonly index: number;
    /** Top of this row's slot, in px from the top of the list. */
    readonly top: number;
}
/**
 * First-paint card height, a pure function of the row.
 *
 * It is an ESTIMATE and it is allowed to be wrong by a few pixels per row —
 * `IdeaWindow.measure` corrects it against the real DOM. What it must never do
 * is be non-deterministic or unbounded, because the scrollbar height and every
 * row offset below depend on it before anything has been measured.
 *
 * The counted parts are exactly the rows that wrap: the title (with its `#N`
 * prefix), the workspace/tag line, the clamped description, the relation chips,
 * the delivery note of a finished run and the value/effort badges.
 */
export declare function estimateIdeaCardHeight(row: WindowRow, charsPerLine?: number): number;
/**
 * Characters that fit one line at `width` px. Returns the default rather than a
 * degenerate budget for a width a DOM never laid out (0 in jsdom, and the same
 * on a hidden column), so an unmeasurable column estimates like a real one
 * instead of like a 18-character sliver.
 */
export declare function charsPerLineFor(width: number): number;
/**
 * The scroll geometry of one column: a size cache, prefix-sum offsets and the
 * window to paint.
 *
 * One instance per column, fed the column's FULL display order. That last part
 * is the contract the drag anchor and the multi-select both rely on: the window
 * decides what is painted, never what the column contains.
 */
export declare class IdeaWindow<T extends WindowRow> {
    /** Rows painted above and below the viewport. */
    readonly overscan: number;
    /** Characters per line the estimates are built on. */
    charsPerLine: number;
    private rows;
    private indexById;
    private measuredById;
    /** Slot size per row (row + inter-card gap). */
    private slots;
    /** Offset of each row inside the list; `offsets[n]` is the total height. */
    private offsets;
    private geometryDirty;
    constructor(rows?: readonly T[], options?: IdeaWindowOptions);
    /** The full column, in display order — what a drop anchor may name. */
    get length(): number;
    /** Scrollable height of the whole column, in px. */
    get totalHeight(): number;
    /** Replace the column content, keeping the cache honest. */
    setRows(rows: readonly T[]): void;
    /** Position of a row in the column, or -1 when it is not in it. */
    indexOf(id: string): number;
    /** The row at `index`, or undefined past the end. */
    rowAt(index: number): T | undefined;
    /** Top of a row's slot in px (clamped to the list). */
    offsetOf(index: number): number;
    /** Effective height of a row: the measured one, else the estimate. */
    heightOf(id: string): number;
    /**
     * Record a real measured height.
     *
     * `anchorIndex` is the row the reader is looking at (the first painted one):
     * every size change ABOVE it moved the list under the pointer, so the return
     * value is that movement in px and the caller adds it to `scrollTop`. Changes
     * at or below the anchor move nothing that is visible, which is why the
     * delta is 0 for them.
     *
     * @returns px to add to `scrollTop`, or 0 when nothing moved.
     */
    measure(id: string, height: number, anchorIndex: number): number;
    /**
     * The rows to paint for a viewport starting at `scrollTop`.
     *
     * `viewport <= 0` answers with the WHOLE column: an unmeasurable viewport
     * cannot be windowed honestly, and painting everything is the one answer that
     * is never wrong.
     */
    window(scrollTop: number, viewport: number): WindowRange;
    /** The rows of `range`, each with the top its slot sits at. */
    entries(range: WindowRange): WindowEntry<T>[];
    /** True when a row is inside the painted range (its DOM node exists). */
    isPainted(id: string, range: WindowRange): boolean;
    /**
     * The `scrollTop` that puts `id` in the middle of a `viewport`-tall window,
     * or undefined when the column does not hold it.
     *
     * A non-positive viewport asks only for "make the row visible": the row is
     * scrolled to the top edge, which is enough for the window to mount it and
     * for the caller's own `scrollIntoView` to finish the job.
     */
    scrollTopFor(id: string, viewport: number): number | undefined;
    /**
     * Index of the row sitting at the top edge of a scrolled viewport.
     *
     * This is the anchor a measurement must preserve: it is the row the reader is
     * reading, and it is the one that must not move when the rows above it are
     * found to be taller (or shorter) than estimated.
     */
    anchorIndexFor(scrollTop: number): number;
    /** Effective slot size (row + gap) at `index`. */
    private slotSize;
    /** Rebuild the prefix sums after a row set or a size changed. */
    private ensureGeometry;
    /** First index whose slot ENDS after `top` (binary search on the prefix sums). */
    private firstIndexAfter;
}
