// @vitest-environment jsdom
/**
 * Virtualization at the trigger size.
 *
 * Virtualization names ~500 cards in the Open column as the point where the board
 * stops being responsive, so this gate measures there rather than at the 140-card
 * objective. The A/B is on the SAME component and the SAME data:
 * `VIEWPORT` is the only thing that differs, and setting it enormous forces the
 * window to cover the whole column, which is exactly what the board did before
 * the feature. That is what makes the two columns comparable.
 *
 * jsdom measures main-thread JAVASCRIPT + DOM mutation only - no
 * style/layout/paint - so the mount figures understate a real browser by the
 * paint cost of every node, which is the half virtualization removes. DOM node
 * counts are the memory proxy.
 *
 * Opt-in: IDEAS_PERF=1. Assertions guard render correctness (what is mounted,
 * and that the column still knows its whole size), never a wall-clock number.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  toListSnapshot,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsView,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'
import { PERF_VIRTUAL_OPEN_COUNT, bodySizeStats, makePerfDataset } from './perf-fixture.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A realistic column viewport: a 1080p window shows roughly this much column. */
const REAL_VIEWPORT_PX = 640
/** Wide enough that the window covers all 500 rows: the pre-#108 behaviour. */
const WHOLE_COLUMN_VIEWPORT_PX = 1_000_000
/** A measured card in the fixture's shape (title + excerpt + meta + actions). */
const CARD_HEIGHT_PX = 230
const COLUMN_WIDTH_PX = 320

class PerfTransport implements IdeasHostTransport {
  private revision = 1
  constructor(private readonly list: IdeasListSnapshot) {}
  async state(): Promise<IdeasListSnapshot> {
    this.revision += 1
    return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: this.revision, ideas: this.list.ideas }
  }
  async stateFull(): Promise<IdeasSnapshot> { return this.list as unknown as IdeasSnapshot }
  async idea(id: string): Promise<IdeaRecord> {
    const found = this.list.ideas.find(row => row.id === id)
    if (found === undefined) throw new Error('not-found')
    return found as unknown as IdeaRecord
  }
  async action(_action: IdeasAction): Promise<IdeasListSnapshot> { return await this.state() }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> {
    return { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS }, revision: 1 }
  }
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient | undefined
let restoreLayout: (() => void) | undefined

/**
 * The layout jsdom does not have. `viewport` is the knob the A/B turns: the
 * window sizes itself against it, so a huge value paints the whole column.
 */
function stubLayout(viewport: number): () => void {
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = []
  const define = (target: object, property: string, get: (element: Element) => number): void => {
    saved.push([target, property, Object.getOwnPropertyDescriptor(target, property)])
    Object.defineProperty(target, property, { configurable: true, get: function (this: Element): number { return get(this) } })
  }
  const scrollTops = new WeakMap<Element, number>()
  const isColumnBody = (el: Element): boolean => el.hasAttribute?.('data-dsh-column-scroll') === true
  const isCard = (el: Element): boolean => el.classList?.contains('dsh-ideas-card-wrapper') === true

  define(Element.prototype, 'clientHeight', el => (isColumnBody(el) ? viewport : 0))
  define(Element.prototype, 'clientWidth', el => (isColumnBody(el) ? COLUMN_WIDTH_PX : 0))
  define(Element.prototype, 'offsetHeight', el => (isCard(el) ? CARD_HEIGHT_PX : 0))
  saved.push([Element.prototype, 'scrollTop', Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')])
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

async function measureAct(run: () => void | Promise<void>): Promise<number> {
  const start = performance.now()
  await act(async () => { await run() })
  return performance.now() - start
}

function domNodes(): number { return host.querySelectorAll('*').length }

function mountedCards(): number {
  const column = host.querySelectorAll('[data-dsh-column-scroll]')[0]
  return column?.querySelectorAll('.dsh-ideas-card-wrapper').length ?? 0
}

function headerCount(): number {
  const header = host.querySelectorAll('.dsh-ideas-column')[0]?.querySelector('.dsh-ideas-column-count')
  return Number(header?.textContent ?? '0')
}

function sizerHeight(): number {
  const sizer = host.querySelector<HTMLElement>('.dsh-ideas-virtual-list')
  return Number.parseFloat(sizer?.style.height ?? '0')
}

/** Mount the 500-open-card board and return the client, with the layout applied. */
async function mountTriggerBoard(viewport: number): Promise<IdeasClient> {
  const snapshot: IdeasSnapshot = {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: makePerfDataset(0x5eed, PERF_VIRTUAL_OPEN_COUNT),
  }
  restoreLayout?.()
  restoreLayout = stubLayout(viewport)
  const transport = new PerfTransport(toListSnapshot(snapshot))
  const created = new IdeasClient(transport, undefined)
  created.snapshot = toListSnapshot(snapshot)
  client = created
  const start = performance.now()
  await act(async () => {
    root = createRoot(host)
    root.render(<IdeasBoard client={created} />)
  })
  const mountMs = performance.now() - start
  await act(async () => { await created.loadConfig() })
  console.log(`[perf-virtual] mount ${PERF_VIRTUAL_OPEN_COUNT} open cards (viewport ${viewport}px): ${mountMs.toFixed(2)} ms, ${domNodes()} DOM nodes, ${mountedCards()} cards painted, header ${headerCount()}`)
  console.log(`[perf-virtual] scrollable column height: ${(sizerHeight() / 1024).toFixed(1)} KiB px`)
  return created
}

/** Unmount, so the next A/B arm starts from a clean root. */
async function unmountBoard(): Promise<void> {
  if (root !== undefined) {
    const mounted = root
    await act(async () => { mounted.unmount() })
  }
  root = undefined
  client?.dispose()
  client = undefined
  restoreLayout?.()
  restoreLayout = undefined
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
})
afterEach(async () => {
  await unmountBoard()
  host.remove()
})

describe.runIf(process.env.IDEAS_PERF === '1')('perf-virtual: the 500-card Open column', () => {
  it('mounts the trigger board, windowed and fully painted, on the same data', async () => {
    const stats = bodySizeStats(makePerfDataset(0x5eed, PERF_VIRTUAL_OPEN_COUNT))
    console.log(`[perf-virtual] fixture: count=${stats.count} bodies total=${(stats.total / 1024).toFixed(1)} KiB p50=${stats.p50} p90=${stats.p90}`)

    // --- arm 1: fully painted (the pre-#108 behaviour, same component) -----
    await mountTriggerBoard(WHOLE_COLUMN_VIEWPORT_PX)
    const fullCards = mountedCards()
    const fullNodes = domNodes()
    // Correctness only: a whole-column viewport must paint every card.
    expect(fullCards).toBe(PERF_VIRTUAL_OPEN_COUNT)
    expect(headerCount()).toBe(PERF_VIRTUAL_OPEN_COUNT)

    await unmountBoard()

    // --- arm 2: windowed -------------------------------------------------
    await mountTriggerBoard(REAL_VIEWPORT_PX)
    const windowedCards = mountedCards()
    const windowedNodes = domNodes()
    // Correctness: the column still KNOWS its size, and paints a slice of it.
    expect(windowedCards).toBeGreaterThan(0)
    expect(windowedCards).toBeLessThan(fullCards)
    expect(headerCount()).toBe(PERF_VIRTUAL_OPEN_COUNT)
    // The scrollbar is honest: the sizer is as tall as the whole column.
    expect(sizerHeight()).toBeGreaterThan(PERF_VIRTUAL_OPEN_COUNT * 100)

    console.log(`[perf-virtual] A/B at ${PERF_VIRTUAL_OPEN_COUNT} open cards: fully painted ${fullCards} cards / ${fullNodes} nodes -> windowed ${windowedCards} cards / ${windowedNodes} nodes (${(windowedNodes / fullNodes * 100).toFixed(1)}% of the DOM)`)

    // --- the recurring cost: a poll that actually changes the board --------
    const changedPollMs = await measureAct(async () => { await client!.refresh() })
    console.log(`[perf-virtual] changed poll (revision bump, commit): ${changedPollMs.toFixed(2)} ms`)

    // --- scrolling the window --------------------------------------------
    const column = host.querySelectorAll<HTMLElement>('[data-dsh-column-scroll]')[0]!
    const scrollMs = await measureAct(() => {
      for (const top of [2_000, 20_000, 40_000, 60_000, 80_000]) {
        column.scrollTop = top
        column.dispatchEvent(new Event('scroll', { bubbles: false }))
      }
    })
    const lastPainted = host.querySelector<HTMLElement>('.dsh-ideas-card-wrapper:last-of-type')
    console.log(`[perf-virtual] scroll the window across 5 positions: ${scrollMs.toFixed(2)} ms, ${mountedCards()} cards painted at the end`)
    // Correctness: after scrolling deep, the painted cards are the deep ones.
    expect(lastPainted?.getAttribute('data-dsh-idea-id')).not.toBe('perf-idea-0')
    expect(mountedCards()).toBeLessThan(PERF_VIRTUAL_OPEN_COUNT)
  }, 120_000)
})