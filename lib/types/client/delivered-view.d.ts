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
 * The run-state tags are the shared RunStateBadges of the Overview
 * card header: a run started while the idea was already under review or
 * archived stays followed by the host poll until the stamp clears, so the
 * journal must not hide a row whose execution is still in flight.
 *
 * The delivery note rides along on the same rows: this tab is the
 * exit log, so "what was delivered" belongs beside "when it was delivered" —
 * and the editor reachable from here is the surface a reader lands on when the
 * journal is not enough.
 */
import type { IdeasClient } from './ideas-client.ts';
import type { IdeaListRow } from '../protocol.ts';
import type { RelationView } from './relations.ts';
export interface DeliveredViewProps {
    client: IdeasClient;
    /** Archived list rows of the current scope, unsorted. */
    archivedIdeas: readonly IdeaListRow[];
    /** Resolve a workspace id to its display label. */
    workspaceTitle: (workspaceId: string) => string;
    /** Open the shared edit modal on the given row (fetches the full body first). */
    onEdit: (idea: IdeaListRow) => void;
    /** Open ANOTHER idea's editor from a relation chip (the id it names). */
    onOpenIdea?: (ideaId: string) => void;
    /** Toggle a tag in the shared conjunctive filter (same state as kanban). */
    onToggleTag: (name: string) => void;
    /** Currently selected filter tags (highlighted row pills). */
    activeTags: readonly string[];
    /** Render descriptions as markdown (raw text otherwise), like the kanban. */
    mdMode: boolean;
    /**
     * Resolve the parent of a follow-up child into its ledger number.
     * The board owns the id -> idea map and passes the resolver down.
     */
    parentNumber?: (ideaId: string) => number | undefined;
    /** Multi-select: ids of the current selection, board-wide. */
    selectedIds?: ReadonlySet<string>;
    /** Multi-select: toggle this row, or extend a range on shift-click. */
    onSelect?: (ideaId: string, shiftKey: boolean) => void;
    /**
     * Relation lines per idea id, derived ONCE per paint by the board
     * over the WHOLE snapshot. Passed in rather than recomputed: this view only
     * receives the SCOPED rows, so it cannot resolve a `#N` on its own, and a row
     * that links to a card outside the current filter would print a bare id.
     * Undefined means "no relations anywhere", which renders no line at all.
     */
    relations?: ReadonlyMap<string, readonly RelationView[]>;
}
/**
 * The Delivered log's display order, exported so the board's multi-select
 * ranges over exactly the rows this view paints: a shift-click
 * block must be the block the author sees, in the order they see it.
 */
export declare function deliveredRows(ideas: readonly IdeaListRow[]): IdeaListRow[];
export declare function DeliveredView({ client, archivedIdeas, workspaceTitle, onEdit, onOpenIdea, onToggleTag, activeTags, mdMode, parentNumber, selectedIds, onSelect, relations }: DeliveredViewProps): import("react").JSX.Element;
