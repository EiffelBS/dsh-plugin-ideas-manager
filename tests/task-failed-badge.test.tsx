// @vitest-environment jsdom
/**
 * Failed-task badge (recette follow-up to idea #34): an open idea whose
 * mirrored TaskBoard card's LAST OBSERVED status is `failed` shows a red
 * "Task failed" pill in its card header, while the idea deliberately stays
 * in the backlog (a failed run delivered nothing - the recette gate is for
 * finished work). The badge is display-only: it never moves the card, and it
 * never shows for a non-failed status nor on a closed column.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasEventPayload,
  type IdeasListSnapshot,
} from '../src/protocol.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fixture(): IdeasListSnapshot {
  const base = { createdAt: 1, updatedAt: 100, workspaceId: 'ws1' }
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { ...base, id: 'failed-card', title: 'Failed task card', status: 'open', rank: 1, bodyExcerpt: 'a', taskBoardId: 'task-1', taskBoardStatus: 'failed' },
      { ...base, id: 'running-card', title: 'Running task card', status: 'open', rank: 2, bodyExcerpt: 'b', taskBoardId: 'task-2', taskBoardStatus: 'running' },
      { ...base, id: 'unbound-card', title: 'Unbound card', status: 'open', rank: 3, bodyExcerpt: 'c' },
      { ...base, id: 'review-card', title: 'Under review card', status: 'underReview', rank: 1, bodyExcerpt: 'd', taskBoardId: 'task-3', taskBoardStatus: 'failed' },
    ],
  }
}

class StaticTransport implements IdeasHostTransport {
  constructor(private readonly list: IdeasListSnapshot) {}
  async state(): Promise<IdeasListSnapshot> { return this.list }
  async action(): Promise<IdeasListSnapshot> { return this.list }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
}

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
})
afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  host.remove()
})

async function renderBoard(): Promise<void> {
  const client = new IdeasClient(new StaticTransport(fixture()), undefined)
  client.snapshot = fixture()
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
}

/** The badge of one card (mounted under that idea id), if any. */
function badgeIn(ideaId: string): HTMLElement | null {
  return host.querySelector(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-task-failed]`)
}

describe('failed-task badge', () => {
  it('shows the badge on an OPEN card whose task failed, with the explanatory tooltip', async () => {
    await renderBoard()
    const badge = badgeIn('failed-card')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe('Task failed')
    const hint = badge?.getAttribute('title') ?? ''
    expect(hint).toContain('stays in the backlog')
  })

  it('does NOT show for a running task, an unbound card, or a closed column', async () => {
    await renderBoard()
    expect(badgeIn('running-card')).toBeNull()
    expect(badgeIn('unbound-card')).toBeNull()
    // An under-review card keeps its own gate badge: the failed pill is for
    // the open backlog only.
    expect(badgeIn('review-card')).toBeNull()
  })

  it('leaves the failed card in the Open column (the badge never moves a card)', async () => {
    await renderBoard()
    const columns = host.querySelectorAll('[data-dsh-column-scroll]')
    const openColumn = columns[0]!
    const failedCard = host.querySelector('[data-dsh-idea-id="failed-card"]')
    expect(failedCard).not.toBeNull()
    expect(openColumn.contains(failedCard)).toBe(true)
  })
})
