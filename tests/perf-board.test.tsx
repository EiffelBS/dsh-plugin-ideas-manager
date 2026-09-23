// @vitest-environment jsdom
/**
 * Client-side load profile (idea #34): what the MAIN THREAD pays with all
 * 140 cards mounted - initial React commit, short-poll emit, search
 * keystroke, workspace scoping (the "limited visible region" comparison),
 * tab switches - plus the pure hot helpers (renderMarkdown, the per-keystroke
 * filter scan, the ordering rebuilds).
 *
 * jsdom measures main-thread JAVASCRIPT + DOM mutation only: there is no
 * style/layout/paint, so treat the numbers as the CPU share of a frame, not
 * the frame itself. DOM node counts are the memory proxy.
 *
 * Opt-in: IDEAS_PERF=1 (see perf-fixture). Timings print as [perf-board]
 * lines for the before/after report; assertions only guard render
 * correctness (mounted card counts), never a wall-clock threshold.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { renderMarkdown } from '../src/client/markdown.ts'
import { orderIdeas, groupedIdOrder, rebuildOrder } from '../src/client/ordering.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  toListRow,
  toListSnapshot,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsView,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'
import {
  PERF_IDEA_COUNT,
  PERF_OPEN_COUNT,
  bodySizeStats,
  makePerfDataset,
  scanFilter,
  timeMs,
} from './perf-fixture.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Transport mirroring the idea#34 wire: `state()` serves the LEAN list
 * projection (fresh JSON round-trip in 'full' mode - what the browser really
 * parses each poll - or an identity clone with a BUMPED revision in
 * 'identity' mode to isolate the change-driven React commit), `stateFull()`
 * the deep-search index, and `idea(id)` the deferred body.
 */
class PerfTransport implements IdeasHostTransport {
  wireMode: 'full' | 'identity' = 'full'
  private revision = 1
  private readonly list: IdeasListSnapshot
  constructor(private readonly data: IdeasSnapshot) {
    this.list = toListSnapshot(data)
  }

  async state(): Promise<IdeasListSnapshot> {
    if (this.wireMode === 'full') return JSON.parse(JSON.stringify(this.list)) as IdeasListSnapshot
    this.revision += 1
    return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: this.revision, ideas: this.list.ideas }
  }

  async stateFull(): Promise<IdeasSnapshot> {
    return JSON.parse(JSON.stringify(this.data)) as IdeasSnapshot
  }

  async idea(id: string): Promise<IdeaRecord> {
    const found = this.data.ideas.find(record => record.id === id)
    if (found === undefined) throw new Error('not-found')
    return JSON.parse(JSON.stringify(found)) as IdeaRecord
  }

  async action(action: IdeasAction): Promise<IdeasListSnapshot> {
    void action
    return await this.state()
  }

  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void {
    return () => {}
  }

  async config(): Promise<IdeasSettingsView> {
    return { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS }, revision: 1 }
  }
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient | undefined
let transport: PerfTransport

function snapshotOf(): IdeasSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: makePerfDataset() }
}

/** act() a mutation and return its elapsed ms (main-thread JS share). */
async function measureAct(run: () => void | Promise<void>): Promise<number> {
  const start = performance.now()
  await act(async () => { await run() })
  return performance.now() - start
}

/** Set an input value through the prototype setter (bypasses the React
 *  value tracker) and fire the bubbling input event the listener reads. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function chooseSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Distinct idea ids currently mounted (wrapper + card both carry the
 *  attribute, so count unique values, never elements). */
function mountedIdeaCount(): number {
  const ids = new Set<string>()
  for (const el of host.querySelectorAll('[data-dsh-idea-id]')) {
    const id = el.getAttribute('data-dsh-idea-id')
    if (id !== null) ids.add(id)
  }
  return ids.size
}

const domNodes = (): number => host.querySelectorAll('*').length
const markdownRegions = (): number => host.querySelectorAll('[data-dsh-ideas-md]').length

beforeEach(() => {
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
})

describe.runIf(process.env.IDEAS_PERF === '1')('perf-board: hot helpers at 140 ideas', () => {
  it('times renderMarkdown, the keystroke filter scan and the ordering rebuilds', () => {
    const ideas = makePerfDataset()
    const stats = bodySizeStats(ideas)
    console.log(`[perf-board] dataset: count=${stats.count} bodies total=${(stats.total / 1024).toFixed(1)} KiB p50=${stats.p50} p90=${stats.p90} max=${stats.max}`)

    // renderMarkdown across the body-size buckets (median of 20, after
    // warm-up): this is the per-card per-render cost with no memoization.
    const byBucket = [
      { name: 'small (2 KB)', bytes: 2048 },
      { name: 'p50 (~4 KB)', bytes: stats.p50 },
      { name: 'p90 (~8 KB)', bytes: stats.p90 },
      { name: 'large (20 KB)', bytes: 20_480 },
      { name: 'xlarge (31 KB)', bytes: 31_744 },
    ]
    for (const bucket of byBucket) {
      const body = 'Render the ledger under load.\n\n'.repeat(Math.ceil(bucket.bytes / 31)).slice(0, bucket.bytes)
      const runs = 20
      renderMarkdown(body) // warm-up
      let html = ''
      const ms = timeMs(() => {
        for (let i = 0; i < runs; i++) html = renderMarkdown(body)
      })
      console.log(`[perf-board] renderMarkdown ${bucket.name}: ${(ms / runs).toFixed(2)} ms/card, html=${(html.length / 1024).toFixed(1)} KiB`)
    }

    // Full-board markdown cost = sum of every mounted card body (what one
    // board render pays today, no memoization).
    const fullRenderMs = timeMs(() => {
      for (const idea of ideas) renderMarkdown(idea.body)
    })
    console.log(`[perf-board] renderMarkdown ALL ${PERF_IDEA_COUNT} bodies (one board render): ${fullRenderMs.toFixed(2)} ms`)

    // Per-keystroke filter scan over LIST ROWS: cold (excerpt haystack, the
    // first keystrokes before the index lands) and warm (whole body, the
    // steady state once ensureSearchIndex filled the cache).
    const rows = ideas.map(idea => toListRow(idea))
    const bodyById = new Map(ideas.map(idea => [idea.id, idea.body]))
    const needles = ['triage', 'ledger', 'projection', 'zzz-no-match']
    const keystrokes = 20
    for (const needle of needles) {
      let hits = 0
      const coldMs = timeMs(() => {
        for (let i = 0; i < keystrokes; i++) hits = rows.filter(idea => scanFilter(idea, needle, undefined)).length
      })
      const warmMs = timeMs(() => {
        for (let i = 0; i < keystrokes; i++) hits = rows.filter(idea => scanFilter(idea, needle, bodyById.get(idea.id))).length
      })
      console.log(`[perf-board] filter scan "${needle}" over ${PERF_IDEA_COUNT} rows: cold(excerpt) ${(coldMs / keystrokes).toFixed(2)} ms/keystroke | deep(whole body) ${(warmMs / keystrokes).toFixed(2)} ms/keystroke, hits=${hits}`)
    }

    // Ordering rebuilds at current load (and a 3x projection for trend).
    for (const scale of [1, 3]) {
      const rows = scale === 1 ? ideas : [...ideas, ...ideas.map(idea => ({ ...idea, id: `${idea.id}-x${scale}` })), ...ideas.map(idea => ({ ...idea, id: `${idea.id}-y${scale}` }))]
      const open = rows.filter(idea => idea.status === 'open')
      const orderMs = medianLocal(20, () => { orderIdeas(open) })
      const groupedMs = medianLocal(10, () => { groupedIdOrder(rows) })
      const rebuildMs = medianLocal(10, () => { rebuildOrder(rows, open[0]!.id, 'open', open[1]?.id) })
      console.log(`[perf-board] ordering at ${rows.length} ideas (open=${open.length}): orderIdeas ${orderMs.toFixed(2)} ms, groupedIdOrder ${groupedMs.toFixed(2)} ms, rebuildOrder ${rebuildMs.toFixed(2)} ms`)
    }
    expect(ideas).toHaveLength(PERF_IDEA_COUNT)
  }, 60_000)
})

describe.runIf(process.env.IDEAS_PERF === '1')('perf-board: React commit at 140 mounted cards', () => {
  it('mounts, polls, filters, scopes and switches tabs', async () => {
    const snapshot = snapshotOf()
    transport = new PerfTransport(snapshot)
    client = new IdeasClient(transport, undefined)
    client.snapshot = toListSnapshot(snapshot)

    // --- initial mount (all 4 columns, every card fully rendered) --------
    const heapBefore = process.memoryUsage().heapUsed
    const mountMs = await measureAct(() => {
      root = createRoot(host)
      root.render(<IdeasBoard client={client!} />)
    })
    const settleMs = await measureAct(async () => { await client!.loadConfig() })
    const heapAfter = process.memoryUsage().heapUsed
    const stats = bodySizeStats(snapshot.ideas)
    console.log(`[perf-board] mount ${PERF_IDEA_COUNT} cards (${(stats.total / 1024).toFixed(0)} KiB bodies): ${mountMs.toFixed(2)} ms + config settle ${settleMs.toFixed(2)} ms`)
    console.log(`[perf-board] DOM after mount: ${domNodes()} nodes, ${mountedIdeaCount()} distinct cards, ${markdownRegions()} markdown regions, heap delta ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)} MiB (reference)`)
    console.log('[perf-board] jsdom caveat: main-thread JS + DOM mutation only; no style/layout/paint')
    expect(mountedIdeaCount()).toBe(PERF_IDEA_COUNT)

    // --- short-poll emit (every 2.5 s while the board is open) -----------
    // full: the real lean wire (parse + adopt) with an UNCHANGED revision -
    // the idle-tick cost after the idea#34 revision bailout (expected to be
    // near-zero render); identity: a bumped revision with the same row
    // references - the change-driven commit of one real update.
    transport.wireMode = 'full'
    const pollIdleMs = await measureAct(async () => { await client!.refresh() })
    transport.wireMode = 'identity'
    const pollChangedMs = await measureAct(async () => { await client!.refresh() })
    console.log(`[perf-board] idle poll (lean wire, same revision -> bailout): ${pollIdleMs.toFixed(2)} ms | changed poll (revision bump, commit): ${pollChangedMs.toFixed(2)} ms`)

    // --- search keystroke (per-keystroke full scan + re-render) ----------
    const search = host.querySelector<HTMLInputElement>('header input[type="search"]')
    expect(search).not.toBeNull()
    const hitMs = await measureAct(() => { typeInto(search!, 'triage') })
    const missMs = await measureAct(() => { typeInto(search!, 'zzz-no-match') })
    const clearMs = await measureAct(() => { typeInto(search!, '') })
    console.log(`[perf-board] search keystroke: hit "${'triage'}" ${hitMs.toFixed(2)} ms, miss ${missMs.toFixed(2)} ms, clear ${clearMs.toFixed(2)} ms (scan+commit)`)
    expect(mountedIdeaCount()).toBe(PERF_IDEA_COUNT)

    // --- workspace scope: all cards vs one third of them -----------------
    const scopedCards = snapshot.ideas.filter(idea => idea.workspaceId === 'ws-opentimbre').length
    const scopeMs = await measureAct(() => {
      const select = host.querySelector<HTMLSelectElement>('header select')
      expect(select).not.toBeNull()
      chooseSelect(select!, 'ws-opentimbre')
    })
    const scopedNodes = domNodes()
    const scopedRegions = markdownRegions()
    console.log(`[perf-board] scope "all workspaces": ${domNodes()} nodes / ${markdownRegions()} md regions -> one workspace (${scopedCards}/${PERF_IDEA_COUNT} cards): ${scopeMs.toFixed(2)} ms, ${scopedNodes} nodes / ${scopedRegions} md regions`)
    expect(mountedIdeaCount()).toBe(scopedCards)

    // Back to all workspaces for the tab measurements.
    await measureAct(() => {
      const select = host.querySelector<HTMLSelectElement>('header select')!
      chooseSelect(select, '')
    })

    // --- tab switches: Priorities (100 ranked rows) + Delivered ----------
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'))
    expect(tabs).toHaveLength(3)
    const prioritiesMs = await measureAct(() => { (tabs[1] as HTMLButtonElement).click() })
    console.log(`[perf-board] switch to Priorities (${PERF_OPEN_COUNT} ranked rows): ${prioritiesMs.toFixed(2)} ms, ${domNodes()} nodes, ${markdownRegions()} md regions`)
    const deliveredMs = await measureAct(() => { (tabs[2] as HTMLButtonElement).click() })
    console.log(`[perf-board] switch to Delivered: ${deliveredMs.toFixed(2)} ms, ${domNodes()} nodes, ${markdownRegions()} md regions`)
    const overviewMs = await measureAct(() => { (tabs[0] as HTMLButtonElement).click() })
    console.log(`[perf-board] switch back to Overview: ${overviewMs.toFixed(2)} ms`)
    expect(mountedIdeaCount()).toBe(PERF_IDEA_COUNT)
  }, 60_000)
})

/** Median wall-clock of `runs` executions after one warm-up run. */
function medianLocal(runs: number, fn: () => void): number {
  fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) samples.push(timeMs(fn))
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]!
}
