/**
 * Center-column panel takeover lifecycle (same discipline as the
 * dsh-task-board / dsh-ssh family).
 *
 * The `conversation` slot is single-occupant and external plugins cannot
 * declare slots, so a family panel takes over the center column at the DOM
 * level: a container is appended inside the center column as an extra
 * trailing child React never manages, and a stylesheet rule hides the
 * conversation content while the panel is active. Toggling is a data
 * attribute on <html> — no React involvement, so the conversation subtree
 * underneath stays mounted and stateful.
 */
import { type Root } from 'react-dom/client';
/** Options for mountCenterPanel; consumers supply the panel tree and attribute names. */
export interface CenterPanelMountOptions {
    /** Render the panel tree (first open, remount while open, locale refresh). */
    render: (root: Root) => void;
    /** dataset key of the injected container's view attribute, e.g. `dshIdeasView` for `data-dsh-ideas-view`. */
    viewDatasetKey: string;
    /** value of the container's L2 `data-dsh-plugin` semantic attribute. */
    pluginName: string;
    /** stylesheet class applied to the injected container. */
    viewClassName: string;
    /** <html> attribute set while this panel is active. */
    activeAttribute: string;
    /**
     * Every family sibling's active attribute, removed from <html> when this
     * panel opens. The center column is single-occupant and each family
     * stylesheet hides every child that is not its own view with !important,
     * so two active attributes at once blank the whole column: the single
     * upstream sibling shape (taskboard<->ssh) would leave a third family
     * member's stale attribute fighting this panel.
     */
    siblingActiveAttributes: readonly string[];
    /** detail value this panel broadcasts on the cross-plugin activation event. */
    panelName: string;
    /**
     * Detail values whose activation closes this panel. The upstream family
     * contract is a strict pair (the task-board closes on 'ssh', ssh closes on
     * 'taskboard'), so a third member must list every sibling here — otherwise
     * that sibling's broadcast leaves this controller open over its panel.
     */
    siblingPanelNames: readonly string[];
    /**
     * Extra detail values broadcast on open, besides `panelName`. The upstream
     * pair members only self-close on the OTHER member's panel name, so this
     * list carries every sibling name: each currently-open sibling controller
     * then closes and can no longer re-assert its active attribute on the next
     * host tick (which would otherwise evict this panel minutes later).
     */
    evictDetails?: readonly string[];
    /** open flag of the owning controller. */
    isOpen: () => boolean;
    /** close the panel, handing the center column back to the conversation. */
    close: () => void;
    /** subscribe to the owning controller's open-state changes; returns an unsubscriber. */
    subscribe: (listener: () => void) => () => void;
}
/**
 * Mount a family panel into the center column and bind its visibility to the
 * owning controller's open state.
 * @returns disposer unmounting the tree and restoring the column.
 */
export declare function mountCenterPanel(options: CenterPanelMountOptions): () => void;
