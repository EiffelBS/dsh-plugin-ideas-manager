/**
 * Idea ordering helpers shared by the kanban (Overview) and the ranked
 * backlog (Priorities): rank-keyed sorting, the column-major rebuild used by
 * drag & drop, and the one-step move inside the open backlog used by the
 * Priorities move-up/move-down actions. Pure and unit-testable in isolation.
 */

import { IDEA_COLUMNS, type IdeaRecord, type IdeaStatus } from '../core/ideas.ts'

/** Ideas without a rank sort after every ranked idea. */
export function orderKey(idea: IdeaRecord): number {
  return idea.rank ?? Number.MAX_SAFE_INTEGER
}

/** Stable rank-sorted copy (ties keep their input order). */
export function orderIdeas(ideas: readonly IdeaRecord[]): IdeaRecord[] {
  return [...ideas].sort((a, b) => orderKey(a) - orderKey(b))
}

/**
 * Rebuild the global rank order with `movedId` placed at the drop position of
 * its target column: after `beforeId` when given, else at the column end.
 * Columns are always laid out open, archived, declined, each rank-sorted.
 */
export function rebuildOrder(
  all: readonly IdeaRecord[],
  movedId: string,
  targetStatus: IdeaStatus,
  beforeId: string | undefined,
): string[] {
  const columns: string[] = []
  for (const status of IDEA_COLUMNS) {
    const ids = orderIdeas(all.filter(idea => idea.status === status && idea.id !== movedId)).map(idea => idea.id)
    if (status === targetStatus) {
      let index = ids.length
      if (beforeId !== undefined) {
        const at = ids.indexOf(beforeId)
        if (at >= 0) index = at
      }
      ids.splice(index, 0, movedId)
    }
    columns.push(...ids)
  }
  return columns
}

/**
 * Next global rank order after moving `movedId` one step up or down INSIDE
 * the open backlog (the Priorities ranking). Returns undefined when the idea
 * is not open or is already at the edge (a no-op), so the caller skips the
 * wire call.
 */
export function moveIdeaInOpenBacklog(
  all: readonly IdeaRecord[],
  movedId: string,
  toward: 'up' | 'down',
): string[] | undefined {
  const open = orderIdeas(all.filter(idea => idea.status === 'open'))
  const at = open.findIndex(idea => idea.id === movedId)
  if (at < 0) return undefined
  const last = open.length - 1
  if ((toward === 'up' && at === 0) || (toward === 'down' && at === last)) return undefined
  const ids = open.map(idea => idea.id)
  const swap = toward === 'up' ? at - 1 : at + 1
  const held = ids[at]!
  ids[at] = ids[swap]!
  ids[swap] = held
  const closed = orderIdeas(all.filter(idea => idea.status !== 'open')).map(idea => idea.id)
  return [...ids, ...closed]
}

/**
 * Archived ideas of a workspace scope that carry a delivery stamp — the
 * Delivered log contents (empty scope = all workspaces).
 */
export function deliveredIdeasOf(
  ideas: readonly IdeaRecord[],
  workspaceId: string,
): IdeaRecord[] {
  return ideas.filter(idea =>
    idea.status === 'archived'
    && idea.deliveredAt !== undefined
    && (workspaceId === '' || idea.workspaceId === workspaceId))
}