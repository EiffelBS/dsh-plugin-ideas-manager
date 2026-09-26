/**
 * Delivered view: the derived "exit log" of the T2 lifecycle — archived ideas
 * of the current workspace scope, most recent exit first. This is the
 * generated equivalent of the exit log for archived ideas; nothing here is
 * hand-edited. One row per archived idea: on the left an
 * exit stamp — green "delivered YYYY-MM-DD" for ideas that went through the
 * deliver verb, a neutral "archived YYYY-MM-DD" for manually archived
 * (abandoned) ones — then the title, workspace, value/effort, description
 * preview (MD/raw like the kanban and Priorities), and the edit/restore
 * actions. Restoring an idea brings it back to the open backlog (the deliver
 * verb is the only way in, restore the only way out).
 *
 * The run-state tags (idea #71) are the shared RunStateBadges of the Overview
 * card header: a run started while the idea was already under review or
 * archived stays followed by the host poll until the stamp clears, so the
 * journal must not hide a row whose execution is still in flight.
 */
import type { IdeasClient } from './ideas-client.ts';
import type { IdeaListRow } from '../protocol.ts';
export interface DeliveredViewProps {
    client: IdeasClient;
    /** Archived list rows of the current scope, unsorted. */
    archivedIdeas: readonly IdeaListRow[];
    /** Resolve a workspace id to its display label. */
    workspaceTitle: (workspaceId: string) => string;
    /** Open the shared edit modal on the given row (fetches the full body first). */
    onEdit: (idea: IdeaListRow) => void;
    /** Toggle a tag in the shared conjunctive filter (same state as kanban). */
    onToggleTag: (name: string) => void;
    /** Currently selected filter tags (highlighted row pills). */
    activeTags: readonly string[];
    /** Render descriptions as markdown (raw text otherwise), like the kanban. */
    mdMode: boolean;
    /**
     * Resolve the parent of a follow-up child into its ledger number (idea #71).
     * The board owns the id -> idea map and passes the resolver down.
     */
    parentNumber?: (ideaId: string) => number | undefined;
}
export declare function DeliveredView({ client, archivedIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, parentNumber }: DeliveredViewProps): import("react").JSX.Element;
