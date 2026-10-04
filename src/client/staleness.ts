/**
 * Freshness marker for open ideas.
 *
 * A backlog that only grows is a graveyard: the idea nobody has looked at in
 * two months looks exactly like the one you meant to pick up yesterday. This
 * is the smallest thing that fixes the read — a quiet *stale* badge on the open
 * ideas nobody has touched.
 *
 * Render-time only, by design: the answer is `now - updatedAt` against one
 * number from the settings, so it costs the Host nothing, writes nothing on
 * the idea, and needs no scheduled job to keep correct. The trade is explicit —
 * the badge re-evaluates when the board re-renders (every poll while it is
 * open, and immediately when it opens), not on a wall clock.
 */

import type { IdeaListRow } from '../protocol.ts'

/** Milliseconds in one day, the unit `staleAfterDays` is expressed in. */
const DAY_MS = 86_400_000

/**
 * Whether an open idea has gone quiet long enough to wear the badge.
 *
 * Three deliberate rules:
 *  - OPEN ideas only: an idea in the review gate or the archive is not "stale",
 *    it is finished, and the columns that say so already say it louder;
 *  - `staleAfterDays <= 0` is OFF (the settings option's escape hatch), not
 *    "everything is stale";
 *  - the comparison is strict, so an idea updated exactly N days ago is not
 *    yet stale — the day count reported in the tooltip is the configured
 *    threshold, which is the number the reader set.
 *
 * @param idea - the row to judge (a list row is enough).
 * @param staleAfterDays - the settings threshold; 0 disables the badge.
 * @param now - render instant, passed in so the value is stable for one render.
 */
export function isStaleIdea(idea: IdeaListRow, staleAfterDays: number, now: number): boolean {
  if (idea.status !== 'open') return false
  if (!Number.isFinite(staleAfterDays) || staleAfterDays <= 0) return false
  return now - idea.updatedAt > staleAfterDays * DAY_MS
}

/**
 * Whole days an open idea has sat untouched, as the tooltip reports it. Zero
 * for anything younger than a day, and for a closed idea (the tooltip is not
 * rendered there anyway) — the number is a quiet signal, not a stopwatch.
 */
export function staleDays(idea: IdeaListRow, now: number): number {
  const elapsed = now - idea.updatedAt
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0
  return Math.floor(elapsed / DAY_MS)
}