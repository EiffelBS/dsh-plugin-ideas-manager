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
  /**
   * Every family sibling's active attribute, removed from <html> when this
   * panel opens. The center column is single-occupant and each family
   * stylesheet hides every child that is not its own view with !important,
   * so two active attributes at once blank the whole column: the single
   * upstream sibling shape (taskboard<->ssh) would leave a third family
   * member's stale attribute fighting this panel.
   */
  siblingActiveAttributes: readonly string[]
  /** detail value this panel broadcasts on the cross-plugin activation event. */
  panelName: string
  /**
   * Detail values whose activation closes this panel. The upstream family
   * contract is a strict pair (the task-board closes on 'ssh', ssh closes on
   * 'taskboard'), so a third member must list every sibling here — otherwise
   * that sibling's broadcast leaves this controller open over its panel.
   */
  siblingPanelNames: readonly string[]
  /**
   * Extra detail values broadcast on open, besides `panelName`. The upstream
   * pair members only self-close on the OTHER member's panel name, so this
   * list carries every sibling name: each currently-open sibling controller
   * then closes and can no longer re-assert its active attribute on the next
   * host tick (which would otherwise evict this panel minutes later).
   */
  evictDetails?: readonly string[]
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
  // Set while THIS panel broadcasts its own activation. A broadcast detail
  // can also be one of our own close triggers ('taskboard' closes this panel
  // too), so the synchronous dispatch must not close us back. Per-instance,
  // not module-level: sibling panels stay responsive to the broadcast even
  // when they share this module copy (tests, HMR re-mounts).
  let broadcasting = false
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
      // Single-occupant center column: opening this panel must evict every
      // family sibling, both its html attributes and its controller state,
      // otherwise the panels' visibility rules fight and the column goes
      // blank (each family stylesheet hides anything that is not its own
      // view with !important).
      for (const attribute of options.siblingActiveAttributes) {
        document.documentElement.removeAttribute(attribute)
      }
      document.documentElement.setAttribute(options.activeAttribute, '')
      // Broadcast this panel's own activation plus every extra eviction
      // detail (see evictDetails), so the sibling controllers self-close.
      // The in-flight flag keeps a broadcast detail that is also one of our
      // own close triggers from closing us back (see onOtherActivate).
      broadcasting = true
      try {
        for (const detail of [options.panelName, ...(options.evictDetails ?? [])]) {
          document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail }))
        }
      } finally {
        broadcasting = false
      }
    } else {
      document.documentElement.removeAttribute(options.activeAttribute)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if (broadcasting) return
    const detail = (event as CustomEvent).detail
    if (detail !== undefined && options.siblingPanelNames.includes(detail) && options.isOpen()) {
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
