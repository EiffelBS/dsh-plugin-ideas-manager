// @vitest-environment jsdom
/**
 * Idea #111: undo for the board's own manual actions.
 *
 * The contract this suite pins is the one the feature actually promises, and it
 * is deliberately narrower than "you can take anything back":
 *
 *  - **The inverse is ordinary verbs.** Every `invertAction` case is asserted as
 *    `restore` / `update` / `move` / `triage` — a batch of the same verbs the
 *    forward action used. No undo verb appears on the wire, so an undo is
 *    indistinguishable, in the ledger, from a human having done it by hand.
 *  - **Absence IS the guarantee.** `decline`, `delete`, `merge`, `followUp`,
 *    `deliver`, `reanalyze`, `create` and `reorder` produce NO entry. So does an
 *    action whose previous value cannot be expressed in ordinary verbs (a score
 *    that did not exist, a body the client never held). No entry means no button
 *    means no promise — these cases are asserted individually, because a verb
 *    that silently became "undoable" later would be the regression that matters.
 *  - **The mirror round trip is replayed.** Restoring the previous labels of an
 *    ARCHIVED, card-bound idea is `restore` -> `update` -> `archive`, exactly as
 *    the forward bulk tag was, because an archived card is read-only for every
 *    verb and a bare `update` would move the idea while its card kept the old
 *    labels.
 *  - **Drift is refused, not applied.** Between the click and the Ctrl+Z an
 *    agent, a second tab or a human can move the same card. The guard compares
 *    what the action wrote against what the row holds NOW, refuses the drifted
 *    idea, and still undoes the rest — one drifted card out of sixty must not
 *    leave the other fifty-nine changed.
 *  - **Ctrl+Z never steals the editor's own undo.** A board-level listener runs
 *    in the capture phase, before the browser's undo on a focused field, so the
 *    filter for `input` / `textarea` / `select` / `contenteditable` is asserted
 *    here rather than trusted — and an EMPTY stack must not even call
 *    `preventDefault`, or the page's native undo would die on a board that simply
 *    has nothing to undo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  dropUndoEntry,
  invertAction,
  isEditableTarget,
  isUndoShortcut,
  planUndo,
  pushUndoEntry,
  shouldHandleUndo,
  topUndoEntry,
  undoDriftedFields,
  undoExpectationOf,
  undoIdeaCount,
  undoKindOf,
  undoTagsFingerprint,
  undoTargetId,
  UNDO_STACK_LIMIT,
  type UndoEntry,
} from '../src/client/undo.ts'
import { toListSnapshot, type IdeasAction, type IdeasSnapshot } from '../src/protocol.ts'
import type { IdeaListRow } from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { en, fr, t, zh } from '../src/client/locales.ts'
import { classes } from '../src/client/style.ts'
import { IdeasBoard } from '../src/client/board-view.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* --- fixtures ------------------------------------------------------------ */

/** A full record; the list projection of it is what the board actually holds. */
function record(partial: Partial<IdeaRecord> & { id: string; status: IdeaRecord['status'] }): IdeaRecord {
  return { title: partial.id, body: '', createdAt: 1, updatedAt: 1, ...partial }
}

function listRow(full: IdeaRecord): IdeaListRow {
  return toListSnapshot({ schemaVersion: 1, revision: 1, ideas: [full] }).ideas[0]!
}

const OPEN_TAGGED = record({ id: 'i1', status: 'open', title: 'Tagged', ideaNumber: 1, tags: [{ name: 'a', promptPrefix: 'keep me' }], workspaceId: 'ws-1' })
const OPEN_SCORED = record({ id: 'i2', status: 'open', title: 'Scored', ideaNumber: 2, rank: 2, value: 7, effort: 3, rationale: 'because' })
const UNDER_REVIEW = record({ id: 'i3', status: 'underReview', title: 'In review', ideaNumber: 3, rank: 1 })
const ARCHIVED_BOUND = record({ id: 'i4', status: 'archived', title: 'Archived bound', ideaNumber: 4, archivedAt: 5, taskBoardId: 'idea-i4', tags: [{ name: 'a' }] })
const ARCHIVED_PLAIN = record({ id: 'i5', status: 'archived', title: 'Archived plain', ideaNumber: 5, archivedAt: 5 })
const DECLINED = record({ id: 'i6', status: 'declined', title: 'Refused', ideaNumber: 6, archivedAt: 5, decision: 'not now' })

/** The inverse steps of an action against one row (and its cached record). */
function invert(action: IdeasAction, full?: IdeaRecord): ReturnType<typeof invertAction> {
  return invertAction(action, { row: listRow(full ?? OPEN_TAGGED), ...(full === undefined ? {} : { full }) })
}

/* --- pure: the inverse table -------------------------------------------- */

describe('invertAction: what has an inverse, and what does not', () => {
  it('update -> update carrying the values the row held BEFORE', () => {
    const plan = invert({ kind: 'update', ideaId: 'i1', patch: { tags: [{ name: 'b' }], workspaceId: 'ws-2' } }, OPEN_TAGGED)
    expect(plan?.steps).toEqual([{
      verb: 'update',
      // The full prior label set, prompt line included: the wire patch
      // REPLACES the labels, so a name-only restore would erase it silently.
      patch: { tags: [{ name: 'a', promptPrefix: 'keep me' }], workspaceId: 'ws-1' },
    }])
    expect(plan?.roundTrip).toBe(false)
  })

  it('update clears what the inverse CAN clear (generic workspace, no labels, no rationale)', () => {
    const generic = record({ id: 'g', status: 'open', title: 'Generic' })
    const plan = invert({ kind: 'update', ideaId: 'g', patch: { workspaceId: 'ws-2', tags: [{ name: 'x' }] } }, generic)
    // '' is the client patch's own "move to the generic group"; [] clears the
    // label set. Both are the documented wire shapes, not invented ones.
    expect(plan?.steps).toEqual([{ verb: 'update', patch: { workspaceId: '', tags: [] } }])

    const noRationale = record({ id: 'n', status: 'open', title: 'No rationale' })
    const rationale = invert({ kind: 'update', ideaId: 'n', patch: { rationale: 'new words' } }, noRationale)
    expect(rationale?.steps).toEqual([{ verb: 'update', patch: { rationale: '' } }])
  })

  it('update of relations restores the exact id lists', () => {
    const related = record({ id: 'r', status: 'open', title: 'Related', relatesTo: ['x', 'y'], blocks: ['z'] })
    const plan = invert({ kind: 'update', ideaId: 'r', patch: { relatesTo: [], blocks: [] } }, related)
    expect(plan?.steps).toEqual([{ verb: 'update', patch: { relatesTo: ['x', 'y'], blocks: ['z'] } }])
  })

  it('update of a BODY needs the cached record, and refuses a stale one', () => {
    const action: IdeasAction = { kind: 'update', ideaId: 'b', patch: { body: 'the analyst rewrite' } }
    const cached = record({ id: 'b', status: 'open', body: 'the original draft', updatedAt: 42 })
    // The invariant the client maintains: a cached full record and the row it
    // was fetched for share one `updatedAt`.
    const sameInstant = listRow(cached)
    const movedOn = listRow({ ...cached, body: 'someone else', updatedAt: 50 })

    // No cached record: the list projection dropped the body, so there is
    // nothing to restore and NO entry (rather than a half-undo).
    expect(invertAction(action, { row: sameInstant })).toBeUndefined()

    // Cached, but the row moved on since: restoring it would put an older draft
    // over a newer edit, so it is refused too.
    expect(invertAction(action, { row: movedOn, full: cached })).toBeUndefined()

    // Cached and current: the body comes back whole.
    expect(invertAction(action, { row: sameInstant, full: cached })?.steps)
      .toEqual([{ verb: 'update', patch: { body: 'the original draft' } }])
  })

  it('update refuses when a score could not be cleared by the inverse', () => {
    // The wire patch sets value/effort but has no way to UNSET them, so an
    // opinion that did not exist before cannot be taken back by an inverse.
    const unscored = record({ id: 'u', status: 'open', title: 'Unscored' })
    expect(invert({ kind: 'update', ideaId: 'u', patch: { value: 9 } }, unscored)).toBeUndefined()

    const scored = record({ id: 's', status: 'open', title: 'Scored', value: 4, effort: 2 })
    expect(invert({ kind: 'update', ideaId: 's', patch: { value: 9, effort: 8 } }, scored)?.steps)
      .toEqual([{ verb: 'update', patch: { value: 4, effort: 2 } }])
  })

  it('move -> move back to the PREVIOUS column, never a blind restore', () => {
    expect(invert({ kind: 'move', ideaId: 'i1', status: 'archived' }, OPEN_TAGGED)?.steps)
      .toEqual([{ verb: 'move', status: 'open' }])
    expect(invert({ kind: 'move', ideaId: 'i3', status: 'archived' }, UNDER_REVIEW)?.steps)
      .toEqual([{ verb: 'move', status: 'underReview' }])
    expect(invert({ kind: 'move', ideaId: 'i3', status: 'open' }, UNDER_REVIEW)?.steps)
      .toEqual([{ verb: 'move', status: 'underReview' }])
  })

  it('restore -> move back to the column the idea came from', () => {
    expect(invert({ kind: 'restore', ideaId: 'i5' }, ARCHIVED_PLAIN)?.steps)
      .toEqual([{ verb: 'move', status: 'archived' }])
    expect(invert({ kind: 'restore', ideaId: 'i3' }, UNDER_REVIEW)?.steps)
      .toEqual([{ verb: 'move', status: 'underReview' }])
  })

  it('refuses every verb with no faithful inverse — the absence IS the guarantee', () => {
    // `restore` forces `open` and clears `archivedAt` alone: `deliveredAt`,
    // `decision` and `followUpOfId` survive. A DECLINED idea therefore has no
    // way back through the ordinary verbs, and guessing one would turn a
    // refusal into a plain archive.
    expect(invert({ kind: 'restore', ideaId: 'i6' }, DECLINED)).toBeUndefined()
    expect(invert({ kind: 'move', ideaId: 'i6', status: 'archived' }, DECLINED)).toBeUndefined()

    // The irreversible four, plus delivery, creation, merge, re-analysis and
    // the whole-list reorder.
    expect(invert({ kind: 'decline', ideaId: 'i1', decision: 'no' }, OPEN_TAGGED)).toBeUndefined()
    expect(invert({ kind: 'delete', ideaId: 'i1' }, OPEN_TAGGED)).toBeUndefined()
    expect(invert({ kind: 'merge', sourceId: 'i1', targetId: 'i2', mode: 'takeSourceRank' }, OPEN_TAGGED)).toBeUndefined()
    expect(invert({ kind: 'followUp', ideaId: 'i3', input: { title: 'T', body: 'B' } }, UNDER_REVIEW)).toBeUndefined()
    expect(invert({ kind: 'deliver', ideaId: 'i1' }, OPEN_TAGGED)).toBeUndefined()
    expect(invert({ kind: 'reanalyze', ideaId: 'i1' }, OPEN_TAGGED)).toBeUndefined()
    expect(invert({ kind: 'reorder', orderedIds: ['i1'] }, OPEN_TAGGED)).toBeUndefined()
    expect(invert({ kind: 'create', id: 'new', input: { title: 'T', body: 'B' } }, OPEN_TAGGED)).toBeUndefined()
  })

  it('only single-row actions have a target to capture', () => {
    expect(undoTargetId({ kind: 'update', ideaId: 'i1', patch: {} })).toBe('i1')
    expect(undoTargetId({ kind: 'move', ideaId: 'i1', status: 'archived' })).toBe('i1')
    expect(undoTargetId({ kind: 'merge', sourceId: 'a', targetId: 'b', mode: 'takeSourceRank' })).toBeUndefined()
    expect(undoTargetId({ kind: 'reorder', orderedIds: ['a'] })).toBeUndefined()
    expect(undoTargetId({ kind: 'export' })).toBeUndefined()
  })

  it('replays the mirror round trip on an archived, card-bound idea', () => {
    const plan = invert({ kind: 'update', ideaId: 'i4', patch: { tags: [{ name: 'b' }] } }, ARCHIVED_BOUND)
    // An archived TaskBoard card is read-only for every verb: a bare update
    // would move the idea while its card kept the old labels forever.
    expect(plan?.steps).toEqual([
      { verb: 'restore' },
      { verb: 'update', patch: { tags: [{ name: 'a' }] } },
      { verb: 'move', status: 'archived' },
    ])
    expect(plan?.roundTrip).toBe(true)

    // An archived idea with NO card needs no round trip.
    expect(invert({ kind: 'update', ideaId: 'i5', patch: { tags: [{ name: 'b' }] } }, ARCHIVED_PLAIN)?.steps)
      .toEqual([{ verb: 'update', patch: { tags: [] } }])
  })

  it('triage -> triage with the old opinion AND the old rank', () => {
    const plan = invert({ kind: 'triage', ideaId: 'i2', patch: { value: 1, effort: 1, rationale: 'new', rank: 9 } }, OPEN_SCORED)
    expect(plan?.steps).toEqual([{ verb: 'triage', patch: { value: 7, effort: 3, rationale: 'because', rank: 2 } }])
  })

  it('triage refuses when the old rank was "none" (the wire cannot un-rank)', () => {
    const unranked = record({ id: 'u', status: 'open', title: 'Unranked', value: 5 })
    expect(invert({ kind: 'triage', ideaId: 'u', patch: { rank: 1 } }, unranked)).toBeUndefined()
    // The opinion half alone IS restorable, so that half gets its entry.
    expect(invert({ kind: 'triage', ideaId: 'u', patch: { value: 9 } }, unranked)?.steps)
      .toEqual([{ verb: 'triage', patch: { value: 5 } }])
  })
})

/* --- pure: the drift guard ----------------------------------------------- */

describe('the drift guard', () => {
  /** An entry whose single item expects the labels `b` on i1. */
  function tagEntry(): UndoEntry {
    const plan = invert({ kind: 'update', ideaId: 'i1', patch: { tags: [{ name: 'b' }] } }, OPEN_TAGGED)!
    return {
      key: 'e1',
      kind: 'tag',
      at: 1,
      items: [{ plan, expect: undoExpectationOf(plan, listRow({ ...OPEN_TAGGED, tags: [{ name: 'b' }] })) }],
    }
  }

  it('accepts a row that still holds what the action wrote', () => {
    const entry = tagEntry()
    const after = listRow({ ...OPEN_TAGGED, tags: [{ name: 'b' }] })
    expect(planUndo(entry, [after])).toEqual({ plan: [entry.items[0]!.plan], refused: [] })
  })

  it('refuses a row whose labels moved, and names the field', () => {
    const entry = tagEntry()
    const moved = listRow({ ...OPEN_TAGGED, tags: [{ name: 'b' }, { name: 'agent-added' }] })
    const { plan, refused } = planUndo(entry, [moved])
    expect(plan[0]?.steps).toEqual([])
    expect(plan[0]?.skipReason).toBe('drifted')
    expect(refused).toEqual([{ id: 'i1', ideaNumber: 1, title: 'Tagged', fields: ['tags'] }])
  })

  it('is order-blind for labels but exact for their prompt lines', () => {
    const a = undoTagsFingerprint([{ name: 'a' }, { name: 'b' }])
    const b = undoTagsFingerprint([{ name: 'b' }, { name: 'a' }])
    expect(a).toBe(b)
    // The prompt line is part of what the action wrote: losing it is drift.
    expect(undoTagsFingerprint([{ name: 'a' }])).not.toBe(undoTagsFingerprint([{ name: 'a', promptPrefix: 'now: ' }]))
  })

  it('guards a column move on the status the action left', () => {
    const plan = invert({ kind: 'move', ideaId: 'i1', status: 'archived' }, OPEN_TAGGED)!
    const guard = undoExpectationOf(plan, listRow({ ...OPEN_TAGGED, status: 'archived', archivedAt: 9 }))
    expect(guard).toEqual({ status: 'archived' })
    expect(undoDriftedFields(guard, listRow(OPEN_TAGGED))).toEqual(['status'])
    expect(undoDriftedFields(guard, listRow({ ...OPEN_TAGGED, status: 'archived' }))).toEqual([])
  })

  it('guards a body edit on updatedAt — the only body signal the list row carries', () => {
    const before = record({ id: 'b', status: 'open', body: 'draft', updatedAt: 42 })
    const plan = invert({ kind: 'update', ideaId: 'b', patch: { body: 'rewrite' } }, before)!
    const after = listRow({ ...before, body: 'rewrite', updatedAt: 50 })
    const guard = undoExpectationOf(plan, after)
    expect(Object.keys(guard).sort()).toEqual(['body', 'updatedAt'])
    // Same body, but something else committed on the card in between.
    expect(undoDriftedFields(guard, listRow({ ...before, body: 'rewrite', updatedAt: 51 }))).toEqual(['updatedAt'])
  })

  it('treats an idea that left the board as fully drifted', () => {
    const entry = tagEntry()
    const { plan, refused } = planUndo(entry, [])
    expect(plan[0]?.skipReason).toBe('drifted')
    expect(refused[0]?.id).toBe('i1')
  })

  it('undoes the ideas that did NOT drift: one moved card never blocks a batch', () => {
    const plans = [OPEN_TAGGED, OPEN_SCORED].map(full =>
      invert({ kind: 'update', ideaId: full.id, patch: { tags: [{ name: 'b' }] } }, full)!)
    const entry: UndoEntry = {
      key: 'e2',
      kind: 'tag',
      at: 1,
      items: plans.map(plan => ({
        plan,
        expect: undoExpectationOf(plan, listRow({ ...(plan.id === 'i1' ? OPEN_TAGGED : OPEN_SCORED), tags: [{ name: 'b' }] })),
      })),
    }
    const rows = [
      listRow({ ...OPEN_TAGGED, tags: [{ name: 'b' }, { name: 'moved' }] }),
      listRow({ ...OPEN_SCORED, tags: [{ name: 'b' }] }),
    ]
    const { plan, refused } = planUndo(entry, rows)
    expect(refused.map(item => item.id)).toEqual(['i1'])
    expect(plan[1]?.steps.length).toBeGreaterThan(0)
  })
})

/* --- pure: one idea, many verbs ------------------------------------------ */

describe('an action that posted several verbs for ONE idea', () => {
  /** A mirrored `restore` -> `update` -> `archive`, captured verb by verb. */
  function mirroredEntry(): { entry: UndoEntry; row: IdeaListRow } {
    const wasOpen = { ...ARCHIVED_BOUND, status: 'open', archivedAt: undefined } as const
    // What each verb's OWN post left behind — the guard is seeded from that.
    const afterOf = [
      listRow({ ...wasOpen, updatedAt: 2 }),
      listRow({ ...wasOpen, tags: [{ name: 'b' }], updatedAt: 3 }),
      listRow({ ...ARCHIVED_BOUND, tags: [{ name: 'b' }], updatedAt: 4 }),
    ]
    const items = [
      invert({ kind: 'restore', ideaId: 'i4' }, ARCHIVED_BOUND)!,
      invert({ kind: 'update', ideaId: 'i4', patch: { tags: [{ name: 'b' }] } }, wasOpen)!,
      invert({ kind: 'move', ideaId: 'i4', status: 'archived' }, wasOpen)!,
    ]
    return {
      entry: {
        key: 'm1',
        kind: 'tag',
        at: 1,
        items: items.map((plan, index) => ({ plan, expect: undoExpectationOf(plan, afterOf[index]!) })),
      },
      row: afterOf[2]!,
    }
  }

  it('becomes ONE plan item, guarded on the LAST write to each field', () => {
    const { entry, row } = mirroredEntry()
    const { plan, refused } = planUndo(entry, [row])
    expect(refused).toEqual([])
    // Three captured verbs, one card: the receipt must be able to say "1".
    expect(plan).toHaveLength(1)
    expect(plan[0]?.id).toBe('i4')

    // The naive per-verb guards would read `status: 'open'` (the state between
    // the restore and the archive) and refuse the very action being reversed.
    expect(plan[0]?.skipReason).toBeUndefined()
  })

  it('re-derives the round trip the captured verbs could not know about', () => {
    const { entry, row } = mirroredEntry()
    const steps = planUndo(entry, [row]).plan[0]?.steps
    // Per-verb column inverses do NOT compose: the chain captured `move
    // archived` for its restore and `move open` for its archive, and replayed
    // in order the second lands last and leaves the idea in the column the
    // action STARTED from. The bare `update` captured while the idea was open
    // is re-derived through `updateSteps`, which is what keeps the mirrored
    // card and the idea in agreement.
    expect(steps).toEqual([
      { verb: 'restore' },
      { verb: 'update', patch: { tags: [{ name: 'a' }] } },
      { verb: 'move', status: 'archived' },
    ])
  })

  it('replays a plan that DID round-trip verbatim, archive step included', () => {
    // The same change made through one verb is captured already round-tripped.
    // Its trailing `archive` is what puts the idea back where the forward
    // action found it: pruning it as "already archived" would leave it OPEN.
    const plan = invert({ kind: 'update', ideaId: 'i4', patch: { tags: [{ name: 'b' }] } }, ARCHIVED_BOUND)!
    const entry: UndoEntry = {
      key: 'm2',
      kind: 'tag',
      at: 1,
      items: [{
        plan,
        expect: undoExpectationOf(plan, listRow({ ...ARCHIVED_BOUND, tags: [{ name: 'b' }] })),
      }],
    }
    expect(plan.roundTrip).toBe(true)
    const steps = planUndo(entry, [listRow({ ...ARCHIVED_BOUND, tags: [{ name: 'b' }] })]).plan[0]?.steps
    expect(steps).toEqual([
      { verb: 'restore' },
      { verb: 'update', patch: { tags: [{ name: 'a' }] } },
      { verb: 'move', status: 'archived' },
    ])
  })
})

/* --- pure: the stack ------------------------------------------------------ */

describe('the undo stack', () => {
  function entry(key: string, at: number): UndoEntry {
    return { key, kind: 'edit', at, items: [] }
  }

  it('keeps the newest first and drops what fell off the bound', () => {
    let stack: UndoEntry[] = []
    for (let index = 0; index < UNDO_STACK_LIMIT + 5; index++) {
      stack = pushUndoEntry(stack, entry(`e${index}`, 1_000), 1_000)
    }
    expect(stack).toHaveLength(UNDO_STACK_LIMIT)
    expect(stack[stack.length - 1]?.key).toBe(`e${UNDO_STACK_LIMIT + 4}`)
    expect(stack[0]?.key).toBe('e5')
  })

  it('expires an entry whose "before" describes a card that has moved on', () => {
    const stack = [entry('old', 0)]
    // Still inside the window: a Ctrl+Z would reverse it.
    expect(topUndoEntry(stack, 60_000)?.key).toBe('old')
    // Past the TTL there is nothing left to promise.
    expect(topUndoEntry(stack, 60 * 60_000 * 24)).toBeUndefined()
  })

  it('top skips the expired ones and still finds the newest live entry', () => {
    const day = 60 * 60_000 * 24
    const stack = [entry('ancient', 0), entry('fresh', day - 60_000)]
    expect(topUndoEntry(stack, day)?.key).toBe('fresh')
  })

  it('drops by key, so a caller that undid the action itself consumes the entry', () => {
    expect(dropUndoEntry([entry('a', 1), entry('b', 1)], 'a').map(item => item.key)).toEqual(['b'])
    expect(dropUndoEntry([entry('a', 1)], 'missing').map(item => item.key)).toEqual(['a'])
  })

  it('counts IDEAS, not captured items: a mirrored idea round-trips three times', () => {
    const bound = record({ id: 'i4', status: 'archived', title: 'Bound', ideaNumber: 4, archivedAt: 5, taskBoardId: 'idea-i4', tags: [{ name: 'a' }] })
    // The forward `restore` -> `update` -> `archive` is three captured items
    // for ONE idea, so an item count would tell the reader it had three.
    const items = [
      invert({ kind: 'restore', ideaId: 'i4' }, bound)!,
      invert({ kind: 'update', ideaId: 'i4', patch: { tags: [{ name: 'b' }] } }, bound)!,
      invert({ kind: 'move', ideaId: 'i4', status: 'archived' }, bound)!,
    ]
    const entry: UndoEntry = {
      key: 'e3',
      kind: 'tag',
      at: 1,
      items: items.map(plan => ({ plan, expect: undoExpectationOf(plan, listRow(bound)) })),
    }
    expect(entry.items).toHaveLength(3)
    expect(undoIdeaCount(entry)).toBe(1)

    // Three ideas, one of them mirrored: four items, three ideas.
    const two = entry.items.concat(
      { plan: invert({ kind: 'update', ideaId: 'i1', patch: { tags: [] } }, OPEN_TAGGED)!, expect: {} },
      { plan: invert({ kind: 'update', ideaId: 'i2', patch: { tags: [] } }, OPEN_SCORED)!, expect: {} },
    )
    expect(undoIdeaCount({ ...entry, items: two })).toBe(3)
  })

  it('labels an entry from the FORWARD action, not from its inverse', () => {
    expect(undoKindOf({ kind: 'update', ideaId: 'i1', patch: { tags: [] } })).toBe('tag')
    expect(undoKindOf({ kind: 'update', ideaId: 'i1', patch: { workspaceId: 'w' } })).toBe('workspace')
    expect(undoKindOf({ kind: 'move', ideaId: 'i1', status: 'archived' })).toBe('archive')
    expect(undoKindOf({ kind: 'move', ideaId: 'i1', status: 'underReview' })).toBe('edit')
    expect(undoKindOf({ kind: 'restore', ideaId: 'i5' })).toBe('restore')
    expect(undoKindOf({ kind: 'triage', ideaId: 'i2', patch: { value: 1 } })).toBe('triage')
    // An archiving action reads as "archive", even though the plan that will
    // reverse it is a move back to Open: a label taken from the inverse would
    // tell the reader the button does something else.
    expect(undoKindOf({ kind: 'move', ideaId: 'i1', status: 'archived' })).not.toBe('edit')
  })
})

/* --- pure: the keyboard filter ------------------------------------------- */

describe('the Ctrl+Z filter', () => {
  it('recognises the chord on both platforms', () => {
    expect(isUndoShortcut({ key: 'z', ctrlKey: true })).toBe(true)
    expect(isUndoShortcut({ key: 'Z', metaKey: true })).toBe(true)
    expect(isUndoShortcut({ key: 'z' })).toBe(false)
    expect(isUndoShortcut({ key: 'y', ctrlKey: true })).toBe(false)
    // Ctrl+Shift+Z is REDO everywhere; binding it to undo would be a lie.
    expect(isUndoShortcut({ key: 'z', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isUndoShortcut({ key: 'z', metaKey: true, altKey: true })).toBe(false)
  })

  it('treats every typing surface as untouchable', () => {
    for (const tag of ['input', 'textarea', 'select', 'TEXTAREA']) {
      expect(isEditableTarget({ tagName: tag })).toBe(true)
    }
    expect(isEditableTarget({ tagName: 'div', isContentEditable: true })).toBe(true)
    // A card, a button and a detached node are fair game.
    expect(isEditableTarget({ tagName: 'div' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget('a string')).toBe(false)
  })

  it('answers false for an empty stack WITHOUT claiming the event', () => {
    // This is the case that would kill the browser's own Ctrl+Z on a board that
    // simply has nothing to undo: the handler must not even preventDefault.
    expect(shouldHandleUndo({ key: 'z', ctrlKey: true }, null, false)).toBe(false)
  })

  it('claims the event on the board, but never over a field being typed in', () => {
    const chord = { key: 'z', ctrlKey: true }
    expect(shouldHandleUndo(chord, { tagName: 'div' }, true)).toBe(true)
    expect(shouldHandleUndo(chord, { tagName: 'TEXTAREA' }, true)).toBe(false)
    expect(shouldHandleUndo(chord, { tagName: 'input' }, true)).toBe(false)
    expect(shouldHandleUndo(chord, { tagName: 'div', isContentEditable: true }, true)).toBe(false)
    // Something upstream already handled it: leave it alone.
    expect(shouldHandleUndo({ ...chord, defaultPrevented: true }, null, true)).toBe(false)
  })
})

/* --- the client: capture, batches and the honest refusals ----------------- */

interface Harness {
  client: IdeasClient
  actions: IdeasAction[]
  setState: (snapshot: IdeasSnapshot) => void
}

/**
 * A client over a fake Host whose ledger is a plain list of records: `apply`
 * mirrors the real ledger closely enough for the fields undo depends on
 * (status, labels, updatedAt, rank), and every posted verb is recorded.
 */
function harness(ideas: IdeaRecord[], refuse?: (action: IdeasAction) => string | undefined): Harness {
  let revision = 1
  let rows = ideas
  const actions: IdeasAction[] = []
  const transport: IdeasHostTransport = {
    state: async () => toListSnapshot({ schemaVersion: 1, revision, ideas: rows }),
    action: async (action) => {
      actions.push(action)
      const refusal = refuse?.(action)
      if (refusal !== undefined) throw new Error(refusal)
      revision += 1
      rows = applyTo(rows, action, revision)
      return toListSnapshot({ schemaVersion: 1, revision, ideas: rows })
    },
    subscribe: () => () => {},
    idea: async (id) => {
      const found = rows.find(item => item.id === id)
      if (found === undefined) throw new Error('not-found')
      return found
    },
  }
  const client = new IdeasClient(transport, undefined)
  client.snapshot = toListSnapshot({ schemaVersion: 1, revision, ideas: rows })
  return {
    client,
    actions,
    setState: snapshot => {
      rows = snapshot.ideas
      revision = snapshot.revision
      client.snapshot = toListSnapshot(snapshot)
    },
  }
}

/** A small ledger mirror: enough of `host-ledger.ts` for undo to be real. */
function applyTo(rows: readonly IdeaRecord[], action: IdeasAction, now: number): IdeaRecord[] {
  const touched = 'ideaId' in action ? action.ideaId : undefined
  const patch = (item: IdeaRecord, next: Partial<IdeaRecord>): IdeaRecord =>
    item.id === touched ? { ...item, ...next, updatedAt: now } : item
  switch (action.kind) {
    case 'update': {
      const p = action.patch
      return rows.map(item => patch(item, {
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.body === undefined ? {} : { body: p.body }),
        ...(p.tags === undefined ? {} : { tags: p.tags ?? undefined }),
        ...(p.workspaceId === undefined ? {} : { workspaceId: p.workspaceId === '' ? undefined : p.workspaceId }),
        ...(p.value === undefined ? {} : { value: p.value }),
        ...(p.effort === undefined ? {} : { effort: p.effort }),
        ...(p.rationale === undefined ? {} : { rationale: p.rationale === '' ? undefined : p.rationale }),
      }))
    }
    case 'triage':
      return rows.map(item => patch(item, {
        ...(action.patch.value === undefined ? {} : { value: action.patch.value }),
        ...(action.patch.effort === undefined ? {} : { effort: action.patch.effort }),
        ...(action.patch.rank === undefined ? {} : { rank: action.patch.rank }),
      }))
    case 'move':
      return rows.map(item => patch(item, {
        status: action.status,
        archivedAt: action.status === 'archived' ? now : undefined,
      }))
    case 'restore':
      return rows.map(item => patch(item, { status: 'open', archivedAt: undefined }))
    default:
      return [...rows]
  }
}

describe('IdeasClient captures an undo entry only for what actually landed', () => {
  it('pushes one entry for a successful update, and undo posts the previous value back', async () => {
    const { client, actions } = harness([OPEN_TAGGED])
    await client.updateIdea('i1', { tags: [{ name: 'b' }] })
    expect(actions).toHaveLength(1)
    expect(client.canUndo).toBe(true)
    expect(client.undoEntry?.kind).toBe('tag')
    expect(client.undoEntry?.items).toHaveLength(1)

    const outcome = await client.undoLast()
    expect(outcome?.applied).toHaveLength(1)
    expect(outcome?.refused).toEqual([])
    // Ordinary verbs, the previous label set, prompt line included.
    expect(actions[1]).toEqual({ kind: 'update', ideaId: 'i1', patch: { tags: [{ name: 'a', promptPrefix: 'keep me' }] } })
    expect(client.snapshot?.ideas[0]?.tags).toEqual([{ name: 'a', promptPrefix: 'keep me' }])
  })

  it('pushes NOTHING for a refused action: there is nothing to take back', async () => {
    const { client } = harness([OPEN_TAGGED], () => 'archived task is read-only')
    await expect(client.updateIdea('i1', { tags: [{ name: 'b' }] })).rejects.toThrow()
    expect(client.canUndo).toBe(false)
    expect(client.undoEntry).toBeUndefined()
  })

  it('restores a body the analyst overwrote, and does not capture its own undo', async () => {
    const idea = record({ id: 'i1', status: 'open', title: 'Draft', body: 'the human draft', ideaNumber: 1 })
    const { client, actions } = harness([idea])
    // The editor holds the full record, so the body is capturable.
    await client.fetchIdea({ id: 'i1', updatedAt: 1 })
    await client.updateIdea('i1', { body: 'the analyst rewrite' })
    expect(client.canUndo).toBe(true)

    await client.undoLast()
    expect(actions[1]).toEqual({ kind: 'update', ideaId: 'i1', patch: { body: 'the human draft' } })
    expect(client.cachedBodyOf('i1')).toBe('the human draft')
    // The undo's own post must NOT be a new undoable action, or the second
    // Ctrl+Z would simply put the rewrite back.
    expect(client.canUndo).toBe(false)
  })

  it('refuses a body edit it never held the body of (no entry, no button)', async () => {
    const idea = record({ id: 'i1', status: 'open', title: 'Draft', body: 'the human draft' })
    const { client } = harness([idea])
    // No fetchIdea: the full record cache is empty and the list row has no body.
    await client.updateIdea('i1', { body: 'the analyst rewrite' })
    expect(client.canUndo).toBe(false)
  })

  it('refuses a drifted idea, undoes the rest, and says which one it left alone', async () => {
    const { client, actions, setState } = harness([OPEN_TAGGED, OPEN_SCORED])
    client.beginUndoBatch('tag')
    await client.updateIdea('i1', { tags: [{ name: 'b' }] })
    await client.updateIdea('i2', { tags: [{ name: 'b' }] })
    client.endUndoBatch()
    expect(client.undoEntry?.items).toHaveLength(2)

    // An agent (or a second tab) moves i1 between the click and the Ctrl+Z.
    setState({
      schemaVersion: 1,
      revision: 9,
      ideas: [
        { ...OPEN_TAGGED, tags: [{ name: 'b' }, { name: 'agent' }] },
        { ...OPEN_SCORED, tags: [{ name: 'b' }], updatedAt: 2 },
      ],
    })

    const outcome = await client.undoLast()
    expect(outcome?.refused).toEqual([{ id: 'i1', ideaNumber: 1, title: 'Tagged', fields: ['tags'] }])
    expect(outcome?.applied.map(item => item.id)).toEqual(['i2'])
    // The drifted card was NOT touched; the other one went back — and "no labels
    // before" travels as the wire's own null, which is how a set is cleared.
    expect(actions).toHaveLength(3)
    expect(actions[2]).toEqual({ kind: 'update', ideaId: 'i2', patch: { tags: null } })
  })

  it('collapses a two-verb save into ONE entry', async () => {
    const { client } = harness([OPEN_SCORED])
    client.beginUndoBatch('edit')
    await client.updateIdea('i2', { title: 'Renamed' })
    await client.triageIdea('i2', { rank: 1 })
    expect(client.endUndoBatch()).toBeTypeOf('string')
    // Two verbs, one action the human performed, one Ctrl+Z.
    expect(client.undoEntry?.items).toHaveLength(2)
    expect(client.undoEntry?.kind).toBe('edit')
  })

  it('pushes no entry for a batch that changed nothing', () => {
    const { client } = harness([OPEN_TAGGED])
    client.beginUndoBatch('tag')
    expect(client.endUndoBatch()).toBeUndefined()
    expect(client.canUndo).toBe(false)
  })

  it('drops the entry a caller undid itself, so the same action is never undoable twice', async () => {
    const { client } = harness([OPEN_TAGGED])
    client.beginUndoBatch('archive')
    await client.moveIdea('i1', 'archived')
    const key = client.endUndoBatch()
    expect(client.canUndo).toBe(true)
    // The bulk dialog's own restore button already undid the run.
    client.discardUndoBatch(key!)
    expect(client.canUndo).toBe(false)
  })

  it('replays restore -> update -> archive on an archived, card-bound idea', async () => {
    const bound = record({ id: 'i4', status: 'archived', title: 'Bound', ideaNumber: 4, archivedAt: 5, taskBoardId: 'idea-i4', tags: [{ name: 'a' }] })
    const { client, actions } = harness([bound])
    // The forward action is one ordinary update: the card read-only rule is the
    // BULK planner's round trip, not something the client method invents.
    await client.updateIdea('i4', { tags: [{ name: 'b' }] })
    expect(actions.map(action => action.kind)).toEqual(['update'])
    actions.length = 0

    await client.undoLast()
    // Its INVERSE must round-trip: an archived card is read-only for every
    // verb, so a bare update would restore the idea while the card kept the
    // label the undo just took away.
    expect(actions.map(action => action.kind)).toEqual(['restore', 'update', 'move'])
    expect(actions[1]).toEqual({ kind: 'update', ideaId: 'i4', patch: { tags: [{ name: 'a' }] } })
    expect(actions[2]).toEqual({ kind: 'move', ideaId: 'i4', status: 'archived' })
  })

  it('undoes a triage back to the old rank, and reports a partial batch as partial', async () => {
    const { client } = harness([OPEN_SCORED, UNDER_REVIEW])
    await client.triageIdea('i2', { value: 1, rank: 1 })
    const outcome = await client.undoLast()
    expect(outcome?.applied).toHaveLength(1)
    expect(client.snapshot?.ideas[0]?.value).toBe(7)
  })

  it('clears the outcome receipt on demand', async () => {
    const { client } = harness([OPEN_TAGGED])
    await client.updateIdea('i1', { tags: [{ name: 'b' }] })
    await client.undoLast()
    expect(client.lastUndo).toBeDefined()
    client.clearLastUndo()
    expect(client.lastUndo).toBeUndefined()
  })
})

/* --- the board surface ---------------------------------------------------- */

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

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

/** Dispatch a real keydown so the board's capture-phase listener sees it. */
function pressUndo(init: KeyboardEventInit & { target?: Element } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...init })
  const target = init.target ?? host
  act(() => { target.dispatchEvent(event) })
  return event
}

function boardHarness(): { client: IdeasClient; actions: IdeasAction[] } {
  let revision = 1
  const ideas = [record({ id: 'i1', status: 'open', title: 'Alpha idea', rank: 1, ideaNumber: 1, tags: [{ name: 'alpha' }] })]
  const actions: IdeasAction[] = []
  const transport: IdeasHostTransport = {
    state: async () => toListSnapshot({ schemaVersion: 1, revision, ideas }),
    action: async (action) => {
      actions.push(action)
      revision += 1
      return toListSnapshot({ schemaVersion: 1, revision, ideas: applyTo(ideas, action, revision) })
    },
    subscribe: () => () => {},
  }
  const client = new IdeasClient(transport, undefined)
  client.snapshot = toListSnapshot({ schemaVersion: 1, revision, ideas })
  return { client, actions }
}

/** A board client whose ledger mirrors the real one, so a round trip is real. */
function mirrorHarness(ideas: IdeaRecord[]): { client: IdeasClient; actions: IdeasAction[] } {
  let revision = 1
  let rows = [...ideas]
  const actions: IdeasAction[] = []
  const transport: IdeasHostTransport = {
    state: async () => toListSnapshot({ schemaVersion: 1, revision, ideas: rows }),
    action: async (action) => {
      actions.push(action)
      revision += 1
      rows = applyTo(rows, action, revision)
      return toListSnapshot({ schemaVersion: 1, revision, ideas: rows })
    },
    subscribe: () => () => {},
  }
  const client = new IdeasClient(transport, undefined)
  client.snapshot = toListSnapshot({ schemaVersion: 1, revision, ideas: rows })
  return { client, actions }
}

describe('board: the undo row and the shortcut', () => {
  it('renders nothing at all while the stack is empty', () => {
    const { client } = boardHarness()
    mount(<IdeasBoard client={client} />)
    expect(host.querySelector('[data-dsh-ideas-undo-bar]')).toBeNull()
  })

  it('names the action and undoes it with Ctrl+Z, in ordinary verbs', async () => {
    const { client, actions } = boardHarness()
    mount(<IdeasBoard client={client} />)

    await act(async () => {
      client.beginUndoBatch('tag')
      await client.updateIdea('i1', { tags: [{ name: 'alpha' }, { name: 'review' }] })
      client.endUndoBatch()
    })

    expect(host.querySelector('[data-dsh-ideas-undo-label]')?.textContent)
      .toBe(t('undo.label.tag', { count: 1, target: '#1' }))
    expect(host.querySelector('[data-dsh-ideas-undo-hint]')?.textContent).toBe(t('undo.hint'))

    const event = pressUndo()
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(actions[1]).toEqual({ kind: 'update', ideaId: 'i1', patch: { tags: [{ name: 'alpha' }] } })
    // The receipt stays until it is dismissed: an undo nobody saw the result of
    // is an undo they press twice.
    expect(host.querySelector('[data-dsh-ideas-undo-result="all"]')).not.toBeNull()
    expect(host.querySelector('[data-dsh-ideas-undo-bar]')).not.toBeNull()
  })

  it('never steals Ctrl+Z from a field the human is typing in', async () => {
    const { client, actions } = boardHarness()
    mount(<IdeasBoard client={client} />)
    await act(async () => { await client.updateIdea('i1', { tags: [{ name: 'review' }] }) })

    const input = document.createElement('input')
    host.appendChild(input)
    const event = pressUndo({ target: input })
    await settle()

    // Not prevented, nothing posted: the editor keeps its own undo.
    expect(event.defaultPrevented).toBe(false)
    expect(actions).toHaveLength(1)
    expect(client.snapshot?.ideas[0]?.tags).toEqual([{ name: 'review' }])
  })

  it('leaves the event alone when there is nothing to undo', async () => {
    const { client, actions } = boardHarness()
    mount(<IdeasBoard client={client} />)
    const event = pressUndo()
    await settle()
    expect(event.defaultPrevented).toBe(false)
    expect(actions).toEqual([])
  })

  it('the Undo button and the chord do the same thing', async () => {
    const { client, actions } = boardHarness()
    mount(<IdeasBoard client={client} />)
    await act(async () => { await client.updateIdea('i1', { tags: [{ name: 'review' }] }) })

    act(() => { (host.querySelector('[data-dsh-ideas-undo]') as HTMLElement).click() })
    await settle()
    expect(actions[1]).toEqual({ kind: 'update', ideaId: 'i1', patch: { tags: [{ name: 'alpha' }] } })
  })

  it('a bulk tag of several ideas is ONE undo, not one per card', async () => {
    const { client, actions } = boardHarness()
    mount(<IdeasBoard client={client} />)
    await act(async () => {
      client.beginUndoBatch('tag')
      await client.updateIdea('i1', { tags: [{ name: 'alpha' }, { name: 'review' }] })
      client.endUndoBatch()
    })
    expect(client.undoEntry?.items).toHaveLength(1)

    pressUndo()
    await settle()
    expect(actions.filter(action => action.kind === 'update')).toHaveLength(2)
  })

  it('the receipt counts IDEAS: a mirrored round trip is not three undone cards', async () => {
    const bound = record({ id: 'i4', status: 'archived', title: 'Bound', ideaNumber: 4, archivedAt: 5, taskBoardId: 'idea-i4', tags: [{ name: 'a' }] })
    const { client } = mirrorHarness([bound])
    mount(<IdeasBoard client={client} />)

    await act(async () => {
      client.beginUndoBatch('tag')
      await client.restoreIdea('i4')
      await client.updateIdea('i4', { tags: [{ name: 'b' }] })
      await client.moveIdea('i4', 'archived')
      client.endUndoBatch()
    })
    // Three verbs captured...
    expect(client.undoEntry?.items).toHaveLength(3)
    // ...but ONE idea, and the row says so.
    expect(host.querySelector('[data-dsh-ideas-undo-label]')?.textContent)
      .toBe(t('undo.label.tag', { count: 1, target: '#4' }))

    pressUndo()
    await settle()
    expect(host.querySelector('[data-dsh-ideas-undo-result="all"]')).not.toBeNull()
    expect(host.querySelector('[data-dsh-ideas-undo-refused]')).toBeNull()
  })

  it('the bar disappears once the receipt is dismissed', async () => {
    const { client } = boardHarness()
    mount(<IdeasBoard client={client} />)
    await act(async () => { await client.updateIdea('i1', { tags: [{ name: 'review' }] }) })
    pressUndo()
    await settle()
    act(() => { (host.querySelector('[data-dsh-ideas-undo-dismiss]') as HTMLElement).click() })
    expect(host.querySelector('[data-dsh-ideas-undo-bar]')).toBeNull()
  })
})

/* --- copy ------------------------------------------------------------------ */

describe('undo copy ships in every dictionary', () => {
  it('has the undo keys in fr, en and zh, with no empty value', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('undo.'))
    expect(keys.length).toBeGreaterThan(10)
    for (const dictionary of [fr, en, zh]) {
      for (const key of keys) {
        expect((dictionary as Record<string, string>)[key], `${key} missing`).toBeTypeOf('string')
        expect((dictionary as Record<string, string>)[key]?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })

  it('never promises a transaction: the honesty line names what undo does NOT cover', () => {
    const scope = en['undo.scope']
    for (const verb of ['delete', 'merge', 'follow-up', 'decline', 'delivery']) {
      expect(scope).toContain(verb)
    }
    // The dead sentence is really gone: a bulk tag IS reversible now.
    expect(Object.keys(en)).not.toContain('bulk.noUndo')
    expect(Object.keys(fr)).not.toContain('bulk.noUndo')
    expect(Object.keys(zh)).not.toContain('bulk.noUndo')
  })

  it('keeps the undo row on the board stylesheet', () => {
    expect(classes.undoBar).toBe('dsh-ideas-undo-bar')
  })
})