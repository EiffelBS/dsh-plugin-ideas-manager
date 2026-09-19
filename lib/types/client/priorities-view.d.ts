/**
 * Priorities view: the suggested ranking of the open backlog, mirroring the
 * "Suggested priority" table the OpenTimbre IDEAS.md process maintained by
 * hand. Each open idea is one ranked row (rank, title, workspace, value/
 * effort, rationale) with move-up/move-down actions that reorder the open
 * column through the rank-write path used by the kanban. The rationale text
 * is displayed when the idea carries one; writing it arrives with the T1
 * triage flow.
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
}
/** Ranked backlog view (see module doc). */
export declare function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit }: PrioritiesProps): import("react").JSX.Element;
