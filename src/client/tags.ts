/**
 * Tag helpers shared by the kanban and the Priorities/Delivered list views.
 * The tag pills on every card and row carry a stable per-name hue and toggle
 * the same conjunctive filter (see board-view.tsx for the state).
 */

import type { IdeaRecord } from '../core/ideas.ts'

/** Conjunctive tag filter: adding a label narrows the board. */
export function matchesTags(idea: IdeaRecord, selected: readonly string[]): boolean {
  if (selected.length === 0) return true
  const names = new Set((idea.tags ?? []).map(tag => tag.name))
  return selected.every(name => names.has(name))
}

/** Every label in use across the ledger, sorted (for the filter chips). */
export function collectKnownTags(ideas: readonly IdeaRecord[]): string[] {
  const names = new Set<string>()
  for (const idea of ideas) for (const tag of idea.tags ?? []) names.add(tag.name)
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Narrow the filter chips with the chip search box (idea #36): a
 * case-insensitive substring match on the label. Matched chips keep their
 * order; SELECTED chips are appended when the query (or nothing at all)
 * hides them, so an active filter never becomes an invisible filter — even
 * for a stale selection whose label left the ledger. A blank query is the
 * full list.
 */
export function filterKnownTags(
  known: readonly string[],
  selected: readonly string[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase()
  const matching = needle === ''
    ? [...known]
    : known.filter(entry => entry.toLowerCase().includes(needle))
  const shown = new Set(matching)
  return [...matching, ...selected.filter(entry => !shown.has(entry))]
}

/**
 * Deterministic per-name hue (0–359) so every tag keeps a stable,
 * distinct color on the cards. FNV-1a then maps onto 15 well-spaced hues.
 */
export function tagHue(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 15) * 24
}