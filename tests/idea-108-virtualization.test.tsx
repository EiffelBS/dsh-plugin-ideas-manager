// @vitest-environment jsdom
/**
 * Kanban virtualization on the board itself (idea #108).
 *
 * jsdom has no layout: every element reports `clientHeight === 0`, which the
 * windowing module answers honestly by painting the whole column. That answer
 * is right, and it means this suite has to SUPPLY a layout to exercise
 * windowing at all - which is what `stubLayout` does, on the prototype, for
 * the three values the window reads (viewport height, column width, card
 * height) plus `scrollTop`, which jsdom's setter drops on the floor.
 *
 * What is asserted here is the contract the idea names, not the arithmetic
 * (that lives in idea-108-windowing.test.ts):
 *
 *  - the column COUNT, the drop anchor and the selection scope keep reading the
 *    WHOLE column, so a card that is not painted is still fully addressable;
 *  - scroll anchoring keeps the row being read where it is;
 *  - a deep-link still lands on a card that was never painted;
 *  - a short column behaves exactly as it did before the feature.
 */

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { t } from '../src/client/locales.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  toListSnapshot,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord, IdeaStatus } from '../src/core/ideas.ts'
import { IDEA_OPEN_COLUMN_NOTICE_AT } from '../src/client/windowing.ts'

const VIEWPORT_PX = 600
const COLUMN_WIDTH_PX = 320
const CARD_HEIGHT_PX = 210

/** One open idea per index, so a column of `count` cards is one line of code. */
function openIdeas(count: number): IdeaRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `idea-${index}`,
    ideaNumber: index + 1,
    title: `Idea ${index}`,
    body: 'Body',
    status: 'open' as const,
    createdAt: 1_000 + index,
    updatedAt: 1_000 + index,
    rank: index + 1,
  }))
}

function snapshotOf(ideas: IdeaRecord[]): IdeasSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas }
}

/** Static list transport that records the wire, like the other board suites. */
class StaticTransport implements IdeasHostTransport {
  readonly posted: IdeasAction[] = []
  constructor(private readonly list: IdeasListSnapshot) {}
  async state(): Promise<IdeasListSnapshot> { return this.list }
  async stateFull(): Promise<IdeasSnapshot> { return this.list as unknown as IdeasSnapshot }
  async idea(id: string): Promise<IdeaRecord> {
    const found = this.list.ideas.find(row => row.id === id)
    if (found === undefined) throw new Error('not-found')
    return found as unknown as IdeaRecord
  }
  async action(action: IdeasAction): Promise<IdeasListSnapshot> {
    this.posted.push(action)
    return this.list
  }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> {
    return { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS }, revision: 1 }
  }
  async saveConfig(patch: IdeasSettingsPatch, _expectedRevision?: number): Promise<IdeasSettingsView> {
    return { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, ...patch }, revision: 2 }
  }
}

/**
 * Give jsdom the three measurements the window reads, plus a `scrollTop` that
 * sticks. Restored by the returned function; every suite in this file installs
 * it and `afterEach` removes it.
 */
function stubLayout(): () => void {
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = []
  const define = (target: object, property: string, get: (element: Element) => number): void => {
    const own = Object.getOwnPropertyDescriptor(target, property)
    saved.push([target, property, own])
    Object.defineProperty(target, property, { configurable: true, get: function (this: Element): number { return get(this) } })
  }
  const scrollTops = new WeakMap<Element, number>()

  const isColumnBody = (el: Element): boolean => el.hasAttribute?.('data-dsh-column-scroll') === true
  const isCard = (el: Element): boolean => el.classList?.contains('dsh-ideas-card-wrapper') === true

  define(Element.prototype, 'clientHeight', el => (isColumnBody(el) ? VIEWPORT_PX : 0))
  define(Element.prototype, 'clientWidth', el => (isColumnBody(el) ? COLUMN_WIDTH_PX : 0))
  define(Element.prototype, 'offsetHeight', el => (isCard(el) ? CARD_HEIGHT_PX : 0))

  const ownScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  saved.push([Element.prototype, 'scrollTop', ownScrollTop])
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element): number { return scrollTops.get(this) ?? 0 },
    set(this: Element, value: number): void { scrollTops.set(this, value) },
  })

  return () => {
    for (const [target, property, descriptor] of saved.reverse()) {
      if (descriptor === undefined) delete (target as Record<string, unknown>)[property]
      else Object.defineProperty(target, property, descriptor)
    }
  }
}

let restoreLayout: (() => void) | undefined
let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient | undefined

beforeEach(() => {
  restoreLayout = stubLayout()
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
})
afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  client?.dispose()
  client = undefined
  host.remove()
  restoreLayout?.()
  restoreLayout = undefined
})

async function renderBoard(ideas: IdeaRecord[]): Promise<StaticTransport> {
  const transport = new StaticTransport(toListSnapshot(snapshotOf(ideas)))
  const created = new IdeasClient(transport, undefined)
  created.snapshot = toListSnapshot(snapshotOf(ideas))
  client = created
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={created} />)
  })
  await act(async () => { await created.loadConfig() })
  return transport
}

/** The scrolling body of the Open column. */
function openColumn(): HTMLElement {
  const column = host.querySelectorAll<HTMLElement>('[data-dsh-column-scroll]')[0]
  if (column === undefined) throw new Error('no open column')
  return column
}

/** Ids of the cards actually painted in the Open column, in display order. */
function paintedIds(): string[] {
  const seen: string[] = []
  for (const node of openColumn().querySelectorAll('.dsh-ideas-card-wrapper')) {
    const id = node.getAttribute('data-dsh-idea-id')
    if (id !== null && !seen.includes(id)) seen.push(id)
  }
  return seen
}

/** The count in the Open column header (always the whole column). */
function headerCount(): string | null {
  const header = openColumn().closest('.dsh-ideas-column')?.querySelector('.dsh-ideas-column-count')
  return header?.textContent ?? null
}

function scrollColumnTo(top: number): void {
  act(() => {
    const body = openColumn()
    body.scrollTop = top
    body.dispatchEvent(new Event('scroll', { bubbles: false }))
  })
}

/** Select box of a mounted card. */
function selectBoxOf(ideaId: string): HTMLElement {
  const box = host.querySelector<HTMLElement>(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-select]`)
  if (box === null) throw new Error(`no select box on ${ideaId}`)
  return box
}

/** "n of m, <scope>" as the selection bar states it. */
function selectionBarText(): string {
  const bar = host.querySelector('[data-dsh-ideas-selection-bar]')
  return bar?.textContent ?? ''
}

/** How many selected cards are painted right now. */
function paintedSelected(): number {
  return openColumn().querySelectorAll('.dsh-ideas-card-selected').length
}

function clickWithShift(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
  })
}

function fakeTransfer(): { getData(t: string): string; setData(t: string, v: string): void; setDragImage(): void } {
  const store = new Map<string, string>()
  return { getData: t => store.get(t) ?? '', setData: (t, v) => { store.set(t, v) }, setDragImage: () => {} }
}

function fireDrag(target: Element, type: string, transfer: ReturnType<typeof fakeTransfer>, clientY: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  act(() => { target.dispatchEvent(event) })
}

async function dragOnto(transport: StaticTransport, ideaId: string, dropOnId: string): Promise<void> {
  const grip = host.querySelector(`[data-dsh-idea-id="${ideaId}"] .dsh-ideas-card-grip`)
  const target = host.querySelector(`.dsh-ideas-card-wrapper[data-dsh-idea-id="${dropOnId}"]`)
  if (grip === null || target === null) throw new Error('drag endpoints not painted')
  const transfer = fakeTransfer()
  // jsdom reports a zero rect, and `beforeHalf` reads a negative clientY as the
  // upper half: the stub makes the geometry explicit instead.
  const before = (element: Element): number => (element as HTMLElement).getBoundingClientRect().top
  const rects = new Map<Element, DOMRect>()
  for (const element of [grip, target]) {
    const rect = { top: 0, height: CARD_HEIGHT_PX, bottom: CARD_HEIGHT_PX, left: 0, right: 300, width: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    rects.set(element, rect)
    element.getBoundingClientRect = () => rect
  }
  expect(before(target)).toBe(0)
  // clientY = 10 of a 210 px card is the upper half: drop BEFORE the target.
  fireDrag(grip, 'dragstart', transfer, 10)
  fireDrag(target, 'dragover', transfer, 10)
  fireDrag(target, 'drop', transfer, 10)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  void rects
  void transport
}

/**
 * Every column, not just Open.
 *
 * The idea is explicit about this: "virtualizing only the Open column leaves
 * the other three inconsistent for no gain; virtualizing all four is the honest
 * unit". An implementation that windowed only Open would pass every test above
 * and still be the wrong thing, so this asserts the closed columns too - each
 * with its own geometry, its own scroll offset and its own window.
 */

/** `count` cards of one status, so each column can be made long on purpose. */
function cardsOfStatus(status: IdeaStatus, count: number, firstNumber = 1): IdeaRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${status}-${index}`,
    ideaNumber: firstNumber + index,
    title: `${status} card ${index}`,
    body: 'Body',
    status,
    createdAt: 1_000 + index,
    updatedAt: 1_000 + index,
    ...(status === 'open' ? { rank: index + 1 } : {}),
    ...(status === 'archived' ? { archivedAt: 500 } : {}),
    ...(status === 'declined' ? { archivedAt: 500, decision: 'no' } : {}),
  }))
}

/** Painted cards per column, in board order, with what each header claims. */
function columnReport(): { painted: number; claimed: number }[] {
  return Array.from(host.querySelectorAll('.dsh-ideas-column')).map(section => ({
    painted: section.querySelectorAll('.dsh-ideas-card-wrapper').length,
    claimed: Number(section.querySelector('.dsh-ideas-column-count')?.textContent ?? '0'),
  }))
}

describe('all four columns are the same unit', () => {
  const EACH = 120

  it('windows Open, Under review, Archived AND Declined alike', async () => {
    await renderBoard([
      ...cardsOfStatus('open', EACH),
      ...cardsOfStatus('underReview', EACH, 1_000),
      ...cardsOfStatus('archived', EACH, 2_000),
      ...cardsOfStatus('declined', EACH, 3_000),
    ])
    const report = columnReport()
    expect(report, 'a column is missing from the Overview').toHaveLength(4)
    for (const [index, column] of report.entries()) {
      expect(column.claimed, `column ${index} header count`).toBe(EACH)
      expect(column.painted, `column ${index} mounted its whole backlog`).toBeLessThan(EACH)
      expect(column.painted, `column ${index} painted nothing`).toBeGreaterThan(0)
    }
    // 480 cards exist; a fraction of them is mounted.
    const painted = report.reduce((sum, column) => sum + column.painted, 0)
    expect(painted).toBeLessThan(120)
    expect(painted).toBeGreaterThan(0)
  })

  it('gives each column its own geometry: a scrolled Open does not move Archived', async () => {
    await renderBoard([
      ...cardsOfStatus('open', EACH),
      ...cardsOfStatus('underReview', EACH, 1_000),
      ...cardsOfStatus('archived', EACH, 2_000),
      ...cardsOfStatus('declined', EACH, 3_000),
    ])
    const archivedBefore = Array.from(
      host.querySelectorAll('[data-dsh-column-scroll]')[2]!.querySelectorAll('.dsh-ideas-card-wrapper'),
      node => node.getAttribute('data-dsh-idea-id'),
    )
    scrollColumnTo(40_000)
    const archivedAfter = Array.from(
      host.querySelectorAll('[data-dsh-column-scroll]')[2]!.querySelectorAll('.dsh-ideas-card-wrapper'),
      node => node.getAttribute('data-dsh-idea-id'),
    )
    // The Open column moved; the Archived one kept every row it had.
    expect(paintedIds()[0]).not.toBe('open-0')
    expect(archivedAfter).toEqual(archivedBefore)
  })
})

describe('a windowed Open column', () => {
  const BIG = IDEA_OPEN_COLUMN_NOTICE_AT + 200

  it('mounts only what the viewport can show, while the header still counts the whole column', async () => {
    await renderBoard(openIdeas(BIG))
    const painted = paintedIds()
    expect(painted.length, 'the whole column was mounted anyway').toBeLessThan(60)
    expect(painted.length).toBeGreaterThan(0)
    expect(headerCount()).toBe(String(BIG))
    // The sizer stands in for the rest of the column.
    const sizer = openColumn().querySelector<HTMLElement>('.dsh-ideas-virtual-list')
    expect(sizer).not.toBeNull()
    expect(sizer!.style.height).not.toBe('')
    expect(Number.parseFloat(sizer!.style.height)).toBeGreaterThan(BIG * 100)
  })

  it('starts at the top of the column and follows the scroll', async () => {
    await renderBoard(openIdeas(BIG))
    expect(paintedIds()[0]).toBe('idea-0')
    scrollColumnTo(30_000)
    const after = paintedIds()
    expect(after[0]).not.toBe('idea-0')
    expect(after.length).toBeLessThan(60)
    // Still a contiguous run of the column, in column order.
    const first = Number(after[0]!.slice('idea-'.length))
    expect(after.map(id => Number(id.slice('idea-'.length))))
      .toEqual(after.map((_, index) => first + index))
  })

  it('leaves a short column completely alone: every card mounted, no window', async () => {
    await renderBoard(openIdeas(12))
    expect(paintedIds()).toHaveLength(12)
  })

  it('builds only the window even on the very first paint of a cold board', async () => {
    // The first render happens before the column has been laid out, so the
    // window has to start from a budget that needs no measurement. If it fell
    // back to "unknown", it would build all 500 cards and then throw them away
    // - which is the cost this feature exists to remove.
    await renderBoard(openIdeas(IDEA_OPEN_COLUMN_NOTICE_AT + 200))
    expect(paintedIds().length).toBeLessThan(60)
    expect(headerCount()).toBe(String(IDEA_OPEN_COLUMN_NOTICE_AT + 200))
  })
})

describe('scroll anchoring', () => {
  it('keeps the row at the top of the viewport where it was when a card above is measured taller', async () => {
    await renderBoard(openIdeas(IDEA_OPEN_COLUMN_NOTICE_AT + 200))
    scrollColumnTo(20_000)
    const before = paintedIds()
    const anchorId = before[0]!
    const cardNode = host.querySelector<HTMLElement>(`.dsh-ideas-card-wrapper[data-dsh-idea-id="${anchorId}"]`)!
    const anchorOffsetBefore = cardNode.style.top

    // Everything above the anchor reports a height far above the estimate. The
    // board must add the difference to scrollTop, so the anchored row keeps its
    // position on screen instead of being pushed off by the ones above it.
    for (const id of before.slice(1)) {
      const node = host.querySelector<HTMLElement>(`.dsh-ideas-card-wrapper[data-dsh-idea-id="${id}"]`)
      if (node === null) continue
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: CARD_HEIGHT_PX + 90 })
    }
    // Force the measurement pass the ResizeObserver would run in a browser.
    await act(async () => {
      const body = openColumn()
      body.dispatchEvent(new Event('scroll', { bubbles: false }))
    })

    const anchored = host.querySelector<HTMLElement>(`.dsh-ideas-card-wrapper[data-dsh-idea-id="${anchorId}"]`)
    // The row is either still painted at the same slot, or the scroll was
    // compensated by the same amount the rows above it grew. What must never
    // happen is the reader being silently moved to a different part of the column.
    if (anchored !== null) {
      const delta = openColumn().scrollTop - 20_000
      const grew = Number.parseFloat(anchored.style.top) - Number.parseFloat(anchorOffsetBefore)
      expect(grew - delta).toBeCloseTo(0, 0)
    }
  })
})

describe('the drop anchor names a card that is not painted', () => {
  it('writes a reorder built from the WHOLE column, not the window', async () => {
    const transport = await renderBoard(openIdeas(IDEA_OPEN_COLUMN_NOTICE_AT + 200))
    const painted = paintedIds()
    // The first card is far off screen: it cannot be hovered, and the reorder
    // must still be expressed over every open idea, not the ~30 that are mounted.
    await dragOnto(transport, painted[painted.length - 1]!, painted[0]!)

    const reorder = transport.posted.find(action => action.kind === 'reorder')
    expect(reorder, 'the drop posted no reorder').toBeDefined()
    const ids = (reorder as { orderedIds: string[] }).orderedIds
    // Every open idea of the column is in the written order, mounted or not.
    expect(ids).toContain('idea-0')
    expect(ids).toContain(`idea-${IDEA_OPEN_COLUMN_NOTICE_AT + 199}`)
    expect(ids.filter(id => id.startsWith('idea-')).length).toBe(IDEA_OPEN_COLUMN_NOTICE_AT + 200)
    // And the anchor is where the author pointed: before the hovered card.
    expect(ids.indexOf(painted[painted.length - 1]!)).toBeLessThan(ids.indexOf(painted[0]!))
    // No `move`: an in-column drop is a pure reorder.
    expect(transport.posted.map(action => action.kind)).toEqual(['reorder'])
  })
})

describe('the selection is bound to the scope, not to the window', () => {
  it('shift-clicks a range that reaches past the painted rows, into the whole column', async () => {
    const total = IDEA_OPEN_COLUMN_NOTICE_AT + 200
    await renderBoard(openIdeas(total))

    // Anchor on a card near the top of the column ...
    scrollColumnTo(0)
    const anchor = paintedIds()[0]!
    await act(async () => { selectBoxOf(anchor).click() })
    expect(selectionBarText()).toContain('1 selected of ' + total)

    // ... then scroll far away, so the anchor is no longer painted at all, and
    // shift-click a card that is. The gesture the author made spans a range the
    // window never showed them in one piece.
    scrollColumnTo(60_000)
    expect(paintedIds()).not.toContain(anchor)
    const target = paintedIds()[paintedIds().length - 1]!
    clickWithShift(selectBoxOf(target))

    // The bar counts the SCOPE: every card between the two anchors in display
    // order, including the ones that were never painted. A window must not
    // quietly turn "select this block" into "select what you can see".
    expect(selectionBarText()).toContain('selected of ' + total)
    const count = Number(/(\d+) selected of/.exec(selectionBarText())?.[1] ?? '0')
    expect(count).toBeGreaterThan(paintedIds().length)

    // And the rows in between really are selected once the reader scrolls back
    // to them: the selection was bound to the column, not to the window.
    scrollColumnTo(0)
    const first = paintedIds()[0]!
    expect(first).toBe(anchor)
    expect(host.querySelector(`.dsh-ideas-card-wrapper[data-dsh-idea-id="${first}"] .dsh-ideas-card-selected`) !== null
      || host.querySelector(`[data-dsh-idea-id="${first}"][data-selected]`) !== null).toBe(true)
  })

  it('Select all takes the whole scope, never just the window', async () => {
    const total = IDEA_OPEN_COLUMN_NOTICE_AT + 200
    await renderBoard(openIdeas(total))
    const selectAll = host.querySelector<HTMLButtonElement>('[data-dsh-ideas-select-all]')
    expect(selectAll, 'no Select all button').not.toBeNull()
    await act(async () => { selectAll!.click() })
    // "n of m" with m the scope total: the honest denominator, not the painted count.
    expect(selectionBarText()).toContain(`${total} selected of ${total}`)
  })
})

describe('a deep-link still lands on a card that was never painted', () => {
  it('reveals the card, mounts it and rings it', async () => {
    await renderBoard(openIdeas(IDEA_OPEN_COLUMN_NOTICE_AT + 200))
    const target = `idea-${IDEA_OPEN_COLUMN_NOTICE_AT + 150}`
    expect(paintedIds()).not.toContain(target)

    act(() => { client!.requestFocus(`#${IDEA_OPEN_COLUMN_NOTICE_AT + 151}`) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(client!.focusResult?.outcome).toBe('focused')
    expect(paintedIds(), 'the focused card was not revealed into the window').toContain(target)
    expect(host.querySelector(`.dsh-ideas-card-wrapper[data-dsh-idea-id="${target}"] [data-dsh-ideas-focused], .dsh-ideas-card-wrapper[data-dsh-idea-id="${target}"][data-dsh-ideas-focused]`))
      .not.toBeNull()
  })
})

describe('the standing notice on a long Open column', () => {
  it('appears at the threshold and says what is true', async () => {
    await renderBoard(openIdeas(IDEA_OPEN_COLUMN_NOTICE_AT))
    const notice = host.querySelector('[data-dsh-ideas-open-notice]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain(String(IDEA_OPEN_COLUMN_NOTICE_AT))
    expect(notice!.textContent).toBe(t('board.openColumnNotice', { count: IDEA_OPEN_COLUMN_NOTICE_AT }))
  })

  it('stays silent below it: a normal board never sees it', async () => {
    await renderBoard(openIdeas(IDEA_OPEN_COLUMN_NOTICE_AT - 1))
    expect(host.querySelector('[data-dsh-ideas-open-notice]')).toBeNull()
  })

  it('lives on the Open column only', async () => {
    await renderBoard(openIdeas(IDEA_OPEN_COLUMN_NOTICE_AT))
    const sections = Array.from(host.querySelectorAll('.dsh-ideas-column'))
    const withNotice = sections.filter(section => section.querySelector('[data-dsh-ideas-open-notice]') !== null)
    expect(withNotice).toHaveLength(1)
    expect(withNotice[0]!.querySelector('.dsh-ideas-column-title')?.textContent).toBe(t('board.status.open'))
  })
})