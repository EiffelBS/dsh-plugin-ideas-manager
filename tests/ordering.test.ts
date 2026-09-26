/**
 * Ordering helper tests: rank sorting, the status-major / workspace-group
 * drag rebuild, the one-step open-backlog move and the Priorities grouping —
 * all under the "rank by workspace" model (ranks are relative inside each
 * (status, workspace) group; the workspace-less ideas form the generic group) —
 * plus the open column's attention ordering (idea #71), whose contract is that
 * it is a VIEW: the default rank order is unchanged and no rank is ever
 * written from a run state.
 */

import { describe, expect, it } from 'vitest'
import { createIdea, type IdeaRecord, type IdeaRunStatus, type IdeaStatus } from '../src/core/ideas.ts'
import {
  activityBlockOf,
  archivedIdeasOf,
  compareWorkspaceGroups,
  groupOpenByWorkspace,
  matchesWorkspaceScope,
  moveIdeaInOpenBacklog,
  NO_WORKSPACE_FILTER,
  orderByActivity,
  orderByWorkspaceGroups,
  orderIdeas,
  orderOpenColumn,
  rebuildOrder,
} from '../src/client/ordering.ts'

function idea(id: string, status: IdeaStatus, rank?: number): IdeaRecord {
  return { ...createIdea({ title: id, body: '' }, 0, id), status, ...(rank === undefined ? {} : { rank }) }
}

function ideaW(id: string, status: IdeaStatus, workspaceId?: string, rank?: number): IdeaRecord {
  return {
    ...idea(id, status, rank),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  }
}

/** Open idea carrying a run state (idea #66 / #71 fixtures). */
function run(id: string, rank: number, runStatus?: IdeaRunStatus, taskBoardStatus?: string): IdeaRecord {
  return {
    ...idea(id, 'open', rank),
    ...(runStatus === undefined ? {} : { runStatus }),
    ...(taskBoardStatus === undefined ? {} : { taskBoardStatus }),
  }
}

describe('orderIdeas', () => {
  it('sorts by rank and pushes unranked ideas last', () => {
    const a = idea('b', 'open', 2)
    const b = idea('a', 'open', 1)
    const c = idea('c', 'open')
    expect(orderIdeas([a, b, c]).map(row => row.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('rebuildOrder', () => {
  it('re-lays the target group end-to-end, keeping the other groups and columns', () => {
    const all = [idea('a', 'open', 1), idea('b', 'open', 2), idea('x', 'archived', 5)]
    expect(rebuildOrder(all, 'b', 'open', undefined)).toEqual(['a', 'b', 'x'])
  })

  it('places the moved idea before a given id inside its own group', () => {
    const all = [idea('a', 'open', 1), idea('b', 'open', 2), idea('c', 'open', 3)]
    expect(rebuildOrder(all, 'c', 'open', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('keeps every other workspace group rank-sorted (relative ranks untouched)', () => {
    const all = [
      ideaW('a', 'open', 'w1', 1),
      ideaW('b', 'open', 'w1', 2),
      ideaW('x', 'open', 'w2', 1),
      ideaW('y', 'open', 'w2', 2),
    ]
    // Move 'b' to the top of its OWN group: the w2 group order is untouched.
    expect(rebuildOrder(all, 'b', 'open', 'a')).toEqual(['b', 'a', 'x', 'y'])
  })

  it('ignores a cross-workspace anchor (no within-group insertion point): the move lands at its group end', () => {
    const all = [
      ideaW('a', 'open', 'w1', 1),
      ideaW('b', 'open', 'w2', 1),
      ideaW('c', 'open', 'w2', 2),
    ]
    expect(rebuildOrder(all, 'a', 'open', 'c')).toEqual(['a', 'b', 'c'])
  })

  it('creates the target group when it held no member yet (cross-column move of a lone row)', () => {
    const all = [ideaW('a', 'open', 'w1', 1), ideaW('b', 'open', 'w2')]
    expect(rebuildOrder(all, 'a', 'archived', undefined)).toEqual(['b', 'a'])
  })

  it('spreads a deadline-drop across closed columns status-major (archived before declined)', () => {
    const all = [
      ideaW('a', 'open', 'w1', 1),
      ideaW('x', 'archived', 'w1', 5),
      ideaW('d', 'declined', 'w1', 1),
    ]
    // Drop 'a' on the archived column without an anchor: the archived group
    // of w1 = [x, a] in rank order; declined stays untouched after it.
    expect(rebuildOrder(all, 'a', 'archived', undefined)).toEqual(['x', 'a', 'd'])
  })
})

describe('moveIdeaInOpenBacklog', () => {
  const all = () => [
    idea('a', 'open', 1),
    idea('b', 'open', 2),
    idea('c', 'open', 3),
    idea('d', 'archived', 1),
    idea('e', 'declined', 1),
  ]

  it('moves an open idea up one rank', () => {
    expect(moveIdeaInOpenBacklog(all(), 'b', 'up')).toEqual(['b', 'a', 'c', 'd', 'e'])
  })

  it('moves an open idea down one rank', () => {
    expect(moveIdeaInOpenBacklog(all(), 'b', 'down')).toEqual(['a', 'c', 'b', 'd', 'e'])
  })

  it('returns undefined at the edges (a no-op)', () => {
    expect(moveIdeaInOpenBacklog(all(), 'a', 'up')).toBeUndefined()
    expect(moveIdeaInOpenBacklog(all(), 'c', 'down')).toBeUndefined()
  })

  it('returns undefined for an idea outside the open backlog', () => {
    expect(moveIdeaInOpenBacklog(all(), 'd', 'up')).toBeUndefined()
    expect(moveIdeaInOpenBacklog(all(), 'absent', 'down')).toBeUndefined()
  })

  it('keeps the closed columns ordered status-major (archived group, then declined)', () => {
    const allIdeas = [...all(), idea('f', 'archived', 2)]
    expect(moveIdeaInOpenBacklog(allIdeas, 'a', 'down')).toEqual(['b', 'a', 'c', 'd', 'f', 'e'])
  })

  it('moves a lower-ranked open idea up past an entry from another column state', () => {
    // The author's ledger shape: an archived idea holding rank 1, an open idea
    // at rank 2 and a fresh unranked open idea. The arrows must still swap the
    // two OPEN rows and leave the closed column untouched.
    const mixed = [
      idea('old', 'archived', 1),
      idea('b', 'open', 2),
      idea('new', 'open'),
    ]
    expect(moveIdeaInOpenBacklog(mixed, 'new', 'up')).toEqual(['new', 'b', 'old'])
    expect(moveIdeaInOpenBacklog(mixed, 'b', 'down')).toEqual(['new', 'b', 'old'])
  })

  it('moves inside the idea\'s own workspace group only (other groups untouched)', () => {
    const allIdeas = [
      ideaW('a', 'open', 'w1', 1),
      ideaW('b', 'open', 'w1', 2),
      ideaW('x', 'open', 'w2', 1),
      ideaW('y', 'open', 'w2', 2),
      idea('g', 'open'), // generic group
    ]
    expect(moveIdeaInOpenBacklog(allIdeas, 'b', 'up')).toEqual(['b', 'a', 'x', 'y', 'g'])
  })

  it('treats the group edge as the move edge (a first/last row of ONE group is not the backlog edge)', () => {
    const allIdeas = [
      ideaW('a', 'open', 'w1', 1),
      ideaW('b', 'open', 'w2', 1),
      ideaW('c', 'open', 'w2', 2),
    ]
    // 'a' is first of w1 but NOT first of the whole backlog: up is still a no-op
    // because its group has no row above it.
    expect(moveIdeaInOpenBacklog(allIdeas, 'a', 'up')).toBeUndefined()
    // 'c' is last of w2: down is a no-op although w1 rows exist below it.
    expect(moveIdeaInOpenBacklog(allIdeas, 'c', 'down')).toBeUndefined()
    // A real within-group move still works ('c' up swaps with 'b' only).
    expect(moveIdeaInOpenBacklog(allIdeas, 'c', 'up')).toEqual(['a', 'c', 'b'])
  })

  it('keeps the generic group last and re-ranks it independently', () => {
    const allIdeas = [
      ideaW('a', 'open', 'w1', 1),
      ideaW('b', 'open', 'w1', 2),
      idea('g1', 'open', 1),
      idea('g2', 'open', 2),
    ]
    // Move g1 down: only the generic group changes.
    expect(moveIdeaInOpenBacklog(allIdeas, 'g1', 'down')).toEqual(['a', 'b', 'g2', 'g1'])
  })
})

describe('groupOpenByWorkspace', () => {
  it('partitions by workspace, sorts every group by its own rank and puts the generic group last', () => {
    const open = [
      ideaW('a', 'open', 'w2', 2),
      ideaW('b', 'open', undefined, 1),
      ideaW('c', 'open', 'w1', 1),
      ideaW('d', 'open', 'w2', 1),
      ideaW('e', 'open', undefined, 2),
    ]
    const groups = groupOpenByWorkspace(open)
    expect(groups.map(group => group.workspaceId ?? null)).toEqual(['w1', 'w2', null])
    expect(groups[0].ideas.map(row => row.id)).toEqual(['c'])
    expect(groups[1].ideas.map(row => row.id)).toEqual(['d', 'a'])
    expect(groups[2].ideas.map(row => row.id)).toEqual(['b', 'e'])
  })

  it('omits the generic group when there is no workspace-less idea', () => {
    const open = [ideaW('a', 'open', 'w1', 1)]
    const groups = groupOpenByWorkspace(open)
    expect(groups).toHaveLength(1)
    expect(groups[0].workspaceId).toBe('w1')
  })
})

describe('orderByWorkspaceGroups', () => {
  const titles = new Map<string, string>([['w1', 'Zeta'], ['w2', 'Alpha']])
  const title = (id: string): string => titles.get(id) ?? id

  it('lays each column out group-contiguous (named by title), rank-sorted inside every group', () => {
    const rows = [
      ideaW('a', 'open', 'w1', 2),
      ideaW('b', 'open', undefined, 1),
      ideaW('c', 'open', 'w2', 2),
      ideaW('d', 'open', 'w1', 1),
      ideaW('e', 'open', 'w2', 1),
    ]
    expect(orderByWorkspaceGroups(rows, title).map(row => row.id)).toEqual(['e', 'c', 'd', 'a', 'b'])
  })

  it('keeps the plain rank sort under a single workspace (one group)', () => {
    const rows = [ideaW('a', 'open', 'w1', 2), ideaW('b', 'open', 'w1', 1)]
    expect(orderByWorkspaceGroups(rows, title).map(row => row.id)).toEqual(['b', 'a'])
  })
})

describe('matchesWorkspaceScope', () => {
  const w = (id: string, workspaceId?: string): IdeaRecord => ({
    ...idea(id, 'open'),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  })

  it('matches every idea when the filter is empty (all workspaces)', () => {
    expect([
      matchesWorkspaceScope(w('a'), ''),
      matchesWorkspaceScope(w('b', 'w1'), ''),
      matchesWorkspaceScope(w('c', 'w2'), ''),
    ]).toEqual([true, true, true])
  })

  it('matches only the workspace-less ideas under NO_WORKSPACE_FILTER', () => {
    expect(matchesWorkspaceScope(w('a'), NO_WORKSPACE_FILTER)).toBe(true)
    expect(matchesWorkspaceScope(w('b', 'w1'), NO_WORKSPACE_FILTER)).toBe(false)
  })

  it('matches a concrete workspace id exactly', () => {
    expect(matchesWorkspaceScope(w('a', 'w1'), 'w1')).toBe(true)
    expect(matchesWorkspaceScope(w('b', 'w2'), 'w1')).toBe(false)
    expect(matchesWorkspaceScope(w('c'), 'w1')).toBe(false)
  })
})

describe('archivedIdeasOf', () => {
  const at = 1_700_000_000_000
  const archived = (id: string, workspaceId?: string, delivered = false): IdeaRecord => ({
    ...idea(id, 'archived'),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(delivered ? { deliveredAt: at } : {}),
  })

  it('keeps every archived idea of the scope, delivered or not (the exit log)', () => {
    const rows = [
      archived('a', undefined, true),
      archived('b'), // abandoned: archived without a stamp
      idea('c', 'open'),
      idea('d', 'declined'),
    ]
    expect(archivedIdeasOf(rows, '').map(row => row.id)).toEqual(['a', 'b'])
  })

  it('scopes to one workspace when asked (empty scope = all)', () => {
    const rows = [
      archived('a', 'w1'),
      archived('b', 'w2'),
      archived('c'),
    ]
    expect(archivedIdeasOf(rows, 'w1').map(row => row.id)).toEqual(['a'])
    expect(archivedIdeasOf(rows, '').map(row => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('scopes to the workspace-less ideas only under NO_WORKSPACE_FILTER', () => {
    const rows = [
      archived('a', 'w1'),
      archived('b'),
      archived('c'),
      idea('d', 'declined'),
    ]
    expect(archivedIdeasOf(rows, NO_WORKSPACE_FILTER).map(row => row.id)).toEqual(['b', 'c'])
  })
})

/* --- attention ordering of the open backlog (idea #71) --- */

describe('activityBlockOf', () => {
  it('reads the run state from runStatus OR the raw card observation', () => {
    // A card started from the task board itself is only folded into runStatus
    // by the next poll, so both fields must count as "in flight".
    expect(activityBlockOf({ runStatus: 'running' })).toBe(0)
    expect(activityBlockOf({ taskBoardStatus: 'running' })).toBe(0)
    expect(activityBlockOf({ runStatus: 'failed' })).toBe(1)
    expect(activityBlockOf({ taskBoardStatus: 'failed' })).toBe(1)
  })

  it('treats a finished run and any other state as ordinary (the review gate owns done)', () => {
    expect(activityBlockOf({})).toBe(2)
    expect(activityBlockOf({ runStatus: 'done' })).toBe(2)
    // A card observed outside a run (backlog/todo) clears the running stamp.
    expect(activityBlockOf({ taskBoardStatus: 'backlog', runStatus: 'done' })).toBe(2)
  })

  it('puts a running idea in the running block even if the card says failed', () => {
    // The stronger "needs attention" signal wins, so the two never disagree
    // with the Running badge drawn on the same row.
    expect(activityBlockOf({ runStatus: 'running', taskBoardStatus: 'failed' })).toBe(0)
  })
})

describe('orderByActivity', () => {
  const rows = (): IdeaRecord[] => [
    run('idle-1', 1),
    run('failed-card', 2, undefined, 'failed'),
    run('running-card', 3, undefined, 'running'),
    run('idle-2', 4),
    run('running-direct', 5, 'running'),
    run('done-card', 6, undefined, 'done'),
    run('failed-direct', 7, 'failed'),
  ]

  it('puts the running block first, then the failed one, then the rest', () => {
    expect(orderByActivity(rows()).map(row => row.id)).toEqual([
      'running-card', 'running-direct',
      'failed-card', 'failed-direct',
      'idle-1', 'idle-2', 'done-card',
    ])
  })

  it('keeps the human rank INSIDE every block (the ranking is never lost)', () => {
    // Same rows with the ranks shuffled: the block order holds, the inside
    // order follows the rank, not the input order.
    const shuffled = [
      run('running-late', 9, 'running'),
      run('running-early', 2, 'running'),
      run('idle-late', 8),
      run('idle-early', 1),
    ]
    expect(orderByActivity(shuffled).map(row => row.id)).toEqual([
      'running-early', 'running-late', 'idle-early', 'idle-late',
    ])
  })

  it('is deterministic across calls (the 2.5 s poll must not reshuffle the column)', () => {
    const input = rows()
    expect(orderByActivity(input).map(row => row.id)).toEqual(orderByActivity(input).map(row => row.id))
  })

  it('leaves the input array untouched (a view, not an in-place sort)', () => {
    const input = rows()
    const before = input.map(row => row.id)
    orderByActivity(input)
    expect(input.map(row => row.id)).toEqual(before)
  })

  it('is the identity on a list with no run at all', () => {
    const idle = [run('a', 2), run('b', 1), run('c', 3)]
    expect(orderByActivity(idle).map(row => row.id)).toEqual(orderIdeas(idle).map(row => row.id))
  })
})

describe('orderOpenColumn', () => {
  const titles = new Map<string, string>([['w1', 'Zeta'], ['w2', 'Alpha']])
  const title = (id: string): string => titles.get(id) ?? id

  it('NON-REGRESSION: the default rank ordering is byte-identical to the pre-#71 order', () => {
    const rows = [
      { ...ideaW('a', 'open', 'w1', 2), runStatus: 'running' as const },
      ideaW('b', 'open', 'w1', 1),
      ideaW('x', 'open', 'w2', 2),
      ideaW('y', 'open', 'w2', 1),
      ideaW('g', 'open', undefined, 1),
    ]
    // Ungrouped: the plain rank sort, whatever the run states are.
    expect(orderOpenColumn(rows, false, title, 'rank')).toEqual(orderIdeas(rows))
    // Grouped: the pre-existing workspace-group layout, untouched.
    expect(orderOpenColumn(rows, true, title, 'rank')).toEqual(orderByWorkspaceGroups(rows, title))
  })

  it('brings the in-flight work to the top of an ungrouped column', () => {
    const rows = [
      ideaW('a', 'open', 'w1', 1),
      { ...ideaW('b', 'open', 'w1', 2), runStatus: 'running' as const },
      ideaW('x', 'open', 'w1', 3),
    ]
    expect(orderOpenColumn(rows, false, title, 'activity').map(row => row.id)).toEqual(['b', 'a', 'x'])
  })

  it('keeps the workspace groups contiguous and sorts INSIDE each one (never across)', () => {
    const rows = [
      // Zeta/w1 holds a running idea at a LOW rank, Alpha/w2 an idle one first.
      { ...ideaW('w1-running', 'open', 'w1', 5), runStatus: 'running' as const },
      ideaW('w1-idle', 'open', 'w1', 1),
      { ...ideaW('w2-running', 'open', 'w2', 6), runStatus: 'running' as const },
      ideaW('w2-idle', 'open', 'w2', 2),
    ]
    // Alpha (w2) first by title, Zeta (w1) second, the generic group last -
    // and inside each group the running idea leads. A running idea of w1 must
    // NOT jump above the w2 header.
    expect(orderOpenColumn(rows, true, title, 'activity').map(row => row.id)).toEqual([
      'w2-running', 'w2-idle', 'w1-running', 'w1-idle',
    ])
  })

  it('leaves the CLOSED columns out of the attention order (the review gate owns them)', () => {
    // orderOpenColumn is only called for the Open column; locked here by
    // showing that a closed idea's run state never reaches it.
    const archived = { ...idea('done', 'archived', 1), runStatus: 'done' as const }
    expect(orderOpenColumn([archived], false, title, 'activity').map(row => row.id)).toEqual(['done'])
  })

  it('never feeds the persisted order: the reorder wire stays rank-based whatever the run states', () => {
    // The risk this option must not create: a run in flight silently
    // rewriting the human ranking through the 2.5 s poll. rebuildOrder reads
    // ranks only, so the wire order of a board with a running idea is the same
    // as without one.
    const idle = [idea('a', 'open', 1), idea('b', 'open', 2), idea('c', 'open', 3)]
    const busy = [idle[0]!, { ...idle[1]!, runStatus: 'running' as const }, idle[2]!]
    expect(rebuildOrder(busy, 'c', 'open', 'a')).toEqual(rebuildOrder(idle, 'c', 'open', 'a'))
    expect(moveIdeaInOpenBacklog(busy, 'c', 'up')).toEqual(moveIdeaInOpenBacklog(idle, 'c', 'up'))
  })
})
