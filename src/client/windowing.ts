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
export const IDEA_CARD_GAP_PX = 8

/** Cards painted above and below the viewport, so a scroll never shows a hole. */
export const IDEA_WINDOW_OVERSCAN = 6

/**
 * Open-column size at which the board prints the standing notice.
 * The notice is the honest interim signal that a column has grown past what a
 * glance can cover; it is NOT a claim that the board is slow (the window keeps
 * it responsive), it names the number so the reader knows what they are looking
 * at before they start scrolling.
 */
export const IDEA_OPEN_COLUMN_NOTICE_AT = 300

/** Below this many rows a column is never windowed: the spacer buys nothing. */
export const IDEA_WINDOW_MIN_ROWS = 40

/** One line of card text, in px (12-13px font at the board's line height). */
const LINE_PX = 17

/**
 * Fixed vertical parts of a card: padding, the header row, the updated stamp
 * and the action buttons. Only the WRAPPING rows vary with content, so the
 * estimate is `chrome + wrapping lines`.
 */
const CHROME_PX = 116

/** Characters per rendered line at the default column width (~300 px). */
const DEFAULT_CHARS_PER_LINE = 34

/** Average px per character at the board's font, used to fit the line budget. */
const PX_PER_CHAR = 7.2

/** Clamp bounds for a width-derived line budget (a 240 px column is ~33 chars). */
const MIN_CHARS_PER_LINE = 18
const MAX_CHARS_PER_LINE = 90

/** What the estimator is allowed to read off a row. */
export interface WindowRow {
  readonly id: string
  readonly title?: string
  readonly bodyExcerpt?: string
  readonly tags?: readonly { readonly name: string }[]
  readonly value?: number
  readonly effort?: number
  readonly relatesTo?: readonly string[]
  readonly blocks?: readonly string[]
  readonly status?: string
  readonly deliveryNote?: string
  readonly workspaceId?: string
  readonly ideaNumber?: number
}

/** Tuning knobs of one window. */
export interface IdeaWindowOptions {
  /** Rows kept mounted above and below the viewport. */
  readonly overscan?: number
  /** Characters that fit one rendered line; the React half refines it from the
   *  measured column width, which is why it is an option and not a constant. */
  readonly charsPerLine?: number
}

/** The half-open `[start, end)` slice of rows to paint. */
export interface WindowRange {
  readonly start: number
  readonly end: number
}

/** A row to paint, with its absolute offset inside the scrollable spacer. */
export interface WindowEntry<T extends WindowRow> {
  readonly row: T
  readonly index: number
  /** Top of this row's slot, in px from the top of the list. */
  readonly top: number
}

/** Number of lines `text` needs at `charsPerLine` characters per line. */
function linesOf(text: number, charsPerLine: number): number {
  if (text <= 0) return 0
  return Math.max(1, Math.ceil(text / Math.max(1, charsPerLine)))
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
export function estimateIdeaCardHeight(row: WindowRow, charsPerLine: number = DEFAULT_CHARS_PER_LINE): number {
  const perLine = clampNumber(Math.round(charsPerLine), MIN_CHARS_PER_LINE, MAX_CHARS_PER_LINE)

  // Title line, including the stable `#N` reference the title is prefixed with.
  const numberPrefix = row.ideaNumber === undefined ? 0 : String(row.ideaNumber).length + 3
  let lines = linesOf((row.title ?? '').length + numberPrefix, perLine)

  // Workspace chip + tags share one wrapping line, and the slot does not exist
  // at all when the row carries neither.
  const metaChars = (row.workspaceId === undefined ? 0 : row.workspaceId.length + 2)
    + (row.tags ?? []).reduce((sum, tag) => sum + tag.name.length + 3, 0)
  if (metaChars > 0) lines += linesOf(metaChars, perLine)

  // The description is line-clamped, so its height is bounded by the clamp and
  // not by the excerpt length; the estimate only has to decide whether the
  // excerpt is shorter than the clamp.
  if ((row.bodyExcerpt ?? '').trim() !== '') {
    lines += Math.min(3, linesOf((row.bodyExcerpt ?? '').length, perLine * 2))
  }

  // Quiet reference line under the body (relation chips).
  if ((row.relatesTo ?? []).length > 0 || (row.blocks ?? []).length > 0) lines += 1
  // The delivery note of a settled run, shown on the review column only.
  if (row.status === 'underReview' && (row.deliveryNote ?? '') !== '') lines += 2
  // Value / effort badges share their own meta line.
  if (row.value !== undefined || row.effort !== undefined) lines += 1

  return CHROME_PX + lines * LINE_PX
}

/**
 * Characters that fit one line at `width` px. Returns the default rather than a
 * degenerate budget for a width a DOM never laid out (0 in jsdom, and the same
 * on a hidden column), so an unmeasurable column estimates like a real one
 * instead of like a 18-character sliver.
 */
export function charsPerLineFor(width: number): number {
  if (!(width > 0)) return DEFAULT_CHARS_PER_LINE
  return Math.max(MIN_CHARS_PER_LINE, Math.min(MAX_CHARS_PER_LINE, Math.round(width / PX_PER_CHAR)))
}

/**
 * The scroll geometry of one column: a size cache, prefix-sum offsets and the
 * window to paint.
 *
 * One instance per column, fed the column's FULL display order. That last part
 * is the contract the drag anchor and the multi-select both rely on: the window
 * decides what is painted, never what the column contains.
 */
export class IdeaWindow<T extends WindowRow> {
  /** Rows painted above and below the viewport. */
  readonly overscan: number
  /** Characters per line the estimates are built on. */
  charsPerLine: number

  private rows: readonly T[] = []
  private indexById = new Map<string, number>()
  private measuredById = new Map<string, number>()
  /** Slot size per row (row + inter-card gap). */
  private slots: number[] = []
  /** Offset of each row inside the list; `offsets[n]` is the total height. */
  private offsets: number[] = [0]
  private geometryDirty = true

  constructor(rows: readonly T[] = [], options: IdeaWindowOptions = {}) {
    this.overscan = Math.max(0, options.overscan ?? IDEA_WINDOW_OVERSCAN)
    this.charsPerLine = clampNumber(
      Math.round(options.charsPerLine ?? DEFAULT_CHARS_PER_LINE),
      MIN_CHARS_PER_LINE,
      MAX_CHARS_PER_LINE,
    )
    this.setRows(rows)
  }

  /** The full column, in display order — what a drop anchor may name. */
  get length(): number {
    return this.rows.length
  }

  /** Scrollable height of the whole column, in px. */
  get totalHeight(): number {
    this.ensureGeometry()
    return this.offsets[this.rows.length]!
  }

  /** Replace the column content, keeping the cache honest. */
  setRows(rows: readonly T[]): void {
    this.rows = rows
    this.indexById = new Map(rows.map((row, index) => [row.id, index]))
    // A measured height belongs to a row, not to a position: a filter that
    // re-orders the column must not move one card's height onto another. Sizes
    // for rows that left are dropped, so the cache cannot grow with the
    // session; a row that comes back is measured again, which is correct.
    for (const id of [...this.measuredById.keys()]) {
      if (!this.indexById.has(id)) this.measuredById.delete(id)
    }
    this.geometryDirty = true
  }

  /** Position of a row in the column, or -1 when it is not in it. */
  indexOf(id: string): number {
    return this.indexById.get(id) ?? -1
  }

  /** The row at `index`, or undefined past the end. */
  rowAt(index: number): T | undefined {
    return this.rows[index]
  }

  /** Top of a row's slot in px (clamped to the list). */
  offsetOf(index: number): number {
    this.ensureGeometry()
    if (index <= 0) return 0
    return this.offsets[Math.min(index, this.rows.length)]!
  }

  /** Effective height of a row: the measured one, else the estimate. */
  heightOf(id: string): number {
    const index = this.indexById.get(id)
    if (index === undefined) return 0
    return this.slotSize(index) - IDEA_CARD_GAP_PX
  }

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
  measure(id: string, height: number, anchorIndex: number): number {
    const index = this.indexById.get(id)
    // A non-positive height is not a measurement: jsdom reports 0 for every
    // element and a collapsed card must not poison the cache with it.
    if (index === undefined || !(height > 0)) return 0
    this.ensureGeometry()
    const anchor = Math.max(0, Math.min(anchorIndex, this.rows.length))
    const before = this.offsets[anchor]!
    const current = this.slotSize(index)
    const next = Math.round(height) + IDEA_CARD_GAP_PX
    // Sub-pixel churn is not a layout change; ignoring it keeps a
    // measure/resize feedback loop from re-rendering forever.
    if (Math.abs(next - current) < 1) return 0
    this.measuredById.set(id, Math.round(height))
    this.geometryDirty = true
    this.ensureGeometry()
    return this.offsets[anchor]! - before
  }

  /**
   * The rows to paint for a viewport starting at `scrollTop`.
   *
   * `viewport <= 0` answers with the WHOLE column: an unmeasurable viewport
   * cannot be windowed honestly, and painting everything is the one answer that
   * is never wrong.
   */
  window(scrollTop: number, viewport: number): WindowRange {
    const n = this.rows.length
    if (n === 0) return { start: 0, end: 0 }
    if (!(viewport > 0)) return { start: 0, end: n }
    this.ensureGeometry()
    const top = Math.max(0, scrollTop)
    const bottom = top + viewport

    // First row whose slot ends after the top of the viewport.
    let start = this.firstIndexAfter(top)
    let end = start
    while (end < n && this.offsets[end]! < bottom) end += 1
    // One extra row: `end` is the first row that STARTS past the bottom.
    if (end < n) end += 1

    start = Math.max(0, start - this.overscan)
    end = Math.min(n, end + this.overscan)
    return { start, end: Math.max(start, end) }
  }

  /** The rows of `range`, each with the top its slot sits at. */
  entries(range: WindowRange): WindowEntry<T>[] {
    this.ensureGeometry()
    const out: WindowEntry<T>[] = []
    for (let index = range.start; index < range.end; index++) {
      const row = this.rows[index]
      if (row !== undefined) out.push({ row, index, top: this.offsets[index]! })
    }
    return out
  }

  /** True when a row is inside the painted range (its DOM node exists). */
  isPainted(id: string, range: WindowRange): boolean {
    const index = this.indexById.get(id)
    return index !== undefined && index >= range.start && index < range.end
  }

  /**
   * The `scrollTop` that puts `id` in the middle of a `viewport`-tall window,
   * or undefined when the column does not hold it.
   *
   * A non-positive viewport asks only for "make the row visible": the row is
   * scrolled to the top edge, which is enough for the window to mount it and
   * for the caller's own `scrollIntoView` to finish the job.
   */
  scrollTopFor(id: string, viewport: number): number | undefined {
    const index = this.indexById.get(id)
    if (index === undefined) return undefined
    this.ensureGeometry()
    const maxScroll = Math.max(0, this.offsets[this.rows.length]! - Math.max(0, viewport))
    const rowHeight = this.slotSize(index)
    const lead = viewport > 0 ? Math.max(0, (viewport - rowHeight) / 2) : 0
    return clampNumber(this.offsets[index]! - lead, 0, maxScroll)
  }

  /**
   * Index of the row sitting at the top edge of a scrolled viewport.
   *
   * This is the anchor a measurement must preserve: it is the row the reader is
   * reading, and it is the one that must not move when the rows above it are
   * found to be taller (or shorter) than estimated.
   */
  anchorIndexFor(scrollTop: number): number {
    this.ensureGeometry()
    if (this.rows.length === 0) return 0
    const top = Math.max(0, scrollTop)
    // Last row that STARTS at or above the viewport top.
    let low = 0
    let high = this.rows.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.offsets[mid]! <= top) low = mid
      else high = mid - 1
    }
    return low
  }

  /** Effective slot size (row + gap) at `index`. */
  private slotSize(index: number): number {
    const row = this.rows[index]
    if (row === undefined) return 0
    // The gap is added on BOTH paths on purpose: a measured row that lost its
    // gap would shrink its slot by 8 px the moment it was measured, and every
    // row below it would jump up by the same amount under the reader's eyes.
    return (this.measuredById.get(row.id) ?? estimateIdeaCardHeight(row, this.charsPerLine)) + IDEA_CARD_GAP_PX
  }

  /** Rebuild the prefix sums after a row set or a size changed. */
  private ensureGeometry(): void {
    if (!this.geometryDirty) return
    const n = this.rows.length
    const offsets = new Array<number>(n + 1)
    offsets[0] = 0
    for (let index = 0; index < n; index++) {
      offsets[index + 1] = offsets[index]! + this.slotSize(index)
    }
    this.offsets = offsets
    this.geometryDirty = false
  }

  /** First index whose slot ENDS after `top` (binary search on the prefix sums). */
  private firstIndexAfter(top: number): number {
    let low = 0
    let high = this.rows.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.offsets[mid + 1]! <= top) low = mid + 1
      else high = mid
    }
    return Math.min(low, Math.max(0, this.rows.length - 1))
  }
}

function clampNumber(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.min(Math.max(value, lo), hi)
}