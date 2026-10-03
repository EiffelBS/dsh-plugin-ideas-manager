/**
 * Idea #110 — the bounded backlog-health aggregate (`view=stats`).
 *
 * Three contracts are under test, and the third one is the reason the feature
 * exists at all.
 *
 *  1. **The aggregate answers the five questions.** Open per workspace,
 *     delivered in the window, median time to deliver, top labels, and the
 *     triage gaps.
 *  2. **The median refuses to print on a thin sample.** Below the floor the
 *     answer is `null` plus the counts that explain it — never a zero, never a
 *     number computed off one or two rows — and the floor itself travels in the
 *     payload so no surface can render a different rule than the Host applied.
 *  3. **The view is ADDITIVE.** The frozen `POST /api/ideas/action` envelope and
 *     the default (full) `GET /api/ideas/state` response are byte-for-byte what
 *     they were, and the aggregate itself stays inside the 512 KiB wire cap at
 *     the 140-card fixture size — which is the whole reason it is a separate
 *     bounded read rather than something the board re-reduces from the
 *     megabyte-wide snapshot.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes } from '../src/host-routes.ts'
import { HttpIdeasHostTransport } from '../src/client/host-api.ts'
import {
  buildIdeasStats,
  calendarMonthStart,
  durationParts,
  IDEAS_STATS_DAY_MS,
  IDEAS_STATS_MAX_TAGS,
  IDEAS_STATS_MAX_WORKSPACES,
  IDEAS_STATS_MEDIAN_MIN_SAMPLES,
  type IdeasStats,
} from '../src/core/ideas-stats.ts'
import {
  IDEAS_API_PREFIX,
  IDEAS_READ_MAX_RESPONSE_BYTES,
  IDEAS_SCHEMA_VERSION,
  ideasStatsSearchParams,
  parseIdeasStatsQuery,
  toListSnapshot,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord, IdeaStatus } from '../src/core/ideas.ts'
import { makePerfDataset, PERF_IDEA_COUNT } from './perf-fixture.ts'

const HOUR = 3_600_000
const DAY = 86_400_000

/** Fixed clock so every window assertion is exact. */
const NOW = new Date(2026, 9, 14, 12, 0, 0, 0).getTime() // 14 Oct 2026, local

function idea(partial: Partial<IdeaRecord> & Pick<IdeaRecord, 'id' | 'status'>): IdeaRecord {
  return {
    title: `Title ${partial.id}`,
    body: `Body ${partial.id}`,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    ...partial,
  }
}

function stats(ideas: IdeaRecord[], options: Parameters<typeof buildIdeasStats>[1] = {}, revision = 7): IdeasStats {
  return buildIdeasStats({ revision, ideas }, { now: NOW, ...options })
}

/** A delivered idea `leadDays` after its creation. */
function delivered(id: string, leadDays: number, extra: Partial<IdeaRecord> = {}): IdeaRecord {
  const createdAt = NOW - 60 * DAY
  return idea({ id, status: 'archived', createdAt, updatedAt: NOW, archivedAt: NOW, deliveredAt: createdAt + leadDays * DAY, ...extra })
}

describe('the health aggregate answers the five questions', () => {
  it('counts the open backlog per workspace, busiest first, with a generic group', () => {
    const result = stats([
      idea({ id: 'a1', status: 'open', workspaceId: 'ws-a', rank: 1, value: 3 }),
      idea({ id: 'a2', status: 'open', workspaceId: 'ws-a', rank: 2, value: 2 }),
      idea({ id: 'b1', status: 'open', workspaceId: 'ws-b', rank: 1, value: 1 }),
      idea({ id: 'g1', status: 'open', rank: 1 }),
      idea({ id: 'r1', status: 'underReview', workspaceId: 'ws-b' }),
      idea({ id: 'x1', status: 'archived', workspaceId: 'ws-b' }),
    ])

    expect(result.openTotal).toBe(4)
    expect(result.scope).toEqual({ kind: 'all', ideas: 6 })
    expect(result.openByWorkspace).toEqual([
      { workspaceId: 'ws-a', open: 2, total: 2 },
      // ws-b carries the under-review and archived rows, so its open count ties
      // the generic group's while its group size breaks the tie.
      { workspaceId: 'ws-b', open: 1, total: 3 },
      { open: 1, total: 1 },
    ])
  })

  it('measures "delivered this month" against the local CALENDAR month, not a rolling window', () => {
    const monthStart = calendarMonthStart(NOW)
    const yesterday = NOW - DAY
    const lastMonth = monthStart - HOUR
    const nextMonth = NOW + 20 * DAY

    const result = stats([
      delivered('inside', 2, { deliveredAt: yesterday }),
      delivered('edge', 2, { deliveredAt: monthStart }),
      delivered('before', 2, { deliveredAt: lastMonth }),
      delivered('ahead', 2, { deliveredAt: nextMonth }),
    ])

    expect(result.window).toEqual({ kind: 'calendarMonth', start: monthStart, end: NOW })
    // Last month's delivery is outside; a future-dated one cannot be "this month".
    expect(result.deliveredInWindow).toBe(2)
  })

  it('takes the median over EVERY timestamped delivery, not only this month', () => {
    const long = { createdAt: NOW - 200 * DAY, deliveredAt: NOW - 120 * DAY }
    const result = stats([
      ...[1, 2, 3, 4, 5].map(days => delivered(`d${days}`, days)),
      // Two more deliveries from previous months, both short: they belong to the
      // median of the whole board, which is what "how long does this take here"
      // actually means.
      delivered('old-1', 5, long),
      delivered('old-2', 5, long),
    ])
    expect(result.delivery.sample).toBe(7)
    // Sorted: 1,2,3,4,5,80,80 -> the middle value of an odd sample.
    expect(result.delivery.medianMs).toBe(4 * DAY)
    // ...while "this month" still counts only the recent ones.
    expect(result.deliveredInWindow).toBe(0)
  })

  it('names the top labels of the OPEN backlog, most used first', () => {
    const result = stats([
      idea({ id: 'a', status: 'open', tags: [{ name: 'perf' }, { name: 'ui' }] }),
      idea({ id: 'b', status: 'open', tags: [{ name: 'perf' }] }),
      // Case-folded: a label a reader would call the same one is counted once,
      // and the first spelling encountered is the one shown.
      idea({ id: 'c', status: 'open', tags: [{ name: 'PERF' }] }),
      // Closed work carries a label the open backlog never uses: it is history,
      // not work to do, so it must not lead the list.
      idea({ id: 'd', status: 'archived', tags: [{ name: 'legacy' }] }),
    ])
    expect(result.topTags).toEqual([{ name: 'perf', count: 3 }, { name: 'ui', count: 1 }])
    expect(result.tagsTotal).toBe(2)
  })

  it('reports the triage gaps as work to do, never as a score', () => {
    const result = stats([
      idea({ id: 'a', status: 'open' }),
      idea({ id: 'b', status: 'open', rank: 1 }),
      idea({ id: 'c', status: 'open', rank: 2, value: 3 }),
      // A closed idea without a score is not backlog triage: nothing to decide.
      idea({ id: 'd', status: 'archived' }),
    ])
    expect(result.triage).toEqual({ open: 3, missingRank: 1, missingValue: 2 })
  })
})

describe('the median refuses to print on a thin sample', () => {
  it('answers null — never a number — below the floor, and carries the floor', () => {
    const thin = stats([1, 2, 3, 4].map(days => delivered(`d${days}`, days)))
    expect(thin.delivery.sample).toBe(4)
    expect(thin.delivery.medianMs).toBeNull()
    expect(thin.delivery.minSamples).toBe(IDEAS_STATS_MEDIAN_MIN_SAMPLES)

    const enough = stats([1, 2, 3, 4, 5].map(days => delivered(`d${days}`, days)))
    expect(enough.delivery.sample).toBe(IDEAS_STATS_MEDIAN_MIN_SAMPLES)
    expect(enough.delivery.medianMs).toBe(3 * DAY)
  })

  it('counts the backlog closed WITHOUT a stamp, and never folds it into the median', () => {
    // The exact failure this view was deferred for: a backlog mostly dragged to
    // Archived has no delivery data, so there is nothing honest to take a
    // median of — and the view must say so in numbers the reader can check.
    const archivedOnly = stats([
      idea({ id: 'a', status: 'archived', archivedAt: NOW }),
      idea({ id: 'b', status: 'archived', archivedAt: NOW }),
      idea({ id: 'c', status: 'archived', archivedAt: NOW }),
    ])
    expect(archivedOnly.delivery).toMatchObject({ sample: 0, withoutStamp: 3, medianMs: null })

    // Three unstamped rows beside five real deliveries must not move the median.
    const mixed = stats([
      ...[1, 2, 3, 4, 5].map(days => delivered(`d${days}`, days)),
      ...['x', 'y', 'z'].map(id => idea({ id, status: 'archived', archivedAt: NOW })),
    ])
    expect(mixed.delivery.sample).toBe(5)
    expect(mixed.delivery.withoutStamp).toBe(3)
    expect(mixed.delivery.medianMs).toBe(3 * DAY)
  })

  it('never averages a stamp that precedes its own creation, and reports it', () => {
    const result = stats([
      ...[1, 2, 3, 4, 5].map(days => delivered(`d${days}`, days)),
      // Only reachable through a hand-edited or imported document.
      idea({ id: 'broken', status: 'archived', createdAt: NOW, deliveredAt: NOW - 10 * DAY }),
    ])
    expect(result.delivery.inconsistent).toBe(1)
    expect(result.delivery.sample).toBe(5)
    expect(result.delivery.medianMs).toBe(3 * DAY)
  })

  it('never counts a DECLINED idea as a missing delivery', () => {
    // A decline is an honest "no", not work closed without a delivery: it must
    // not inflate `withoutStamp`, which is the count of unstamped ARCHIVES.
    const result = stats([
      idea({ id: 'd1', status: 'declined', archivedAt: NOW }),
      idea({ id: 'd2', status: 'declined', archivedAt: NOW }),
    ])
    expect(result.delivery).toMatchObject({ sample: 0, withoutStamp: 0, inconsistent: 0, medianMs: null })
  })

  it('keeps a real delivery in the sample even when the idea moved on afterwards', () => {
    // `restore` clears `archivedAt` alone, so a delivered idea can be reopened
    // and later declined while keeping the stamp. The delivery happened; the
    // median has every right to count it.
    const result = stats([{ ...delivered('x', 4), status: 'declined' as IdeaStatus }])
    expect(result.delivery.sample).toBe(1)
    expect(result.delivery.medianMs).toBeNull()
  })

  it('is deterministic for one revision', () => {
    const ideas = [delivered('a', 1), delivered('b', 2), idea({ id: 'c', status: 'open', workspaceId: 'ws' })]
    expect(JSON.stringify(stats(ideas))).toBe(JSON.stringify(stats(ideas)))
  })
})

describe('the aggregate is scoped, and the scope is spelled in the answer', () => {
  const board = [
    idea({ id: 'a1', status: 'open', workspaceId: 'ws-a', tags: [{ name: 'alpha' }] }),
    idea({ id: 'b1', status: 'open', workspaceId: 'ws-b', tags: [{ name: 'beta' }] }),
    idea({ id: 'g1', status: 'open', tags: [{ name: 'gamma' }] }),
  ]

  it('answers for every workspace by default', () => {
    const result = stats(board)
    expect(result.scope.kind).toBe('all')
    expect(result.openTotal).toBe(3)
    expect(result.topTags.map(tag => tag.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('answers for one workspace, and for the workspace-less group', () => {
    const scoped = stats(board, { workspaceId: 'ws-a' })
    expect(scoped.scope).toEqual({ kind: 'workspace', workspaceId: 'ws-a', ideas: 1 })
    expect(scoped.topTags.map(tag => tag.name)).toEqual(['alpha'])

    const generic = stats(board, { workspaceId: '' })
    expect(generic.scope).toEqual({ kind: 'generic', ideas: 1 })
    expect(generic.topTags.map(tag => tag.name)).toEqual(['gamma'])
  })

  it('handles a scope holding nothing at all without inventing a zero median', () => {
    const empty = stats(board, { workspaceId: 'ws-missing' })
    expect(empty.scope.ideas).toBe(0)
    expect(empty.openTotal).toBe(0)
    expect(empty.deliveredInWindow).toBe(0)
    expect(empty.delivery.medianMs).toBeNull()
    expect(empty.topTags).toEqual([])
    expect(empty.openByWorkspace).toEqual([])
  })
})

describe('the aggregate is bounded whatever the ledger weighs', () => {
  it('caps the workspace breakdown and the label list, and says how many are left out', () => {
    const ideas = Array.from({ length: 40 }, (_, index) =>
      idea({ id: `i${index}`, status: 'open', workspaceId: `ws-${index}`, tags: [{ name: `tag-${index}` }] }))
    const result = stats(ideas)
    expect(result.openByWorkspace).toHaveLength(IDEAS_STATS_MAX_WORKSPACES)
    expect(result.workspacesTotal).toBe(40)
    expect(result.topTags).toHaveLength(IDEAS_STATS_MAX_TAGS)
    expect(result.tagsTotal).toBe(40)
  })

  it('keeps the 140-card fixture far inside the 512 KiB wire cap', () => {
    const ledger: IdeasSnapshot = { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 101, ideas: makePerfDataset() }
    const full = JSON.stringify(ledger)
    const result = buildIdeasStats(ledger, { now: NOW })
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')

    expect(result.scope.ideas).toBe(PERF_IDEA_COUNT)
    expect(bytes).toBeLessThanOrEqual(IDEAS_READ_MAX_RESPONSE_BYTES)
    // The point of a bounded view: three orders of magnitude lighter than the
    // snapshot it replaces as a poll payload.
    expect(bytes * 100).toBeLessThan(Buffer.byteLength(full, 'utf8'))
  })
})

describe('durationParts is the one formatting rule', () => {
  it('picks a unit and never rounds a real lead time down to zero', () => {
    expect(durationParts(45 * MINUTE_MS)).toEqual({ value: 45, unit: 'minutes' })
    expect(durationParts(3 * HOUR)).toEqual({ value: 3, unit: 'hours' })
    expect(durationParts(12 * IDEAS_STATS_DAY_MS)).toEqual({ value: 12, unit: 'days' })
    // Half a day is hours, not "0 days": the unit is chosen before the rounding,
    // so a naive round(days) could never show up as a zero.
    expect(durationParts(IDEAS_STATS_DAY_MS / 2)).toEqual({ value: 12, unit: 'hours' })
    // Ten seconds is a real lead time too; the floor is one minute, never zero.
    expect(durationParts(10_000)).toEqual({ value: 1, unit: 'minutes' })
    expect(durationParts(0)).toEqual({ value: 1, unit: 'minutes' })
    expect(durationParts(Number.NaN)).toEqual({ value: 1, unit: 'minutes' })
  })
})

const MINUTE_MS = 60_000

describe('the stats query parser', () => {
  it('reads the three scopes the board selector can ask for', () => {
    expect(parseIdeasStatsQuery(new URLSearchParams('view=stats'))).toEqual({})
    expect(parseIdeasStatsQuery(new URLSearchParams('view=stats&workspaceId=ws-a'))).toEqual({ workspaceId: 'ws-a' })
    expect(parseIdeasStatsQuery(new URLSearchParams('view=stats&workspaceId='))).toEqual({ workspaceId: '' })
    expect(parseIdeasStatsQuery(new URLSearchParams('view=stats&workspaceId=%20'))).toEqual({ workspaceId: '' })
  })

  it('refuses another view, an unknown key and an oversized workspace id', () => {
    expect(parseIdeasStatsQuery(new URLSearchParams('view=summary'))).toBeUndefined()
    expect(parseIdeasStatsQuery(new URLSearchParams('view=stats&limit=10'))).toBeUndefined()
    expect(parseIdeasStatsQuery(new URLSearchParams('view=stats&fields=body'))).toBeUndefined()
    expect(parseIdeasStatsQuery(new URLSearchParams(`view=stats&workspaceId=${'x'.repeat(257)}`))).toBeUndefined()
  })

  it('round-trips through the browser serializer', () => {
    expect(ideasStatsSearchParams().toString()).toBe('view=stats')
    const params = ideasStatsSearchParams({ workspaceId: 'ws-a' })
    expect(parseIdeasStatsQuery(params)).toEqual({ workspaceId: 'ws-a' })
  })
})

/* --- the route, against a real loopback server ---------------------------- */

let dir = ''
let server: Server | undefined
let service: IdeasHostService | undefined

afterEach(async () => {
  const open = server
  server = undefined
  if (open !== undefined) await new Promise<void>(resolve => { open.close(() => { resolve() }) })
  // Dispose BEFORE rm: the ledger holds a lock file on Windows.
  service?.dispose()
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

async function serve(): Promise<string> {
  dir = join(tmpdir(), `ideas-stats-route-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir })
  const routes = makeIdeasRoutes(service)
  const open = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void Promise.resolve(route.handler(req as IncomingMessage, res as ServerResponse)).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => { open.listen(0, '127.0.0.1', () => { resolve() }) })
  server = open
  const address = open.address()
  if (address === null || typeof address === 'string') throw new Error('no listen address')
  return `http://127.0.0.1:${address.port}`
}

const get = (url: string, marker = true): Promise<Response> =>
  fetch(url, { headers: marker ? { 'sec-fetch-site': 'same-origin' } : {} })

describe('GET /api/ideas/state?view=stats', () => {
  it('serves the aggregate, scoped, behind the browser fence', async () => {
    const base = await serve()
    service!.apply('c1', { kind: 'create', id: 'idea-1', input: { title: 'Alpha', body: 'B', workspaceId: 'ws-a' } })
    service!.apply('c2', { kind: 'create', id: 'idea-2', input: { title: 'Beta', body: 'B', workspaceId: 'ws-b' } })

    const all = await get(`${base}${IDEAS_API_PREFIX}/state?view=stats`)
    expect(all.status).toBe(200)
    const payload = await all.json() as IdeasStats
    expect(payload.scope).toEqual({ kind: 'all', ideas: 2 })
    expect(payload.openTotal).toBe(2)
    expect(payload.delivery.medianMs).toBeNull()

    const scoped = await get(`${base}${IDEAS_API_PREFIX}/state?view=stats&workspaceId=ws-a`)
    const scopedPayload = await scoped.json() as IdeasStats
    expect(scopedPayload.scope).toEqual({ kind: 'workspace', workspaceId: 'ws-a', ideas: 1 })
    // The revision travels with the numbers, so the panel can tell a fresh
    // aggregate from one that predates the board it is painted under.
    expect(scopedPayload.revision).toBe(payload.revision)

    const refused = await get(`${base}${IDEAS_API_PREFIX}/state?view=stats`, false)
    expect(refused.status).toBe(403)
  })

  it('refuses a bad query rather than answering a different question', async () => {
    const base = await serve()
    for (const query of ['view=stats&limit=5', 'view=stats&fields=body', `view=stats&workspaceId=${'x'.repeat(300)}`]) {
      const response = await get(`${base}${IDEAS_API_PREFIX}/state?${query}`)
      expect({ query, status: response.status }).toEqual({ query, status: 400 })
      expect(await response.json()).toMatchObject({ ok: false, error: 'invalid-query' })
    }
  })

  it('refuses a non-GET', async () => {
    const base = await serve()
    const response = await fetch(`${base}${IDEAS_API_PREFIX}/state?view=stats`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    expect(response.status).toBe(405)
  })
})

describe('the view is ADDITIVE: the frozen wire did not move', () => {
  it('the default full snapshot carries no health key at all', async () => {
    const base = await serve()
    service!.apply('c1', { kind: 'create', id: 'idea-1', input: { title: 'Alpha', body: 'B' } })

    const full = await (await get(`${base}${IDEAS_API_PREFIX}/state`)).text()
    expect(Object.keys(JSON.parse(full) as object).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])
    expect(full).not.toContain('stats')
    expect(full).not.toContain('medianMs')

    // The board's own poll projection too: not one byte of this feature.
    const list = await (await get(`${base}${IDEAS_API_PREFIX}/state?view=list`)).text()
    expect(list).not.toContain('stats')
    expect(list).not.toContain('medianMs')

    // And the two bounded row views keep their exact envelopes.
    const summary = await (await get(`${base}${IDEAS_API_PREFIX}/state?view=summary`)).json() as { ideas: unknown[]; meta: unknown }
    expect(Object.keys(summary).sort()).toEqual(['ideas', 'meta', 'revision', 'schemaVersion'])
  })

  it('the list projection of a snapshot is byte-identical with or without the route', async () => {
    const base = await serve()
    service!.apply('c1', { kind: 'create', id: 'idea-1', input: { title: 'Alpha', body: 'B' } })
    const before = await (await get(`${base}${IDEAS_API_PREFIX}/state?view=list`)).text()
    await get(`${base}${IDEAS_API_PREFIX}/state?view=stats`)
    const after = await (await get(`${base}${IDEAS_API_PREFIX}/state?view=list`)).text()
    expect(after).toBe(before)
  })

  it('the action envelope is unchanged and still refuses anything that is not a verb', async () => {
    const base = await serve()
    const post = (body: unknown): Promise<Response> => fetch(`${base}${IDEAS_API_PREFIX}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    })

    const created = await post({ requestId: 'r1', action: { kind: 'create', id: 'idea-1', input: { title: 'Alpha', body: 'B' } } })
    expect(created.status).toBe(200)
    // The action answer stays the FULL snapshot: no stats block rides it.
    const body = await created.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])
    expect(JSON.stringify(body)).not.toContain('medianMs')

    // `stats` is not a verb, and reading the aggregate is not a mutation.
    expect((await post({ requestId: 'r2', action: { kind: 'stats' } })).status).toBe(400)
    expect((await post({ requestId: 'r3', action: { kind: 'snapshot' } })).status).toBe(400)

    // Import/export round-trip whatever the ledger already holds: this feature
    // added no record field, so a delivery stamp travels exactly as before.
    service!.apply('d1', { kind: 'deliver', ideaId: 'idea-1' })
    const exported = await (await get(`${base}${IDEAS_API_PREFIX}/state?view=detail&fields=deliveredAt`)).json() as { ideas: Array<Record<string, unknown>> }
    expect(exported.ideas[0]?.deliveredAt).toBeTypeOf('number')
  })

  it('export/import of a delivered board still carries every stored field', async () => {
    const base = await serve()
    service!.apply('c1', { kind: 'create', id: 'idea-1', input: { title: 'Alpha', body: 'B' } })
    service!.apply('d1', { kind: 'deliver', ideaId: 'idea-1' })

    const document = await (await get(`${base}${IDEAS_API_PREFIX}/state`)).text() as string
    const before = stats(JSON.parse(document).ideas as IdeaRecord[], {}, JSON.parse(document).revision as number)
    expect(before.delivery.sample).toBe(1)

    const adopted = await fetch(`${base}${IDEAS_API_PREFIX}/backup/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ document }),
    })
    expect(adopted.status).toBe(200)

    const after = buildIdeasStats(service!.snapshot())
    // Same deliveries, therefore the same median decision — the aggregate is
    // derived, so a ledger that round-tripped is provably intact.
    expect(after.delivery.sample).toBe(before.delivery.sample)
    expect(after.delivery.medianMs).toBe(before.delivery.medianMs)
  })

  it('a snapshot projection of the same board is unchanged by the new module', () => {
    const ledger: IdeasSnapshot = { schemaVersion: 1, revision: 3, ideas: [idea({ id: 'a', status: 'open' })] }
    expect(toListSnapshot(ledger).revision).toBe(3)
    expect(JSON.stringify(toListSnapshot(ledger))).not.toContain('medianMs')
  })
})

describe('the browser transport asks for it separately from the poll', () => {
  const realFetch = globalThis.fetch
  let urls: string[]

  beforeEach(() => {
    urls = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === 'string' ? input : input.toString())
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('uses its own URL, and leaves the poll URL exactly as it was', async () => {
    const transport = new HttpIdeasHostTransport()
    await transport.stats()
    await transport.stats({ workspaceId: 'ws-a' })
    await transport.stats({ workspaceId: '' })
    await transport.state()

    expect(urls.slice(0, 3)).toEqual([
      '/api/ideas/state?view=stats',
      '/api/ideas/state?view=stats&workspaceId=ws-a',
      '/api/ideas/state?view=stats&workspaceId=',
    ])
    // The 2.5 s poll is byte-identical to what it has always requested: this
    // feature has no reason to appear in it.
    expect(urls[3]).toBe('/api/ideas/state?view=list')
  })
})