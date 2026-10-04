/**
 * Undo for the board's own manual actions (idea #111): the session-local
 * INVERSE of an edit, a triage, a restore, a bulk tag, a bulk re-home and a
 * bulk archive.
 *
 * Five facts shape everything here.
 *
 * 1. **The inverse is ordinary verbs.** `UndoStep` IS `BulkStep`: an undo posts
 *    `restore` / `update` / `move` / `triage` through `IdeasClient`, exactly the
 *    way the forward action did. There is no undo verb on the wire, no patch to
 *    `POST /api/ideas/action` and no ledger write — the frozen envelope is
 *    untouched and an undo is indistinguishable, in the activity log, from a
 *    human having done it by hand.
 * 2. **The "before" value exists at exactly one moment.** `update` REPLACES, so
 *    the previous body/title/tag set cannot be reconstructed from the ledger
 *    after the fact. It can only be read BEFORE the post, from the snapshot the
 *    client holds (and, for a body, from the `fullRecords` cache — the list
 *    projection drops it). `invertAction` therefore takes the pre-action state
 *    as an argument and answers `undefined` whenever the inverse cannot be
 *    expressed in ordinary verbs. **That absence IS the guarantee**: there is no
 *    entry, so there is no button, so nothing promises a way back that does not
 *    exist.
 * 3. **Some inverses are simply not expressible.** The wire `update` patch sets
 *    `value`/`effort`/`rank` but has no way to CLEAR them, so undoing an opinion
 *    that did not exist before is impossible and produces no entry rather than a
 *    half-restored card. Same for a body whose full record was never cached.
 * 4. **`restore` is not a faithful inverse.** It forces `open` and clears
 *    `archivedAt` alone — `deliveredAt`, `decision` and `followUpOfId` survive.
 *    So the inverse of a column move is `move` back to the PREVIOUS column, and
 *    an idea that came from `declined` gets no entry at all (there is no verb
 *    that erases a decision). `deliver` is excluded for the same reason: a
 *    `restore` would bring back a card still stamped as delivered.
 * 5. **The mirror round trip is not optional.** An archived idea bound to a
 *    TaskBoard card is read-only for every verb, so the inverse of an update on
 *    it is `restore` -> `update` -> `archive` (`updateSteps`, reused from
 *    `bulk.ts`). A plain `update` would move the idea while its card silently
 *    kept the old labels.
 *
 * On top of the inverse sits the **drift guard**: an entry remembers what the
 * forward action wrote for the exact fields it touched, and an undo refuses the
 * idea whose row no longer holds those values. An agent, a second tab or a
 * human can move the same card between the click and the Ctrl+Z; the guard turns
 * that race into an explicit per-idea refusal instead of a silent overwrite of
 * somebody else's work. The refusal is reported, never swallowed.
 *
 * Pure and framework-free, like `bulk.ts`: the plans are plain data, the stack
 * helpers are array functions, and the keyboard filter is a predicate over an
 * event-shaped object. Nothing here imports React, touches the DOM or posts
 * anything, so every rule is unit-testable without mounting the board.
 */

import type { IdeaRecord, IdeaTag } from '../core/ideas.ts'
import type { IdeaListRow, IdeaUpdatePatch, IdeasAction, TriagePatch } from '../protocol.ts'
import { updateSteps, type BulkPlanItem, type BulkStep, type ColumnStatus } from './bulk.ts'
import type { IdeaClientPatch } from './ideas-client.ts'

/** How many actions the session stack keeps (the oldest falls off). */
export const UNDO_STACK_LIMIT = 20

/**
 * How long an entry stays undoable. An hour-old "before" value describes a card
 * that has almost certainly moved since; the drift guard would refuse most of
 * them anyway, and an expiry says so earlier and more honestly than a refusal.
 */
export const UNDO_ENTRY_TTL_MS = 30 * 60_000


/** What one undoable action was, as a code the board localizes. */
export type UndoKind =
  | 'tag'
  | 'workspace'
  | 'archive'
  | 'edit'
  | 'triage'
  | 'restore'

/**
 * The values one idea's forward action WROTE, one entry per touched field,
 * canonicalized to a comparable string.
 *
 * This is the drift guard's whole state: the undo overwrites exactly these
 * fields, so it may only do so while they still hold what the action left.
 */
export type UndoExpectation = Readonly<Record<string, string>>

/** One idea's inverse: the plan to post and what it expects to find. */
export interface UndoItem {
  /** The inverse verbs, in wire order (a plain plan item for `runBulkPlan`). */
  plan: BulkPlanItem
  /** What the forward action wrote for the fields this plan will overwrite. */
  expect: UndoExpectation
}

/** One undoable action: every idea it changed, captured at once. */
export interface UndoEntry {
  /** Stable identity (also the React key and the `discard` handle). */
  key: string
  /** What this entry undoes, as a code the board localizes. */
  kind: UndoKind
  /** When the action landed (ms epoch) — the expiry clock. */
  at: number
  /** One inverse per idea. An action that changed nothing has no entry. */
  items: UndoItem[]
}

/**
 * How many IDEAS an entry covers — not how many items it holds.
 *
 * They are different numbers, and the copy has to use this one. An archived,
 * card-bound idea goes through `restore` → `update` → `archive`, so its single
 * tag change is captured as THREE items; a batch of four such ideas would be
 * twelve items, and a receipt reading "untagged on 12 ideas" would be a lie the
 * reader can check in one glance.
 */
export function undoIdeaCount(entry: UndoEntry): number {
  return new Set(entry.items.map(item => item.plan.id)).size
}

/**
 * The pre-action state an inverse is built from. `full` is the cached full
 * record, and is REQUIRED for a body: the list projection drops it, so a body
 * can only be restored from a record the client already holds.
 */
export interface UndoBefore {
  row: IdeaListRow
  full?: IdeaRecord
}

/* --- fingerprinting ---------------------------------------------------- */

/**
 * Canonical string for one row value, so the drift guard compares values and
 * never object identity. Arrays go through JSON with their tags sorted by name:
 * a host that reorders the label set did not change it, and that must not read
 * as a drift.
 */
export function undoFingerprint(value: unknown): string {
  if (value === undefined) return ''
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalEntry))
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function canonicalEntry(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const row = value as Record<string, unknown>
  // A tag row, rebuilt from its two real fields: name first, then the prompt
  // line. Rebuilding rather than string-joining keeps the comparison free of any
  // separator that could collide with a label name.
  if (typeof row.name === 'string') {
    return { name: row.name, promptPrefix: String(row.promptPrefix ?? '') }
  }
  return value
}

/** Tags sorted by name then prompt line — the order-independent label form. */
export function undoTagsFingerprint(tags: readonly IdeaTag[] | undefined): string {
  return undoFingerprint(tags === undefined ? [] : [...tags].sort(compareTags))
}

function compareTags(left: IdeaTag, right: IdeaTag): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  return String(left.promptPrefix ?? '').localeCompare(String(right.promptPrefix ?? ''))
}

/* --- inverting an action ------------------------------------------------ */

/**
 * The inverse of one successful action, as an ordinary-verb plan for ONE idea.
 *
 * @returns the plan, or `undefined` when the action has no faithful inverse in
 *   the verb vocabulary. `undefined` is the whole answer for the irreversible
 *   verbs (`create`, `decline`, `deliver`, `followUp`, `delete`, `merge`,
 *   `reanalyze`, `reorder`, `import`, `export`): no entry, no button, no
 *   promise.
 */
export function invertAction(action: IdeasAction, before: UndoBefore): BulkPlanItem | undefined {
  switch (action.kind) {
    case 'update':
      return invertUpdate(action.patch, before)
    case 'move':
      // The previous COLUMN is the faithful inverse — not `restore`, which
      // would land every idea in Open whatever column it came from.
      return invertColumn(before.row)
    case 'restore':
      return invertColumn(before.row)
    case 'triage':
      return invertTriage(action.patch, before.row)
    default:
      return undefined
  }
}

/**
 * The state a capture needs before the post. Only actions that target ONE
 * existing row can be inverted; everything else (a merge reconciles two rows, a
 * create has no "before", a reorder is a whole-list ordering) has no prior value
 * to have captured.
 */
export function undoTargetId(action: IdeasAction): string | undefined {
  switch (action.kind) {
    case 'update':
    case 'move':
    case 'decline':
    case 'deliver':
    case 'triage':
    case 'followUp':
    case 'restore':
    case 'delete':
    case 'reanalyze':
      return action.ideaId
    default:
      return undefined
  }
}

/**
 * Inverse of a `move` / `restore`: the move back to the column the idea came
 * from. A DECLINED idea gets nothing — no verb erases `decision`, so "put it
 * back in Open" would quietly turn a decline into a plain archive, which is
 * exactly the reason `bulk.ts` refuses to touch a declined card.
 */
function invertColumn(row: IdeaListRow): BulkPlanItem | undefined {
  if (row.status === 'declined') return undefined
  return {
    id: row.id,
    ...(row.ideaNumber === undefined ? {} : { ideaNumber: row.ideaNumber }),
    title: row.title,
    steps: [{ verb: 'move', status: row.status satisfies ColumnStatus }],
    roundTrip: false,
  }
}

/**
 * Inverse of an `update` patch: the same fields, carrying the values the row
 * held BEFORE the action. Only the touched fields travel, so an undo never
 * rewrites an edge or a label the action never mentioned.
 */
function invertUpdate(patch: IdeaUpdatePatch, before: UndoBefore): BulkPlanItem | undefined {
  const row = before.row
  const view = row as unknown as Record<string, unknown>
  const inverse: IdeaClientPatch = {}
  for (const field of Object.keys(patch)) {
    switch (field) {
      case 'title':
        inverse.title = row.title
        break
      case 'body': {
        // The list row carries no body. Only a cached full record that still
        // matches the row can restore one; a stale cache would put back an older
        // draft over a newer edit, so it is refused rather than trusted.
        const full = before.full
        if (full === undefined || full.updatedAt !== row.updatedAt) return undefined
        inverse.body = full.body
        break
      }
      case 'tags':
        inverse.tags = (row.tags ?? []).map(tag => ({ ...tag }))
        break
      case 'workspaceId':
        // '' is the generic group: the client patch's own "move to generic".
        inverse.workspaceId = row.workspaceId ?? ''
        break
      case 'relatesTo':
        inverse.relatesTo = [...(row.relatesTo ?? [])]
        break
      case 'blocks':
        inverse.blocks = [...(row.blocks ?? [])]
        break
      case 'rationale':
        // A blank rationale CLEARS it on the wire (blankToUndefined).
        inverse.rationale = row.rationale ?? ''
        break
      case 'value':
      case 'effort': {
        // The wire patch has no way to CLEAR a score, so a card that had no
        // opinion before cannot have one taken away by an inverse.
        const previous = view[field]
        if (previous === undefined) return undefined
        if (field === 'value') inverse.value = previous as number
        else inverse.effort = previous as number
        break
      }
      default:
        // An unknown or non-invertible field (rank, summary, and whatever the
        // wire grows next): refuse the WHOLE entry rather than restore half of
        // an edit. This branch is the safety net that keeps the list above
        // exhaustive — a new field must fail loudly HERE, not silently fall
        // through an inverse that never heard of it.
        return undefined
    }
  }
  if (Object.keys(inverse).length === 0) return undefined
  const { steps, roundTrip } = updateSteps(row, inverse)
  return { id: row.id, ...numberOf(row), title: row.title, steps, roundTrip }
}

/** Inverse of a `triage`: the old opinion, re-applied at the old rank. */
function invertTriage(patch: TriagePatch, row: IdeaListRow): BulkPlanItem | undefined {
  const inverse: TriagePatch = {}
  if (patch.value !== undefined) {
    // Not clearable on the wire: no score before means no way back.
    if (row.value === undefined) return undefined
    inverse.value = row.value
  }
  if (patch.effort !== undefined) {
    if (row.effort === undefined) return undefined
    inverse.effort = row.effort
  }
  if (patch.rationale !== undefined) inverse.rationale = row.rationale ?? ''
  if (patch.rank !== undefined) {
    // A rank is a 1-based position inside the open backlog and the re-rank is
    // transactional: restoring the OLD position is what puts the neighbours
    // back where they were. An unranked idea has no position to return to.
    if (row.rank === undefined) return undefined
    inverse.rank = row.rank
  }
  if (Object.keys(inverse).length === 0) return undefined
  return { id: row.id, ...numberOf(row), title: row.title, steps: [{ verb: 'triage', patch: inverse }], roundTrip: false }
}

/** Copy the ledger number off a row only when it carries one. */
function numberOf(row: IdeaListRow): { ideaNumber?: number } {
  return row.ideaNumber === undefined ? {} : { ideaNumber: row.ideaNumber }
}

/* --- drift guard -------------------------------------------------------- */

/**
 * What one inverse expects to find on the row, read off the state the action
 * LEFT behind (never the state before it).
 *
 * The rule is deliberately narrow, and it has two halves that must not be
 * confused:
 *
 *  - the PLAN says WHICH fields the inverse is about to overwrite;
 *  - the `after` row says what the forward action left in each of them.
 *
 * Never the third possibility — reading the expectation off the inverse's own
 * values would make the guard compare the card against itself and always pass.
 * So a `move` back to `open` is guarded on the row still being `archived`, not
 * on it being `open`.
 *
 * The guard is also narrow on purpose: it protects the fields this inverse
 * touches and nothing else. An unrelated commit — a launch settle, a task-status
 * observation — must not make a perfectly reversible tag edit un-undoable. The
 * one exception is a body, which the list row cannot hold: an update that
 * touched one is guarded on the row's whole `updatedAt` stamp, the only signal a
 * body edit leaves in the projection.
 */
export function undoExpectationOf(plan: BulkPlanItem, after: IdeaListRow): UndoExpectation {
  const expect: Record<string, string> = {}
  for (const step of plan.steps) {
    switch (step.verb) {
      case 'restore':
      case 'move':
        expect.status = undoFingerprint(after.status)
        break
      case 'triage': {
        for (const field of ['value', 'effort', 'rationale', 'rank'] as const) {
          if (step.patch[field] !== undefined) expect[field] = undoFingerprint(after[field])
        }
        break
      }
      default:
        for (const field of Object.keys(step.patch)) {
          expect[field] = field === 'tags'
            ? undoTagsFingerprint(after.tags)
            : undoFingerprint((after as unknown as Record<string, unknown>)[field])
        }
        if (step.patch.body !== undefined) expect.updatedAt = undoFingerprint(after.updatedAt)
        break
    }
  }
  return expect
}

/**
 * The fields that no longer hold what the action wrote. Non-empty means the
 * idea drifted and must NOT be overwritten by this entry.
 */
export function undoDriftedFields(expect: UndoExpectation, row: IdeaListRow | undefined): string[] {
  if (row === undefined) return Object.keys(expect).length === 0 ? ['idea'] : Object.keys(expect)
  const drifted: string[] = []
  for (const [field, value] of Object.entries(expect)) {
    const current = field === 'tags'
      ? undoTagsFingerprint(row.tags)
      : undoFingerprint((row as unknown as Record<string, unknown>)[field])
    if (current !== value) drifted.push(field)
  }
  return drifted
}

/* --- planning an undo --------------------------------------------------- */

/** One idea an undo refused, with the fields that had moved. */
export interface UndoRefusal {
  id: string
  ideaNumber?: number
  title: string
  /** The row fields that no longer hold what the action wrote. */
  fields: string[]
}

/** The plan an undo will post, split from what it refused. */
export interface UndoPlan {
  /** One plan item per IDEA — never one per captured verb. */
  plan: BulkPlanItem[]
  refused: UndoRefusal[]
}

/**
 * Merge the guards of an idea's captured verbs: per field, the expectation of
 * the LAST verb that wrote it.
 *
 * This is forced by the wire, and it is worth writing down. A mirrored tag
 * change is three verbs (`restore` -> `update` -> `archive`), so it is captured
 * three times — and at undo time the row holds the result of the LAST write to
 * each field, not the state it passed through in between. Guarding each verb on
 * the snapshot its own post returned would refuse the very batch the feature
 * exists to reverse: the `restore` guard would read `status: 'open'` while the
 * row has been archived ever since.
 */
function mergedExpectation(items: readonly UndoItem[]): UndoExpectation {
  let guard: Record<string, string> = {}
  for (const item of items) guard = { ...guard, ...item.expect }
  return guard
}

/**
 * Re-decide the mirror round trip, and the column, against the row as it stands
 * NOW. Per-verb inverses are the raw material; this is where they become one
 * coherent plan for the card.
 *
 * Three rules, each of which was a real bug before it was a rule:
 *
 *  - **A plan that DID round-trip is replayed verbatim.** Its trailing `archive`
 *    is what puts the idea back where the forward action found it, so pruning
 *    it as "already archived" would leave the idea open.
 *  - **Every other `update` step is re-derived** through `updateSteps`, the one
 *    function that owns the mirror rule. The `update` inside a captured
 *    `restore` -> `update` -> `archive` was planned while the idea was open, so
 *    its bare step would change the idea while its mirrored card silently kept
 *    the label the undo just took away.
 *  - **At most ONE captured column step survives, the first.** Per-verb column
 *    inverses do not compose: a mirrored chain captures `move archived` for its
 *    `restore` and `move open` for its `archive`, and replayed in order the
 *    second lands last and leaves the idea in the column the action STARTED
 *    from. The column the action started from is exactly what the first
 *    captured column step asks for, so that one wins and the rest — states the
 *    action itself passed through — are dropped. A first step that asks for the
 *    column the row is already in is a no-op and is dropped too, and it still
 *    settles the question, so a later one cannot sneak past.
 */
function reboundPlan(base: BulkPlanItem, items: readonly UndoItem[], row: IdeaListRow): BulkPlanItem {
  const steps: BulkStep[] = []
  let columnSettled = false
  for (const item of items) {
    if (item.plan.roundTrip) {
      steps.push(...item.plan.steps)
      columnSettled = true
      continue
    }
    for (const step of item.plan.steps) {
      if (step.verb === 'move') {
        if (columnSettled) continue
        columnSettled = true
        if (step.status === row.status) continue
      }
      if (step.verb !== 'update') {
        steps.push(step)
        continue
      }
      steps.push(...updateSteps(row, step.patch).steps)
    }
  }
  return { ...base, steps, roundTrip: steps.some(step => step.verb === 'restore') }
}

/**
 * Build the plan for one entry against the CURRENT board.
 *
 * The unit is the IDEA, not the captured verb: an action that posted several
 * verbs for one card becomes one plan item whose steps are its inverse in wire
 * order, guarded on the fields that inverse overwrites. That is what makes the
 * receipt countable in ideas and what lets a mirrored round trip replay as one
 * coherent move.
 *
 * A drifted idea is reported, never applied, and never aborts the rest: the
 * entry is the inverse of a batch, and a batch that quietly stopped halfway
 * because one of sixty cards moved would be worse than one that undid fifty-nine
 * and said which one it left alone.
 */
export function planUndo(entry: UndoEntry, rows: readonly IdeaListRow[]): UndoPlan {
  const order: string[] = []
  const groups = new Map<string, UndoItem[]>()
  for (const item of entry.items) {
    const id = item.plan.id
    const bucket = groups.get(id)
    if (bucket === undefined) {
      groups.set(id, [item])
      order.push(id)
      continue
    }
    bucket.push(item)
  }

  const plan: BulkPlanItem[] = []
  const refused: UndoRefusal[] = []
  for (const id of order) {
    const items = groups.get(id)!
    const base = items[0]!.plan
    const row = rows.find(candidate => candidate.id === id)
    const fields = undoDriftedFields(mergedExpectation(items), row)
    if (fields.length > 0) {
      plan.push({ ...base, steps: [], skipReason: 'drifted' })
      refused.push({
        id,
        ...(base.ideaNumber === undefined ? {} : { ideaNumber: base.ideaNumber }),
        title: base.title,
        fields,
      })
      continue
    }
    // No row means no inverse is postable, and the guard already refused it.
    if (row === undefined) continue
    plan.push(reboundPlan(base, items, row))
  }
  return { plan, refused }
}

/**
 * The label an action gets, read off the FORWARD action rather than off its
 * inverse.
 *
 * That direction matters: the inverse of "move to Archived" is "move to Open",
 * so a label derived from the plan would call an archiving action an ordinary
 * edit — and the human reading the Undo row would have no idea what the button
 * was about to reverse.
 */
export function undoKindOf(action: IdeasAction): UndoKind {
  switch (action.kind) {
    case 'triage':
      return 'triage'
    case 'restore':
      return 'restore'
    case 'move':
      return action.status === 'archived' ? 'archive' : 'edit'
    case 'update': {
      const fields = Object.keys(action.patch)
      if (fields.length === 1 && fields[0] === 'tags') return 'tag'
      if (fields.length === 1 && fields[0] === 'workspaceId') return 'workspace'
      return 'edit'
    }
    default:
      return 'edit'
  }
}

/* --- the stack ---------------------------------------------------------- */

/**
 * Push one entry, dropping the expired ones first and the oldest past the
 * limit. A bounded stack is the whole safety argument: undo is a convenience
 * over the last handful of actions, never a journal.
 */
export function pushUndoEntry(stack: readonly UndoEntry[], entry: UndoEntry, now: number): UndoEntry[] {
  const kept = stack.filter(candidate => now - candidate.at <= UNDO_ENTRY_TTL_MS)
  kept.push(entry)
  while (kept.length > UNDO_STACK_LIMIT) kept.shift()
  return kept
}

/** The entry a Ctrl+Z would reverse: the newest one that has not expired. */
export function topUndoEntry(stack: readonly UndoEntry[], now: number): UndoEntry | undefined {
  for (let index = stack.length - 1; index >= 0; index--) {
    const entry = stack[index]!
    if (now - entry.at <= UNDO_ENTRY_TTL_MS) return entry
  }
  return undefined
}

/** Remove one entry by key (a caller that undid the action itself). */
export function dropUndoEntry(stack: readonly UndoEntry[], key: string): UndoEntry[] {
  return stack.filter(entry => entry.key !== key)
}

/* --- the keyboard shortcut ---------------------------------------------- */

/** The event shape the filter reads — structural, so it is testable anywhere. */
export interface UndoKeyEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  defaultPrevented?: boolean
}

/**
 * `Ctrl+Z` / `Cmd+Z`, and nothing else.
 *
 * `Ctrl+Shift+Z` is deliberately NOT the undo: that chord is redo everywhere,
 * and this board has no redo (idea #111 defers it on purpose — redoing a
 * destructive batch without the confirmation its original click carried is a new
 * way to make a mistake, not a comfort).
 */
export function isUndoShortcut(event: UndoKeyEvent): boolean {
  if (event.key.toLowerCase() !== 'z') return false
  if (event.shiftKey === true || event.altKey === true) return false
  return event.ctrlKey === true || event.metaKey === true
}

/**
 * Whether the event came from something the human is TYPING in.
 *
 * A board-level listener runs in the capture phase, so it fires BEFORE the
 * browser's own undo on a focused field. Without this filter a single Ctrl+Z
 * inside the idea editor would rewrite the LEDGER instead of restoring the text
 * the caret was in — the worst possible victim for a global shortcut.
 *
 * Structural on purpose (`tagName` / `isContentEditable` instead of
 * `instanceof`): the check runs in a test process with no DOM globals at all.
 */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return element.isContentEditable === true
}

/**
 * The whole gate in one predicate, so the rule is one test instead of four
 * branches in an effect: the chord, a field that is not being typed in, no
 * other handler having already claimed the event, and something to undo.
 *
 * It answers FALSE for an empty stack on purpose. Not intercepting is what
 * leaves the browser's own Ctrl+Z working on a page that has nothing to undo.
 */
export function shouldHandleUndo(event: UndoKeyEvent, target: unknown, canUndo: boolean): boolean {
  if (!canUndo) return false
  if (event.defaultPrevented === true) return false
  if (!isUndoShortcut(event)) return false
  return !isEditableTarget(target)
}