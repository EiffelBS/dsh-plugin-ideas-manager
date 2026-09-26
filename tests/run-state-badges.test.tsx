// @vitest-environment jsdom
/**
 * Run-state tags on the Priorities and Delivered rows (idea #71).
 *
 * The Overview card header already drew "Running", "Task failed" and
 * "follow-up of #N"; the two list tabs drew nothing, so a ranked row gave no
 * clue that its idea was already being worked on — the exact situation that
 * produces duplicated work now that several runs can be in flight at once.
 * These tests lock that both tabs read the SAME shared component as the
 * Overview (one owner, so a row can never disagree with a card), that the
 * follow-up lineage resolves to the parent's number, and that the
 * attention-first ordering is opt-in and never touches a rank.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
} from '../src/protocol.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = { createdAt: 1, updatedAt: 100, workspaceId: 'ws1' }

/** One open idea per run state, one follow-up child, one archived run. */
function fixture(): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { ...base, id: 'plain', ideaNumber: 1, title: 'Plain idea', status: 'open', rank: 1, bodyExcerpt: 'a' },
      { ...base, id: 'failed', ideaNumber: 2, title: 'Failed idea', status: 'open', rank: 2, bodyExcerpt: 'b', taskBoardId: 'task-1', taskBoardStatus: 'failed' },
      { ...base, id: 'running', ideaNumber: 3, title: 'Running idea', status: 'open', rank: 3, bodyExcerpt: 'c', taskBoardId: 'task-2', taskBoardStatus: 'running' },
      { ...base, id: 'child', ideaNumber: 4, title: 'Follow-up idea', status: 'open', rank: 4, bodyExcerpt: 'd', followUpOfId: 'failed' },
      { ...base, id: 'archived-run', ideaNumber: 5, title: 'Archived while running', status: 'archived', rank: 1, bodyExcerpt: 'e', archivedAt: 50, runStatus: 'running' },
      { ...base, id: 'gate', ideaNumber: 6, title: 'Under review idea', status: 'underReview', rank: 1, bodyExcerpt: 'f' },
    ],
  }
}

/** Static list transport, plus an optional config surface (off by default,
 *  so the board keeps the spelled defaults — rank ordering included). */
class StaticTransport implements IdeasHostTransport {
  configView: IdeasSettingsView | undefined

  constructor(private readonly list: IdeasListSnapshot) {}

  async state(): Promise<IdeasListSnapshot> { return this.list }
  async action(): Promise<IdeasListSnapshot> { return this.list }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> {
    return this.configView ?? { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS }, revision: 1 }
  }
  async saveConfig(patch: IdeasSettingsPatch, _expectedRevision?: number): Promise<IdeasSettingsView> {
    const current = await this.config()
    this.configView = { available: true, value: { ...current.value, ...patch }, revision: (current.revision ?? 0) + 1 }
    return this.configView
  }
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

async function renderBoard(transport = new StaticTransport(fixture())): Promise<IdeasClient> {
  const client = new IdeasClient(transport, undefined)
  client.snapshot = fixture()
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
  return client
}

function tabButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')) as HTMLButtonElement[]
}

async function openTab(index: 0 | 1 | 2): Promise<void> {
  await act(async () => { tabButtons()[index]!.click() })
}

/** A tag mounted under one idea, by the data attribute the component sets. */
function tagIn(ideaId: string, attribute: string): HTMLElement | null {
  return host.querySelector(`[data-dsh-idea-id="${ideaId}"] [${attribute}]`)
}

/** Ids of the rows/cards mounted in the given list, in display order. The
 *  Overview card marks its wrapper AND the card, so an id can appear twice:
 *  keep the first occurrence only. */
function idsIn(selector: string): string[] {
  const seen: string[] = []
  for (const node of host.querySelectorAll(`${selector} [data-dsh-idea-id]`)) {
    const id = node.getAttribute('data-dsh-idea-id') ?? ''
    if (!seen.includes(id)) seen.push(id)
  }
  return seen
}

/** Ids of the Nth kanban column, in display order (0 = Open). */
function columnIds(index: number): string[] {
  const column = host.querySelectorAll('[data-dsh-column-scroll]')[index]
  if (column === undefined) return []
  const seen: string[] = []
  for (const node of column.querySelectorAll('[data-dsh-idea-id]')) {
    const id = node.getAttribute('data-dsh-idea-id') ?? ''
    if (!seen.includes(id)) seen.push(id)
  }
  return seen
}

/** The Delivered rows carry no idea-id attribute (see search-scope tests). */
function deliveredTitles(): string[] {
  return Array.from(host.querySelectorAll('[data-dsh-ideas-delivered] li'))
    .map(row => (row.textContent ?? '').trim())
}

describe('run-state tags on the Priorities rows', () => {
  it('shows the running and failed tags on a ranked row, with the last-observed tooltip', async () => {
    await renderBoard()
    await openTab(1)

    const running = tagIn('running', 'data-dsh-ideas-task-running')
    expect(running, 'no running tag on the Priorities row').not.toBeNull()
    expect(running?.textContent).toBe('Running')
    expect(running?.getAttribute('title')).toContain('in flight')

    const failed = tagIn('failed', 'data-dsh-ideas-task-failed')
    expect(failed, 'no failed tag on the Priorities row').not.toBeNull()
    expect(failed?.textContent).toBe('Task failed')
    expect(failed?.getAttribute('title')).toContain('last observed status')
  })

  it('stays silent on an idle row and never invents a recipe tag (out of scope here)', async () => {
    await renderBoard()
    await openTab(1)
    expect(tagIn('plain', 'data-dsh-ideas-task-running')).toBeNull()
    expect(tagIn('plain', 'data-dsh-ideas-task-failed')).toBeNull()
    // The recipe gate is a COLUMN, not a run state: Priorities only lists open
    // ideas, so the Under review badge must never appear here.
    expect(host.querySelector('[data-dsh-ideas-priorities] .dsh-ideas-review-badge')).toBeNull()
  })

  it('resolves the follow-up lineage to the parent number (#2)', async () => {
    await renderBoard()
    await openTab(1)
    const row = host.querySelector('[data-dsh-idea-id="child"]')
    const chip = row?.querySelector(`.${'dsh-ideas-followup-badge'}`)
    expect(chip?.textContent).toBe('follow-up of #2')
  })

  it('never moves a row: the ranked order is the stored rank', async () => {
    await renderBoard()
    await openTab(1)
    expect(idsIn('[data-dsh-ideas-priorities]')).toEqual(['plain', 'failed', 'running', 'child'])
  })
})

describe('run-state tags on the Delivered rows', () => {
  it('shows a run still in flight on an archived idea (its row has no other meta)', async () => {
    await renderBoard()
    await openTab(2)
    const titles = deliveredTitles()
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain('Archived while running')
    // A bare archived row (workspace-less fixture row, no tags/badges) still
    // has to render its meta line for the tag to exist at all.
    const tag = host.querySelector('[data-dsh-ideas-delivered] [data-dsh-ideas-task-running]')
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toBe('Running')
  })

  it('does not duplicate the delivery date (the exit stamp already carries it)', async () => {
    await renderBoard()
    await openTab(2)
    expect(host.querySelector('[data-dsh-ideas-delivered] .dsh-ideas-delivered-badge')).toBeNull()
  })
})

describe('attention-first ordering of the Open column (setting openOrdering)', () => {
  it('NON-REGRESSION: the default option keeps the stored rank, in the Overview column', async () => {
    const transport = new StaticTransport(fixture())
    await renderBoard(transport)
    expect(transport.configView).toBeUndefined()
    // Overview: the Open column reads rank 1..4, the running idea stays third.
    expect(columnIds(0)).toEqual(['plain', 'failed', 'running', 'child'])
  })

  it('brings the in-flight work to the top of the Open column when opted in', async () => {
    const transport = new StaticTransport(fixture())
    transport.configView = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, openOrdering: 'activity' }, revision: 1 }
    await renderBoard(transport)
    // running first, then the failed one, then the two idle rows by rank.
    expect(columnIds(0)).toEqual(['running', 'failed', 'plain', 'child'])
  })

  it('leaves the closed columns on their own ordering', async () => {
    const transport = new StaticTransport(fixture())
    transport.configView = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, openOrdering: 'activity' }, revision: 1 }
    await renderBoard(transport)
    const reviewColumn = host.querySelectorAll('[data-dsh-column-scroll]')[1]!
    expect(reviewColumn.textContent).toContain('Under review idea')
  })
})
