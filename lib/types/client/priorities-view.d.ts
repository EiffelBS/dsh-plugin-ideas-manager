/**
 * Priorities view: the suggested ranking of the open backlog, mirroring the
 * "Suggested priority" table the OpenTimbre IDEAS.md process maintained by
 * hand. Each open idea is one ranked row (rank, title, workspace, value/
 * effort, description preview, rationale) with move-up/move-down actions and
 * drag & drop reordering of the open column (drop before a row or at the end
 * of the list; the wire call is the same rank-write path the kanban uses).
 * The rationale text is displayed when the idea carries one; writing it
 * arrives with the T1 triage flow.
 */
import type { IdeasClient } from './ideas-client.ts';
import type { IdeaRecord } from '../core/ideas.ts';
export interface PrioritiesProps {
    client: IdeasClient;
    /** Open ideas of the current workspace scope, unsorted (ranked below). */
    openIdeas: readonly IdeaRecord[];
    /** Full ledger rows, for the column-major rebuild the reorder needs. */
    allIdeas: readonly IdeaRecord[];
    /** Resolve a workspace id to its display label. */
    workspaceTitle: (workspaceId: string) => string;
    /** Open the shared edit modal on the given idea. */
    onEdit: (idea: IdeaRecord) => void;
    /** Render descriptions as markdown (raw text otherwise), like the kanban. */
    mdMode: boolean;
}
/** Ranked backlog view (see module doc). */
export declare function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, mdMode }: PrioritiesProps): import("react").JSX.Element;
