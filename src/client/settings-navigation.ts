/**
 * Open the DSH Settings modal on this plugin's section.
 *
 * The shell keeps its active section as private React state and exposes no
 * open-section API, so the header gear drives the DOM the shell actually
 * paints. Two shells are in the field, and a deployment has exactly one of
 * them:
 *
 * 1. Dialog trigger (the web shell, and any build that still paints the
 *    fallback sidebar button): the only shell button carrying both
 *    `aria-haspopup="dialog"` and an aria-label from the host locale dict
 *    ("Settings" / "设置"). Clicking it opens the modal on the first section.
 * 2. Account launcher (the Desktop shell since 0.2.0-rc.2): `settings.launcher`
 *    replaces that button with an account menu (`aria-haspopup="menu"`,
 *    labelled "Account menu" / "账号菜单"). Settings is a menuitem inside it;
 *    choosing the item calls the same `open()` the dialog trigger used to.
 *
 * Either way the follow-up click is our nav row, matched by every dictionary's
 * label: the host resolves `label()` when it builds the dialog, so the row can
 * carry the boot language while the panel renders in the pinned one. Matching
 * only the current label opened the modal without selecting Ideas.
 *
 * When neither hook matches, log and leave the GUI untouched — never throw.
 */

import { t, SETTINGS_NAV_LABELS } from './locales.ts'

/** Host locale labels of the fallback settings button (`t("trigger")`). */
const DIALOG_TRIGGER_LABELS = ['Settings', '设置'] as const

/**
 * Host locale labels of the account menu button (`t("menu")`). The visible
 * caption can be the signed-in name or "More"; the accessible name stays this.
 */
const ACCOUNT_MENU_LABELS = ['Account menu', '账号菜单'] as const

/** Host locale labels of the Settings menuitem (`t("settings")`). */
const SETTINGS_ITEM_LABELS = ['Settings', '设置'] as const

/** How long we keep looking after a click before giving up. */
const OPEN_DEADLINE_MS = 800

/**
 * Find our settings nav row inside an open dialog, or undefined.
 * @returns the row button, when the dialog is open and the label matches.
 */
export function findIdeasSettingsNavRow(): HTMLButtonElement | undefined {
  const labels = [t('settings.nav'), ...SETTINGS_NAV_LABELS]
  for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
    if (!dialog.isConnected) continue
    for (const button of Array.from(dialog.querySelectorAll('nav button'))) {
      const text = (button.textContent ?? '').trim()
      if (labels.includes(text)) return button as HTMLButtonElement
    }
  }
  return undefined
}

/** The fallback settings button, or undefined when this shell does not paint it. */
export function findHostSettingsTrigger(): HTMLButtonElement | undefined {
  return findButton('button[aria-haspopup="dialog"]', DIALOG_TRIGGER_LABELS)
}

/**
 * The account menu button that owns the Settings item on the Desktop shell.
 * @returns the button, or undefined when this shell still uses the dialog trigger.
 */
export function findAccountMenuTrigger(): HTMLButtonElement | undefined {
  return findButton('button[aria-haspopup="menu"]', ACCOUNT_MENU_LABELS)
}

/**
 * The Settings row of an open account menu.
 * @returns the menuitem, or undefined while the menu is closed or unlabelled.
 */
export function findSettingsMenuItem(): HTMLButtonElement | undefined {
  for (const item of Array.from(document.querySelectorAll('[role="menu"] button[role="menuitem"]'))) {
    const text = (item.textContent ?? '').trim()
    if (SETTINGS_ITEM_LABELS.some(label => text === label || text.startsWith(label))) {
      return item as HTMLButtonElement
    }
  }
  return undefined
}

/**
 * Open Settings on this plugin's section.
 *
 * An already-open dialog is selected directly. Otherwise the dialog trigger is
 * preferred (one click, then the row), and the account menu is the Desktop
 * path (open the menu, choose Settings, then the row).
 */
export function openIdeasSettingsSection(): void {
  if (clickIdeasNavRow()) return

  const dialogTrigger = findHostSettingsTrigger()
  if (dialogTrigger !== undefined) {
    dialogTrigger.click()
    watchFor(clickIdeasNavRow, () => {
      console.warn('[dsh-plugin-ideas-manager] settings dialog did not render in time: section select skipped')
    })
    return
  }

  const account = findAccountMenuTrigger()
  if (account === undefined) {
    console.warn('[dsh-plugin-ideas-manager] settings trigger not found: looked for the dialog button ("Settings"/"设置") and the account menu ("Account menu"/"账号菜单")')
    return
  }
  // A second click toggles the menu shut, so only open it when it is closed.
  if (account.getAttribute('aria-expanded') !== 'true') account.click()
  let itemClicked = false
  watchFor(() => {
    if (clickIdeasNavRow()) return true
    if (itemClicked) return false
    const item = findSettingsMenuItem()
    if (item === undefined) return false
    itemClicked = true
    item.click()
    return clickIdeasNavRow()
  }, () => {
    console.warn('[dsh-plugin-ideas-manager] settings dialog did not render in time: section select skipped')
  })
}

/** Click our nav row when the dialog is already open. */
function clickIdeasNavRow(): boolean {
  const row = findIdeasSettingsNavRow()
  if (row === undefined) return false
  row.click()
  return true
}

/**
 * The first button matching `selector` whose accessible name is one of `labels`.
 * @param selector - button query, including the popup kind.
 * @param labels - host locale labels to accept.
 */
function findButton(selector: string, labels: readonly string[]): HTMLButtonElement | undefined {
  for (const button of Array.from(document.querySelectorAll(selector))) {
    const label = button.getAttribute('aria-label') ?? ''
    if (labels.includes(label)) return button as HTMLButtonElement
  }
  return undefined
}

/**
 * Run `step` on the next frames until it reports done or the deadline passes.
 * The shell commits the menu and the dialog on a later React frame, so the
 * first look is the frame after the click, not the click itself.
 * @param step - returns true when the section has been selected.
 * @param onTimeout - called once when the deadline passes with the step still false.
 */
function watchFor(step: () => boolean, onTimeout: () => void): void {
  const deadline = performance.now() + OPEN_DEADLINE_MS
  const tick = (): void => {
    if (step()) return
    if (performance.now() < deadline) requestAnimationFrame(tick)
    else onTimeout()
  }
  requestAnimationFrame(tick)
}
