/**
 * Backlog health (idea #110) — the ONE definition of every number the health
 * view prints.
 *
 * Framework-free and pure, exactly like `core/ideas.ts`: the Host route, the
 * browser transport and any future surface read this module, so an aggregate
 * can never be computed two different ways in two places. That is the one
 * failure mode a dashboard has and a test does not always catch.
 *
 * Four decisions live here, and each one is load-bearing rather than a
 * convenience:
 *
 *  1. **The median refuses to print on a thin sample.** `deliveredAt` is
 *     stamped by the `deliver` verb and is only as honest as the way the
 *     backlog is closed, so the sample is the set of ideas that carry a REAL
 *     stamp. Below {@link IDEAS_STATS_MEDIAN_MIN_SAMPLES} the response answers
 *     `medianMs: null` and says how many rows it had — never a zero, never a
 *     number computed on one row. The floor and the sample size both travel in
 *     the payload so the UI cannot render a different rule than the Host used.
 *  2. **"Delivered this month" is the Host's LOCAL CALENDAR month**, reported
 *     as an explicit `{start, end}` pair so the user-facing label can be
 *     checked against the data it claims. A rolling window would need a
 *     different label ("last 30 days"); the words on the card mean this one.
 *  3. **The view is SCOPED, not global.** It follows the board's workspace
 *     selector, like every other tab, so a number never answers a different
 *     question than the one on screen. `scope.kind` says which scope it is.
 *  4. **"No rank, no value" is triage WORK, not a score.** It counts OPEN ideas
 *     in scope and is named as a to-do; it is never a judgement about whoever
 *     wrote the idea.
 *
 * The response is bounded by construction: the workspace breakdown and the tag
 * list are hard-capped, so the whole aggregate stays a few kilobytes whatever
 * the ledger weighs (the board's full snapshot is over a megabyte).
 */

import type { IdeaRecord } from './ideas.ts'

/** Wire version of the health aggregate (independent of the snapshot schema). */
export const IDEAS_STATS_SCHEMA_VERSION = 1 as const

/**
 * How many ideas must carry a real `deliveredAt` before a median time-to-deliver
 * is printed at all.
 *
 * Five is the smallest sample where the middle of the distribution means
 * something: below it, one delivery decides the "typical" lead time, and a
 * dashboard that shows a confident number computed from two rows is worse than
 * one that admits it has nothing to say. The floor is deliberately a constant
 * rather than a percentage: a percentage would let a small board print a
 * median off two rows while a big one stayed silent, which is exactly the
 * confident-wrong-number failure this view exists to avoid.
 */
export const IDEAS_STATS_MEDIAN_MIN_SAMPLES = 5

/** Hard cap of the per-workspace open breakdown. */
export const IDEAS_STATS_MAX_WORKSPACES = 8

/** Hard cap of the top-tags list. */
export const IDEAS_STATS_MAX_TAGS = 8

/** One day in milliseconds — the unit {@link durationParts} falls back on. */
export const IDEAS_STATS_DAY_MS = 86_400_000

/**
 * Which workspace population the numbers cover. `generic` is the ideas with no
 * workspace at all — the same group the board's "— without workspace —"
 * selector shows, and the same one `rankGroupKey` ranks together.
 */
export type IdeasStatsScopeKind = 'all' | 'generic' | 'workspace'

/** One row of the open-per-workspace breakdown. */
export interface IdeasStatsWorkspaceRow {
  /** Absent for the workspace-less (generic) group. */
  workspaceId?: string
  /** Open ideas in this group. */
  open: number
  /** Every idea in this group, any status. */
  total: number
}

/** One row of the top-tags list. */
export interface IdeasStatsTagRow {
  name: string
  count: number
}

/**
 * Delivery honesty, the whole point of this view.
 *
 * `medianMs` is `null` — and only `null` — when the sample is thinner than
 * {@link IDEAS_STATS_MEDIAN_MIN_SAMPLES}. `sample` is the median's actual
 * population, `withoutStamp` is how many ideas left the backlog WITHOUT a
 * delivery stamp (dragged to Archived rather than delivered: work to do, and
 * the reason a backlog can have no honest median at all), and `inconsistent`
 * counts stamps that precede their own creation — reachable only through a
 * hand-edited or imported document, and never silently averaged away.
 */
export interface IdeasStatsDelivery {
  /** Ideas carrying a usable `deliveredAt` (the median's sample). */
  sample: number
  /** Archived ideas with no delivery stamp: excluded from the median. */
  withoutStamp: number
  /** Stamps that precede their own creation: a data problem, never averaged. */
  inconsistent: number
  /** Median time to deliver in milliseconds, or null below the sample floor. */
  medianMs: number | null
  /** The floor `sample` had to reach for `medianMs` to be printed. */
  minSamples: number
}

/** Triage work to do among the OPEN ideas in scope. Never a quality score. */
export interface IdeasStatsTriage {
  open: number
  missingRank: number
  missingValue: number
}

/** The "delivered this month" window, spelled so a label can be checked. */
export interface IdeasStatsWindow {
  kind: 'calendarMonth'
  /** Inclusive first instant of the Host's local calendar month. */
  start: number
  /** Inclusive instant the aggregate was measured at. */
  end: number
}

/** Which scope the numbers cover, plus how many ideas it holds. */
export interface IdeasStatsScope {
  kind: IdeasStatsScopeKind
  /** Present only when `kind` is `workspace`. */
  workspaceId?: string
  /** Ideas in scope, any status. */
  ideas: number
}

/**
 * The whole health aggregate, as `GET /api/ideas/state?view=stats` serves it.
 * Every array in it is hard-capped, so the response stays bounded no matter how
 * large the ledger is.
 */
export interface IdeasStats {
  schemaVersion: typeof IDEAS_STATS_SCHEMA_VERSION
  /** Ledger revision these numbers were derived from. */
  revision: number
  /** Instant the window was measured at (the Host clock). */
  computedAt: number
  scope: IdeasStatsScope
  window: IdeasStatsWindow
  /** Open ideas in scope. */
  openTotal: number
  /** Bounded open-per-workspace breakdown, busiest first. */
  openByWorkspace: IdeasStatsWorkspaceRow[]
  /** Workspace groups found before the cap was applied. */
  workspacesTotal: number
  /** Ideas delivered inside the window. */
  deliveredInWindow: number
  delivery: IdeasStatsDelivery
  /** Bounded top labels of the OPEN backlog, most used first. */
  topTags: IdeasStatsTagRow[]
  /** Distinct labels found before the cap was applied. */
  tagsTotal: number
  triage: IdeasStatsTriage
}

/**
 * The slice of the snapshot the aggregate reads. Structural on purpose: the
 * aggregate imports the domain model and nothing else, so it can be handed the
 * Host snapshot, a test fixture or a plain array without an adapter.
 */
export interface IdeasStatsSource {
  revision: number
  ideas: readonly IdeaRecord[]
}

/** Scope and clock of one aggregate. */
export interface IdeasStatsOptions {
  /**
   * Workspace scope: omitted = every workspace, `''` = the workspace-less
   * (generic) group, a real id = that workspace. The board's selector maps its
   * three values straight onto these.
   */
  workspaceId?: string
  /** Instant the window is measured from (defaults to the Host clock). */
  now?: number
}

/** Unit the median is rendered in. The words belong to the locale, not here. */
export type IdeasDurationUnit = 'minutes' | 'hours' | 'days'

/**
 * First instant of the Host's LOCAL calendar month containing `at`.
 *
 * Local, not UTC, and deliberately: "delivered this month" is a sentence a
 * reader checks against their own wall clock, and a UTC month boundary would
 * put the last delivery of a month in the wrong bucket for most of the day.
 */
export function calendarMonthStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0).getTime()
}

/**
 * Split a duration into a value and a unit the panel can label. Pure and
 * locale-free on purpose: the definition of "how long" belongs here, the words
 * for it belong to the dictionary.
 *
 * Rounding never produces a zero: a lead time of zero is a real answer, and
 * printing "0 days" for half a day would be the rounding talking, not the data.
 */
export function durationParts(ms: number): { value: number; unit: IdeasDurationUnit } {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const days = safe / IDEAS_STATS_DAY_MS
  if (days >= 1) return { value: Math.round(days), unit: 'days' }
  const hours = safe / 3_600_000
  if (hours >= 1) return { value: Math.round(hours), unit: 'hours' }
  return { value: Math.max(1, Math.round(safe / 60_000)), unit: 'minutes' }
}

/** Median of a non-empty sample (mean of the two middle values when even). */
function medianOf(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const value = sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
  return Math.round(value)
}

/**
 * Build the health aggregate for one scope.
 *
 * One pass over the ideas in scope, no allocation proportional to the ledger:
 * the only structures that grow are the workspace groups and the label counts,
 * and both are cut to their cap before the response is built.
 *
 * @param source - the current snapshot (revision + rows).
 * @param options - the workspace scope and the clock.
 * @returns the bounded aggregate; never throws on a partial or odd ledger.
 */
export function buildIdeasStats(source: IdeasStatsSource, options: IdeasStatsOptions = {}): IdeasStats {
  const now = options.now ?? Date.now()
  const scopeId = options.workspaceId
  const inScope = (idea: IdeaRecord): boolean =>
    scopeId === undefined ? true : (idea.workspaceId ?? '') === scopeId

  const windowStart = calendarMonthStart(now)
  const groups = new Map<string, { open: number; total: number }>()
  const tagCounts = new Map<string, { name: string; count: number }>()
  const leadTimes: number[] = []

  let ideas = 0
  let openTotal = 0
  let deliveredInWindow = 0
  let withoutStamp = 0
  let inconsistent = 0
  let missingRank = 0
  let missingValue = 0

  for (const idea of source.ideas) {
    if (!inScope(idea)) continue
    ideas += 1

    const key = idea.workspaceId ?? ''
    const group = groups.get(key) ?? { open: 0, total: 0 }
    group.total += 1
    if (idea.status === 'open') {
      group.open += 1
      openTotal += 1
      if (idea.rank === undefined) missingRank += 1
      if (idea.value === undefined) missingValue += 1
      // Labels are counted on the OPEN backlog only: a label that only appears
      // on closed work is not work to do, and this view is a triage instrument.
      for (const tag of idea.tags ?? []) {
        const name = tag.name.trim()
        if (name === '') continue
        // Case-folded counting, first spelling wins: two rows differing only in
        // case are one label for a reader, never two.
        const folded = name.toLowerCase()
        const entry = tagCounts.get(folded)
        if (entry === undefined) tagCounts.set(folded, { name, count: 1 })
        else entry.count += 1
      }
    }
    groups.set(key, group)

    // Delivery: only the `deliver` verb stamps `deliveredAt`, so a stamp IS the
    // evidence that this idea was delivered rather than filed away.
    const deliveredAt = idea.deliveredAt
    if (deliveredAt === undefined || !Number.isFinite(deliveredAt)) {
      // A DECLINED idea is an honest "no", and an archived one without a stamp
      // is work closed without a delivery: neither belongs in a lead time.
      if (idea.status === 'archived') withoutStamp += 1
      continue
    }
    const leadTime = deliveredAt - idea.createdAt
    if (leadTime < 0) {
      inconsistent += 1
      continue
    }
    leadTimes.push(leadTime)
    if (deliveredAt >= windowStart && deliveredAt <= now) deliveredInWindow += 1
  }

  // Busiest first; ties broken on the group size and then the id, so two runs
  // over one revision always answer identically.
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

  const sample = leadTimes.length
  return {
    schemaVersion: IDEAS_STATS_SCHEMA_VERSION,
    revision: source.revision,
    computedAt: now,
    scope: {
      kind: scopeId === undefined ? 'all' : scopeId === '' ? 'generic' : 'workspace',
      ...(scopeId === undefined || scopeId === '' ? {} : { workspaceId: scopeId }),
      ideas,
    },
    window: { kind: 'calendarMonth', start: windowStart, end: now },
    openTotal,
    openByWorkspace: openByWorkspace.slice(0, IDEAS_STATS_MAX_WORKSPACES),
    workspacesTotal: openByWorkspace.length,
    deliveredInWindow,
    delivery: {
      sample,
      withoutStamp,
      inconsistent,
      medianMs: sample < IDEAS_STATS_MEDIAN_MIN_SAMPLES ? null : medianOf(leadTimes),
      minSamples: IDEAS_STATS_MEDIAN_MIN_SAMPLES,
    },
    topTags: topTags.slice(0, IDEAS_STATS_MAX_TAGS),
    tagsTotal: topTags.length,
    triage: { open: openTotal, missingRank, missingValue },
  }
}