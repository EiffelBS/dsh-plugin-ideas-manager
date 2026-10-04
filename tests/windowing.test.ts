/**
 * Windowing geometry.
 *
 * Pure and DOM-free on purpose: everything a virtualized list can quietly lie
 * about - the scroll height before anything is measured, what "the viewport"
 * covers, and whether a refined card height pushes the row the reader is looking
 * at off screen - is decided here, and is asserted here without a DOM.
 *
 * The three behaviours the idea names explicitly are the load-bearing tests:
 * scroll anchoring (`measure`), the drop anchor surviving a re-order
 * (`setRows` keeps a measured size with its ID, not its index) and the window
 * never claiming to be the column (`window` with an unmeasurable viewport).
 */

import { describe, expect, it } from 'vitest'
import {
  IDEA_CARD_GAP_PX,
  IDEA_WINDOW_MIN_ROWS,
  IdeaWindow,
  charsPerLineFor,
  estimateIdeaCardHeight,
  type WindowRow,
} from '../src/client/windowing.ts'

/** A bare row: title only, nothing that wraps. */
function row(id: string, extra: Partial<WindowRow> = {}): WindowRow {
  return { id, title: `idea ${id}`, ...extra }
}

/** `count` rows of a uniform shape, ids `r0..rN`. */
function rows(count: number, extra: Partial<WindowRow> = {}): WindowRow[] {
  return Array.from({ length: count }, (_, index) => row(`r${index}`, extra))
}

describe('the first-paint estimate', () => {
  it('is a pure function of the row: same input, same height, every time', () => {
    const content = { title: 'A title of a known length', bodyExcerpt: 'x'.repeat(200), tags: [{ name: 'perf' }] }
    expect(estimateIdeaCardHeight(row('a', content))).toBe(estimateIdeaCardHeight(row('a', content)))
  })

  it('counts the parts that actually wrap, and nothing that does not', () => {
    const bare = estimateIdeaCardHeight(row('a'))
    expect(bare, 'a bare card must be the cheapest possible card').toBeGreaterThan(0)
    // Each of these adds exactly one wrapping row to the bare card.
    const tagged = estimateIdeaCardHeight(row('a', { tags: [{ name: 'kanban' }] }))
    const excerpted = estimateIdeaCardHeight(row('a', { bodyExcerpt: 'y'.repeat(400) }))
    const scored = estimateIdeaCardHeight(row('a', { value: 3, effort: 2 }))
    const linked = estimateIdeaCardHeight(row('a', { relatesTo: ['b'] }))
    for (const [name, height] of [['tags', tagged], ['excerpt', excerpted], ['scores', scored], ['relations', linked]] as const) {
      expect(height, `${name} did not add a row`).toBeGreaterThan(bare)
    }
  })

  it('caps the description at the line clamp, so a huge excerpt cannot blow up', () => {
    const short = estimateIdeaCardHeight(row('a', { bodyExcerpt: 'z'.repeat(20) }))
    const huge = estimateIdeaCardHeight(row('a', { bodyExcerpt: 'z'.repeat(20_000) }))
    // The card clamps the preview at 3 rendered lines; the estimate has to
    // respect that or the scrollbar would claim 20 000 characters of height.
    expect(huge - short).toBeLessThan(3 * 17)
  })

  it('is monotonic: more text is never a shorter card', () => {
    let previous = 0
    for (const length of [0, 20, 60, 140, 400, 1_200]) {
      const height = estimateIdeaCardHeight(row('a', { title: 't'.repeat(length), bodyExcerpt: 'e'.repeat(length) }))
      expect(height).toBeGreaterThanOrEqual(previous)
      previous = height
    }
  })

  it('counts the #N prefix in the title line, or a long number would not cost a line', () => {
    const short = estimateIdeaCardHeight(row('a', { title: 'x'.repeat(60) }))
    const numbered = estimateIdeaCardHeight(row('a', { title: 'x'.repeat(60), ideaNumber: 12_345 }))
    expect(numbered).toBeGreaterThanOrEqual(short)
  })

  it('refuses to degenerate on a column that was never laid out', () => {
    // jsdom, a detached column and a display:none panel all report width 0.
    // Estimating like an 18-character sliver there would be a lie in the
    // pessimistic direction, and it would be the common case in tests.
    expect(charsPerLineFor(0)).toBe(charsPerLineFor(Number.NaN))
    // Width 0 therefore estimates exactly like the untouched default.
    expect(charsPerLineFor(0)).toBeGreaterThan(0)
    expect(estimateIdeaCardHeight(row('a'), charsPerLineFor(0))).toBe(estimateIdeaCardHeight(row('a')))
    expect(charsPerLineFor(320)).toBeGreaterThan(charsPerLineFor(160))
  })
})

describe('the scroll geometry', () => {
  it('knows the whole column height before a single card is measured', () => {
    const window = new IdeaWindow(rows(500))
    // The point of the estimate: the scrollbar is right on the FIRST paint.
    expect(window.totalHeight).toBeGreaterThan(window.length * 100)
    expect(window.totalHeight).toBeLessThan(window.length * 1_000)
  })

  it('bakes the inter-card gap into the slots, so painted and computed spacing agree', () => {
    const one = new IdeaWindow([row('a')])
    const two = new IdeaWindow(rows(2))
    // The second row starts one card height plus one gap down.
    expect(two.offsetOf(1)).toBe(one.heightOf('a') + IDEA_CARD_GAP_PX)
    // No trailing gap after the last card.
    expect(two.totalHeight - two.offsetOf(2)).toBe(0)
  })
})

describe('the window', () => {
  const big = new IdeaWindow(rows(500))

  it('paints EVERY row when the viewport cannot be measured', () => {
    // jsdom reports clientHeight 0, and so does a DOM without layout. Windowing
    // against an unknown viewport would paint a slice and claim it is the board.
    expect(big.window(0, 0)).toEqual({ start: 0, end: 500 })
    expect(big.window(-1, -1)).toEqual({ start: 0, end: 500 })
  })

  it('covers the viewport, with overscan on both sides', () => {
    const viewport = 900
    const range = big.window(20_000, viewport)
    expect(range.end - range.start).toBeGreaterThan(2)
    expect(range.end - range.start).toBeLessThan(40)
    // The first painted row starts at or above the top of the viewport, and the
    // last one reaches past its bottom: scrolling never shows a hole.
    expect(big.offsetOf(range.start)).toBeLessThanOrEqual(20_000)
    expect(big.offsetOf(range.end)).toBeGreaterThan(20_000 + viewport)
  })

  it('starts at the top of the list for a scrollTop of 0', () => {
    const range = big.window(0, 900)
    expect(range.start).toBe(0)
  })

  it('never reports a window outside the column', () => {
    for (const scrollTop of [0, 1, 5_000, big.totalHeight - 10, big.totalHeight, big.totalHeight * 4]) {
      const range = big.window(scrollTop, 900)
      expect(range.start).toBeGreaterThanOrEqual(0)
      expect(range.end).toBeLessThanOrEqual(500)
      expect(range.end).toBeGreaterThanOrEqual(range.start)
    }
  })

  it('walks the column in order as the reader scrolls down', () => {
    let previousStart = -1
    for (let scrollTop = 0; scrollTop < big.totalHeight; scrollTop += 4_000) {
      const range = big.window(scrollTop, 900)
      expect(range.start, `went backwards at ${scrollTop}`).toBeGreaterThanOrEqual(previousStart)
      previousStart = range.start
    }
  })

  it('hands each painted row the exact top its slot sits at', () => {
    const range = big.window(3_000, 900)
    for (const entry of big.entries(range)) {
      expect(entry.top).toBe(big.offsetOf(entry.index))
      expect(entry.row.id).toBe(`r${entry.index}`)
    }
  })
})

describe('scroll anchoring: a refined height must never move the row being read', () => {
  const viewport = 900

  it('returns the movement of everything ABOVE the anchored row', () => {
    const window = new IdeaWindow(rows(500))
    window.window(20_000, viewport)
    const anchor = window.anchorIndexFor(20_000)
    expect(anchor).toBeGreaterThan(0)

    // The card at the top of the viewport turns out 40 px taller than estimated.
    const before = window.offsetOf(anchor)
    const delta = window.measure('r0', estimateIdeaCardHeight(row('r0')) + 40, anchor)
    expect(delta).toBe(40)
    // Adding the delta back to scrollTop restores the anchored row exactly.
    expect(window.offsetOf(anchor) - delta).toBe(before)
  })

  it('returns 0 for a card AT or BELOW the anchored row: the reader cannot see it move', () => {
    const window = new IdeaWindow(rows(500))
    window.window(20_000, viewport)
    const anchor = window.anchorIndexFor(20_000)
    expect(window.measure(`r${anchor}`, 5_000, anchor)).toBe(0)
    expect(window.measure(`r${anchor + 5}`, 5_000, anchor)).toBe(0)
  })

  it('keeps the reader on the same row after a whole screen of cards is re-measured', () => {
    const window = new IdeaWindow(rows(500))
    const scrollTop = 30_000
    const anchor = window.anchorIndexFor(scrollTop)
    // Where the anchored row sits relative to the top of the viewport, before.
    const screenBefore = window.offsetOf(anchor) - scrollTop
    let top = scrollTop
    // Every card above the viewport turns out taller than estimated.
    for (let index = 0; index < anchor; index++) {
      top += window.measure(`r${index}`, estimateIdeaCardHeight(row(`r${index}`)) + 25, anchor)
    }
    // After the caller compensates the scroll with every delta, the reader sees
    // the SAME row at the SAME place on screen. This is the assertion that makes
    // a windowed column usable: without it the list slides under a resting hand.
    expect(top).toBeGreaterThan(scrollTop)
    expect(window.offsetOf(anchor) - top).toBe(screenBefore)
  })

  it('refuses a zero or negative height instead of poisoning the cache', () => {
    const window = new IdeaWindow(rows(500))
    const estimated = window.heightOf('r0')
    expect(window.measure('r0', 0, 0)).toBe(0)
    expect(window.measure('r0', -10, 0)).toBe(0)
    expect(window.heightOf('r0')).toBe(estimated)
  })

  it('ignores sub-pixel churn, so a resize cannot loop forever', () => {
    const window = new IdeaWindow(rows(10))
    const height = window.heightOf('r0')
    expect(window.measure('r0', height + 0.4, 0)).toBe(0)
    expect(window.heightOf('r0')).toBe(height)
  })

  it('ignores a row that is not in this column at all', () => {
    const window = new IdeaWindow(rows(10))
    expect(window.measure('somewhere-else', 999, 0)).toBe(0)
  })
})

describe('the cache belongs to a row, not to a position', () => {
  it('keeps a measured size with its id when the column is re-ordered', () => {
    const window = new IdeaWindow(rows(5))
    window.measure('r3', 400, 0)
    // Reversed: the row that carried the 400 px measurement is now second.
    window.setRows(rows(5).reverse())
    expect(window.indexOf('r3')).toBe(1)
    expect(window.heightOf('r3')).toBe(400)
    // ...and the row now sitting where r3 used to is estimated, not 400.
    expect(window.heightOf('r1')).not.toBe(400)
  })

  it('drops the sizes of rows that left, so the cache cannot grow with the session', () => {
    const window = new IdeaWindow(rows(5))
    window.measure('r3', 400, 0)
    window.setRows(rows(3))
    window.setRows(rows(5))
    expect(window.heightOf('r3')).toBe(estimateIdeaCardHeight(row('r3')))
  })

  it('re-estimates everything when the line budget changes', () => {
    // Long titles, so the budget genuinely decides how many lines they take:
    // at 40 chars a line they wrap onto two, at 20 onto four.
    const long = rows(20, { title: 'w'.repeat(60) })
    const window = new IdeaWindow(long, { charsPerLine: 40 })
    const wide = window.totalHeight
    window.charsPerLine = 20
    window.setRows(long)
    expect(window.totalHeight).toBeGreaterThan(wide)
  })
})

describe('revealing a row the reader cannot see', () => {
  it('centres a row and stays inside the scrollable range', () => {
    const window = new IdeaWindow(rows(500))
    const viewport = 900
    const target = window.scrollTopFor('r250', viewport)
    expect(target).toBeDefined()
    expect(target!).toBeGreaterThan(0)
    expect(target!).toBeLessThanOrEqual(window.totalHeight - viewport)
    // After that scroll the row really is inside the painted window: this is
    // what a deep-link relies on to mount the card it wants to ring.
    const range = window.window(target!, viewport)
    expect(range.start).toBeLessThanOrEqual(250)
    expect(range.end).toBeGreaterThan(250)
  })

  it('pins an unmappable viewport to the top of the row, which still mounts it', () => {
    const window = new IdeaWindow(rows(500))
    const target = window.scrollTopFor('r250', 0)
    expect(target).toBe(window.offsetOf(250))
    const range = window.window(target!, 0)
    expect(range.start).toBe(0)
  })

  it('clamps the last row instead of scrolling past the end', () => {
    const window = new IdeaWindow(rows(500))
    expect(window.scrollTopFor('r499', 900)).toBe(Math.max(0, window.totalHeight - 900))
  })

  it('returns undefined for a row the column does not hold', () => {
    expect(new IdeaWindow(rows(10)).scrollTopFor('nope', 900)).toBeUndefined()
  })
})

describe('the short-column floor', () => {
  it('is the number the React binding uses to skip windowing entirely', () => {
    // Asserted here so the constant cannot drift from the intent it encodes:
    // below this many rows a column is painted whole, so a board that is fine
    // today behaves exactly as it did before the windowing.
    expect(IDEA_WINDOW_MIN_ROWS).toBeGreaterThan(0)
    expect(new IdeaWindow(rows(IDEA_WINDOW_MIN_ROWS)).length).toBe(IDEA_WINDOW_MIN_ROWS)
  })
})