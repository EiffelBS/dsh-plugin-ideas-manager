/**
 * Priorities view: the suggested ranking of the open backlog — the current
 * best ordering of the open ideas. Each open idea is one ranked row (rank,
 * title, workspace chip, value/effort, description preview, rationale) with
 * move-up/move-down actions and drag & drop reordering of the open column.
 * During a drag an accent line shows the insertion point: before the hovered
 * row (upper half) or after it (lower half); dropping on the list surface
 * below the rows appends at the end of the dragged idea's workspace group.
 *
 * Ranking is PER WORKSPACE ("rank by workspace"): every workspace group (the
 * workspace-less ideas are one generic group) carries its own relative ranks.
 * When the board shows "all workspaces" (`grouped`) the rows are laid out in
 * headed sections — workspaces first in title order, the generic group last —
 * and a drag is only accepted inside the dragged idea's own group (a
 * cross-workspace drop has no within-group insertion point). When the board
 * is scoped to one workspace the grouped layout degrades to a single
 * unheaded list, identical to the pre-grouping behaviour. The wire call is
 * the same rank-write path the kanban uses.
 */
import type { IdeasClient } from './ideas-client.ts';
import type { IdeaRecord } from '../core/ideas.ts';
export interface PrioritiesProps {
    client: IdeasClient;
    /** Open ideas of the current workspace scope, unsorted (ranked below). */
    openIdeas: readonly IdeaRecord[];
    /** Full ledger rows, for the group-major rebuild the reorder needs. */
    allIdeas: readonly IdeaRecord[];
    /** Resolve a workspace id to its display label. */
    workspaceTitle: (workspaceId: string) => string;
    /** Open the shared edit modal on the given idea. */
    onEdit: (idea: IdeaRecord) => void;
    /** Toggle a tag in the shared conjunctive filter (same state as kanban). */
    onToggleTag: (name: string) => void;
    /** Currently selected filter tags (highlighted pills + row meta). */
    activeTags: readonly string[];
    /** Render descriptions as markdown (raw text otherwise), like the kanban. */
    mdMode: boolean;
    /** True when the board shows "all workspaces": render per-workspace headed
     *  sections (the generic group last) and restrict drops to one group.
     *  False (single-workspace scope) keeps the plain unheaded list. */
    grouped: boolean;
}
/** Ranked backlog view (see module doc). */
export declare function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, grouped }: PrioritiesProps): import("react").JSX.Element;
