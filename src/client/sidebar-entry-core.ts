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

import { subscribeBodyInvalidations } from './body-mutations.ts'

/** Per-package configuration for one sidebar entry row. */
export interface SidebarEntryOptions {
  /** Full attribute name identifying the injected row (idempotency key), e.g. 'data-dsh-ideas-entry'. */
  rowAttribute: string
  /** CSS selector matching the injected row, e.g. '[data-dsh-ideas-entry]'. */
  rowSelector: string
  /** L2 semantic-attribute plugin id; when set the row outputs data-dsh-plugin="<id>". */
  plugin?: string
  /** Inline icon markup (matches the shell's 16px nav-icon look). */
  icon: string
  /** CSS class names for the row and its two spans (entry / entryIcon / entryLabel). */
  css: Record<string, string>
  /** Localized row label (aria-label + visible text). */
  label(): string
  /** Optional localized tooltip (title attribute). */
  tooltip?(): string
  /** Click action (open/toggle the owning panel). */
  onToggle(): void
  /** Family-block position: 'before' inserts ahead of sibling plugin rows, 'after' behind them. */
  position: 'before' | 'after'
  /**
   * Selectors of the sibling plugin entry rows this package orders against
   * (its own row included). Each package passes the same list it wants to
   * stay ordered with so the rendered order is stable across re-renders.
   */
  familySelectors: readonly string[]
  /** Optional active-state bridge; highlights the row while the panel is open. */
  active?: {
    subscribe(listener: () => void): () => void
    isOpen(): boolean
  }
}

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  // Current shells wrap the sidebar UI: column > wrapper > root(logoRow owner).
  // Prefer the element that owns the logo row — the real sidebar UI root —
  // and fall back to the column's first child for legacy shells.
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(options: SidebarEntryOptions): { entry: HTMLButtonElement } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(options.rowAttribute, '')
  if (options.plugin !== undefined) {
    entry.setAttribute('data-dsh-plugin', options.plugin)
    entry.setAttribute('data-dsh-part', 'sidebar-entry')
  }
  entry.className = options.css['entry'] ?? ''
  const labelSpan = document.createElement('span')
  labelSpan.className = options.css['entryLabel'] ?? ''
  const iconSpan = document.createElement('span')
  iconSpan.className = options.css['entryIcon'] ?? ''
  iconSpan.innerHTML = options.icon
  entry.append(iconSpan, labelSpan)
  const applyLabel = (): void => {
    entry.setAttribute('aria-label', options.label())
    if (options.tooltip !== undefined) entry.setAttribute('title', options.tooltip())
    labelSpan.textContent = options.label()
  }
  applyLabel()
  entry.addEventListener('click', options.onToggle)
  return { entry }
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement, options: SidebarEntryOptions): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    // Position relative to the family block (entries injected by sibling
    // plugins), never relative to transient logoRow geometry: every family
    // plugin that self-heals during a re-render then lands in the same
    // relative order, so the entries cannot swap positions regardless of
    // observer callback order or of shell wrapper changes.
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(options.familySelectors.join(', ')),
    )
    const anchor = options.position === 'before'
      ? (family.length > 0 ? family[0] : base.nextElementSibling)
      : (family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling)
    root.insertBefore(entry, anchor)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(options: SidebarEntryOptions): () => void {
  // DOM-level idempotency: never mount a second row (duplicated apply, HMR
  // re-injection, stale module still alive). The existing row keeps working;
  // a full page reload is the ultimate reset.
  if (typeof document !== 'undefined' && document.querySelector(options.rowSelector) !== null) {
    return () => {}
  }
  const { entry } = createEntry(options)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      // The shell rebuilt the sidebar pane (whole-tree teardown); the root
      // observer is gone with the old tree, so detach it and re-query from
      // scratch. The new pane is later noticed by the body-level watcher.
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      // Cheap short-circuit: entry still lives in a mountable subtree.
      if (document.body.contains(entry)) return
      // Entry was torn down together with the old tree; reset and re-place.
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry, options)
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  // Body-level watcher retained as the "whole rebuild" fallback: when the
  // shell tears down the whole sidebar pane, the root observer is gone with
  // it and only this body observation can notice the new pane mounting.
  const unsubscribeBody = subscribeBodyInvalidations(() => { tryPlace() })

  // Self-heal: if a React re-render displaces the row, re-insert it in the
  // same frame (microtask before paint -> no visible flicker).
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      placed = placeEntry(root, entry, options)
    }
  })

  // Reflect the panel's open state on the row (active highlight). Assigning
  // undefined to dataset.active would materialize data-active="undefined" and
  // keep the row permanently highlighted — delete the attribute instead.
  const unsubscribeActive = options.active === undefined ? undefined : (() => {
    const syncActive = (): void => {
      if (options.active!.isOpen()) entry.dataset.active = 'true'
      else delete entry.dataset.active
    }
    const unsubscribe = options.active.subscribe(syncActive)
    syncActive()
    return unsubscribe
  })()

  tryPlace()

  return () => {
    unsubscribeBody()
    rootObserver.disconnect()
    unsubscribeActive?.()
    entry.remove()
  }
}
