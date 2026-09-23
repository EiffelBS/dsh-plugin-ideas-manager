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
 * Pure and unit-testable in isolation.
 */
import { type RankableIdea, type IdeaStatus } from '../core/ideas.ts';
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
/**
 * Archived ideas of a workspace scope — the Delivered log contents. The
 * filter follows matchesWorkspaceScope: '' = all workspaces, a concrete id =
 * one workspace, NO_WORKSPACE_FILTER = the workspace-less ideas only. The
 * journal shows every idea that left the open backlog: delivered ones carry a
 * deliveredAt stamp, manually archived (abandoned) ones do not.
 */
export declare function archivedIdeasOf<T extends RankableIdea>(ideas: readonly T[], workspaceFilter: string): T[];
