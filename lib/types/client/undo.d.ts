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
import type { IdeaRecord, IdeaTag } from '../core/ideas.ts';
import type { IdeaListRow, IdeasAction } from '../protocol.ts';
import { type BulkPlanItem } from './bulk.ts';
/** How many actions the session stack keeps (the oldest falls off). */
export declare const UNDO_STACK_LIMIT = 20;
/**
 * How long an entry stays undoable. An hour-old "before" value describes a card
 * that has almost certainly moved since; the drift guard would refuse most of
 * them anyway, and an expiry says so earlier and more honestly than a refusal.
 */
export declare const UNDO_ENTRY_TTL_MS: number;
/** What one undoable action was, as a code the board localizes. */
export type UndoKind = 'tag' | 'workspace' | 'archive' | 'edit' | 'triage' | 'restore';
/**
 * The values one idea's forward action WROTE, one entry per touched field,
 * canonicalized to a comparable string.
 *
 * This is the drift guard's whole state: the undo overwrites exactly these
 * fields, so it may only do so while they still hold what the action left.
 */
export type UndoExpectation = Readonly<Record<string, string>>;
/** One idea's inverse: the plan to post and what it expects to find. */
export interface UndoItem {
    /** The inverse verbs, in wire order (a plain plan item for `runBulkPlan`). */
    plan: BulkPlanItem;
    /** What the forward action wrote for the fields this plan will overwrite. */
    expect: UndoExpectation;
}
/** One undoable action: every idea it changed, captured at once. */
export interface UndoEntry {
    /** Stable identity (also the React key and the `discard` handle). */
    key: string;
    /** What this entry undoes, as a code the board localizes. */
    kind: UndoKind;
    /** When the action landed (ms epoch) — the expiry clock. */
    at: number;
    /** One inverse per idea. An action that changed nothing has no entry. */
    items: UndoItem[];
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
export declare function undoIdeaCount(entry: UndoEntry): number;
/**
 * The pre-action state an inverse is built from. `full` is the cached full
 * record, and is REQUIRED for a body: the list projection drops it, so a body
 * can only be restored from a record the client already holds.
 */
export interface UndoBefore {
    row: IdeaListRow;
    full?: IdeaRecord;
}
/**
 * Canonical string for one row value, so the drift guard compares values and
 * never object identity. Arrays go through JSON with their tags sorted by name:
 * a host that reorders the label set did not change it, and that must not read
 * as a drift.
 */
export declare function undoFingerprint(value: unknown): string;
/** Tags sorted by name then prompt line — the order-independent label form. */
export declare function undoTagsFingerprint(tags: readonly IdeaTag[] | undefined): string;
/**
 * The inverse of one successful action, as an ordinary-verb plan for ONE idea.
 *
 * @returns the plan, or `undefined` when the action has no faithful inverse in
 *   the verb vocabulary. `undefined` is the whole answer for the irreversible
 *   verbs (`create`, `decline`, `deliver`, `followUp`, `delete`, `merge`,
 *   `reanalyze`, `reorder`, `import`, `export`): no entry, no button, no
 *   promise.
 */
export declare function invertAction(action: IdeasAction, before: UndoBefore): BulkPlanItem | undefined;
/**
 * The state a capture needs before the post. Only actions that target ONE
 * existing row can be inverted; everything else (a merge reconciles two rows, a
 * create has no "before", a reorder is a whole-list ordering) has no prior value
 * to have captured.
 */
export declare function undoTargetId(action: IdeasAction): string | undefined;
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
export declare function undoExpectationOf(plan: BulkPlanItem, after: IdeaListRow): UndoExpectation;
/**
 * The fields that no longer hold what the action wrote. Non-empty means the
 * idea drifted and must NOT be overwritten by this entry.
 */
export declare function undoDriftedFields(expect: UndoExpectation, row: IdeaListRow | undefined): string[];
/** One idea an undo refused, with the fields that had moved. */
export interface UndoRefusal {
    id: string;
    ideaNumber?: number;
    title: string;
    /** The row fields that no longer hold what the action wrote. */
    fields: string[];
}
/** The plan an undo will post, split from what it refused. */
export interface UndoPlan {
    /** One plan item per IDEA — never one per captured verb. */
    plan: BulkPlanItem[];
    refused: UndoRefusal[];
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
export declare function planUndo(entry: UndoEntry, rows: readonly IdeaListRow[]): UndoPlan;
/**
 * The label an action gets, read off the FORWARD action rather than off its
 * inverse.
 *
 * That direction matters: the inverse of "move to Archived" is "move to Open",
 * so a label derived from the plan would call an archiving action an ordinary
 * edit — and the human reading the Undo row would have no idea what the button
 * was about to reverse.
 */
export declare function undoKindOf(action: IdeasAction): UndoKind;
/**
 * Push one entry, dropping the expired ones first and the oldest past the
 * limit. A bounded stack is the whole safety argument: undo is a convenience
 * over the last handful of actions, never a journal.
 */
export declare function pushUndoEntry(stack: readonly UndoEntry[], entry: UndoEntry, now: number): UndoEntry[];
/** The entry a Ctrl+Z would reverse: the newest one that has not expired. */
export declare function topUndoEntry(stack: readonly UndoEntry[], now: number): UndoEntry | undefined;
/** Remove one entry by key (a caller that undid the action itself). */
export declare function dropUndoEntry(stack: readonly UndoEntry[], key: string): UndoEntry[];
/** The event shape the filter reads — structural, so it is testable anywhere. */
export interface UndoKeyEvent {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    defaultPrevented?: boolean;
}
/**
 * `Ctrl+Z` / `Cmd+Z`, and nothing else.
 *
 * `Ctrl+Shift+Z` is deliberately NOT the undo: that chord is redo everywhere,
 * and this board has no redo (idea #111 defers it on purpose — redoing a
 * destructive batch without the confirmation its original click carried is a new
 * way to make a mistake, not a comfort).
 */
export declare function isUndoShortcut(event: UndoKeyEvent): boolean;
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
export declare function isEditableTarget(target: unknown): boolean;
/**
 * The whole gate in one predicate, so the rule is one test instead of four
 * branches in an effect: the chord, a field that is not being typed in, no
 * other handler having already claimed the event, and something to undo.
 *
 * It answers FALSE for an empty stack on purpose. Not intercepting is what
 * leaves the browser's own Ctrl+Z working on a page that has nothing to undo.
 */
export declare function shouldHandleUndo(event: UndoKeyEvent, target: unknown, canUndo: boolean): boolean;
