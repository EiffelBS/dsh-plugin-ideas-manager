// @vitest-environment jsdom
/**
 * Idea #94: multi-select and bulk actions on the board.
 *
 * Three contracts are pinned here, and they are the ones the brief asks for.
 *
 *  - **The selection scope.** A selection can only ever hold ids inside the
 *    ACTIVE scope (the tab's filtered rows: workspace selector + tag filter +
 *    search), a shift-click paints the block of rows the author actually sees
 *    (display order, not ledger order), "select everything" is exactly that
 *    scope, and an idea that leaves the filter leaves the selection. The board
 *    integration half asserts the bar states the count AND the scope.
 *  - **A bulk operation.** Bulk tag / re-home / archive are batches of the
 *    ORDINARY per-idea verbs — the test transport records every posted action,
 *    so a bulk-only verb or a ledger edit would show up as a missing/extra verb.
 *    The mirror constraint is asserted too: an archived idea bound to a task
 *    card goes restore -> update -> archive, because an archived card is
 *    read-only for every verb.
 *  - **The partial-failure path.** One refused idea out of three must not abort
 *    the batch and must not read as a blanket success: the report names the
 *    failing idea and the Host's own reason, the other two are still applied,
 *    and a failed round trip is compensated (never left in the OPEN backlog)
 *    with the compensation said out loud.
 *
 * Undo is covered with the bulk archive it belongs to: the report restores
 * exactly the ideas the run archived, and says plainly that the other two
 * actions have no undo here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  EMPTY_SELECTION,
  extendSelection,
  isSelected,
  isWholeScopeSelected,
  pruneSelection,
  selectAll,
  selectedRows,
  toggleSelection,
} from '../src/client/selection.ts'
import {
  parseBulkTagNames,
  planBulkArchive,
  planBulkTag,
  planBulkWorkspace,
  runBulkPlan,
  summarizeBulk,
  undoableIds,
  type BulkStep,
} from '../src/client/bulk.ts'
import { classes } from '../src/client/style.ts'
import { en, t } from '../src/client/locales.ts'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { toListSnapshot, type IdeasAction, type IdeasSnapshot } from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* --- pure: selection scope -------------------------------------------- */

const SCOPE = ['i1', 'i2', 'i3', 'i4', 'i5']

describe('selection scope', () => {
  it('toggles one row at a time and keeps the clicked row as the anchor', () => {
    let selection = toggleSelection(EMPTY_SELECTION, 'i2', SCOPE)
    expect(selection.ids).toEqual(['i2'])
    expect(selection.anchor).toBe('i2')
    selection = toggleSelection(selection, 'i4', SCOPE)
    expect(selection.ids).toEqual(['i2', 'i4'])
    expect(selection.anchor).toBe('i4')
    selection = toggleSelection(selection, 'i4', SCOPE)
    expect(selection.ids).toEqual(['i2'])
    expect(isSelected(selection, 'i4')).toBe(false)
  })

  it('refuses an id outside the scope, even a stale click after the filter moved', () => {
    const selection = toggleSelection(EMPTY_SELECTION, 'gone', SCOPE)
    expect(selection).toBe(EMPTY_SELECTION)
    expect(isSelected(selection, 'gone')).toBe(false)
  })

  it('shift-click paints the range in DISPLAY order and adds it to what was selected', () => {
    const first = toggleSelection(EMPTY_SELECTION, 'i1', SCOPE)
    const ranged = extendSelection(first, 'i3', SCOPE)
    expect(ranged.ids).toEqual(['i1', 'i2', 'i3'])
    // The anchor moves to the clicked row, so a second shift-click re-grows
    // from there instead of from the original row.
    expect(ranged.anchor).toBe('i3')
    const second = extendSelection(ranged, 'i5', SCOPE)
    expect(second.ids).toEqual(['i1', 'i2', 'i3', 'i4', 'i5'])
  })

  it('shift-click works backwards and degrades to a toggle without an anchor', () => {
    const far = toggleSelection(EMPTY_SELECTION, 'i5', SCOPE)
    expect(extendSelection(far, 'i3', SCOPE).ids).toEqual(['i5', 'i3', 'i4'])
    const orphan = extendSelection({ ids: ['i1'], anchor: undefined }, 'i2', SCOPE)
    expect(orphan.ids).toEqual(['i1', 'i2'])
    // An anchor that left the scope cannot anchor a range any more.
    const stale = extendSelection({ ids: ['i1'], anchor: 'gone' }, 'i2', SCOPE)
    expect(stale.ids).toEqual(['i1', 'i2'])
  })

  it('select-all is exactly the scope, and knows when the whole scope is selected', () => {
    const all = selectAll(SCOPE)
    expect(all.ids).toEqual(SCOPE)
    expect(isWholeScopeSelected(all, SCOPE)).toBe(true)
    expect(isWholeScopeSelected(toggleSelection(all, 'i3', SCOPE), SCOPE)).toBe(false)
    // An empty scope is never "all selected" (the affordance stays meaningful).
    expect(isWholeScopeSelected(selectAll([]), [])).toBe(false)
  })

  it('prunes the selection when the scope moves, and keeps it when it does not', () => {
    const selection = toggleSelection(EMPTY_SELECTION, 'i2', SCOPE)
    // A narrower filter: i3/i4 leave the scope, the selection follows.
    expect(pruneSelection(selection, ['i1', 'i2']).ids).toEqual(['i2'])
    // Same scope: the SAME object comes back (no render loop on the 2.5 s poll).
    expect(pruneSelection(selection, SCOPE)).toBe(selection)
    const gone = toggleSelection(EMPTY_SELECTION, 'i5', SCOPE)
    const pruned = pruneSelection(gone, ['i1', 'i2'])
    expect(pruned.ids).toEqual([])
    expect(pruned.anchor).toBeUndefined()
  })

  it('returns the selected rows in scope order, whatever the selection order was', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const selection = toggleSelection(toggleSelection(EMPTY_SELECTION, 'c', ['a', 'b', 'c']), 'a', ['a', 'b', 'c'])
    expect(selectedRows(rows, selection)).toEqual([{ id: 'a' }, { id: 'c' }])
  })
})

/* --- pure: bulk plans -------------------------------------------------- */

function row(partial: Partial<IdeaRecord> & { id: string; status: IdeaRecord['status'] }): IdeaRecord {
  return { title: partial.id, body: '', createdAt: 1, updatedAt: 1, ...partial }
}

const TAGGED = row({ id: 'i1', status: 'open', tags: [{ name: 'a', promptPrefix: 'keep me' }] })
const ARCHIVED_BOUND = row({ id: 'i2', status: 'archived', archivedAt: 5, taskBoardId: 'idea-i2', tags: [{ name: 'a' }] })
const ARCHIVED_UNBOUND = row({ id: 'i3', status: 'archived', archivedAt: 5, tags: [{ name: 'a' }] })
const DECLINED = row({ id: 'i4', status: 'declined', archivedAt: 5, taskBoardId: 'idea-i4', tags: [{ name: 'a' }] })

describe('bulk plans (ordinary verbs only)', () => {
  it('bulk tag keeps the existing labels AND their prompt line, and unions the new one', () => {
    const [plan] = planBulkTag([TAGGED], [{ name: 'b' }])
    expect(plan?.steps).toEqual([{ verb: 'update', patch: { tags: [{ name: 'a', promptPrefix: 'keep me' }, { name: 'b' }] } }])
    expect(plan?.roundTrip).toBe(false)
  })

  it('bulk tag skips an idea that already carries the label, and one at the label cap', () => {
    const [already] = planBulkTag([TAGGED], [{ name: 'a' }])
    expect(already?.steps).toEqual([])
    expect(already?.skipReason).toBe('already-tagged')
    const full = row({ id: 'f', status: 'open', tags: Array.from({ length: 8 }, (_, index) => ({ name: `t${index}` })) })
    const [capped] = planBulkTag([full], [{ name: 'new' }])
    expect(capped?.steps).toEqual([])
    // Skipped, NOT silently truncated: the ledger drops the overflow.
    expect(capped?.skipReason).toBe('tag-limit')
  })

  it('round-trips a card-bound ARCHIVED idea and never a declined one', () => {
    const plans = planBulkTag([ARCHIVED_BOUND, ARCHIVED_UNBOUND, DECLINED], [{ name: 'b' }])
    // An archived card is read-only for every verb: restore -> update -> archive.
    expect(plans[0]?.steps).toEqual([
      { verb: 'restore' },
      { verb: 'update', patch: { tags: [{ name: 'a' }, { name: 'b' }] } },
      { verb: 'move', status: 'archived' },
    ])
    expect(plans[0]?.roundTrip).toBe(true)
    // Unbound: the plain patch is enough (no card to keep in sync).
    expect(plans[1]?.steps).toHaveLength(1)
    expect(plans[1]?.roundTrip).toBe(false)
    // Declined: restoring it to patch the card would rewrite a decline.
    expect(plans[2]?.steps).toEqual([])
    expect(plans[2]?.skipReason).toBe('declined')
  })

  it('bulk re-home sends the stable workspace UUID, skipping the ideas already there', () => {
    const plans = planBulkWorkspace([TAGGED, row({ id: 'there', status: 'open', workspaceId: 'ws-2' })], 'ws-2')
    expect(plans[0]?.steps).toEqual([{ verb: 'update', patch: { workspaceId: 'ws-2' } }])
    expect(plans[1]?.steps).toEqual([])
    expect(plans[1]?.skipReason).toBe('already-there')
    // '' is the generic (workspace-less) group, not a workspace named "": an
    // idea already generic is skipped, one in a workspace gets the patch.
    expect(planBulkWorkspace([TAGGED], '')[0]?.skipReason).toBe('already-there')
    expect(planBulkWorkspace([row({ id: 'ws', status: 'open', workspaceId: 'ws-2' })], '')[0]?.steps)
      .toEqual([{ verb: 'update', patch: { workspaceId: '' } }])
  })

  it('bulk archive moves what can move and skips the rest with a reason', () => {
    const plans = planBulkArchive([TAGGED, ARCHIVED_UNBOUND, DECLINED, row({ id: 'u', status: 'underReview' })])
    expect(plans[0]?.steps).toEqual([{ verb: 'move', status: 'archived' }])
    expect(plans[1]?.skipReason).toBe('already-archived')
    expect(plans[2]?.skipReason).toBe('declined')
    expect(plans[3]?.steps).toEqual([{ verb: 'move', status: 'archived' }])
  })

  it('rejects an over-long tag name instead of letting the ledger drop it', () => {
    expect(parseBulkTagNames(' ok , ' + 'x'.repeat(33)).invalid).toHaveLength(1)
    expect(parseBulkTagNames(' ok , ok , second ').names.map(tag => tag.name)).toEqual(['ok', 'second'])
    expect(parseBulkTagNames('  ,  ').names).toEqual([])
  })
})

/* --- pure: the runner and the report ----------------------------------- */

describe('bulk runner (partial failures stay per idea)', () => {
  it('keeps going after a refusal and reports the Host reason verbatim', async () => {
    const posted: [string, BulkStep['verb']][] = []
    const results = await runBulkPlan(planBulkArchive([TAGGED, row({ id: 'i2', status: 'open' }), row({ id: 'i3', status: 'open' })]),
      async (ideaId, step) => {
        posted.push([ideaId, step.verb])
        if (ideaId === 'i2') throw new Error('idea not found')
      })
    expect(posted).toEqual([['i1', 'move'], ['i2', 'move'], ['i3', 'move']])
    expect(results.map(result => result.state)).toEqual(['applied', 'failed', 'applied'])
    expect(results[1]?.reason).toBe('idea not found')
  })

  it('never leaves a round-tripped idea in the OPEN backlog when the patch fails', async () => {
    const posted: BulkStep['verb'][] = []
    const [result] = await runBulkPlan(planBulkTag([ARCHIVED_BOUND], [{ name: 'b' }]),
      async (_ideaId, step) => {
        posted.push(step.verb)
        if (step.verb === 'update') throw new Error('task has already been executed')
      })
    expect(posted).toEqual(['restore', 'update', 'move'])
    expect(result?.state).toBe('failed')
    expect(result?.reason).toBe('task has already been executed')
    expect(result?.note).toBe('rearchived')
  })

  it('says so when even the compensation was refused', async () => {
    const [result] = await runBulkPlan(planBulkTag([ARCHIVED_BOUND], [{ name: 'b' }]),
      async (_ideaId, step) => {
        if (step.verb === 'update') throw new Error('nope')
        if (step.verb === 'move') throw new Error('nope')
      })
    expect(result?.note).toBe('left-open')
  })

  it('marks a bulk archive reversible and offers exactly the ids that went through', async () => {
    const results = await runBulkPlan(
      planBulkArchive([TAGGED, DECLINED, row({ id: 'i2', status: 'open' })]),
      async ideaId => { if (ideaId === 'i2') throw new Error('boom') })
    const report = summarizeBulk('archive', results)
    expect(report.reversible).toBe(true)
    // A skipped idea is not "archived", so undoing it would resurrect a row
    // that never moved.
    expect(undoableIds(report)).toEqual(['i1'])
    expect(summarizeBulk('tag', results).reversible).toBe(false)
    expect(undoableIds(summarizeBulk('tag', results))).toEqual([])
  })
})

/* --- DOM: the board surface ------------------------------------------- */

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

function mount(element: ReactElement): void {
  act(() => {
    root = createRoot(host)
    root.render(element)
  })
}

function click(target: Element | undefined | null, shiftKey = false): void {
  if (target === undefined || target === null) throw new Error('element not found')
  act(() => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey })
    ;(target as HTMLElement).dispatchEvent(event)
  })
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function selectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Wait for the async batch to settle (the runner awaits real promises). */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const text = (): string => host.textContent ?? ''
const bar = (): Element => host.querySelector(`.${classes.selectionBar}`) as Element
const selectAllButton = (): Element => host.querySelector('[data-dsh-ideas-select-all]') as Element
const countText = (): string => host.querySelector('[data-dsh-ideas-selection-count]')?.textContent ?? ''
/** The select box of one card/row, in DOM order. */
const boxes = (): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll('[data-dsh-ideas-select]')) as HTMLButtonElement[]
const cardBox = (title: string): HTMLButtonElement => {
  const card = Array.from(host.querySelectorAll(`.${classes.card}`)).find(element => (element.textContent ?? '').includes(title))
  const box = card?.querySelector('[data-dsh-ideas-select]')
  if (box === undefined) throw new Error(`no select box on ${title}`)
  return box as HTMLButtonElement
}
const buttonByLabel = (label: string): Element | undefined =>
  Array.from(host.querySelectorAll('button')).find(button => button.textContent === label)

/** A fake transport recording every action the board posts. */
function recordingClient(snapshot: IdeasSnapshot, refuse?: (action: IdeasAction) => string | undefined): {
  client: IdeasClient
  actions: IdeasAction[]
} {
  const list = toListSnapshot(snapshot)
  const actions: IdeasAction[] = []
  const transport: IdeasHostTransport = {
    state: async () => list,
    action: async (action) => {
      actions.push(action)
      const refusal = refuse?.(action)
      if (refusal !== undefined) throw new Error(refusal)
      return list
    },
    subscribe: () => () => {},
  }
  // A DSH workspace registry, so the board can name the scope instead of
  // falling back to the raw ledger id.
  const workspaces = {
    list: () => [
      { workspaceId: 'ws-1', title: 'Alpha project' },
      { workspaceId: 'ws-2', title: 'Beta project' },
    ],
    subscribe: () => () => {},
    dispose: () => {},
  }
  const client = new IdeasClient(transport, workspaces)
  client.snapshot = list
  return { client, actions }
}

function fixture(): IdeasSnapshot {
  return {
    schemaVersion: 1,
    revision: 3,
    ideas: [
      row({ id: 'i1', title: 'Alpha idea', status: 'open', rank: 1, ideaNumber: 1, workspaceId: 'ws-1', tags: [{ name: 'alpha' }] }),
      row({ id: 'i2', title: 'Beta idea', status: 'open', rank: 2, ideaNumber: 2, workspaceId: 'ws-1' }),
      row({ id: 'i3', title: 'Gamma idea', status: 'open', rank: 3, ideaNumber: 3, workspaceId: 'ws-2', tags: [{ name: 'alpha' }] }),
      row({ id: 'i4', title: 'Archived bound', status: 'archived', archivedAt: 9, ideaNumber: 4, workspaceId: 'ws-1', taskBoardId: 'idea-i4' }),
    ],
  }
}

describe('board: the selection bar states its scope', () => {
  it('counts the selection and names the workspace / tags / search behind "all"', () => {
    const { client } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    expect(bar()).not.toBeNull()
    // No filter at all: the bar says so, instead of leaving "all" dangling.
    expect(text()).toContain(t('bulk.scope.everything'))
    expect(countText()).toContain('0')
    expect(countText()).toContain('4')

    click(cardBox('Beta idea'))
    expect(countText()).toBe(t('bulk.bar.count', { selected: 1, total: 4 }))
    expect(text()).toContain(t('bulk.scope.everything'))

    // The workspace chip on a card scopes the board; the sentence follows and
    // names the workspace the author recognises.
    const chip = Array.from(host.querySelectorAll(`.${classes.workspaceChip}`))
      .find(element => element.getAttribute('title')?.includes('Beta project')) as HTMLElement
    click(chip)
    expect(text()).toContain(t('bulk.scope.label', { scope: 'Beta project' }))
    expect(text()).not.toContain(t('bulk.scope.everything'))
    // The scope moved to Beta: only Gamma is in it, so the selection is gone.
    expect(countText()).toBe(t('bulk.bar.count', { selected: 0, total: 1 }))
  })

  it('select-all selects exactly the current filter and toggles back off', () => {
    const { client } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    click(selectAllButton())
    expect(countText()).toBe(t('bulk.bar.count', { selected: 4, total: 4 }))
    expect(host.querySelectorAll(`[data-selected]`)).toHaveLength(4)
    // The same button now offers the reverse, so "all" is never a dead end.
    expect(selectAllButton().textContent).toBe(t('bulk.bar.clearSelection'))
    click(selectAllButton())
    expect(countText()).toBe(t('bulk.bar.count', { selected: 0, total: 4 }))
    expect(host.querySelectorAll(`[data-selected]`)).toHaveLength(0)
  })

  it('shift-click paints a range of cards, and a search that hides it prunes it', async () => {
    const { client } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    click(cardBox('Alpha idea'))
    click(cardBox('Gamma idea'), true)
    expect(countText()).toBe(t('bulk.bar.count', { selected: 3, total: 4 }))

    // A search that only Gamma matches drops the two it hides from the
    // selection: a bulk action can never reach a row the filter hides.
    type(host.querySelector(`.${classes.search}`) as HTMLInputElement, 'Gamma')
    // The active search loads the deep index in the background (idea #34).
    await settle()
    expect(countText()).toBe(t('bulk.bar.count', { selected: 1, total: 1 }))
  })
})

describe('board: the select box lives on every tab', () => {
  it('renders no selection bar at all on a board that holds no idea', () => {
    const { client } = recordingClient({ schemaVersion: 1, revision: 1, ideas: [] })
    mount(<IdeasBoard client={client} />)
    expect(bar()).toBeNull()
    expect(text()).toContain(t('board.empty'))
  })

  /** Click a panel tab by its label. */
  function openTab(key: 'tab.overview' | 'tab.priorities' | 'tab.delivered'): void {
    click(Array.from(host.querySelectorAll('[role="tab"]'))
      .find(button => (button.textContent ?? '').includes(t(key))))
  }

  /** The select box of the row carrying this title, in the current view. */
  function rowBox(title: string): HTMLButtonElement {
    const row = Array.from(host.querySelectorAll(`.${classes.prioritiesRow}`))
      .find(element => (element.textContent ?? '').includes(title))
    const box = row?.querySelector('[data-dsh-ideas-select]')
    if (box === undefined) throw new Error(`no select box on row ${title}`)
    return box as HTMLButtonElement
  }

  it('selects and ranges over the Priorities rows, scoped to the open backlog', async () => {
    const { client } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    openTab('tab.priorities')
    // Priorities shows the OPEN backlog only: three of the four ideas.
    expect(countText()).toBe(t('bulk.bar.count', { selected: 0, total: 3 }))
    click(rowBox('Alpha idea'))
    click(rowBox('Gamma idea'), true)
    expect(countText()).toBe(t('bulk.bar.count', { selected: 3, total: 3 }))
    expect(selectAllButton().textContent).toBe(t('bulk.bar.clearSelection'))

    // The tag filter follows the shared scope, so the selection prunes with it:
    // three rows were selected, only the two carrying 'alpha' survive.
    const chip = Array.from(host.querySelectorAll(`.${classes.filterChip}`))
      .find(button => button.textContent === 'alpha') as HTMLButtonElement
    click(chip)
    await settle()
    expect(countText()).toBe(t('bulk.bar.count', { selected: 2, total: 2 }))
  })

  it('selects and ranges over the Delivered rows, scoped to the archived journal', async () => {
    const { client, actions } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    openTab('tab.delivered')
    expect(countText()).toBe(t('bulk.bar.count', { selected: 0, total: 1 }))
    click(rowBox('Archived bound'))
    click(host.querySelector('[data-dsh-ideas-bulk-archive]') as Element)
    click(host.querySelector('[data-dsh-ideas-bulk-submit]') as Element)
    await settle()
    // Already archived: skipped with its reason, nothing posted.
    expect(actions).toEqual([])
    expect(host.querySelector('[data-dsh-ideas-bulk-group="skipped"]')?.textContent)
      .toContain(t('bulk.reason.alreadyArchived'))
  })

  it('switching tab re-scopes the selection instead of carrying it across', async () => {
    const { client } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    click(cardBox('Archived bound'))
    expect(countText()).toBe(t('bulk.bar.count', { selected: 1, total: 4 }))
    openTab('tab.priorities')
    await settle()
    // The archived idea is not in the Priorities scope (open backlog), so it
    // leaves the selection: the batch can never reach a row of another tab.
    expect(countText()).toBe(t('bulk.bar.count', { selected: 0, total: 3 }))
  })
})

describe('board: bulk tag is a batch of ordinary update verbs', () => {
  it('posts one update per selected idea, never a bulk verb, and reports per idea', async () => {
    const { client, actions } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    // Two open cards of Alpha plus the archived, card-bound one.
    click(cardBox('Beta idea'))
    click(cardBox('Gamma idea'), true)
    click(cardBox('Archived bound'))
    click(host.querySelector('[data-dsh-ideas-bulk-tag]') as Element)
    expect(text()).toContain(t('bulk.tag.title', { count: 3 }))
    // The dialog restates the batch AND its scope: a batch is never posted
    // from a surface that lost the "of what" half.
    expect(host.querySelector('[data-dsh-ideas-bulk-batch]')?.textContent).toBe(t('bulk.batch.count', { count: 3 }))
    expect(host.querySelector('[data-dsh-ideas-bulk-scope]')?.textContent).toBe(t('bulk.scope.everything'))

    type(host.querySelector('#dsh-ideas-bulk-tags') as HTMLInputElement, 'review')
    click(host.querySelector('[data-dsh-ideas-bulk-submit]') as Element)
    await settle()

    // One `update` per idea and nothing else: the frozen wire keeps its verbs.
    expect(actions.map(action => action.kind)).toEqual(['update', 'update', 'restore', 'update', 'move'])
    expect(actions.every(action => !('bulk' in (action as Record<string, unknown>)))).toBe(true)
    // The archived, card-bound idea went through the mirror round trip.
    expect(actions[2]).toEqual({ kind: 'restore', ideaId: 'i4' })
    expect(actions[4]).toEqual({ kind: 'move', ideaId: 'i4', status: 'archived' })
    // Labels are unioned, never replaced.
    expect(actions[0]).toEqual({ kind: 'update', ideaId: 'i2', patch: { tags: [{ name: 'review' }] } })
    expect(actions[1]).toEqual({ kind: 'update', ideaId: 'i3', patch: { tags: [{ name: 'alpha' }, { name: 'review' }] } })
    // The report answers per idea, and now says the batch IS reversible
    // (idea #111) — plus the line that keeps the promise honest about what
    // undo never covers.
    expect(host.querySelector('[data-dsh-ideas-bulk-summary]')?.textContent)
      .toBe(t('bulk.report.summary', { applied: 3, skipped: 0, failed: 0 }))
    expect(host.querySelector('[data-dsh-ideas-bulk-undo-note]')?.textContent).toBe(t('bulk.undoNote'))
    expect(host.querySelector('[data-dsh-ideas-bulk-undo-scope]')?.textContent).toBe(t('undo.scope'))
    // The dialog offers no per-report button for a tag batch: the board-level
    // Undo row and Ctrl+Z are the one affordance for it (an undo of the whole
    // batch, not of the ideas the report happens to list).
    expect(host.querySelector('[data-dsh-ideas-bulk-undo]')).toBeNull()
  })
})

describe('board: bulk re-home', () => {
  it('sends the stable workspace UUID and skips the ideas already there', async () => {
    const { client, actions } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    click(cardBox('Alpha idea'))
    click(cardBox('Archived bound'))
    click(host.querySelector('[data-dsh-ideas-bulk-workspace]') as Element)
    selectValue(host.querySelector('#dsh-ideas-bulk-workspace') as HTMLSelectElement, 'ws-2')
    click(host.querySelector('[data-dsh-ideas-bulk-submit]') as Element)
    await settle()

    expect(actions[0]).toEqual({ kind: 'update', ideaId: 'i1', patch: { workspaceId: 'ws-2' } })
    expect(actions[1]).toEqual({ kind: 'restore', ideaId: 'i4' })
    expect(actions[2]).toEqual({ kind: 'update', ideaId: 'i4', patch: { workspaceId: 'ws-2' } })
    expect(actions[3]).toEqual({ kind: 'move', ideaId: 'i4', status: 'archived' })
    // Both selected ideas moved: nothing was skipped, so the report has no
    // skipped bucket at all.
    expect(host.querySelector('[data-dsh-ideas-bulk-group="skipped"]')).toBeNull()
  })
})

describe('board: a partial failure stays visible and per idea', () => {
  it('applies the rest, names the refused idea and its reason, and never aborts', async () => {
    const { client, actions } = recordingClient(
      fixture(),
      action => (action.kind === 'update' && action.ideaId === 'i3' ? 'task has already been executed' : undefined),
    )
    mount(<IdeasBoard client={client} />)
    click(selectAllButton())
    click(host.querySelector('[data-dsh-ideas-bulk-tag]') as Element)
    type(host.querySelector('#dsh-ideas-bulk-tags') as HTMLInputElement, 'review')
    click(host.querySelector('[data-dsh-ideas-bulk-submit]') as Element)
    await settle()

    expect(host.querySelector('[data-dsh-ideas-bulk-summary]')?.textContent)
      .toBe(t('bulk.report.summary', { applied: 3, skipped: 0, failed: 1 }))
    const failed = host.querySelector('[data-dsh-ideas-bulk-group="failed"]')
    expect(failed?.textContent).toContain('Gamma idea')
    // The Host's own sentence, not a blanket "the batch failed".
    expect(failed?.textContent).toContain('task has already been executed')
    // The batch kept going after the refusal, in scope order (the three open
    // cards first, then the archived one through its round trip).
    expect(actions.filter(action => action.kind === 'update').map(action => (action as { ideaId: string }).ideaId))
      .toEqual(['i1', 'i2', 'i3', 'i4'])
  })

  it('re-archives a round-tripped idea whose patch was refused, and says it did', async () => {
    const { client, actions } = recordingClient(
      fixture(),
      action => (action.kind === 'update' && action.ideaId === 'i4' ? 'archived task is read-only' : undefined),
    )
    mount(<IdeasBoard client={client} />)
    click(cardBox('Archived bound'))
    click(host.querySelector('[data-dsh-ideas-bulk-tag]') as Element)
    type(host.querySelector('#dsh-ideas-bulk-tags') as HTMLInputElement, 'review')
    click(host.querySelector('[data-dsh-ideas-bulk-submit]') as Element)
    await settle()

    // restore -> update (refused) -> move back to the archive.
    expect(actions.map(action => action.kind)).toEqual(['restore', 'update', 'move'])
    const failed = host.querySelector('[data-dsh-ideas-bulk-group="failed"]')
    expect(failed?.textContent).toContain(t('bulk.note.rearchived'))
  })
})

describe('board: undo of a bulk archive', () => {
  it('restores exactly the ideas the run archived, and only archives are reversible', async () => {
    const { client, actions } = recordingClient(fixture())
    mount(<IdeasBoard client={client} />)
    click(cardBox('Alpha idea'))
    click(cardBox('Beta idea'), true)
    click(host.querySelector('[data-dsh-ideas-bulk-archive]') as Element)
    expect(text()).toContain(t('bulk.archive.title', { count: 2 }))
    click(host.querySelector('[data-dsh-ideas-bulk-submit]') as Element)
    await settle()

    expect(actions).toEqual([
      { kind: 'move', ideaId: 'i1', status: 'archived' },
      { kind: 'move', ideaId: 'i2', status: 'archived' },
    ])
    expect(host.querySelector('[data-dsh-ideas-bulk-undo-note]')?.textContent).toBe(t('bulk.undoHint'))

    click(host.querySelector('[data-dsh-ideas-bulk-undo]') as Element)
    await settle()
    expect(actions.slice(2)).toEqual([
      { kind: 'restore', ideaId: 'i1' },
      { kind: 'restore', ideaId: 'i2' },
    ])
    expect(text()).toContain(t('bulk.undoReport'))
    expect(host.querySelector('[data-dsh-ideas-bulk-undo]')).toBeNull()
    click(buttonByLabel(t('bulk.close')) as Element)
  })

  it('offers nothing to undo when every idea was skipped', async () => {
    const snapshot: IdeasSnapshot = {
      schemaVersion: 1,
      revision: 1,
      ideas: [row({ id: 'i1', title: 'Already archived', status: 'archived', archivedAt: 4 })],
    }
    const { client, actions } = recordingClient(snapshot)
    mount(<IdeasBoard client={client} />)
    click(selectAllButton())
    click(host.querySelector('[data-dsh-ideas-bulk-archive]') as Element)
    click(host.querySelector('[data-dsh-ideas-bulk-submit]') as Element)
    await settle()

    expect(actions).toEqual([])
    expect(host.querySelector('[data-dsh-ideas-bulk-group="skipped"]')?.textContent)
      .toContain(t('bulk.reason.alreadyArchived'))
    expect(host.querySelector('[data-dsh-ideas-bulk-undo]')).toBeNull()
  })
})

describe('bulk copy ships in every dictionary', () => {
  it('has no empty key in the English dictionary', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('bulk.'))
    expect(keys.length).toBeGreaterThan(30)
    for (const key of keys) expect(typeof en[key as keyof typeof en]).toBe('string')
    expect(keys.every(key => (en as Record<string, string>)[key] !== '')).toBe(true)
  })
})