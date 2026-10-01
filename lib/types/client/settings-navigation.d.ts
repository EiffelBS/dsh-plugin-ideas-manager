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
/**
 * Find our settings nav row inside an open dialog, or undefined.
 * @returns the row button, when the dialog is open and the label matches.
 */
export declare function findIdeasSettingsNavRow(): HTMLButtonElement | undefined;
/** The fallback settings button, or undefined when this shell does not paint it. */
export declare function findHostSettingsTrigger(): HTMLButtonElement | undefined;
/**
 * The account menu button that owns the Settings item on the Desktop shell.
 * @returns the button, or undefined when this shell still uses the dialog trigger.
 */
export declare function findAccountMenuTrigger(): HTMLButtonElement | undefined;
/**
 * The Settings row of an open account menu.
 * @returns the menuitem, or undefined while the menu is closed or unlabelled.
 */
export declare function findSettingsMenuItem(): HTMLButtonElement | undefined;
/**
 * Open Settings on this plugin's section.
 *
 * An already-open dialog is selected directly. Otherwise the dialog trigger is
 * preferred (one click, then the row), and the account menu is the Desktop
 * path (open the menu, choose Settings, then the row).
 */
export declare function openIdeasSettingsSection(): void;
