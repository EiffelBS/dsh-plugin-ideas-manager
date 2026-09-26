/**
 * Priorities view: the suggested ranking of the open backlog — the current
 * best ordering of the open ideas. Each open idea is one ranked row (rank,
 * title, workspace chip, run-state tags, value/effort, description preview,
 * rationale) with move-up/move-down actions and drag & drop reordering of the
 * open column. During a drag an accent line shows the insertion point: before
 * the hovered row (upper half) or after it (lower half); dropping on the list
 * surface below the rows appends at the end of the dragged idea's workspace
 * group.
 *
 * The run-state tags (idea #71) are the shared RunStateBadges of the Overview
 * card header: an idea in flight or in failure says so on its row, which is
 * where the "what do I pick next" decision is actually made. They are
 * last-observation facts written by the host poll, never by an idea verb, and
 * they never move a row — the ranking below stays the human order.
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
import type { IdeaListRow } from '../protocol.ts';
export interface PrioritiesProps {
    client: IdeasClient;
    /** Open list rows of the current workspace scope, unsorted (ranked below). */
    openIdeas: readonly IdeaListRow[];
    /** Full ledger row ids/status/ranks, for the group-major rebuild the reorder needs. */
    allIdeas: readonly IdeaListRow[];
    /** Resolve a workspace id to its display label. */
    workspaceTitle: (workspaceId: string) => string;
    /** Open the shared edit modal on the given row (fetches the full body first). */
    onEdit: (idea: IdeaListRow) => void;
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
    /**
     * Resolve the parent of a follow-up child into its ledger number (idea #71).
     * The row carries `followUpOfId` but never the parent's number, so the board
     * owns the id -> idea map and passes the resolver down; the run-state chips
     * are skipped when it is absent.
     */
    parentNumber?: (ideaId: string) => number | undefined;
}
/** Ranked backlog view (see module doc). */
export declare function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, grouped, parentNumber }: PrioritiesProps): import("react").JSX.Element;
