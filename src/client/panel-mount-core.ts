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

import { createRoot, type Root } from 'react-dom/client'
import { subscribeBodyInvalidations } from './body-mutations.ts'

/** Options for mountCenterPanel; consumers supply the panel tree and attribute names. */
export interface CenterPanelMountOptions {
  /** Render the panel tree (first open, remount while open, locale refresh). */
  render: (root: Root) => void
  /** dataset key of the injected container's view attribute, e.g. `dshIdeasView` for `data-dsh-ideas-view`. */
  viewDatasetKey: string
  /** value of the container's L2 `data-dsh-plugin` semantic attribute. */
  pluginName: string
  /** stylesheet class applied to the injected container. */
  viewClassName: string
  /** <html> attribute set while this panel is active. */
  activeAttribute: string
  /** the sibling panel's active attribute, removed from <html> when this panel opens. */
  siblingActiveAttribute: string
  /** detail value this panel broadcasts on the cross-plugin activation event. */
  panelName: string
  /** sibling detail value whose activation closes this panel. */
  siblingPanelName: string
  /** open flag of the owning controller. */
  isOpen: () => boolean
  /** close the panel, handing the center column back to the conversation. */
  close: () => void
  /** subscribe to the owning controller's open-state changes; returns an unsubscriber. */
  subscribe: (listener: () => void) => () => void
}

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
// Sidebar rows whose clicks hand the center column back to the conversation.
// Capture phase, so the panel closes before the shell processes the click.
const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * Mount a family panel into the center column and bind its visibility to the
 * owning controller's open state.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountCenterPanel(options: CenterPanelMountOptions): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined && !container.isConnected) {
      // The conversation pane was replaced; drop the stale tree and remount.
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    if (container === undefined) {
      const column = conversationColumn()
      if (column === undefined) return
      container = document.createElement('div')
      container.dataset[options.viewDatasetKey] = ''
      container.dataset.dshPlugin = options.pluginName
      container.className = options.viewClassName
      column.appendChild(container)
    }
    // Keep a visited tree mounted so drafts and edits survive close/reopen;
    // an unused panel needs neither a React root nor effects.
    if (root !== undefined || !options.isOpen()) return
    root = createRoot(container)
    options.render(root)
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const unsubscribeBody = subscribeBodyInvalidations(() => { ensure() })

  const applyActive = (): void => {
    if (options.isOpen()) {
      ensure()
      // Single-occupant center column: opening this panel must evict the
      // sibling panel, both its html attribute and its controller state,
      // otherwise the two panels' visibility rules fight.
      document.documentElement.removeAttribute(options.siblingActiveAttribute)
      document.documentElement.setAttribute(options.activeAttribute, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: options.panelName }))
    } else {
      document.documentElement.removeAttribute(options.activeAttribute)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail === options.siblingPanelName && options.isOpen()) {
      options.close()
    }
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!options.isOpen()) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) options.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = options.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    unsubscribeBody()
    unsubscribe()
    document.documentElement.removeAttribute(options.activeAttribute)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
