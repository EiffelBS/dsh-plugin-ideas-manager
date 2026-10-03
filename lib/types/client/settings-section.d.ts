/**
 * Settings surface for the plugin: a section in the DSH Settings modal,
 * registered through the shell's `settings.section` slot, reading and writing
 * the `ideas` settings namespace through the plugin's OWN fenced
 * /api/ideas/config route (the DSH settings RPC domain serves only
 * allowlisted namespaces to configuration clients - the Side card precedent).
 *
 * Three jobs, one install function:
 *  - applyTagChipRows runs on every IdeasClient config change and pushes the
 *    `tagRows` row budget onto the document (--dsh-ideas-tag-rows), which
 *    the tag-zone rule reads through calc();
 *  - the Display and About tabs render the plugin's own copy of its options
 *    and its metadata;
 *  - registerIdeasSettingsSection contributes the nav row + page when the
 *    shell exposes the slots contract; a shell without it still gets the
 *    style wiring (never throws - the GUI must survive this plugin).
 *
 * The Backup tab (idea #95, `client/backup-panel.tsx`) drives its OWN Host
 * routes rather than the settings port, so a deployment whose settings service
 * is unavailable still gets snapshots, restore and the portable export: only
 * the display options above degrade to the spelled defaults.
 *
 * Copy discipline: every option carries an explicit title AND a description
 * stating what it changes, its range/default and when it applies; failures
 * render inline instead of silently reverting. Controls commit immediately
 * (selects and toggle switches), except the number row which stages its draft
 * and commits on blur/Enter so typing never writes per keystroke.
 */
import type { IdeasClient } from './ideas-client.ts';
/** One tab in the settings section. */
export type SettingsTab = 'display' | 'backup' | 'about';
/** Structural face of the shell slot registry (no ui-slots dependency). */
export interface SettingsSlotsFace {
    inject(name: string, factory: () => unknown): () => void;
    register(options: unknown, component: unknown): () => void;
}
/**
 * Push the tag-filter row budget (settings option `tagRows`, 1..5) onto the
 * document as --dsh-ideas-tag-rows; the tag-zone rule reads it through
 * calc(). Idempotent and clamped, so a corrupt wire can never break layout.
 */
export declare function applyTagChipRows(rows: number): void;
/** Props injected by the registration (the shell adds its own runtime props). */
export interface IdeasSettingsSectionProps {
    client: IdeasClient;
    /** Shell runtime props (ignored - the page renders the plugin's own copy). */
    [key: string]: unknown;
}
/** The section page: heading, tabs, status lines, and the option rows. */
export declare function IdeasSettingsSection({ client }: IdeasSettingsSectionProps): import("react").JSX.Element;
/**
 * Install the settings glue: wire `tagRows` from the client's config onto the
 * document (a settings write updates the open board live) and register the
 * Settings-modal section when the shell exposes the slots contract. A context
 * without slots still gets the style wiring. Returns the combined disposer.
 */
export declare function registerIdeasSettingsSection(ctx: unknown, client: IdeasClient): () => void;
