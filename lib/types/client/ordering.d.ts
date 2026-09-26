/**
 * Idea ordering helpers shared by the kanban (Overview) and the ranked
 * backlog (Priorities): rank-keyed sorting, the grouped rebuild used by
 * drag & drop, and the one-step move inside the open backlog used by the
 * Priorities move-up/move-down actions.
 *
 * Rank model (v2, "rank by workspace"): an idea's rank is a position RELATIVE
 * to the other ideas of the same (status, workspace) pair — see
 * rankGroupKey(). The workspace-less ideas form one generic group. Every
 * rebuild below emits a status-major, group-minor, rank-ordered id list, the
 * shape the host reorder consumes (it re-derives per-group ranks from the
 * appearance order, so each group's order in the wire list is what counts).
 *
 * The one departure from the human ranking is the open column's optional
 * display order (idea #71): orderOpenColumn can lay the column out by creation
 * date instead of rank, and can float the in-flight work above whichever order
 * is selected. Both are views, never a persisted order — every 2.5 s client poll
 * re-derives them from the same snapshot, so they cannot rewrite the human
 * ranking behind the reader's back.
 * Pure and unit-testable in isolation.
 */
import { type RankableIdea, type IdeaRunStatus, type IdeaStatus } from '../core/ideas.ts';
import type { IdeasOpenOrdering } from '../protocol.ts';
/**
 * Sentinel workspace-filter value: the generic ideas (no workspace assigned).
 * A real workspace id is a UUID, so a fixed unlikely string can never collide
 * with the registry; the board selector offers it alongside real workspaces.
 */
export declare const NO_WORKSPACE_FILTER = "__no-workspace__";
/** True when the idea belongs to the workspace scope: '' = all workspaces,
 *  NO_WORKSPACE_FILTER = the workspace-less ideas only, a concrete id =
 *  exact match. Single source for every board derivation that scopes to a
 *  workspace (Overview columns, Priorities, Delivered). */
export declare function matchesWorkspaceScope(idea: {
    workspaceId?: string;
}, workspaceFilter: string): boolean;
/** Ideas without a rank sort after every ranked idea. */
export declare function orderKey(idea: RankableIdea): number;
/** Stable rank-sorted copy (ties keep their input order). Generic over the
 *  row type so list rows and full records both pass through unchanged. */
export declare function orderIdeas<T extends RankableIdea>(ideas: readonly T[]): T[];
/**
 * Group key of an idea's own peer set inside one column: (status, workspace).
 * The workspace-less ideas share the generic group. (Re-exported from the
 * model so the client call sites read the wire/display semantics directly.)
 */
export declare function groupKeyOf(idea: RankableIdea): string;
/**
 * Build the canonical status-major, group-minor id order of the whole ledger:
 * for every column (open, archived, declined) the workspace groups appear in
 * a stable key order and every group is rank-sorted. `override` replaces the
 * id order of ONE group (the moved idea's target group) with the caller's
 * new order — every other group keeps its rank-sorted order, so a reorder
 * preserves their ranks.
 */
export declare function groupedIdOrder(all: readonly RankableIdea[], override?: {
    key: string;
    orderedIds: string[];
}): string[];
/**
 * Rebuild the rank order with `movedId` placed at the drop position of its
 * target column: the moved idea joins its OWN workspace group of that column,
 * right before `beforeId` when the anchor belongs to the same group, else at
 * the group end (a cross-workspace drop cannot define a within-group
 * insertion point). Columns are always laid out open, archived, declined,
 * each workspace group rank-sorted.
 */
export declare function rebuildOrder(all: readonly RankableIdea[], movedId: string, targetStatus: IdeaStatus, beforeId: string | undefined): string[];
/**
 * Next rank order after moving `movedId` one step up or down INSIDE its own
 * workspace group of the open column (the Priorities ranking). Returns
 * undefined when the idea is not open or is already at the group's edge (a
 * no-op), so the caller skips the wire call.
 */
export declare function moveIdeaInOpenBacklog(all: readonly RankableIdea[], movedId: string, toward: 'up' | 'down'): string[] | undefined;
/**
 * Open ideas partitioned by workspace group for the Priorities "all
 * workspaces" view: one group per workspace plus the generic (workspace-less)
 * group LAST, each group rank-sorted (its own relative ranking). Groups with
 * a workspace id come first in a stable key order; the presentation layer
 * may re-order them by title.
 */
export declare function groupOpenByWorkspace<T extends RankableIdea>(openIdeas: readonly T[]): OpenRankGroup<T>[];
/** One Priorities "all" group: a workspace (undefined = generic) and its
 *  rank-sorted open ideas (relative ranks). Generic over the row type (list
 *  rows or full records). */
export interface OpenRankGroup<T = RankableIdea> {
    workspaceId: string | undefined;
    ideas: T[];
}
/** Display-order comparator of workspace groups: the named workspaces first
 *  (by registry title), the generic (workspace-less) group last regardless of
 *  its title. */
export declare function compareWorkspaceGroups(a: OpenRankGroup<unknown>, b: OpenRankGroup<unknown>, workspaceTitle: (workspaceId: string) => string): number;
/** Column order for the "all workspaces" board: every workspace group is
 *  contiguous (named by title, the generic group last) and rank-sorted inside
 *  itself — the "rank by workspace" presentation the Priorities view also
 *  uses. Under a single-workspace scope the plain rank sort is identical. */
export declare function orderByWorkspaceGroups<T extends RankableIdea>(rows: readonly T[], workspaceTitle: (workspaceId: string) => string): T[];
/** The two run fields the running-first block reads. Both are host-written
 *  system fields (last observation, never an idea verb) and both are optional
 *  on a list row, so the comparator stays a pure function of the row. */
export interface ActivityRankable {
    /** Backend-neutral state of the last launched run (idea #66). */
    runStatus?: IdeaRunStatus;
    /** Last raw observation of the linked TaskBoard card. */
    taskBoardStatus?: string;
}
/**
 * Running block of one idea: 0 = a run in flight, 1 = everything else (idle,
 * done, or failed).
 *
 * Only the RUNNING state is floated, deliberately: a failed run keeps its tag
 * but its row stays where the selected order puts it, because a date-ordered
 * backlog that jumped every failure to the top would stop reading as a diary.
 * The rule mirrors the running badge exactly, so the sort and the tag can never
 * point at different rows: the block is `runStatus` OR the raw card observation
 * (a card started from the task board itself is only folded into runStatus by
 * the next poll).
 */
export declare function runningBlockOf(idea: ActivityRankable): 0 | 1;
/**
 * Creation-date ordering of one block (idea #71). `desc` flips it to newest
 * first. Ties — an import can stamp a whole batch with the same instant — fall
 * back to the human rank and then to the input order, so the column is
 * deterministic from one poll to the next instead of reshuffling on every 2.5 s
 * refresh.
 */
export declare function orderByCreatedAt<T extends RankableIdea & {
    createdAt: number;
}>(rows: readonly T[], desc: boolean): T[];
/**
 * The presentation order of the Overview **Open column**, combining the three
 * orthogonal decisions (idea #71):
 *
 *  - grouping: `grouped` lays the column out per workspace group (the board on
 *    "all workspaces"); ungrouped is one flat list;
 *  - ordering: `createdAt` (the default, oldest first), `createdAtDesc`, or
 *    `rank` — the human ranking the reorder verb wrote;
 *  - `runningFirst`: with it on, the ideas whose run is in flight are laid out
 *    first and every other idea keeps the selected order below them, so the
 *    float composes with a date order exactly as it does with the rank.
 *
 * The selected order is applied INSIDE each group, never across groups: a
 * running idea of workspace B must not land under workspace A's header, and
 * the drag & drop of a grouped column stays group-local by construction.
 *
 * The Priorities ranking deliberately does NOT go through here. It is a pure
 * rank list whose rows print their position and whose arrows/drag write one
 * rank step, so an attention order would make the printed number contradict
 * the stored rank the reader is editing. Priorities carries the run-state
 * badges instead, which answer the same question without moving anything.
 *
 * Pure, so the whole decision is unit-testable without a component.
 */
export declare function orderOpenColumn<T extends RankableIdea & ActivityRankable & {
    createdAt: number;
}>(rows: readonly T[], grouped: boolean, workspaceTitle: (workspaceId: string) => string, ordering: IdeasOpenOrdering, runningFirst: boolean): T[];
/**
 * Archived ideas of a workspace scope — the Delivered log contents. The
 * filter follows matchesWorkspaceScope: '' = all workspaces, a concrete id =
 * one workspace, NO_WORKSPACE_FILTER = the workspace-less ideas only. The
 * journal shows every idea that left the open backlog: delivered ones carry a
 * deliveredAt stamp, manually archived (abandoned) ones do not.
 */
export declare function archivedIdeasOf<T extends RankableIdea>(ideas: readonly T[], workspaceFilter: string): T[];
