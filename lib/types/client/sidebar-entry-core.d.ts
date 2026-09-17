/**
 * Sidebar entry injection core (same discipline as the dsh-task-board /
 * dsh-ssh family: shared logic lives once here, packages supply their icon,
 * copy, CSS classes, ordering and toggle through options).
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into,
 * so the entry row is injected between the shell's New Session button and the
 * workspace browser. The injection self-heals: a MutationObserver watches the
 * sidebar root and re-inserts the row whenever a React re-render displaces it
 * (re-insertion happens in the same frame, before paint, so no flicker).
 *
 * The row is plain DOM (no React tree) so it can never disturb the shell's
 * reconciliation; the view it toggles is a separate root owned by the caller.
 */
/** Per-package configuration for one sidebar entry row. */
export interface SidebarEntryOptions {
    /** Full attribute name identifying the injected row (idempotency key), e.g. 'data-dsh-ideas-entry'. */
    rowAttribute: string;
    /** CSS selector matching the injected row, e.g. '[data-dsh-ideas-entry]'. */
    rowSelector: string;
    /** L2 semantic-attribute plugin id; when set the row outputs data-dsh-plugin="<id>". */
    plugin?: string;
    /** Inline icon markup (matches the shell's 16px nav-icon look). */
    icon: string;
    /** CSS class names for the row and its two spans (entry / entryIcon / entryLabel). */
    css: Record<string, string>;
    /** Localized row label (aria-label + visible text). */
    label(): string;
    /** Optional localized tooltip (title attribute). */
    tooltip?(): string;
    /** Click action (open/toggle the owning panel). */
    onToggle(): void;
    /** Family-block position: 'before' inserts ahead of sibling plugin rows, 'after' behind them. */
    position: 'before' | 'after';
    /**
     * Selectors of the sibling plugin entry rows this package orders against
     * (its own row included). Each package passes the same list it wants to
     * stay ordered with so the rendered order is stable across re-renders.
     */
    familySelectors: readonly string[];
    /** Optional active-state bridge; highlights the row while the panel is open. */
    active?: {
        subscribe(listener: () => void): () => void;
        isOpen(): boolean;
    };
}
/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @returns disposer removing the entry and its observers.
 */
export declare function mountSidebarEntry(options: SidebarEntryOptions): () => void;
