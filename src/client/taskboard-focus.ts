/**
 * Bring the human from a refused launch to the exact card that refused it.
 *
 * The TaskBoard plugin exposes no cross-plugin way to preselect a card: the
 * `main` slot is keyed and carries no selection payload, the board publishes no
 * client service, and there is no deeplink. What it does have is a filter field
 * ("Filter tasks...") that matches TITLE, description, tags and freeze — never
 * the task id. So the redirect is: bring the board panel to the front, then
 * write the idea TITLE into that filter, which is the text the card is actually
 * filed under.
 *
 * The panel is selected the way the sidebar row itself does it. The row's glyph
 * carries `data-dsh-panel-entry="task-board"` (the only DOM the board owns
 * inside the shell-owned button), and clicking that button calls the shell's
 * live `selectPanel`. That click is preferred over this plugin's layout face:
 * on the Desktop shell the face can be missing or refuse the id, while the
 * sidebar row the human would click is still there. The layout face remains
 * the fallback for a shell whose row has not mounted yet.
 *
 * Writing the input is deliberate DOM surgery rather than a contract call,
 * because no contract exists. It is therefore defensive end to end: the native
 * value setter is used (a React-controlled input ignores a plain assignment),
 * a bubbling `input` event carries the change into the board's state, the
 * lookup is scoped to the board's own panel, the retries are bounded, and every
 * failure degrades to "the board is open, type the title yourself" — the
 * message shown to the user carries the title either way.
 */

import { TASK_BOARD_PANEL_ID, type PanelNavigator } from './panel-navigation.ts'

/** The board's own panel anchor (stamped by its main-slot occupant). */
const BOARD_PANEL_SELECTOR = '[data-dsh-taskboard-view]'
/** The filter field inside it. */
const BOARD_FILTER_SELECTOR = 'input[type="search"]'
/** How long we keep looking for the field after the panel was selected. */
const DEFAULT_ATTEMPTS = 20
const DEFAULT_DELAY_MS = 50

/** Retry budget; `attempts <= 1` tries once and gives up. */
export interface FocusOptions {
  attempts?: number
  delayMs?: number
}

/** The single pending retry, replaced (never stacked) by the next call. */
let pendingRetry: ReturnType<typeof setTimeout> | undefined

/**
 * Open the TaskBoard panel and filter it on `filter` (the idea title).
 *
 * The field usually is not in the DOM yet — selecting a panel mounts it on the
 * next React commit — so the write is retried on a bounded schedule. Exactly one
 * retry loop is ever pending: a second call replaces the first, which keeps a
 * user clicking through several refusals from stacking timers.
 *
 * @param navigator - the shell panel face; undefined means "no layout service".
 * @param filter - text to type into the board's filter field.
 * @param options - retry budget (tests shrink it).
 * @returns true when a panel selection was issued (sidebar row or layout face),
 *   false when neither is available (nothing to do, and nothing failed either).
 */
export function openTaskBoardFiltered(
  navigator: PanelNavigator | undefined,
  filter: string,
  options: FocusOptions = {},
): boolean {
  if (pendingRetry !== undefined) {
    clearTimeout(pendingRetry)
    pendingRetry = undefined
  }
  if (!selectTaskBoardPanel(navigator)) return false
  const needle = filter.trim()
  // An already-mounted board answers on the first try; anything else is the
  // panel-selection case, which needs the retry below.
  if (needle === '' || applyBoardFilter(needle)) return true

  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  let tries = 1
  const retry = (): void => {
    pendingRetry = undefined
    if (applyBoardFilter(needle)) return
    tries += 1
    if (tries >= attempts) return
    pendingRetry = setTimeout(retry, delayMs)
  }
  pendingRetry = setTimeout(retry, delayMs)
  return true
}

/**
 * Write `text` into the board's filter field, as the board's own React state.
 * @returns true when the field was found and updated.
 */
export function applyBoardFilter(text: string): boolean {
  const input = boardFilterInput()
  if (input === undefined) return false
  setInputValue(input, text)
  // React's onChange is driven by the native `input` event; dispatching it here
  // is what makes the board filter (and re-render) instead of only painting the
  // field, which the next re-render would then wipe.
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/**
 * Bring the TaskBoard panel to the front.
 *
 * The sidebar row wins when it is mounted: that button is the shell's own
 * `selectPanel` call, so a deployment whose layout face this plugin cannot
 * reach still navigates. The face is the fallback for a row that has not
 * mounted yet.
 * @returns true when a selection was issued.
 */
function selectTaskBoardPanel(navigator: PanelNavigator | undefined): boolean {
  const row = taskBoardSidebarButton()
  if (row !== undefined) {
    row.click()
    return true
  }
  if (navigator === undefined) return false
  navigator.select(TASK_BOARD_PANEL_ID)
  return true
}

/**
 * The shell button that owns the TaskBoard glyph, or undefined when the
 * sidebar row is not mounted.
 */
function taskBoardSidebarButton(): HTMLButtonElement | undefined {
  const glyph = document.querySelector(`[data-dsh-panel-entry="${TASK_BOARD_PANEL_ID}"]`)
  if (glyph === null) return undefined
  const button = glyph.closest('button')
  return button instanceof HTMLButtonElement ? button : undefined
}

/** The filter field of the mounted board, scoped to its own panel. */
function boardFilterInput(): HTMLInputElement | undefined {
  const panel = document.querySelector<HTMLElement>(BOARD_PANEL_SELECTOR)
  if (panel === null) return undefined
  return panel.querySelector<HTMLInputElement>(BOARD_FILTER_SELECTOR) ?? undefined
}

/**
 * Set a controlled input's value through its prototype setter: assigning
 * `input.value` directly is invisible to React, which tracks the previous value
 * and would swallow the following change event as a no-op.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
    return
  }
  setter.call(input, value)
}
