/**
 * Relations on the board (idea #106): the pure half.
 *
 * Everything the UI needs to decide — which ideas a relation row may name, what
 * a chip prints, and whether a list actually changed — is here, DOM-free and
 * framework-free, so the rules are unit-testable and the React half only
 * paints and posts. The ledger owns the truth; this module never decides
 * whether an edge is legal, it only prepares what a human can pick and what to
 * send.
 *
 * The stored model is one-direction per kind (see docs/architecture.md): the
 * board's own rows carry `relatesTo` / `blocks`, and the `blockedBy` side is
 * derived with {@link ideaBlockedBy} rather than stored. Nothing here invents
 * an edge: a relation is a statement the human makes, exactly like the
 * near-duplicate flag is NOT (that one is a scan, this one is a sentence).
 */

import { IDEA_RELATION_LIMIT, ideaBlockedBy } from '../core/ideas.ts'

/** The rows this module reads: what a list row already carries. */
export interface RelationRow {
  id: string
  title: string
  ideaNumber?: number
  relatesTo?: string[]
  blocks?: string[]
}

/** One idea a relation picker may offer. */
export interface RelationCandidate {
  /** The idea id that would be written. */
  id: string
  /** What the chip prints: `#12 Fix the poll`, the board's own title format. */
  label: string
}

/** Cap of the chips a card prints before it folds the rest into a counter. */
export const CARD_RELATION_CHIP_LIMIT = 3

/**
 * One relation a card or a row may print: which idea, and under which kind.
 * The kind is what makes the same id readable in two different sentences.
 */
export interface RelationView {
  /** The referenced idea id (always a live row: the ledger sweeps deletions). */
  id: string
  /** `relatesTo`, `blocks` or the derived `blockedBy`. */
  kind: IdeaRelationViewKind
  /** `#12 Fix the poll`, the board's own title format — a chip's full label. */
  label: string
  /**
   * `#12`, or the bare title for a row the ledger has not numbered yet. This is
   * what a CARD prints: the board already teaches that the number is the durable
   * reference, so a chip stays one token wide and the full label is its tooltip.
   */
  short: string
}

/** The three kinds a surface may print; `blockedBy` is never stored. */
export type IdeaRelationViewKind = 'relatesTo' | 'blocks' | 'blockedBy'

function labelOf(row: RelationRow | undefined, id: string): string {
  if (row === undefined) return id
  return row.ideaNumber === undefined ? row.title : `#${row.ideaNumber} ${row.title}`
}

function shortOf(row: RelationRow | undefined, id: string): string {
  if (row === undefined) return id
  return row.ideaNumber === undefined ? row.title : `#${row.ideaNumber}`
}

/**
 * The three relation lines of one idea, in the order a reader wants them:
 * what it is adjacent to, what it waits for, what waits for it.
 *
 * Every reference is resolved through the row map, so a chip NEVER prints a
 * bare id while the board still has the idea — and a relation pointing at
 * something the board cannot resolve is dropped from the VIEW rather than
 * rendered as an unopenable `#3` with no title. (The ledger keeps such an edge
 * only until its next reconciliation, and `delete` removes it outright.)
 */
export function relationViews(ideas: readonly RelationRow[], ideaId: string): RelationView[] {
  return relationIndexOf(ideas).get(ideaId) ?? []
}

/**
 * The relation lines of EVERY row, built in one pass.
 *
 * A card asks for its own line, and a naive `relationViews` per card would
 * rebuild the row map and rescan the board once per card — O(rows²) on every
 * paint. The board therefore derives the whole index ONCE per paint (the same
 * discipline the multi-select follows when it derives the scope where the
 * columns are drawn) and hands each card its slice.
 */
export function relationIndexOf(ideas: readonly RelationRow[]): Map<string, RelationView[]> {
  const byId = new Map(ideas.map(item => [item.id, item]))
  const index = new Map<string, RelationView[]>()
  for (const idea of ideas) {
    const views: RelationView[] = []
    for (const id of idea.relatesTo ?? []) {
      const target = byId.get(id)
      if (target === undefined || id === idea.id) continue
      views.push({ id, kind: 'relatesTo', label: labelOf(target, id), short: shortOf(target, id) })
    }
    for (const id of idea.blocks ?? []) {
      const target = byId.get(id)
      if (target === undefined || id === idea.id) continue
      views.push({ id, kind: 'blocks', label: labelOf(target, id), short: shortOf(target, id) })
    }
    for (const id of ideaBlockedBy(ideas, idea.id)) {
      const target = byId.get(id)
      if (target === undefined) continue
      views.push({ id, kind: 'blockedBy', label: labelOf(target, id), short: shortOf(target, id) })
    }
    if (views.length > 0) index.set(idea.id, views)
  }
  return index
}

/**
 * The ideas a relation picker may still offer: every other idea the board
 * knows, minus the ones already named by `exclude`, ordered by the stable `#N`
 * so the list reads like the board does. Ids with no number sort last, by
 * title, so an imported row is still findable and the order never flickers.
 */
export function relationCandidates(
  ideas: readonly RelationRow[],
  selfId: string,
  exclude: readonly string[] = [],
): RelationCandidate[] {
  const taken = new Set([selfId, ...exclude])
  return ideas
    .filter(idea => !taken.has(idea.id))
    .map(idea => ({ id: idea.id, label: labelOf(idea, idea.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
}

/**
 * Whether an edited list actually differs from the stored one. The editor sends
 * only what changed: an untouched relation must not spend a revision, a mirror
 * round trip and an activity-log line saying "Edited related ideas".
 *
 * Order is NOT a change. The ledger appends and re-points edges, so the same
 * set in a different order is the same statement — treating it as a change
 * would make every open-and-save rewrite a list nobody touched.
 */
export function relationListChanged(
  next: readonly string[],
  previous: readonly string[] | undefined,
): boolean {
  const before = [...(previous ?? [])].sort()
  const after = [...next].sort()
  if (before.length !== after.length) return true
  return after.some((id, index) => id !== before[index])
}

/**
 * Add one target to a relation list, keeping the ledger's cap and refusing a
 * repeat. Returns the SAME array when nothing changed, so a React state that
 * holds the list does not re-render for a no-op.
 */
export function withRelation(
  list: readonly string[],
  id: string,
  limit: number = IDEA_RELATION_LIMIT,
): string[] {
  if (id === '' || list.includes(id) || list.length >= limit) return [...list]
  return [...list, id]
}

/** Remove one target from a relation list (same identity rule as above). */
export function withoutRelation(list: readonly string[], id: string): string[] {
  if (!list.includes(id)) return [...list]
  return list.filter(entry => entry !== id)
}
