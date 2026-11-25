/**
 * Backlog health — the ONE definition of every number the health
 * dashboard prints.
 *
 * Framework-free and pure, exactly like `core/ideas.ts`: the Host route, the
 * browser transport and every future surface read this module, so an aggregate
 * can never be computed two different ways in two places.
 *
 * The dashboard is deliberately made of signals rather than one opaque score:
 * workflow volume, delivery flow, triage work, age, activity and data quality.
 * Every array is hard-capped, so the response stays small whatever the ledger
 * weighs.
 */

import type { IdeaRecord } from './ideas.ts'

/** Wire version of the health aggregate (independent of the snapshot schema). */
export const IDEAS_STATS_SCHEMA_VERSION = 2 as const

/** Minimum real deliveries before a median is printed. */
export const IDEAS_STATS_MEDIAN_MIN_SAMPLES = 5

/** Hard caps keep the aggregate bounded. */
export const IDEAS_STATS_MAX_WORKSPACES = 8
export const IDEAS_STATS_MAX_TAGS = 8
export const IDEAS_STATS_DELIVERY_BUCKETS = 8
export const IDEAS_STATS_ACTIVITY_DAYS = 84

/** One day in milliseconds. */
export const IDEAS_STATS_DAY_MS = 86_400_000

/** Period selected by the dashboard. */
export type IdeasStatsRange = 'month' | '30d' | '90d' | 'all'

/** Which workspace population the numbers cover. */
export type IdeasStatsScopeKind = 'all' | 'generic' | 'workspace'

/** One row of the open-per-workspace breakdown. */
export interface IdeasStatsWorkspaceRow {
  /** Absent for the workspace-less (generic) group. */
  workspaceId?: string
  open: number
  total: number
}

/** One row of the top-tags list. */
export interface IdeasStatsTagRow {
  name: string
  count: number
}

/** Active workflow signals. Running and blocked overlap the status columns. */
export interface IdeasStatsWorkflow {
  open: number
  underReview: number
  running: number
  blocked: number
}

/** Age buckets for OPEN ideas only. */
export interface IdeasStatsAging {
  upTo7: number
  upTo30: number
  upTo90: number
  over90: number
  oldestMs: number | null
}

/** One local calendar day in the fixed activity heatmap. */
export interface IdeasStatsActivityDay {
  /** Local Host date, `YYYY-MM-DD`. */
  date: string
  created: number
  delivered: number
}

/** Fixed 12-week activity heatmap. */
export interface IdeasStatsActivity {
  days: IdeasStatsActivityDay[]
  created: number
  delivered: number
  activeDays: number
}

/** One delivery bar in the selected period. */
export interface IdeasStatsDeliveryBucket {
  start: number
  end: number
  count: number
}

/** Delivery honesty and the selected-period distribution. */
export interface IdeasStatsDelivery {
  /** Usable deliveries inside the selected window. */
  sample: number
  /** Archived ideas with no delivery stamp, all time. */
  withoutStamp: number
  /** Stamps that precede their own creation, all time. */
  inconsistent: number
  /** Median lead time inside the selected window, or null below the floor. */
  medianMs: number | null
  minSamples: number
  /** Eight bounded bars covering the selected period. */
  buckets: IdeasStatsDeliveryBucket[]
}

/** Triage work among OPEN ideas. `unique` never double-counts a row. */
export interface IdeasStatsTriage {
  open: number
  missingRank: number
  missingValue: number
  unique: number
}

/** Data-quality facts kept separate from workflow judgements. */
export interface IdeasStatsQuality {
  withoutStamp: number
  inconsistent: number
  withoutWorkspace: number
}

/** The measured window, spelled so the UI can label it honestly. */
export interface IdeasStatsWindow {
  kind: 'calendarMonth' | 'rollingDays' | 'allTime'
  start: number
  end: number
  /** Present only for a rolling window. */
  days?: 30 | 90
}

/** Which scope the numbers cover, plus how many ideas it holds. */
export interface IdeasStatsScope {
  kind: IdeasStatsScopeKind
  workspaceId?: string
  ideas: number
}

/** Whole bounded health aggregate served by `GET /api/ideas/state?view=stats`. */
export interface IdeasStats {
  schemaVersion: typeof IDEAS_STATS_SCHEMA_VERSION
  revision: number
  computedAt: number
  range: IdeasStatsRange
  scope: IdeasStatsScope
  window: IdeasStatsWindow
  openTotal: number
  workflow: IdeasStatsWorkflow
  aging: IdeasStatsAging
  openByWorkspace: IdeasStatsWorkspaceRow[]
  workspacesTotal: number
  deliveredInWindow: number
  delivery: IdeasStatsDelivery
  activity: IdeasStatsActivity
  topTags: IdeasStatsTagRow[]
  tagsTotal: number
  triage: IdeasStatsTriage
  quality: IdeasStatsQuality
}

/** Read-only seam the Host hands to the pure aggregate. */
export interface IdeasStatsSource {
  revision: number
  ideas: readonly IdeaRecord[]
}

/** Scope, period and clock of one aggregate. */
export interface IdeasStatsOptions {
  /** Omitted = all, `''` = workspace-less, real id = one workspace. */
  workspaceId?: string
  /** Selected dashboard period; defaults to the current calendar month. */
  range?: IdeasStatsRange
  /** Instant the window is measured at (defaults to the Host clock). */
  now?: number
}

/** Unit the median is rendered in. */
export type IdeasDurationUnit = 'minutes' | 'hours' | 'days'

/** First instant of the Host's LOCAL calendar month containing `at`. */
export function calendarMonthStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0).getTime()
}

/** First instant of the Host's LOCAL calendar day containing `at`. */
export function calendarDayStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime()
}

/** Local `YYYY-MM-DD` key, never a UTC day boundary. */
function localDayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Split a duration into a value and a unit the panel can label. */
export function durationParts(ms: number): { value: number; unit: IdeasDurationUnit } {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const days = safe / IDEAS_STATS_DAY_MS
  if (days >= 1) return { value: Math.round(days), unit: 'days' }
  const hours = safe / 3_600_000
  if (hours >= 1) return { value: Math.round(hours), unit: 'hours' }
  return { value: Math.max(1, Math.round(safe / 60_000)), unit: 'minutes' }
}

/** Median of a non-empty sample. */
function medianOf(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const value = sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
  return Math.round(value)
}

function windowOf(now: number, range: IdeasStatsRange): IdeasStatsWindow {
  if (range === 'month') return { kind: 'calendarMonth', start: calendarMonthStart(now), end: now }
  if (range === '30d') return { kind: 'rollingDays', start: now - 30 * IDEAS_STATS_DAY_MS, end: now, days: 30 }
  if (range === '90d') return { kind: 'rollingDays', start: now - 90 * IDEAS_STATS_DAY_MS, end: now, days: 90 }
  return { kind: 'allTime', start: 0, end: now }
}

/** Build eight deterministic delivery bars for the selected period. */
function deliveryBuckets(
  deliveries: readonly { at: number; ms: number }[],
  window: IdeasStatsWindow,
  earliestActivity: number,
  now: number,
): IdeasStatsDeliveryBucket[] {
  const inWindow = deliveries.filter(item => item.at >= window.start && item.at <= window.end)
  let start = window.kind === 'allTime' ? earliestActivity : window.start
  if (window.kind === 'allTime') {
    for (const item of inWindow) start = Math.min(start, item.at)
    start = Math.min(start, now)
  }
  const safeStart = Number.isFinite(start) ? Math.min(start, now) : now
  const span = Math.max(1, now - safeStart)
  const width = span / IDEAS_STATS_DELIVERY_BUCKETS
  const buckets = Array.from({ length: IDEAS_STATS_DELIVERY_BUCKETS }, (_, index) => ({
    start: safeStart + Math.floor(width * index),
    end: safeStart + Math.floor(width * (index + 1)),
    count: 0,
  }))
  for (const item of inWindow) {
    const raw = Math.floor((item.at - safeStart) / width)
    const index = Math.max(0, Math.min(IDEAS_STATS_DELIVERY_BUCKETS - 1, raw))
    buckets[index]!.count += 1
  }
  return buckets
}

/** Fixed 84-day local activity heatmap. */
function activityOf(source: IdeasStatsSource, inScope: (idea: IdeaRecord) => boolean, now: number): IdeasStatsActivity {
  const today = calendarDayStart(now)
  const first = today - (IDEAS_STATS_ACTIVITY_DAYS - 1) * IDEAS_STATS_DAY_MS
  const days: IdeasStatsActivityDay[] = Array.from({ length: IDEAS_STATS_ACTIVITY_DAYS }, (_, index) => ({
    date: localDayKey(first + index * IDEAS_STATS_DAY_MS),
    created: 0,
    delivered: 0,
  }))
  const byDate = new Map(days.map((day, index) => [day.date, index]))
  for (const idea of source.ideas) {
    if (!inScope(idea)) continue
    const createdIndex = byDate.get(localDayKey(idea.createdAt))
    if (createdIndex !== undefined) days[createdIndex]!.created += 1
    if (idea.deliveredAt !== undefined && Number.isFinite(idea.deliveredAt) && idea.deliveredAt >= idea.createdAt) {
      const deliveredIndex = byDate.get(localDayKey(idea.deliveredAt))
      if (deliveredIndex !== undefined) days[deliveredIndex]!.delivered += 1
    }
  }
  const created = days.reduce((sum, day) => sum + day.created, 0)
  const delivered = days.reduce((sum, day) => sum + day.delivered, 0)
  return { days, created, delivered, activeDays: days.filter(day => day.created + day.delivered > 0).length }
}

/** Build the bounded health aggregate for one scope and period. */
export function buildIdeasStats(source: IdeasStatsSource, options: IdeasStatsOptions = {}): IdeasStats {
  const now = options.now ?? Date.now()
  const range = options.range ?? 'month'
  const scopeId = options.workspaceId
  const inScope = (idea: IdeaRecord): boolean =>
    scopeId === undefined ? true : (idea.workspaceId ?? '') === scopeId
  const window = windowOf(now, range)

  const groups = new Map<string, { open: number; total: number }>()
  const tagCounts = new Map<string, { name: string; count: number }>()
  const deliveries: Array<{ at: number; ms: number }> = []
  const activeIds = new Set<string>()

  let ideas = 0
  let openTotal = 0
  let underReview = 0
  let running = 0
  let deliveredInWindow = 0
  let withoutStamp = 0
  let inconsistent = 0
  let withoutWorkspace = 0
  let missingRank = 0
  let missingValue = 0
  let uniqueTriage = 0
  let oldestMs: number | null = null
  let earliestActivity = now
  let age7 = 0
  let age30 = 0
  let age90 = 0
  let ageOver90 = 0

  for (const idea of source.ideas) {
    if (!inScope(idea)) continue
    ideas += 1
    earliestActivity = Math.min(earliestActivity, idea.createdAt)
    if (idea.workspaceId === undefined || idea.workspaceId === '') withoutWorkspace += 1

    const key = idea.workspaceId ?? ''
    const group = groups.get(key) ?? { open: 0, total: 0 }
    group.total += 1
    if (idea.status === 'open') {
      group.open += 1
      openTotal += 1
      activeIds.add(idea.id)
      const age = Math.max(0, now - idea.createdAt)
      oldestMs = oldestMs === null ? age : Math.max(oldestMs, age)
      if (age <= 7 * IDEAS_STATS_DAY_MS) age7 += 1
      else if (age <= 30 * IDEAS_STATS_DAY_MS) age30 += 1
      else if (age <= 90 * IDEAS_STATS_DAY_MS) age90 += 1
      else ageOver90 += 1
      const lacksRank = idea.rank === undefined
      const lacksValue = idea.value === undefined
      if (lacksRank) missingRank += 1
      if (lacksValue) missingValue += 1
      if (lacksRank || lacksValue) uniqueTriage += 1
      if (idea.runStatus === 'running') running += 1
      for (const tag of idea.tags ?? []) {
        const name = tag.name.trim()
        if (name === '') continue
        const folded = name.toLowerCase()
        const entry = tagCounts.get(folded)
        if (entry === undefined) tagCounts.set(folded, { name, count: 1 })
        else entry.count += 1
      }
    } else if (idea.status === 'underReview') {
      underReview += 1
      activeIds.add(idea.id)
      if (idea.runStatus === 'running') running += 1
    }
    groups.set(key, group)

    const deliveredAt = idea.deliveredAt
    if (deliveredAt === undefined || !Number.isFinite(deliveredAt)) {
      if (idea.status === 'archived') withoutStamp += 1
      continue
    }
    earliestActivity = Math.min(earliestActivity, deliveredAt)
    const leadTime = deliveredAt - idea.createdAt
    if (leadTime < 0) {
      inconsistent += 1
      continue
    }
    deliveries.push({ at: deliveredAt, ms: leadTime })
    if (deliveredAt >= window.start && deliveredAt <= window.end) deliveredInWindow += 1
  }

  // A blocked signal is an active idea named by another scoped idea's `blocks`.
  // The relation remains a statement, never a scheduling constraint.
  const blockedIds = new Set<string>()
  for (const idea of source.ideas) {
    if (!inScope(idea)) continue
    for (const target of idea.blocks ?? []) {
      if (activeIds.has(target)) blockedIds.add(target)
    }
  }

  const sampleLeadTimes = deliveries
    .filter(item => item.at >= window.start && item.at <= window.end)
    .map(item => item.ms)
  const sample = sampleLeadTimes.length

  const openByWorkspace = [...groups.entries()]
    .map(([workspaceId, group]) => ({
      ...(workspaceId === '' ? {} : { workspaceId }),
      open: group.open,
      total: group.total,
    }))
    .sort((a, b) => b.open - a.open || b.total - a.total
      || (a.workspaceId ?? '').localeCompare(b.workspaceId ?? ''))
  const topTags = [...tagCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return {
    schemaVersion: IDEAS_STATS_SCHEMA_VERSION,
    revision: source.revision,
    computedAt: now,
    range,
    scope: {
      kind: scopeId === undefined ? 'all' : scopeId === '' ? 'generic' : 'workspace',
      ...(scopeId === undefined || scopeId === '' ? {} : { workspaceId: scopeId }),
      ideas,
    },
    window,
    openTotal,
    workflow: { open: openTotal, underReview, running, blocked: blockedIds.size },
    aging: { upTo7: age7, upTo30: age30, upTo90: age90, over90: ageOver90, oldestMs },
    openByWorkspace: openByWorkspace.slice(0, IDEAS_STATS_MAX_WORKSPACES),
    workspacesTotal: openByWorkspace.length,
    deliveredInWindow,
    delivery: {
      sample,
      withoutStamp,
      inconsistent,
      medianMs: sample < IDEAS_STATS_MEDIAN_MIN_SAMPLES ? null : medianOf(sampleLeadTimes),
      minSamples: IDEAS_STATS_MEDIAN_MIN_SAMPLES,
      buckets: deliveryBuckets(deliveries, window, earliestActivity, now),
    },
    activity: activityOf(source, inScope, now),
    topTags: topTags.slice(0, IDEAS_STATS_MAX_TAGS),
    tagsTotal: topTags.length,
    triage: { open: openTotal, missingRank, missingValue, unique: uniqueTriage },
    quality: { withoutStamp, inconsistent, withoutWorkspace },
  }
}
