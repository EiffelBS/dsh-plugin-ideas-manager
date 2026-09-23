/**
 * Idea ordering helpers shared by the kanban (Overview) and the ranked
 * backlog (Priorities): rank-keyed sorting, the grouped rebuild used by
 * drag & drop, and the one-step move inside the open backlog used by the
 * Priorities move-up/move-down actions.
 *
 * Rank model (v2, "rank by workspace"): an idea's rank is a position RELATIVE
 * to the other ideas of the same (status, workspace) pair — see
 * rankGroupKey(). The workspace-less ideas form one generic group. Every
 * rebuild below emits a status-major, group-minor, rank-ordered id list, the
 * shape the host reorder consumes (it re-derives per-group ranks from the
 * appearance order, so each group's order in the wire list is what counts).
 * Pure and unit-testable in isolation.
 */

import { IDEA_COLUMNS, rankGroupKey, type RankableIdea, type IdeaStatus } from '../core/ideas.ts'

/**
 * Sentinel workspace-filter value: the generic ideas (no workspace assigned).
 * A real workspace id is a UUID, so a fixed unlikely string can never collide
 * with the registry; the board selector offers it alongside real workspaces.
 */
export const NO_WORKSPACE_FILTER = '__no-workspace__'

/** True when the idea belongs to the workspace scope: '' = all workspaces,
 *  NO_WORKSPACE_FILTER = the workspace-less ideas only, a concrete id =
 *  exact match. Single source for every board derivation that scopes to a
 *  workspace (Overview columns, Priorities, Delivered). */
export function matchesWorkspaceScope(idea: { workspaceId?: string }, workspaceFilter: string): boolean {
  if (workspaceFilter === '') return true
  if (workspaceFilter === NO_WORKSPACE_FILTER) return idea.workspaceId === undefined
  return idea.workspaceId === workspaceFilter
}

/** Ideas without a rank sort after every ranked idea. */
export function orderKey(idea: RankableIdea): number {
  return idea.rank ?? Number.MAX_SAFE_INTEGER
}

/** Stable rank-sorted copy (ties keep their input order). Generic over the
 *  row type so list rows and full records both pass through unchanged. */
export function orderIdeas<T extends RankableIdea>(ideas: readonly T[]): T[] {
  return [...ideas].sort((a, b) => orderKey(a) - orderKey(b))
}

/**
 * Group key of an idea's own peer set inside one column: (status, workspace).
 * The workspace-less ideas share the generic group. (Re-exported from the
 * model so the client call sites read the wire/display semantics directly.)
 */
export function groupKeyOf(idea: RankableIdea): string {
  return rankGroupKey(idea.status, idea.workspaceId)
}

/**
 * Build the canonical status-major, group-minor id order of the whole ledger:
 * for every column (open, archived, declined) the workspace groups appear in
 * a stable key order and every group is rank-sorted. `override` replaces the
 * id order of ONE group (the moved idea's target group) with the caller's
 * new order — every other group keeps its rank-sorted order, so a reorder
 * preserves their ranks.
 */
export function groupedIdOrder(
  all: readonly RankableIdea[],
  override?: { key: string; orderedIds: string[] },
): string[] {
  const byGroup = new Map<string, RankableIdea[]>()
  for (const idea of all) {
    const key = groupKeyOf(idea)
    const rows = byGroup.get(key)
    if (rows === undefined) byGroup.set(key, [idea])
    else rows.push(idea)
  }
  const out: string[] = []
  for (const status of IDEA_COLUMNS) {
    // The override group may no longer exist in `all` (its members were
    // filtered out as the moved idea) — re-add its key so the target column
    // still carries the group, at the right sorted position.
    const overrideKey = override !== undefined && override.key.startsWith(`${status}\u0000`)
      ? override.key
      : undefined
    const keys = new Set(byGroup.keys())
    if (overrideKey !== undefined) keys.add(overrideKey)
    const sorted = [...keys].filter(key => key.startsWith(`${status}\u0000`)).sort((a, b) => {
      // Group presentation order: the workspace groups first (stable key
      // order), the generic (workspace-less) group last — the same layout
      // convention as the Priorities "all" view.
      const aGeneric = a.endsWith('\u0000')
      const bGeneric = b.endsWith('\u0000')
      if (aGeneric !== bGeneric) return aGeneric ? 1 : -1
      return a < b ? -1 : a > b ? 1 : 0
    })
    for (const key of sorted) {
      const rows = byGroup.get(key)
      if (override !== undefined && override.key === key) {
        out.push(...override.orderedIds)
      } else if (rows !== undefined) {
        out.push(...orderIdeas(rows).map(row => row.id))
      }
    }
  }
  return out
}

/**
 * Rebuild the rank order with `movedId` placed at the drop position of its
 * target column: the moved idea joins its OWN workspace group of that column,
 * right before `beforeId` when the anchor belongs to the same group, else at
 * the group end (a cross-workspace drop cannot define a within-group
 * insertion point). Columns are always laid out open, archived, declined,
 * each workspace group rank-sorted.
 */
export function rebuildOrder(
  all: readonly RankableIdea[],
  movedId: string,
  targetStatus: IdeaStatus,
  beforeId: string | undefined,
): string[] {
  const moved = all.find(idea => idea.id === movedId)
  if (moved === undefined) return groupedIdOrder(all)
  const targetKey = rankGroupKey(targetStatus, moved.workspaceId)
  const targetIds = orderIdeas(all.filter(idea =>
    idea.id !== movedId && groupKeyOf(idea) === targetKey)).map(idea => idea.id)
  let at = targetIds.length
  if (beforeId !== undefined) {
    // The anchor shares the moved idea's target group: insert before it.
    // A cross-workspace anchor cannot define a within-group insertion point,
    // so it is ignored and the move lands at the group end instead.
    const before = all.find(idea => idea.id === beforeId)
    if (before !== undefined && before.status === targetStatus &&
        rankGroupKey(before.status, before.workspaceId) === targetKey) {
      const index = targetIds.indexOf(beforeId)
      if (index >= 0) at = index
    }
  }
  targetIds.splice(at, 0, movedId)
  return groupedIdOrder(all.filter(idea => idea.id !== movedId), { key: targetKey, orderedIds: targetIds })
}

/**
 * Next rank order after moving `movedId` one step up or down INSIDE its own
 * workspace group of the open column (the Priorities ranking). Returns
 * undefined when the idea is not open or is already at the group's edge (a
 * no-op), so the caller skips the wire call.
 */
export function moveIdeaInOpenBacklog(
  all: readonly RankableIdea[],
  movedId: string,
  toward: 'up' | 'down',
): string[] | undefined {
  const moved = all.find(idea => idea.id === movedId)
  if (moved === undefined || moved.status !== 'open') return undefined
  const groupKey = rankGroupKey('open', moved.workspaceId)
  const openInGroup = orderIdeas(all.filter(idea =>
    idea.status === 'open' && rankGroupKey('open', idea.workspaceId) === groupKey))
  const at = openInGroup.findIndex(idea => idea.id === movedId)
  if (at < 0) return undefined
  const last = openInGroup.length - 1
  if ((toward === 'up' && at === 0) || (toward === 'down' && at === last)) return undefined
  const ids = openInGroup.map(idea => idea.id)
  const swap = toward === 'up' ? at - 1 : at + 1
  const held = ids[at]!
  ids[at] = ids[swap]!
  ids[swap] = held
  return groupedIdOrder(all, { key: groupKey, orderedIds: ids })
}

/**
 * Open ideas partitioned by workspace group for the Priorities "all
 * workspaces" view: one group per workspace plus the generic (workspace-less)
 * group LAST, each group rank-sorted (its own relative ranking). Groups with
 * a workspace id come first in a stable key order; the presentation layer
 * may re-order them by title.
 */
export function groupOpenByWorkspace<T extends RankableIdea>(openIdeas: readonly T[]): OpenRankGroup<T>[] {
  const byWorkspace = new Map<string, T[]>()
  const generic: T[] = []
  for (const idea of openIdeas) {
    if (idea.workspaceId === undefined) {
      generic.push(idea)
    } else {
      const rows = byWorkspace.get(idea.workspaceId)
      if (rows === undefined) byWorkspace.set(idea.workspaceId, [idea])
      else rows.push(idea)
    }
  }
  const groups: OpenRankGroup<T>[] = [...byWorkspace.keys()]
    .sort()
    .map(workspaceId => ({ workspaceId, ideas: orderIdeas(byWorkspace.get(workspaceId)!) }))
  if (generic.length > 0) groups.push({ workspaceId: undefined, ideas: orderIdeas(generic) })
  return groups
}

/** One Priorities "all" group: a workspace (undefined = generic) and its
 *  rank-sorted open ideas (relative ranks). Generic over the row type (list
 *  rows or full records). */
export interface OpenRankGroup<T = RankableIdea> {
  workspaceId: string | undefined
  ideas: T[]
}

/** Display-order comparator of workspace groups: the named workspaces first
 *  (by registry title), the generic (workspace-less) group last regardless of
 *  its title. */
export function compareWorkspaceGroups(
  a: OpenRankGroup<unknown>,
  b: OpenRankGroup<unknown>,
  workspaceTitle: (workspaceId: string) => string,
): number {
  if (a.workspaceId === undefined) return 1
  if (b.workspaceId === undefined) return -1
  return workspaceTitle(a.workspaceId).localeCompare(workspaceTitle(b.workspaceId))
}

/** Column order for the "all workspaces" board: every workspace group is
 *  contiguous (named by title, the generic group last) and rank-sorted inside
 *  itself — the "rank by workspace" presentation the Priorities view also
 *  uses. Under a single-workspace scope the plain rank sort is identical. */
export function orderByWorkspaceGroups<T extends RankableIdea>(
  rows: readonly T[],
  workspaceTitle: (workspaceId: string) => string,
): T[] {
  return groupOpenByWorkspace(rows)
    .sort((a, b) => compareWorkspaceGroups(a, b, workspaceTitle))
    .flatMap(group => group.ideas)
}

/**
 * Archived ideas of a workspace scope — the Delivered log contents. The
 * filter follows matchesWorkspaceScope: '' = all workspaces, a concrete id =
 * one workspace, NO_WORKSPACE_FILTER = the workspace-less ideas only. The
 * journal shows every idea that left the open backlog: delivered ones carry a
 * deliveredAt stamp, manually archived (abandoned) ones do not.
 */
export function archivedIdeasOf<T extends RankableIdea>(
  ideas: readonly T[],
  workspaceFilter: string,
): T[] {
  return ideas.filter(idea =>
    idea.status === 'archived' && matchesWorkspaceScope(idea, workspaceFilter))
}
