/**
 * Multi-select and bulk actions on the board (idea #94): the per-row select
 * box, the selection bar, and the bulk dialog that runs a batch and reports it
 * idea by idea.
 *
 * The three components here are deliberately thin. Every rule — what may be
 * selected, which verbs a batch posts, what a skip or a failure means — lives in
 * the pure modules `selection.ts` and `bulk.ts`, so this file only renders them
 * and posts the ordinary per-idea verbs through `IdeasClient`. There is no
 * bulk-only verb and no ledger write anywhere on this path.
 *
 * The bar always states what "all" means: how many are selected, how many the
 * current filter shows, and which workspace / tags / search produced that set.
 * That sentence is the difference between "everything" (what the user sees) and
 * "everything" (what the batch would touch).
 */
import type { IdeasClient } from './ideas-client.ts';
import type { IdeaListRow } from '../protocol.ts';
import type { WorkspaceCatalogEntry } from './workspaces.ts';
import { type BulkOperation } from './bulk.ts';
/**
 * Per-row select box. A real button with `role="checkbox"` (keyboard reachable
 * and announced), stopping propagation so picking a row never opens the editor
 * underneath it, and honouring shift-click for a range.
 *
 * The tick is drawn by a CSS pseudo-element, NOT by a child span: this control
 * renders on EVERY card of every view, and at 140 cards a second node per card
 * is ~140 extra DOM nodes on every re-render of the board (the search
 * keystroke and the workspace scoping both re-render all of them). One node per
 * row is the whole budget this affordance spends.
 */
export declare function SelectBox({ checked, onToggle, label }: {
    checked: boolean;
    onToggle: (shiftKey: boolean) => void;
    label: string;
}): import("react").JSX.Element;
/** The selection bar: the count, the scope sentence and the three bulk actions. */
export declare function SelectionBar({ selectedCount, scopeTotal, scopeLabel, wholeScope, busy, onSelectAll, onClear, onTag, onWorkspace, onArchive, }: {
    selectedCount: number;
    /** How many ideas the active filter shows (the denominator of "all"). */
    scopeTotal: number;
    /** One sentence naming the scope: workspace, tags and search in force. */
    scopeLabel: string;
    wholeScope: boolean;
    busy: boolean;
    onSelectAll: () => void;
    onClear: () => void;
    onTag: () => void;
    onWorkspace: () => void;
    onArchive: () => void;
}): import("react").JSX.Element;
/**
 * The bulk dialog: confirm -> run -> report, in one modal so the batch keeps the
 * author's attention until it is settled. Every verb goes through `IdeasClient`;
 * a refusal is recorded against the idea that hit it and the batch continues,
 * because the report owes a per-idea answer rather than a single error line.
 */
export declare function BulkDialog({ client, operation, rows, catalog, scopeLabel, onClose }: {
    client: IdeasClient;
    operation: BulkOperation;
    /** The selected rows, in scope order (what the batch operates on). */
    rows: readonly IdeaListRow[];
    catalog: readonly WorkspaceCatalogEntry[];
    /** The scope sentence the selection bar already states; repeated here so a
     *  batch is never posted from a dialog that lost the "of what" half. */
    scopeLabel: string;
    onClose: () => void;
}): import("react").JSX.Element;
