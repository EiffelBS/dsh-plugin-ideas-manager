// @vitest-environment jsdom
/**
 * the Health tab as the board renders it.
 *
 * The aggregate and its wire are pinned in `stats.test.ts`. What is
 * under test HERE is the part that can quietly lie: a panel that recomputes, a
 * panel that shows a median it should have refused, and a panel whose feature
 * quietly grew the poll it was supposed to leave alone.
 *
 *  - the numbers come from the Host, rendered verbatim — the fake Host computes
 *    them with the very module the server uses;
 *  - a thin sample renders the explicit "not enough deliveries yet" sentence and
 *    NO duration, while a real one renders the duration;
 *  - the 2.5 s poll is unchanged: the aggregate is a separate call, issued when
 *    the tab opens, never folded into `state()`;
 *  - the list-only affordances (search, tag filter, selection bar) step aside,
 *    because none of them can narrow an aggregate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { buildIdeasStats, IDEAS_STATS_MEDIAN_MIN_SAMPLES } from '../src/core/ideas-stats.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasListSnapshot,
  type IdeasReadQuery,
  type IdeasReadSnapshot,
  type IdeasStats,
  type IdeasStatsQuery,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DAY = 86_400_000
const NOW = new Date(2026, 9, 14, 12, 0, 0, 0).getTime()

type Row = IdeasListSnapshot['ideas'][number]

function record(id: string, partial: Partial<IdeaRecord> & Pick<IdeaRecord, 'status'>): IdeaRecord {
  return {
    id,
    title: `Idea ${id}`,
    body: `Body ${id}`,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    ideaNumber: Number(id.replace(/\D/g, '')) || 1,
    ...partial,
  }
}

function rowOf(idea: IdeaRecord): Row {
  const { body: _body, analysisAudit: _audit, events: _events, ...rest } = idea
  return { ...rest, bodyExcerpt: `Body ${idea.id}` }
}

const OPEN: IdeaRecord[] = [
  record('a1', { status: 'open', workspaceId: 'ws-a', tags: [{ name: 'perf' }], rank: 1, value: 3 }),
  record('a2', { status: 'open', workspaceId: 'ws-a', tags: [{ name: 'ui' }] }),
  record('b1', { status: 'open', workspaceId: 'ws-b', rank: 2 }),
]

/** Six real deliveries with lead times of 1..6 days. */
const DELIVERED: IdeaRecord[] = Array.from({ length: 6 }, (_, index) => record(`d${index + 1}`, {
  status: 'archived',
  createdAt: NOW - 20 * DAY,
  updatedAt: NOW - DAY,
  archivedAt: NOW - DAY,
  deliveredAt: NOW - (20 - (index + 1)) * DAY,
}))

class FakeTransport implements IdeasHostTransport {
  hosted: IdeaRecord[]
  revision = 1
  /** Every poll the board issued, so the test can prove the aggregate is not in it. */
  stateCalls = 0
  /** Every aggregate request, in order, with the scope each asked for. */
  statsQueries: IdeasStatsQuery[] = []
  statsAvailable = true
  /** While true, the health request stays in flight until `releaseStats()`. */
  holdStats = false
  /** When set, every aggregate request rejects with this message. */
  failStats: string | undefined
  private held: (() => void) | undefined

  constructor(hosted: IdeaRecord[] = [...OPEN, ...DELIVERED]) {
    this.hosted = hosted
  }

  /** Let a held health request finish. */
  releaseStats(): void {
    this.holdStats = false
    this.held?.()
    this.held = undefined
  }

  async state(): Promise<IdeasListSnapshot> {
    this.stateCalls += 1
    return {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: this.revision,
      ideas: this.hosted.map(rowOf),
    }
  }

  async action(): Promise<IdeasListSnapshot> { return await this.state() }

  async read(query: IdeasReadQuery): Promise<IdeasReadSnapshot> {
    const matched = this.hosted.filter(idea =>
      (query.numbers === undefined || (idea.ideaNumber !== undefined && query.numbers.includes(idea.ideaNumber)))
      && (query.ids === undefined || query.ids.includes(idea.id)))
    return {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: this.revision,
      ideas: matched.slice(0, query.limit ?? matched.length).map(rowOf),
      meta: {
        view: 'summary', fields: [], bodyLimitBytes: 0, limit: 1, offset: 0,
        matched: matched.length, returned: matched.length, rowTruncated: false, nextOffset: null,
        bodyTruncated: false, omittedFields: [],
      },
    }
  }

  stats(query: IdeasStatsQuery = {}): Promise<IdeasStats> {
    // Optional capability: a transport may simply not have it (an older Host).
    if (!this.statsAvailable) return Promise.reject(new Error('stats-unavailable'))
    this.statsQueries.push(query)
    const value = buildIdeasStats({ revision: this.revision, ideas: this.hosted }, { now: NOW, ...query })
    if (this.failStats !== undefined) return Promise.reject(new Error(this.failStats))
    if (!this.holdStats) return Promise.resolve(value)
    return new Promise<IdeasStats>(resolve => { this.held = () => { resolve(value) } })
  }

  subscribe(): () => void { return () => {} }
}

let host: HTMLDivElement
let root: Root | undefined

function tab(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(button => button.textContent?.trim().startsWith(name))
  if (found === undefined) throw new Error(`no tab ${name}`)
  return found
}

function healthRange(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('.dsh-ideas-health-range-tab')]
    .find(button => button.textContent === name)
  if (found === undefined) throw new Error(`no health range ${name}`)
  return found
}

function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function mount(transport: IdeasHostTransport): Promise<IdeasClient> {
  const client = new IdeasClient(transport, undefined, undefined)
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.refresh() })
  await act(async () => { await client.loadConfig() })
  return client
}

function health(): HTMLElement | null {
  return host.querySelector('[data-dsh-ideas-health]')
}

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
  host.remove()
  document.body.innerHTML = ''
})

describe('the Health tab', () => {
  it('exists beside the three list tabs, with no count badge of its own', async () => {
    await mount(new FakeTransport())
    const labels = [...host.querySelectorAll('[role="tab"]')].map(node => node.textContent?.trim())
    // Overview counts every visible row; Health carries no badge at all.
    expect(labels).toEqual(['Overview9', 'Priorities3', 'Delivered6', 'Health'])
  })

  it('asks for the aggregate when it opens, scoped to every workspace by default', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    expect(transport.statsQueries).toHaveLength(0)

    await act(async () => { click(tab('Health')) })
    expect(transport.statsQueries).toEqual([{ range: 'month' }])
    expect(health()?.textContent).toContain('all workspaces')
  })

  it('re-asks when the workspace scope changes, and shows THAT scope', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })

    const select = host.querySelector<HTMLSelectElement>('select')
    expect(select).not.toBeNull()
    await act(async () => {
      select!.value = 'ws-a'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(transport.statsQueries).toEqual([{ range: 'month' }, { workspaceId: 'ws-a', range: 'month' }])
    expect(health()?.textContent).toContain('ws-a')
  })

  it('never paints one scope\'s numbers under another scope\'s label', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    // Hold the scoped answer: while it is in flight the view shows the honest
    // "computing" note instead of the previous scope's figures.
    transport.holdStats = true
    const select = host.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      select.value = 'ws-a'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(health()?.textContent).not.toContain('3 open of 9 idea(s)')
    await act(async () => { transport.releaseStats() })
  })

  it('drops the aggregate when the tab is left, so re-opening re-reads it', async () => {
    const transport = new FakeTransport()
    const client = await mount(transport)
    await act(async () => { click(tab('Health')) })
    expect(client.stats).toBeDefined()

    await act(async () => { click(tab('Overview')) })
    expect(client.stats).toBeUndefined()

    await act(async () => { click(tab('Health')) })
    expect(transport.statsQueries).toHaveLength(2)
  })
})

describe('the median honesty rule reaches the screen', () => {
  it('prints the duration when the selected all-time sample is above the floor', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    await act(async () => { click(healthRange('All')) })
    expect(transport.statsQueries.at(-1)).toEqual({ range: 'all' })

    const text = health()!.textContent ?? ''
    expect(text).toContain('Median lead time')
    // Six deliveries, lead times 1..6 days -> median 3.5 days, rounded to 4.
    expect(text).toContain('4 d')
    expect(text).not.toContain('Not enough deliveries yet')
    expect(text).toContain('across 6 timestamped delivery')
  })

  it('prints an explicit refusal — never a number — below the floor', async () => {
    const thin = [...OPEN, ...DELIVERED.slice(0, IDEAS_STATS_MEDIAN_MIN_SAMPLES - 2)]
    const transport = new FakeTransport(thin)
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    await act(async () => { click(healthRange('All')) })

    const text = health()!.textContent ?? ''
    expect(text).toContain(`Not enough deliveries yet (${IDEAS_STATS_MEDIAN_MIN_SAMPLES - 2} / ${IDEAS_STATS_MEDIAN_MIN_SAMPLES})`)
    expect(text).toContain('a median is only printed from')
    expect(text).not.toMatch(/\b\d+ (min|h|d)\b/)
  })

  it('reports archives without a delivery stamp in the quality card', async () => {
    const unstamped = [...OPEN, ...DELIVERED.slice(0, 3), record('u1', { status: 'archived', archivedAt: NOW })]
    const transport = new FakeTransport(unstamped)
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    await act(async () => { click(healthRange('All')) })

    const text = health()!.textContent ?? ''
    expect(text).toContain('Archives without a delivery timestamp')
    expect(text).toContain('Not enough deliveries yet')
  })

  it('names the calendar month the default window measured, not a vague "recent"', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const month = new Date(NOW).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
    expect(health()?.textContent).toContain(month)
  })

  it('presents triage gaps as work to do and counts each idea once', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const text = health()!.textContent ?? ''
    expect(text).toContain('Remaining work, never a quality score')
    expect(text).toContain('Ideas concerned2')
    expect(text).toContain('No rank1')
    expect(text).toContain('No value2')
  })

  it('renders four KPI cards and the graphical dashboard sections', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const text = health()!.textContent ?? ''
    expect(text).toContain('A graphical reading of flow, remaining work and data quality.')
    expect(text).not.toMatch(/five figures|cinq chiffres/)
    expect(host.querySelectorAll('[data-dsh-ideas-health-figures] > *')).toHaveLength(4)
    expect(host.querySelector('.dsh-ideas-health-donut')).not.toBeNull()
    expect(host.querySelector('.dsh-ideas-health-progress-ring')).not.toBeNull()
    expect(host.querySelector('.dsh-ideas-health-bar-chart')).not.toBeNull()
    expect(host.querySelector('.dsh-ideas-health-heatmap')?.children).toHaveLength(84)
    expect((host.querySelector('.dsh-ideas-health-heatmap') as HTMLElement).tabIndex).toBe(0)
    expect(host.querySelector('.dsh-ideas-health-heat-readout')?.textContent).toContain('2026-')
    expect(host.querySelectorAll('.dsh-ideas-health-sr-only tbody tr')).toHaveLength(92)
    expect((host.querySelector('.dsh-ideas-health-bar') as HTMLElement).style.height).toBe('0%')
    expect(host.querySelector('.dsh-ideas-health-heat-cell')?.hasAttribute('tabindex')).toBe(false)
  })
})

describe('stale figures say so', () => {
  it('labels the revision the figures came from while a refresh is in flight', async () => {
    const transport = new FakeTransport()
    const client = await mount(transport)
    await act(async () => { click(tab('Health')) })
    expect(health()?.querySelector('[data-dsh-ideas-health-stale]')).toBeNull()

    // The board moves on: the poll adopts revision 2 while the aggregate for
    // revision 1 is still the one on screen. The figures stay (blanking them
    // would flicker on every commit), but they are labelled as out of date.
    transport.holdStats = true
    transport.revision = 2
    await act(async () => { await client.refresh() })

    const note = health()?.querySelector('[data-dsh-ideas-health-stale]')
    expect(note?.textContent).toContain('revision 1')
    expect(note?.textContent).toContain('refreshing')
    await act(async () => { transport.releaseStats() })
    // Once the refresh lands, the figures describe the board again.
    expect(health()?.querySelector('[data-dsh-ideas-health-stale]')).toBeNull()
  })

  it('says so when the refresh FAILED, instead of quietly keeping old numbers', async () => {
    const transport = new FakeTransport()
    const client = await mount(transport)
    await act(async () => { click(tab('Health')) })

    transport.failStats = 'host exploded'
    transport.revision = 2
    await act(async () => { await client.refresh() })

    const note = health()?.querySelector('[data-dsh-ideas-health-stale="failed"]')
    expect(note?.textContent).toContain('revision 1')
    expect(note?.textContent).toContain('host exploded')
    // The last good figures are still readable: a failed refresh is not a reason
    // to blank a screen the reader is looking at.
    expect(health()?.textContent).toContain('Median lead time')
  })

  it('reveals chart details on hover and exposes tooltip data for assistive technology', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })

    const openSegment = host.querySelector('.dsh-ideas-health-donut-open') as SVGCircleElement
    await act(async () => { openSegment.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(host.querySelector('.dsh-ideas-health-donut-label')?.textContent).toBe('Open')
    expect(host.querySelector('.dsh-ideas-health-donut-value')?.textContent).toBe('3')
    await act(async () => { openSegment.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(host.querySelector('.dsh-ideas-health-donut-label')?.textContent).toBe('active ideas')

    expect(host.querySelector('.dsh-ideas-health-bar')?.getAttribute('data-tooltip')).toContain('· 0')
    expect(host.querySelector('.dsh-ideas-health-rank-row')?.getAttribute('title')).toContain('ws-a')
    expect(host.querySelector('.dsh-ideas-health-heat-cell')?.getAttribute('data-tooltip')).toContain('2026-')
  })

  it('navigates heatmap days with the keyboard and keeps a visible readout', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const heatmap = host.querySelector('.dsh-ideas-health-heatmap') as HTMLElement
    const first = heatmap.getAttribute('aria-activedescendant')
    await act(async () => { heatmap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    const second = heatmap.getAttribute('aria-activedescendant')
    expect(second).not.toBe(first)
    expect(host.querySelector('.dsh-ideas-health-heat-readout')?.textContent).toContain(second?.replace('health-heat-', '') ?? '')
    await act(async () => { heatmap.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(heatmap.getAttribute('aria-activedescendant')).toMatch(/2026-10-14$/)
  })

  it('keeps keyboard focus when a stats refresh restarts the animations', async () => {
    const transport = new FakeTransport()
    const client = await mount(transport)
    await act(async () => { click(tab('Health')) })
    const bar = host.querySelector('.dsh-ideas-health-bar') as HTMLElement
    act(() => { bar.focus() })
    expect(document.activeElement).toBe(bar)
    transport.revision = 2
    await act(async () => { await client.refresh() })
    await act(async () => { await vi.waitFor(() => { expect(client.stats?.revision).toBe(2) }, { timeout: 5_000 }) })
    expect(document.activeElement).toBe(bar)
  })

  it('turns a workspace bar into a scoped Overview and a tag bar into a filter', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const workspaceRow = [...host.querySelectorAll<HTMLButtonElement>('.dsh-ideas-health-rank-row')]
      .find(row => row.textContent?.startsWith('ws-a'))
    if (workspaceRow === undefined) throw new Error('no ws-a health row')
    await act(async () => { click(workspaceRow) })
    expect(tab('Overview').getAttribute('aria-selected')).toBe('true')
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('ws-a')

    await act(async () => { click(tab('Health')) })
    const tagRow = [...host.querySelectorAll<HTMLButtonElement>('.dsh-ideas-health-rank-row')]
      .find(row => row.textContent?.includes('perf'))
    if (tagRow === undefined) throw new Error('no perf health row')
    await act(async () => { click(tagRow) })
    expect(tab('Overview').getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('.dsh-ideas-tag-filter-chips')?.textContent).toContain('perf')

    await act(async () => { click(tab('Health')) })
    const activeTagRow = [...host.querySelectorAll<HTMLButtonElement>('.dsh-ideas-health-rank-row')]
      .find(row => row.textContent?.includes('perf'))
    if (activeTagRow === undefined) throw new Error('no perf health row on return')
    await act(async () => { click(activeTagRow) })
    expect(host.querySelector('.dsh-ideas-tag-filter-chips')?.textContent).toContain('perf')
  })

  it('sends the triage action to Priorities', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const cta = host.querySelector('.dsh-ideas-health-triage-cta') as HTMLButtonElement
    await act(async () => { click(cta) })
    expect(tab('Priorities').getAttribute('aria-selected')).toBe('true')
  })

  it('shows no staleness note when the board has not moved', async () => {
    const transport = new FakeTransport()
    const client = await mount(transport)
    await act(async () => { click(tab('Health')) })
    // An idle poll adopts the same revision; nothing may claim to be stale.
    await act(async () => { await client.refresh() })
    expect(health()?.querySelector('[data-dsh-ideas-health-stale]')).toBeNull()
  })
})

describe('the poll is untouched', () => {
  it('never asks for the aggregate before the tab is opened, and never folds it into state()', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    const beforeStats = transport.stateCalls
    expect(transport.statsQueries).toHaveLength(0)
    expect(beforeStats).toBeGreaterThan(0)

    // The board's own read still carries exactly what it always carried: the
    // transport's `state` is the poll, and no aggregate key rides it.
    const client = new IdeasClient(transport, undefined, undefined)
    await act(async () => { await client.refresh() })
    expect(client.snapshot?.ideas.every(row => !('medianMs' in row))).toBe(true)
  })

  it('hides the list-only affordances, which cannot narrow an aggregate', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    expect(host.querySelector('input[type="search"]')).not.toBeNull()

    await act(async () => { click(tab('Health')) })
    expect(host.querySelector('input[type="search"]')).toBeNull()
    // The selection bar and the tag filter are the other two list-only tools.
    expect(host.textContent).not.toContain('Select all')

    await act(async () => { click(tab('Overview')) })
    expect(host.querySelector('input[type="search"]')).not.toBeNull()
  })
})

describe('a deployment without the health surface', () => {
  it('says so once, and keeps the rest of the board alive', async () => {
    const transport = new FakeTransport()
    // The capability is OPTIONAL on the transport interface: a Host that
    // predates the route simply does not expose it.
    const withoutCapability = new IdeasClient({
      state: () => transport.state(),
      action: () => transport.action(),
      read: query => transport.read(query ?? {}),
      subscribe: () => () => {},
    }, undefined, undefined)
    act(() => {
      root = createRoot(host)
      root.render(<IdeasBoard client={withoutCapability} />)
    })
    await act(async () => { await withoutCapability.refresh() })
    await act(async () => { await withoutCapability.loadConfig() })
    await act(async () => { click(tab('Health')) })

    expect(health()?.textContent).toContain('does not serve the health view')
    expect(withoutCapability.statsAvailable).toBe(false)
    // No crash, no error bar: this is a downgrade, not an error.
    expect(withoutCapability.error).toBeUndefined()
  })

  it('surfaces a failed read as the host message plus a retry, never a blank panel', async () => {
    const transport = new FakeTransport()
    const failing = new IdeasClient({
      state: () => transport.state(),
      action: () => transport.action(),
      read: query => transport.read(query ?? {}),
      subscribe: () => () => {},
      stats: () => Promise.reject(new Error('host exploded')),
    }, undefined, undefined)
    act(() => {
      root = createRoot(host)
      root.render(<IdeasBoard client={failing} />)
    })
    await act(async () => { await failing.refresh() })
    await act(async () => { await failing.loadConfig() })
    await act(async () => { click(tab('Health')) })

    expect(health()?.textContent).toContain('host exploded')
    expect(health()?.querySelector('button')?.textContent).toBe('Retry')
  })
})
