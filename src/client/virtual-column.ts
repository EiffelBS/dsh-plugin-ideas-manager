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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { IdeaStatus } from '../core/ideas.ts'
import type { IdeaListRow } from '../protocol.ts'
import {
  IDEA_WINDOW_MIN_ROWS,
  IdeaWindow,
  charsPerLineFor,
  type WindowEntry,
  type WindowRange,
} from './windowing.ts'

/** What the board needs from one windowed column. */
export interface VirtualColumn {
  /** The full column, in display order. Never windowed. */
  readonly rowCount: number
  /** True when the column paints fewer rows than it holds. */
  readonly windowed: boolean
  /** Rows to paint, each with the top its slot sits at. */
  readonly entries: readonly WindowEntry<IdeaListRow>[]
  /** Height of the scrollable spacer standing in for the unpainted rows. */
  readonly totalHeight: number
  /** Attach to the scrolling element of the column. */
  readonly scrollerRef: (element: HTMLElement | null) => void
  /** Attach to one rendered card wrapper. */
  readonly cardRef: (id: string) => (element: HTMLElement | null) => void
  /** Scroll a row into the painted window; true when the column had to move. */
  readonly reveal: (id: string) => boolean
}

/** The windowed columns plus the one scroll handler they share. */
export interface VirtualColumnsBinding {
  readonly columns: ReadonlyMap<IdeaStatus, VirtualColumn>
  /** Attach to each column's scrolling element as its `onScroll`. */
  readonly onScroll: (event: { currentTarget: HTMLElement | null }) => void
}

function sameRange(a: WindowRange, b: WindowRange): boolean {
  return a.start === b.start && a.end === b.end
}

function fullRange(length: number): WindowRange {
  return { start: 0, end: length }
}

/** The two layout values a window is computed from, cached between renders. */
interface ScrollView {
  readonly scrollTop: number
  readonly viewport: number
}

/**
 * The last viewport height each column actually had, kept at MODULE scope so it
 * survives the panel being closed and re-opened.
 *
 * This is what keeps the first render of a re-opened board cheap. A board that
 * has been opened once already knows how tall its columns are; one that has not
 * falls back to `provisionalViewport()`, and the ref callback corrects it in the
 * same commit. Without this the feature would still build 500 cards on every
 * re-open, which is exactly what it exists to avoid.
 */
const lastViewport = new Map<IdeaStatus, number>()

/**
 * A safe budget for a column nobody has measured yet.
 *
 * `window.innerHeight` is readable synchronously, with no layout, and a column
 * can never be taller than the window it is drawn in - so it is an upper bound
 * that bounds how many cards the FIRST render builds. The scroller ref replaces
 * it with the real measurement before the browser paints.
 */
function provisionalViewport(): number {
  if (typeof window === 'undefined') return 0
  return window.innerHeight > 0 ? window.innerHeight : 0
}

/**
 * Upper bound on a REMEMBERED column height, as a multiple of the window.
 *
 * A column cannot be usefully taller than the window it is drawn in, so a
 * measurement beyond this is not a viewport: it is a panel rendered somewhere
 * it has no height (a detached container, a hidden tab, a display:none
 * ancestor). Remembering that number would pin a useless budget for the rest of
 * the session and every later open would build the whole column again.
 */
const MAX_REMEMBERED_VIEWPORT_FACTOR = 4

function rememberViewport(status: IdeaStatus, viewport: number): number {
  const ceiling = Math.max(provisionalViewport(), 1) * MAX_REMEMBERED_VIEWPORT_FACTOR
  const remembered = viewport > 0 ? Math.min(viewport, ceiling) : viewport
  lastViewport.set(status, remembered)
  return remembered
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
export function useVirtualColumns(
  rowsByStatus: Readonly<Record<IdeaStatus, IdeaListRow[]>>,
  statuses: readonly IdeaStatus[],
): VirtualColumnsBinding {
  const statusKey = statuses.join(',')
  // One geometry per column, kept across renders so a measured height survives
  // the next poll. Created lazily: a hidden column is never constructed.
  const windowsRef = useRef(new Map<IdeaStatus, IdeaWindow<IdeaListRow>>())
  const scrollersRef = useRef(new Map<IdeaStatus, HTMLElement>())
  // Mounted card wrappers, so a viewport resize can re-measure without a
  // re-render. Keyed by row id; a row can only be in one column at a time.
  const cardElsRef = useRef(new Map<string, HTMLElement>())
  const observerRef = useRef<ResizeObserver | null>(null)
  // Memoized ref callbacks, keyed by column and id.
  const cardRefsRef = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const scrollerRefsRef = useRef(new Map<IdeaStatus, (element: HTMLElement | null) => void>())
  // Cached scroll geometry per column: the only layout values the render reads,
  // and the reason a render never forces a reflow.
  const viewRef = useRef(new Map<IdeaStatus, ScrollView>())
  const [tick, bump] = useState(0)
  // Read inside callbacks that must not re-subscribe on every render.
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses

  const windowFor = useCallback((status: IdeaStatus): IdeaWindow<IdeaListRow> => {
    const known = windowsRef.current.get(status)
    if (known !== undefined) return known
    const created = new IdeaWindow<IdeaListRow>()
    windowsRef.current.set(status, created)
    return created
  }, [])

  /** The window for a column, from its cached scroll geometry. */
  const rangeFor = useCallback((window: IdeaWindow<IdeaListRow>, scrollTop: number, viewport: number): WindowRange => {
    // Below the floor the column is painted whole: windowing a short column buys
    // nothing and would change behaviour on every board that is fine today.
    if (window.length <= IDEA_WINDOW_MIN_ROWS) return fullRange(window.length)
    return window.window(scrollTop, viewport)
  }, [])

  /* --- measurement --------------------------------------------------------
   * Two paths, deliberately. The ref callback measures in the commit phase, so
   * the geometry is right on the FIRST paint; a ResizeObserver catches what
   * only shows up later: a column resize, a font swap, a re-rendered markdown
   * block. */
  const measureAll = useCallback((): void => {
    let moved = 0
    let changed = false
    for (const status of statusesRef.current) {
      const window = windowsRef.current.get(status)
      const scroller = scrollersRef.current.get(status)
      if (window === undefined || scroller === undefined) continue
      const anchor = window.anchorIndexFor(scroller.scrollTop)
      let delta = 0
      for (const [id, element] of cardElsRef.current) {
        if (window.indexOf(id) < 0) continue
        delta += window.measure(id, element.offsetHeight, anchor)
      }
      moved += delta
      if (delta !== 0) changed = true
    }
    // Anchoring: a size change ABOVE the anchored row moved the list under the
    // pointer. Adding the delta back is what keeps the row the reader is
    // looking at exactly where it was. Without it the column slides under a
    // resting hand as the cards above resolve to their real heights, and a
    // deep-link or a drop lands on a row the reader never saw move.
    if (moved !== 0) {
      for (const [status, element] of scrollersRef.current) {
        element.scrollTop += moved
        // Keep the cached geometry in step with the compensation, or the next
        // render would derive the window from a scrollTop that no longer exists.
        viewRef.current.set(status, { scrollTop: element.scrollTop, viewport: element.clientHeight })
      }
      changed = true
    }
    if (changed) bump(value => value + 1)
  }, [])

  /* --- this paint's geometry ---------------------------------------------
   * `setRows` is idempotent and drops the sizes of rows that left, so calling
   * it during render is a cache update, not a side effect: the same render must
   * produce the same geometry whatever ran before it.
   *
   * The window is DERIVED HERE from the cached scroll geometry rather than
   * stored from the last event. That is what keeps it honest: a poll that adds
   * a capture, a filter that removes 300 cards or a cold panel that has just
   * received its first list all change the row list without any scroll event,
   * and a range carried over from the previous list would paint a slice of the
   * board and call it the board. */
  const columns = new Map<IdeaStatus, VirtualColumn>()
  let rowCountKey = ''
  for (const status of statuses) {
    const window = windowFor(status)
    const rows = rowsByStatus[status] ?? []
    const scroller = scrollersRef.current.get(status)
    if (scroller !== undefined && scroller.clientWidth > 0) {
      const perLine = charsPerLineFor(scroller.clientWidth)
      if (perLine !== window.charsPerLine) {
        window.charsPerLine = perLine
        window.setRows(rows)
      }
    }
    window.setRows(rows)
    rowCountKey += `${window.length},`
    // Last measured height for this column, else the last one it had in this
    // session, else a bound the window can never exceed. Never zero when a
    // budget is knowable: a zero viewport is the "paint everything" answer.
    const view = viewRef.current.get(status)
      ?? { scrollTop: 0, viewport: lastViewport.get(status) ?? provisionalViewport() }
    const range = rangeFor(window, view.scrollTop, view.viewport)

    // Memoized per column, for the same reason as the card refs: a ref callback
    // whose identity changes is detached and re-attached on EVERY render, and
    // an attach bumps the tick - so a fresh closure here is an infinite render
    // loop, not a harmless re-measure.
    const knownScrollerRef = scrollerRefsRef.current.get(status)
    const scrollerRef = knownScrollerRef ?? ((element: HTMLElement | null): void => {
      if (element === null) {
        scrollersRef.current.delete(status)
        viewRef.current.delete(status)
        bump(value => value + 1)
        return
      }
      scrollersRef.current.set(status, element)
      observerRef.current?.observe(element)
      // Remember a CONSERVATIVE height for the next mount, but window against
      // the live one: this is what makes re-opening the panel cheap, and it
      // refuses to let one absurd measurement (a panel rendered where it has
      // no height) pin a budget that rebuilds the whole column every later open.
      rememberViewport(status, element.clientHeight)
      // Runs in the commit phase, so the corrected window is in place BEFORE
      // the browser paints. Mounting a 500-card column must not first build
      // 500 cards and then throw them away.
      const next = { scrollTop: element.scrollTop, viewport: element.clientHeight }
      const previous = viewRef.current.get(status)
      viewRef.current.set(status, next)
      // Re-render ONLY when the correction actually moves the window. Attaching
      // a scroller is the one thing every mount does, so an unconditional bump
      // there costs one extra full board render per panel open to learn
      // something a re-opened panel usually already knows.
      if (previous !== undefined && previous.scrollTop === next.scrollTop && previous.viewport === next.viewport) return
      bump(value => value + 1)
    })
    scrollerRefsRef.current.set(status, scrollerRef)

    const cardRef = (id: string) => {
      const key = `${status}|${id}`
      const known = cardRefsRef.current.get(key)
      if (known !== undefined) return known
      const created = (element: HTMLElement | null): void => {
        const previous = cardElsRef.current.get(id)
        if (previous !== undefined && previous !== element) {
          observerRef.current?.unobserve(previous)
          cardElsRef.current.delete(id)
        }
        if (element === null) {
          cardRefsRef.current.delete(key)
          return
        }
        cardElsRef.current.set(id, element)
        observerRef.current?.observe(element)
        // A DOM that never laid out (jsdom, a detached column) reports 0, and
        // `measure` refuses it: the estimate stands rather than the cache being
        // poisoned with zeros.
        const scroller = scrollersRef.current.get(status)
        window.measure(id, element.offsetHeight, window.anchorIndexFor(scroller?.scrollTop ?? 0))
      }
      cardRefsRef.current.set(key, created)
      return created
    }

    const reveal = (id: string): boolean => {
      const element = scrollersRef.current.get(status)
      if (element === undefined) return false
      const target = window.scrollTopFor(id, element.clientHeight)
      if (target === undefined) return false
      const maxScroll = Math.max(0, window.totalHeight - element.clientHeight)
      const clamped = Math.min(Math.max(target, 0), maxScroll)
      if (Math.abs(element.scrollTop - clamped) < 1) return false
      element.scrollTop = clamped
      viewRef.current.set(status, { scrollTop: clamped, viewport: element.clientHeight })
      bump(value => value + 1)
      return true
    }

    columns.set(status, {
      rowCount: window.length,
      windowed: range.end - range.start < window.length,
      entries: window.entries(range),
      totalHeight: window.totalHeight,
      scrollerRef,
      cardRef,
      reveal,
    })
  }

  /* --- effects ---------------------------------------------------------- */
  // A scroll is the one event that moves the window. It sets state only when the
  // paint would actually change, so a scroll inside the overscan costs nothing.
  const onScroll = useCallback((event: { currentTarget: HTMLElement | null }): void => {
    const element = event.currentTarget
    if (element === null) return
    for (const [status, window] of windowsRef.current) {
      if (scrollersRef.current.get(status) !== element) continue
      const nextView = { scrollTop: element.scrollTop, viewport: element.clientHeight }
      rememberViewport(status, element.clientHeight)
      const previous = viewRef.current.get(status)
      viewRef.current.set(status, nextView)
      if (previous !== undefined && sameRange(rangeFor(window, previous.scrollTop, previous.viewport), rangeFor(window, nextView.scrollTop, nextView.viewport))) break
      bump(value => value + 1)
    }
  }, [rangeFor])

  // Re-measure whenever the columns or their row counts moved: a capture, a
  // filter, a tab switch or a poll brings new cards into the painted set.
  useEffect(() => { measureAll() }, [measureAll, statusKey, rowCountKey, tick])

  // One observer for the whole board, created by an effect; cards attached
  // before it starts are picked up by the loop below. A viewport resize also
  // changes the cached geometry, so refresh it here rather than only measuring.
  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      for (const [status, element] of scrollersRef.current) {
        rememberViewport(status, element.clientHeight)
        viewRef.current.set(status, { scrollTop: element.scrollTop, viewport: element.clientHeight })
      }
      measureAll()
      bump(value => value + 1)
    })
    observerRef.current = observer
    for (const element of scrollersRef.current.values()) observer.observe(element)
    for (const element of cardElsRef.current.values()) observer.observe(element)
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [measureAll, statusKey])

  return { columns, onScroll }
}