/**
 * Idea ordering helpers shared by the kanban (Overview) and the ranked
 * backlog (Priorities): rank-keyed sorting, the column-major rebuild used by
 * drag & drop, and the one-step move inside the open backlog used by the
 * Priorities move-up/move-down actions. Pure and unit-testable in isolation.
 */
import { type IdeaRecord, type IdeaStatus } from '../core/ideas.ts';
/** Ideas without a rank sort after every ranked idea. */
export declare function orderKey(idea: IdeaRecord): number;
/** Stable rank-sorted copy (ties keep their input order). */
export declare function orderIdeas(ideas: readonly IdeaRecord[]): IdeaRecord[];
/**
 * Rebuild the global rank order with `movedId` placed at the drop position of
 * its target column: after `beforeId` when given, else at the column end.
 * Columns are always laid out open, archived, declined, each rank-sorted.
 */
export declare function rebuildOrder(all: readonly IdeaRecord[], movedId: string, targetStatus: IdeaStatus, beforeId: string | undefined): string[];
/**
 * Next global rank order after moving `movedId` one step up or down INSIDE
 * the open backlog (the Priorities ranking). Returns undefined when the idea
 * is not open or is already at the edge (a no-op), so the caller skips the
 * wire call.
 */
export declare function moveIdeaInOpenBacklog(all: readonly IdeaRecord[], movedId: string, toward: 'up' | 'down'): string[] | undefined;
/**
 * Archived ideas of a workspace scope that carry a delivery stamp — the
 * Delivered log contents (empty scope = all workspaces).
 */
export declare function deliveredIdeasOf(ideas: readonly IdeaRecord[], workspaceId: string): IdeaRecord[];
