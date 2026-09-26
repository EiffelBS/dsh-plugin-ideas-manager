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
import { classes } from '../src/client/style.ts'
import { t } from '../src/client/locales.ts'
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

/**
 * One open idea per run state, one follow-up child, one archived run.
 *
 * The `createdAt` stamps run in a DIFFERENT order from the ranks on purpose
 * (`plain` is rank 1 but the newest, `failed` is rank 2 but the oldest): a
 * fixture where both agree cannot tell a date order from a rank order.
 */
function fixture(): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { ...base, createdAt: 500, id: 'plain', ideaNumber: 1, title: 'Plain idea', status: 'open', rank: 1, bodyExcerpt: 'a' },
      { ...base, createdAt: 100, id: 'failed', ideaNumber: 2, title: 'Failed idea', status: 'open', rank: 2, bodyExcerpt: 'b', taskBoardId: 'task-1', taskBoardStatus: 'failed' },
      { ...base, createdAt: 400, id: 'running', ideaNumber: 3, title: 'Running idea', status: 'open', rank: 3, bodyExcerpt: 'c', taskBoardId: 'task-2', taskBoardStatus: 'running' },
      { ...base, createdAt: 200, id: 'child', ideaNumber: 4, title: 'Follow-up idea', status: 'open', rank: 4, bodyExcerpt: 'd', followUpOfId: 'failed' },
      // Deliberately BARE: no workspace, no tags, no value/effort, no
      // deliveredAt. Its meta line does not exist at all, so the run state must
      // render from the state slot alone.
      { createdAt: 1, updatedAt: 100, id: 'archived-run', ideaNumber: 5, title: 'Archived while running', status: 'archived', rank: 1, bodyExcerpt: 'e', archivedAt: 50, runStatus: 'running' },
      { ...base, id: 'gate', ideaNumber: 6, title: 'Under review idea', status: 'underReview', rank: 1, bodyExcerpt: 'f' },
      // Delivered, then restored: the ledger clears archivedAt but keeps
      // deliveredAt, so an OPEN row can still carry a delivery date.
      { ...base, createdAt: 300, id: 'restored', ideaNumber: 7, title: 'Restored idea', status: 'open', rank: 5, bodyExcerpt: 'g', deliveredAt: 70 },
    ],
  }
}

/** Static list transport, plus an optional config surface (a fresh view keeps
 *  the shipped defaults; `configView` overrides it to pin one setting). */
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
    expect(idsIn('[data-dsh-ideas-priorities]'))
      .toEqual(['plain', 'failed', 'running', 'child', 'restored'])
  })

  it('PLACEMENT: the state tags sit in the row top-right, never in the meta line', async () => {
    // A live acceptance run reported the "Running" tag as MISSING from a
    // Priorities row that was showing it: it sat in the meta line between the
    // topic tags and the value/effort badges, where a quiet pill reads as one
    // more topic label. The Overview card header is the reference placement -
    // the title is `flex: 1 1 0`, so the badges land in its top-right corner -
    // and the rows now match it.
    await renderBoard()
    await openTab(1)
    const slots = [
      ['running', '[data-dsh-ideas-task-running]'],
      ['failed', '[data-dsh-ideas-task-failed]'],
      ['child', `.${classes.followUpBadge}`],
    ] as const
    for (const [id, marker] of slots) {
      const row = host.querySelector(`[data-dsh-idea-id="${id}"]`)
      const tag = row?.querySelector(marker)
      expect(tag, `tag missing on ${id}`).not.toBeNull()
      // Its own slot, sibling of the grow area, not inside the meta line.
      expect(tag?.closest(`.${classes.rowState}`), `not in the state slot on ${id}`).not.toBeNull()
      expect(tag?.closest(`.${classes.cardMeta}`), `still inside the meta line on ${id}`).toBeNull()
    }
    // The meta line keeps the workspace chip and the scores - and no state tag.
    const meta = host.querySelector(`[data-dsh-idea-id="failed"] .${classes.cardMeta}`)
    expect(meta?.textContent).toBe('ws1')
    expect(meta?.querySelector(`.${classes.taskRunningBadge}`)).toBeNull()
    expect(meta?.querySelector(`.${classes.taskFailedBadge}`)).toBeNull()
  })
})

describe('run-state tags on the Delivered rows', () => {
  it('shows a run still in flight on an archived idea (its row has no other meta)', async () => {
    await renderBoard()
    await openTab(2)
    const titles = deliveredTitles()
    expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('Archived while running')]))
    // The fixture row is deliberately bare (no workspace, no tags, no
    // value/effort): the tag shows with no meta line in the row at all, which
    // is the whole point of giving the state tags their own slot.
    const row = Array.from(host.querySelectorAll('[data-dsh-ideas-delivered] li'))
      .find(node => (node.textContent ?? '').includes('Archived while running'))
    expect(row?.querySelector(`.${classes.workspaceChip}`), 'fixture row is not bare').toBeNull()
    expect(row?.querySelector(`.${classes.cardMeta}`), 'bare row has no meta line').toBeNull()
    const tag = row?.querySelector('[data-dsh-ideas-task-running]')
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toBe('Running')
  })

  it('PLACEMENT: same top-right slot as the Priorities rows', async () => {
    await renderBoard()
    await openTab(2)
    const row = Array.from(host.querySelectorAll('[data-dsh-ideas-delivered] li'))
      .find(node => (node.textContent ?? '').includes('Archived while running'))
    const tag = row?.querySelector('[data-dsh-ideas-task-running]')
    expect(tag?.closest(`.${classes.rowState}`)).not.toBeNull()
    expect(tag?.closest(`.${classes.cardMeta}`)).toBeNull()
  })

  it('does not duplicate the delivery date (the exit stamp already carries it)', async () => {
    await renderBoard()
    await openTab(2)
    expect(host.querySelector('[data-dsh-ideas-delivered] .dsh-ideas-delivered-badge')).toBeNull()
  })
})

describe('Open column display order (openOrdering + runningFirst)', () => {
  /** Pin one setting, keep the shipped value of every other one. */
  const withSettings = (patch: IdeasSettingsPatch): StaticTransport => {
    const transport = new StaticTransport(fixture())
    transport.configView = {
      available: true,
      value: { ...IDEAS_SETTINGS_DEFAULTS, ...patch },
      revision: 1,
    }
    return transport
  }

  it('DEFAULT: creation date ascending, with the running idea floated on top', async () => {
    // createdAt asc is failed(100), child(200), restored(300), running(400),
    // plain(500) - a different order from the ranks on purpose. The running
    // idea leads, the rest keep the date order below it.
    await renderBoard(withSettings({}))
    expect(columnIds(0)).toEqual(['running', 'failed', 'child', 'restored', 'plain'])
  })

  it('the running float composes with a date order instead of replacing it', async () => {
    await renderBoard(withSettings({ openOrdering: 'createdAtDesc' }))
    // Newest first below the float: plain(500), restored(300), child(200),
    // failed(100) - the running idea (400) is out of its date slot, on top.
    expect(columnIds(0)).toEqual(['running', 'plain', 'restored', 'child', 'failed'])
  })

  it('turning the float OFF gives the selected order alone', async () => {
    await renderBoard(withSettings({ runningFirst: false }))
    // No block at all: the running idea goes back to its date slot (400).
    expect(columnIds(0)).toEqual(['failed', 'child', 'restored', 'running', 'plain'])
  })

  it('the rank order is available too, and floats the running idea as well', async () => {
    await renderBoard(withSettings({ openOrdering: 'rank' }))
    // plain(1), failed(2), running(3), child(4), restored(5) - the float only
    // promotes the running one.
    expect(columnIds(0)).toEqual(['running', 'plain', 'failed', 'child', 'restored'])
  })

  it('NEVER touches the Priorities ranking, whatever the column order', async () => {
    // The ranked list prints a position and its arrows write one rank step,
    // so it stays on the stored rank: the column settings are Overview-only.
    await renderBoard(withSettings({ openOrdering: 'createdAtDesc' }))
    await openTab(1)
    expect(idsIn('[data-dsh-ideas-priorities]'))
      .toEqual(['plain', 'failed', 'running', 'child', 'restored'])
  })

  it('leaves the closed columns on their own ordering', async () => {
    await renderBoard(withSettings({ openOrdering: 'createdAtDesc' }))
    const reviewColumn = host.querySelectorAll('[data-dsh-column-scroll]')[1]!
    expect(reviewColumn.textContent).toContain('Under review idea')
  })

  it('takes the OPEN column out of drag & drop whenever the view reorders it', async () => {
    // The drop anchor is read from the DISPLAY order (the half-split line and
    // dropNextId) while rebuildOrder resolves it in RANK space. In a reordered
    // column the two disagree and a drop can rewrite the rank the card already
    // had - a wire call whose only visible effect is nothing. The grip is
    // therefore inert (with a tooltip that says why) while the column is a
    // view, and the card's own action buttons still move the idea.
    for (const patch of [{ runningFirst: true }, { openOrdering: 'createdAt' as const }]) {
      await renderBoard(withSettings(patch))
      const openGrip = host.querySelector('[data-dsh-idea-id="plain"] .dsh-ideas-card-grip')
      expect(openGrip?.getAttribute('draggable'), JSON.stringify(patch)).toBe('false')
      expect(openGrip?.getAttribute('title')).toBe(t('card.dragLocked'))
      // The archive action on the same card is untouched, so a lifecycle move
      // never depended on the grip.
      expect(host.querySelector('[data-dsh-idea-id="plain"] .dsh-ideas-card-actions')).not.toBeNull()
    }
  })

  it('leaves the drag enabled everywhere else: rank order with the float off, and the closed columns', async () => {
    await renderBoard(withSettings({ openOrdering: 'rank', runningFirst: false }))
    expect(host.querySelector('[data-dsh-idea-id="plain"] .dsh-ideas-card-grip')?.getAttribute('draggable')).toBe('true')
    // Under review / Archived / Declined are always in rank order.
    expect(host.querySelector('[data-dsh-idea-id="gate"] .dsh-ideas-card-grip')?.getAttribute('draggable')).toBe('true')
  })
})

describe('the exit stamp never lies on an actionable row', () => {
  it('a restored idea (open, still carrying deliveredAt) shows NO Delivered stamp in Priorities', async () => {
    // The restore verb clears archivedAt but keeps deliveredAt, so an OPEN
    // ranked row can still carry a delivery date. Printing it there would read
    // as "this one is done" on the list that decides what to pick next.
    await renderBoard()
    await openTab(1)
    const row = host.querySelector('[data-dsh-idea-id="restored"]')
    expect(row, 'restored idea missing from the ranking').not.toBeNull()
    expect(row?.querySelector('.dsh-ideas-delivered-badge')).toBeNull()
    expect(row?.querySelector('[data-dsh-ideas-task-running]')).toBeNull()
  })
})
