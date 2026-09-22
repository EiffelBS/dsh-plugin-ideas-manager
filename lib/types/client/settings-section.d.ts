/**
 * Settings surface for the plugin: a section in the DSH Settings modal,
 * registered through the shell's `settings.section` slot, reading and writing
 * the `ideas` settings namespace through the plugin's OWN fenced
 * /api/ideas/config route (the DSH settings RPC domain serves only
 * allowlisted namespaces to configuration clients - the Side card precedent).
 *
 * Two jobs, one install function:
 *  - applyTagChipRows runs on every IdeasClient config change and pushes the
 *    `tagRows` row budget onto the document (--dsh-ideas-tag-chip-rows), which
 *    the chip-zone rule reads through calc();
 *  - registerIdeasSettingsSection contributes the nav row + page when the
 *    shell exposes the slots contract; a shell without it still gets the
 *    style wiring (never throws - the GUI must survive this plugin).
 *
 * Copy discipline: every option carries an explicit title AND a description
 * stating what it changes, its range and its default; failures render inline
 * instead of silently reverting.
 */
import type { IdeasClient } from './ideas-client.ts';
/** Structural face of the shell slot registry (no ui-slots dependency). */
export interface SettingsSlotsFace {
    inject(name: string, factory: () => unknown): () => void;
    register(options: unknown, component: unknown): () => void;
}
/**
 * Push the tag-filter row budget (settings option `tagRows`, 1..5) onto the
 * document as --dsh-ideas-tag-chip-rows; the chips rule reads it through
 * calc(). Idempotent and clamped, so a corrupt wire can never break layout.
 */
export declare function applyTagChipRows(rows: number): void;
/** Props injected by the registration (the shell adds its own runtime props). */
export interface IdeasSettingsSectionProps {
    client: IdeasClient;
    /** Shell runtime props (ignored - the page renders the plugin's own copy). */
    [key: string]: unknown;
}
/** The section page: heading, intro, and the option rows (settings recipe). */
export declare function IdeasSettingsSection({ client }: IdeasSettingsSectionProps): import("react").JSX.Element;
/**
 * Install the settings glue: wire `tagRows` from the client's config onto the
 * document (a settings write updates the open board live) and register the
 * Settings-modal section when the shell exposes the slots contract. A context
 * without slots still gets the style wiring. Returns the combined disposer.
 */
export declare function registerIdeasSettingsSection(ctx: unknown, client: IdeasClient): () => void;
