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
/**
 * Publish the live shortcut reader used by the gear.
 * @param read - returns the effective `settings.open` aria string, or undefined.
 * @returns a disposer clearing the reader (only when it is still the current one).
 */
export declare function configureSettingsShortcut(read: () => string | undefined): () => void;
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
export declare function readSettingsShortcutAria(ctx: unknown): string | undefined;
/**
 * Find our settings nav row inside an open dialog, or undefined.
 *
 * The registered section icon is tried first: it is ours, so no label — in any
 * language — can break the lookup. Older shells (no `settings.section.icon`)
 * fall through to the row label, matched against every dictionary this plugin
 * ships.
 * @returns the row button, when its section is mounted.
 */
export declare function findIdeasSettingsNavRow(): HTMLButtonElement | undefined;
/**
 * The fallback settings button, or undefined when this shell does not paint it.
 *
 * The shortcut's `aria-keyshortcuts` identifies it without reading localized
 * text; the label list keeps hosts from before that attribute working.
 * @returns the dialog trigger, when this deployment paints one.
 */
export declare function findHostSettingsTrigger(): HTMLButtonElement | undefined;
/**
 * The account menu button that owns the Settings item on the Desktop shell.
 *
 * The launcher paints `data-signed-out` on its anchor in every language (a DOM
 * fact, not copy), which is the structural identity; the localized accessible
 * name stays as the fallback for shells that predate the attribute.
 * @returns the button, or undefined when this shell still uses the dialog trigger.
 */
export declare function findAccountMenuTrigger(): HTMLButtonElement | undefined;
/**
 * The Settings row of an open account menu.
 *
 * The row's `aria-keyshortcuts` carries the same language-free identity as the
 * trigger; when the user unbound the shortcut, the label is matched against
 * every shipped host language (the keycap suffix some shells append is why the
 * text comparison accepts a prefix).
 * @returns the menuitem, or undefined while the menu is closed or unlabelled.
 */
export declare function findSettingsMenuItem(): HTMLButtonElement | undefined;
/**
 * Open Settings on this plugin's section.
 *
 * An already-open panel is selected directly (the row may mount a frame late,
 * so it is watched for). Otherwise the dialog trigger is preferred (one click,
 * then the row), and the account menu is the Desktop path (open the menu,
 * choose Settings, then the row).
 */
export declare function openIdeasSettingsSection(): void;
