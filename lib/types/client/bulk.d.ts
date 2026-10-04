/**
 * Bulk actions on the ideas board (idea #94): the plans and the runner behind
 * bulk **tag**, bulk **re-home workspace** and bulk **archive**.
 *
 * Three invariants shape everything in this file.
 *
 * 1. **No bulk verb, no ledger edit.** A bulk action is a batch of the ordinary
 *    per-idea verbs (`update`, `move`, `restore`), planned here and posted by
 *    the board through `IdeasClient`. The `POST /api/ideas/action` envelope and
 *    the ledger document are untouched, so a bulk run is exactly the same
 *    sequence an author would perform by hand, idea by idea.
 * 2. **`workspaceId` is the stable workspace UUID**, never a display title:
 *    re-homing is a batch of `update` patches, so renaming a workspace moves
 *    nothing and a second workspace sharing a name gets its own records.
 * 3. **A mirror-bound idea that is archived needs the round trip.** An archived
 *    TaskBoard card is read-only for EVERY verb, so a plain `update` would
 *    change the idea while its card silently kept the old labels/workspace.
 *    Such an idea is therefore updated as `restore` -> `update` -> `archive`
 *    (`restore` clears `archivedAt` alone: status, labels, executions and
 *    schedule all survive). A DECLINED idea is never round-tripped — restoring
 *    it would turn a decline into a plain archive — so it is reported as skipped
 *    instead, which is exactly the "why the others did not" the report owes.
 *
 * The runner is serial on purpose: `IdeasClient` adopts the snapshot returned by
 * every verb, so interleaved responses could adopt a stale revision and the board
 * would paint an older board than the ledger holds. A bulk run is a deliberate
 * bulk operation, not a latency race.
 *
 * Pure and framework-free: the plans are plain data and the executor takes a
 * caller-supplied runner, so every rule above is unit-testable without mounting
 * the board.
 */
import type { IdeaStatus, IdeaTag } from '../core/ideas.ts';
import type { IdeaListRow, TriagePatch } from '../protocol.ts';
import type { IdeaClientPatch } from './ideas-client.ts';
/** The three bulk actions the board offers. */
export type BulkOperation = 'tag' | 'workspace' | 'archive';
/**
 * The columns a `move` verb can name. `declined` is absent on purpose: it has
 * its own verb, and no verb takes an idea back out of it.
 */
/**
 * The columns a `move` can name. Exported because idea #111's undo plans moves
 * too, and a second copy of this definition would be free to drift.
 */
export type ColumnStatus = Extract<IdeaStatus, 'open' | 'underReview' | 'archived'>;
/**
 * One ordinary verb a bulk run posts for one idea. Exactly the shapes
 * `IdeasClient` already speaks — no bulk-only verb exists anywhere on this path.
 *
 * `move` names any column and `triage` exists because an UNDO (idea #111) posts
 * through this same vocabulary: the inverse of a triage is a triage, and the
 * inverse of a column move is a move back. Neither planner below ever emits
 * them; they exist so one step type covers every write the board makes.
 */
export type BulkStep = {
    verb: 'restore';
} | {
    verb: 'update';
    patch: IdeaClientPatch;
} | {
    verb: 'move';
    status: ColumnStatus;
} | {
    verb: 'triage';
    patch: TriagePatch;
};
/** What a bulk run did (or could not do) to one idea. */
export type BulkItemState = 'applied' | 'skipped' | 'failed';
/** One idea's planned verbs, in wire order. Empty steps = nothing to post. */
export interface BulkPlanItem {
    id: string;
    ideaNumber?: number;
    title: string;
    /** Verbs to post, in order; empty for an idea the plan skips. */
    steps: BulkStep[];
    /** Why this idea was skipped (the report shows it; it is never a blanket error). */
    skipReason?: BulkReason;
    /** True when the plan carries the restore -> update -> archive mirror round trip. */
    roundTrip: boolean;
}
/** Why a bulk run could not post (or complete) one idea, as a stable code. */
export type BulkReason = 'declined' | 'already-tagged' | 'tag-limit' | 'already-there' | 'already-archived' | 'drifted';
/** What the runner had to do about a round-trip idea whose patch failed. */
export type BulkNote = 'rearchived' | 'left-open';
/** The outcome of one idea in a finished bulk run. */
export interface BulkItemResult {
    id: string;
    ideaNumber?: number;
    title: string;
    state: BulkItemState;
    /** A skip code, or the Host's own message when the verb was refused. */
    reason?: BulkReason | string;
    /** Set when the runner had to compensate for a failed round trip. */
    note?: BulkNote;
}
/** A finished bulk run, split per idea so nothing is ever reported as a blanket. */
export interface BulkReport {
    operation: BulkOperation;
    /** Ideas the run was asked about (selected), including the skipped ones. */
    total: number;
    results: BulkItemResult[];
    applied: BulkItemResult[];
    skipped: BulkItemResult[];
    failed: BulkItemResult[];
    /**
     * True only for a bulk archive: the reverse verb (`restore`) exists, so the
     * report can offer a one-click way back. Bulk tagging and re-homing have no
     * reverse verb — `update` carries no previous value — and the report says so
     * rather than pretending to be an undo system.
     */
    reversible: boolean;
    /** True once the reversible operation has been undone in this report. */
    undone: boolean;
}
/** Posts one planned verb; the board wires this to the per-idea client methods. */
export type BulkStepRunner = (ideaId: string, step: BulkStep) => Promise<void>;
/** Internal row face the planners read (a list row carries everything needed). */
type PlanRow = Pick<IdeaListRow, 'id' | 'title' | 'status' | 'tags' | 'workspaceId' | 'taskBoardId' | 'ideaNumber'>;
/**
 * Wrap an update in the mirror round trip when the idea's card is archived.
 * The order matters: the card is read-only until the idea leaves the archive,
 * and the idea must go back to the archive right after the patch lands.
 *
 * Exported because it is the rule an UNDO needs just as much as a bulk run
 * (idea #111): restoring the previous labels of an archived, card-bound idea
 * must go through the same round trip, or the idea and its card would disagree.
 */
export declare function updateSteps(row: PlanRow, patch: IdeaClientPatch): {
    steps: BulkStep[];
    roundTrip: boolean;
};
/**
 * Bulk tag: add the given labels to every selected idea, keeping the labels it
 * already has (and each one's prompt line). An idea is SKIPPED rather than
 * silently truncated when the union would exceed the ledger's per-idea label
 * cap, because the Host would drop the overflow instead of refusing it.
 */
export declare function planBulkTag(rows: readonly PlanRow[], names: readonly IdeaTag[]): BulkPlanItem[];
/**
 * Bulk re-home: move every selected idea to `workspaceId` — the stable
 * workspace UUID, or '' for the generic (workspace-less) group. An idea already
 * there is reported as skipped: posting an identical patch would only spend a
 * revision and a mirror round trip on a no-op.
 */
export declare function planBulkWorkspace(rows: readonly PlanRow[], workspaceId: string): BulkPlanItem[];
/**
 * Bulk archive: the ordinary `move` to the Archived column for everything that
 * can legally go there. Declined ideas are skipped (archiving one would erase
 * the decline itself), already archived ones are skipped as no-ops.
 */
export declare function planBulkArchive(rows: readonly PlanRow[]): BulkPlanItem[];
/** Undo a bulk archive: the reverse verb for exactly the ideas that went through. */
export declare function planBulkRestore(rows: readonly PlanRow[]): BulkPlanItem[];
/**
 * Validate the tag input of the bulk dialog. Over-long and blank names are
 * rejected BEFORE the run instead of being dropped by the ledger's own
 * normalization, which would leave a "tagged" batch that never got the label.
 */
export declare function parseBulkTagNames(raw: string): {
    names: IdeaTag[];
    invalid: string[];
};
/** Progress of a running batch: how many ideas have been settled so far. */
export type BulkProgress = (done: number, total: number) => void;
/**
 * Execute a plan, one idea at a time, and never abort the batch: a refusal is
 * recorded against the idea that hit it and the run continues, because the whole
 * point of the report is to say which ones went through.
 *
 * A round-trip idea whose patch fails leaves the idea in the OPEN backlog (the
 * `restore` already landed). The runner therefore compensates with the same
 * archive verb and says so in the reason — a bulk tag must not be able to leave
 * an archived backlog open by accident.
 */
export declare function runBulkPlan(plan: readonly BulkPlanItem[], run: BulkStepRunner, onProgress?: BulkProgress): Promise<BulkItemResult[]>;
/** Split a finished run into the three per-idea buckets the report renders. */
export declare function summarizeBulk(operation: BulkOperation, results: readonly BulkItemResult[]): BulkReport;
/** Mark a report as undone (the bulk archive restored) without touching counts. */
export declare function markBulkUndone(report: BulkReport): BulkReport;
/**
 * The ids a bulk archive's undo restores: exactly the ideas the run really
 * archived. Skipped and failed ones are deliberately excluded — restoring an
 * idea that never moved would silently resurrect an unrelated row.
 */
export declare function undoableIds(report: BulkReport): string[];
export {};
