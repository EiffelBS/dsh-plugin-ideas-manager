/**
 * Delivered view: the derived "delivered log" of the T2 lifecycle — archived
 * ideas of the current workspace scope that carry a delivery stamp, most
 * recent first. This is the generated equivalent of the OT delivered-log
 * entries (hand-maintained in IDEAS.md); nothing here is hand-edited. One
 * row per delivered idea: the delivery date, title, workspace, value/effort,
 * description preview (MD/raw like the kanban and Priorities), and the
 * edit/restore actions. Restoring an idea brings it back to the open backlog
 * (the deliver verb is the only way in, restore the only way out).
 */
import type { IdeasClient } from './ideas-client.ts';
import type { IdeaRecord } from '../core/ideas.ts';
export interface DeliveredViewProps {
    client: IdeasClient;
    /** Archived + deliveredAt ideas of the current scope, unsorted. */
    deliveredIdeas: readonly IdeaRecord[];
    /** Resolve a workspace id to its display label. */
    workspaceTitle: (workspaceId: string) => string;
    /** Open the shared edit modal on the given idea. */
    onEdit: (idea: IdeaRecord) => void;
    /** Render descriptions as markdown (raw text otherwise), like the kanban. */
    mdMode: boolean;
}
export declare function DeliveredView({ client, deliveredIdeas, workspaceTitle, onEdit, mdMode }: DeliveredViewProps): import("react").JSX.Element;
