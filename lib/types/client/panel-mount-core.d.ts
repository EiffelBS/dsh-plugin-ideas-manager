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
    /** the sibling panel's active attribute, removed from <html> when this panel opens. */
    siblingActiveAttribute: string;
    /** detail value this panel broadcasts on the cross-plugin activation event. */
    panelName: string;
    /** sibling detail value whose activation closes this panel. */
    siblingPanelName: string;
    /**
     * Extra detail values broadcast on open, besides `panelName`. A family
     * panel we do not own (e.g. the task-board) only self-closes on its own
     * declared sibling, so broadcasting its value here closes that controller
     * when this panel takes the column — otherwise a stale open state
     * re-asserts its active attribute later and evicts this panel.
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
