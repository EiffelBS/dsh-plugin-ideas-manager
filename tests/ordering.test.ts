/**
 * Ordering helper tests: rank sorting, the column-major drag rebuild and the
 * one-step open-backlog move used by the Priorities tab.
 */

import { describe, expect, it } from 'vitest'
import { createIdea, type IdeaRecord, type IdeaStatus } from '../src/core/ideas.ts'
import { moveIdeaInOpenBacklog, orderIdeas, rebuildOrder } from '../src/client/ordering.ts'

function idea(id: string, status: IdeaStatus, rank?: number): IdeaRecord {
  return { ...createIdea({ title: id, body: '' }, 0, id), status, ...(rank === undefined ? {} : { rank }) }
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
  it('re-lays the target column end-to-end, keeping the other column orders', () => {
    const all = [idea('a', 'open', 1), idea('b', 'open', 2), idea('x', 'archived', 5)]
    expect(rebuildOrder(all, 'b', 'open', undefined)).toEqual(['a', 'b', 'x'])
  })

  it('places the moved idea before a given id in the target column', () => {
    const all = [idea('a', 'open', 1), idea('b', 'open', 2), idea('c', 'open', 3)]
    expect(rebuildOrder(all, 'c', 'open', 'a')).toEqual(['c', 'a', 'b'])
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

  it('keeps the closed column order untouched', () => {
    const allIdeas = [...all(), idea('f', 'archived', 2)]
    expect(moveIdeaInOpenBacklog(allIdeas, 'a', 'down')).toEqual(['b', 'a', 'c', 'd', 'e', 'f'])
  })
})