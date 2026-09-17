/**
 * Ideas board stylesheet (plain CSS, injected once per page) and the class
 * map consumed by the sidebar core and the React board. Scoped by the
 * plugin's own data attributes so nothing leaks into the rest of the GUI;
 * colors ride the dsh --dsw-* tokens so the board follows the active theme
 * (light/dark and skins).
 */
/** Class map consumed by the sidebar core and the board JSX. */
export declare const classes: {
    readonly entry: "dsh-ideas-entry";
    readonly entryIcon: "dsh-ideas-entry-icon";
    readonly entryLabel: "dsh-ideas-entry-label";
    readonly boardView: "dsh-ideas-board-view";
    readonly board: "dsh-ideas-board";
    readonly boardHeader: "dsh-ideas-board-header";
    readonly boardTitle: "dsh-ideas-board-title";
    readonly backButton: "dsh-ideas-back-button";
    readonly detailMeta: "dsh-ideas-detail-meta";
    readonly search: "dsh-ideas-search";
    readonly primaryButton: "dsh-ideas-primary-button";
    readonly ghostButton: "dsh-ideas-ghost-button";
    readonly error: "dsh-ideas-error";
    readonly columns: "dsh-ideas-columns";
    readonly column: "dsh-ideas-column";
    readonly columnHeader: "dsh-ideas-column-header";
    readonly columnTitle: "dsh-ideas-column-title";
    readonly columnCount: "dsh-ideas-column-count";
    readonly columnBody: "dsh-ideas-column-body";
    readonly empty: "dsh-ideas-empty";
    readonly card: "dsh-ideas-card";
    readonly cardHeader: "dsh-ideas-card-header";
    readonly cardTitle: "dsh-ideas-card-title";
    readonly cardGrip: "dsh-ideas-card-grip";
    readonly cardBody: "dsh-ideas-card-body";
    readonly cardMeta: "dsh-ideas-card-meta";
    readonly tag: "dsh-ideas-tag";
    readonly score: "dsh-ideas-score";
    readonly overlay: "dsh-ideas-overlay";
    readonly modal: "dsh-ideas-modal";
    readonly modalTitle: "dsh-ideas-modal-title";
    readonly field: "dsh-ideas-field";
    readonly fieldRow: "dsh-ideas-field-row";
    readonly fieldLabel: "dsh-ideas-field-label";
    readonly input: "dsh-ideas-input";
    readonly textarea: "dsh-ideas-textarea";
    readonly modalActions: "dsh-ideas-modal-actions";
    readonly tagFilterRow: "dsh-ideas-tag-filter-row";
    readonly tagFilterLabel: "dsh-ideas-tag-filter-label";
    readonly filterChip: "dsh-ideas-filter-chip";
    readonly filterChipActive: "dsh-ideas-filter-chip-active";
    readonly dragHint: "dsh-ideas-drag-hint";
    readonly cardWrapper: "dsh-ideas-card-wrapper";
    readonly cardActions: "dsh-ideas-card-actions";
    readonly actionButton: "dsh-ideas-action-button";
    readonly dangerButton: "dsh-ideas-danger-button";
    readonly confirmLabel: "dsh-ideas-confirm-label";
};
/** Inject the stylesheet once per page (idempotent, plugin-owned tag). */
export declare function ensureIdeasStyle(): void;
