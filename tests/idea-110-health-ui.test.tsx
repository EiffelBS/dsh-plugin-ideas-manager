// @vitest-environment jsdom
/**
 * Idea #110 — the Health tab as the board renders it.
 *
 * The aggregate and its wire are pinned in `idea-110-stats.test.ts`. What is
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    expect(transport.statsQueries).toEqual([{}])
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
    expect(transport.statsQueries).toEqual([{}, { workspaceId: 'ws-a' }])
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
  it('prints the duration when the sample is above the floor', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })

    const text = health()!.textContent ?? ''
    expect(text).toContain('Median time to deliver')
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

    const text = health()!.textContent ?? ''
    expect(text).toContain(`Not enough deliveries yet (${IDEAS_STATS_MEDIAN_MIN_SAMPLES - 2} / ${IDEAS_STATS_MEDIAN_MIN_SAMPLES})`)
    expect(text).toContain('a median is only printed from')
    // No duration anywhere: a wrong number is worse than no number.
    expect(text).not.toMatch(/\b\d+ (min|h|d)\b/)
  })

  it('says how many ideas left the backlog without a delivery stamp', async () => {
    const unstamped = [...OPEN, ...DELIVERED.slice(0, 3), record('u1', { status: 'archived', archivedAt: NOW })]
    const transport = new FakeTransport(unstamped)
    await mount(transport)
    await act(async () => { click(tab('Health')) })

    const text = health()!.textContent ?? ''
    expect(text).toContain('left the backlog with no delivery stamp')
    // And the median stays refused, because those rows are not deliveries.
    expect(text).toContain('Not enough deliveries yet')
  })

  it('names the calendar month the window measured, not a vague "recent"', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const month = new Date(NOW).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
    expect(health()?.textContent).toContain(month)
  })

  it('presents the triage gaps as work to do, never as a quality score', async () => {
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const text = health()!.textContent ?? ''
    expect(text).toContain('triage point(s) to fill in')
    expect(text).toContain('work to do on your ideas, never a quality score')
  })

  it('makes no claim about how many figures it prints', async () => {
    // The hint once said "five figures" while the tab paints four figures and
    // two lists. A health view that overstates itself is the failure this whole
    // feature exists to avoid, so the copy claims nothing countable and the
    // figure count is pinned instead.
    const transport = new FakeTransport()
    await mount(transport)
    await act(async () => { click(tab('Health')) })
    const text = health()!.textContent ?? ''
    expect(text).toContain('computed by the host, never recounted by the board')
    expect(text).not.toMatch(/five figures|cinq chiffres/)
    expect(host.querySelectorAll('[data-dsh-ideas-health-figures] > *')).toHaveLength(4)
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
    expect(health()?.textContent).toContain('Median time to deliver')
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
