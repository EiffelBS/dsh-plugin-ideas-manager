/**
 * Open the DSH Settings modal on this plugin's section.
 *
 * The shell keeps its active section as private React state and exposes no
 * open-section API, so the header gear drives the DOM the shell actually
 * paints. Two shells are in the field, and a deployment has exactly one of
 * them:
 *
 * 1. Dialog trigger (the web shell, and any build that still paints the
 *    fallback sidebar button): a button with `aria-haspopup="dialog"` whose
 *    accessible name comes from the host locale dict.
 * 2. Account launcher (the Desktop shell since 0.2.0-rc.2): `settings.launcher`
 *    replaces that button with an account menu (`aria-haspopup="menu"`).
 *    Settings is a menuitem inside it; choosing the item opens the same dialog.
 *
 * Host chrome is LOCALIZED — eight languages since DSH 0.2 — so a lookup that
 * compares translated text breaks the moment the user switches language: on a
 * French UI the Settings row reads "Paramètres" and a gear that only knew
 * "Settings"/"设置" silently did nothing. This module therefore reaches for
 * structural facts first and falls back to text only for hosts that predate
 * them:
 *
 * 1. **The settings shortcut's accessible combination.** Every shell paints
 *    `aria-keyshortcuts` equal to the effective `settings.open` binding on the
 *    dialog trigger and on the account-menu Settings item. That string is
 *    language-free, and reading it from the live shortcut catalog means a
 *    rebound key follows the user instead of a default we hard-coded.
 * 2. **Our own nav-row marker.** The section icon we register through
 *    `settings.section.icon` (DSH >= 0.2.2) lives inside our nav row and
 *    carries `data-dsh-ideas-settings-icon`, so selecting the section no
 *    longer depends on the label at all.
 * 3. **Text, as the last resort**, covering every language the shipped host
 *    dictionaries carry (en, zh, ja, es, fr, de, ru, pt) instead of English
 *    and Chinese alone.
 *
 * When nothing matches, log and leave the GUI untouched — never throw.
 */

import { t, SETTINGS_NAV_LABELS } from './locales.ts'

/**
 * The one word the Settings entry carries in every shipped host dictionary
 * (`settings.general.trigger`, `settings.account.settings`). Simplified and
 * traditional Chinese both select the row, hence both 设置 and 設定.
 */
const SETTINGS_LABELS = [
  'Settings',
  '设置',
  '設定',
  'Paramètres',
  'Einstellungen',
  'Configuración',
  'Configurações',
  'Настройки',
] as const

/** Host locale labels of the fallback settings button (`t("trigger")`). */
const DIALOG_TRIGGER_LABELS = SETTINGS_LABELS

/**
 * Host locale labels of the account menu button (`t("menu")`). The visible
 * caption can be the signed-in name or "More"; the accessible name stays this.
 */
const ACCOUNT_MENU_LABELS = [
  'Account menu',
  '账号菜单',
  'アカウントメニュー',
  'Menu du compte',
  'Kontomenü',
  'Menú de cuenta',
  'Меню аккаунта',
  'Menu da conta',
] as const

/** Host locale labels of the Settings menuitem (`t("settings")`). */
const SETTINGS_ITEM_LABELS = SETTINGS_LABELS

/**
 * Marker the registered `settings.section.icon` paints inside OUR nav row.
 * The shell stamps no per-entry hook on a nav button, so the icon it asks us
 * for is the one DOM node that is guaranteed to be ours.
 */
const NAV_ICON_MARKER = '[data-dsh-ideas-settings-icon]'

/** Selectors that identify the mounted Settings panel in either shell. */
const PANEL_SELECTOR = '[role="dialog"], [data-shortcut-modal="settings"]'

/** How long we keep looking after a click before giving up. */
const OPEN_DEADLINE_MS = 800

/**
 * Live reader for the effective `settings.open` accessible combination.
 *
 * Set by the plugin that owns the shortcut catalog (see
 * `configureSettingsShortcut`); read at CLICK time, because the user can rebind
 * the key while the page is open. Undefined on a deployment that serves no
 * shortcuts service, which simply means every lookup falls back to labels.
 */
let shortcutSource: (() => string | undefined) | undefined

/**
 * Publish the live shortcut reader used by the gear.
 * @param read - returns the effective `settings.open` aria string, or undefined.
 * @returns a disposer clearing the reader (only when it is still the current one).
 */
export function configureSettingsShortcut(read: () => string | undefined): () => void {
  shortcutSource = read
  return () => {
    if (shortcutSource === read) shortcutSource = undefined
  }
}

/**
 * Read the effective `settings.open` shortcut's accessible combination from a
 * cordis client context (`ctx.get("shortcuts")` -> catalog snapshot).
 *
 * The value is the same string the shell writes into `aria-keyshortcuts`, which
 * makes it a language-free way to recognize both Settings entry points. A
 * context without the service, or a user who unbound the command, yields
 * undefined and the caller falls back to labels.
 *
 * @param ctx - the client root context, read defensively: never throws.
 * @returns the aria string (for example `Control+,`), or undefined.
 */
export function readSettingsShortcutAria(ctx: unknown): string | undefined {
  if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  try {
    const host = ctx as { get?: (name: string) => unknown }
    const face = typeof host.get === 'function' ? host.get('shortcuts') : undefined
    const catalog = (face as { catalog?: { getSnapshot?: () => unknown } } | undefined)?.catalog
    const rows = catalog?.getSnapshot?.()
    if (!Array.isArray(rows)) return undefined
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const entry = row as { id?: unknown; aria?: unknown }
      if (entry.id !== 'settings.open') continue
      return typeof entry.aria === 'string' && entry.aria.length > 0 ? entry.aria : undefined
    }
  } catch {
    // An undeclared cordis service getter throws; a gear that degrades to
    // labels is the whole contract here.
    return undefined
  }
  return undefined
}

/** The aria string currently advertised for `settings.open`, if any. */
function settingsShortcutAria(): string | undefined {
  try {
    const aria = shortcutSource?.()
    return typeof aria === 'string' && aria.length > 0 ? aria : undefined
  } catch {
    return undefined
  }
}

/**
 * Find our settings nav row inside an open dialog, or undefined.
 *
 * The registered section icon is tried first: it is ours, so no label — in any
 * language — can break the lookup. Older shells (no `settings.section.icon`)
 * fall through to the row label, matched against every dictionary this plugin
 * ships.
 * @returns the row button, when its section is mounted.
 */
export function findIdeasSettingsNavRow(): HTMLButtonElement | undefined {
  const marker = document.querySelector(NAV_ICON_MARKER)
  if (marker !== null) {
    const button = marker.closest('button')
    if (button !== null) return button
  }
  const labels = [t('settings.nav'), ...SETTINGS_NAV_LABELS]
  for (const panel of settingsPanels()) {
    for (const button of Array.from(panel.querySelectorAll('nav button'))) {
      const text = (button.textContent ?? '').trim()
      if (labels.includes(text)) return button as HTMLButtonElement
    }
  }
  return undefined
}

/**
 * The fallback settings button, or undefined when this shell does not paint it.
 *
 * The shortcut's `aria-keyshortcuts` identifies it without reading localized
 * text; the label list keeps hosts from before that attribute working.
 * @returns the dialog trigger, when this deployment paints one.
 */
export function findHostSettingsTrigger(): HTMLButtonElement | undefined {
  const aria = settingsShortcutAria()
  const byShortcut = findButtonByShortcut('button[aria-haspopup="dialog"]', aria)
  if (byShortcut !== undefined) return byShortcut
  return findButton('button[aria-haspopup="dialog"]', DIALOG_TRIGGER_LABELS)
}

/**
 * The account menu button that owns the Settings item on the Desktop shell.
 *
 * The launcher paints `data-signed-out` on its anchor in every language (a DOM
 * fact, not copy), which is the structural identity; the localized accessible
 * name stays as the fallback for shells that predate the attribute.
 * @returns the button, or undefined when this shell still uses the dialog trigger.
 */
export function findAccountMenuTrigger(): HTMLButtonElement | undefined {
  const structural = document.querySelector('button[aria-haspopup="menu"][data-signed-out]')
  if (structural !== null) return structural as HTMLButtonElement
  return findButton('button[aria-haspopup="menu"]', ACCOUNT_MENU_LABELS)
}

/**
 * The Settings row of an open account menu.
 *
 * The row's `aria-keyshortcuts` carries the same language-free identity as the
 * trigger; when the user unbound the shortcut, the label is matched against
 * every shipped host language (the keycap suffix some shells append is why the
 * text comparison accepts a prefix).
 * @returns the menuitem, or undefined while the menu is closed or unlabelled.
 */
export function findSettingsMenuItem(): HTMLButtonElement | undefined {
  const items = Array.from(document.querySelectorAll('[role="menu"] button[role="menuitem"]'))
  const aria = settingsShortcutAria()
  if (aria !== undefined) {
    for (const item of items) {
      if (item.getAttribute('aria-keyshortcuts') === aria) return item as HTMLButtonElement
    }
  }
  for (const item of items) {
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
 * An already-open panel is selected directly (the row may mount a frame late,
 * so it is watched for). Otherwise the dialog trigger is preferred (one click,
 * then the row), and the account menu is the Desktop path (open the menu,
 * choose Settings, then the row).
 */
export function openIdeasSettingsSection(): void {
  if (clickIdeasNavRow()) return

  // A panel that is already mounted but has not painted our row yet: wait for
  // it instead of clicking a trigger that would toggle chrome the user did not
  // ask to touch.
  if (settingsPanel() !== undefined) {
    watchFor(clickIdeasNavRow, () => {
      console.warn('[dsh-plugin-ideas-manager] settings panel is open but the Ideas section row did not appear')
    })
    return
  }

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
    const aria = settingsShortcutAria()
    console.warn(
      '[dsh-plugin-ideas-manager] settings trigger not found: tried the dialog button ' +
      `(aria-keyshortcuts ${JSON.stringify(aria ?? null)}, labels ${DIALOG_TRIGGER_LABELS.map(label => JSON.stringify(label)).join(', ')}) ` +
      `and the account menu (labels ${ACCOUNT_MENU_LABELS.map(label => JSON.stringify(label)).join(', ')})`,
    )
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

/** Every element that may be the mounted Settings panel. */
function settingsPanels(): Element[] {
  return Array.from(document.querySelectorAll(PANEL_SELECTOR))
}

/** The first mounted Settings panel, or undefined. */
function settingsPanel(): Element | undefined {
  return document.querySelector(PANEL_SELECTOR) ?? undefined
}

/**
 * The first button matching `selector` whose `aria-keyshortcuts` is `aria`.
 * @param selector - button query, including the popup kind.
 * @param aria - the accessible combination to match, or undefined to skip.
 */
function findButtonByShortcut(selector: string, aria: string | undefined): HTMLButtonElement | undefined {
  if (aria === undefined) return undefined
  for (const button of Array.from(document.querySelectorAll(selector))) {
    if (button.getAttribute('aria-keyshortcuts') === aria) return button as HTMLButtonElement
  }
  return undefined
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
