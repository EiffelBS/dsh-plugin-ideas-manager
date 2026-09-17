/**
 * Host loader entry for the dsh-plugin-ideas-manager plugin.
 *
 * The Host owns the (P0 in-memory) ideas ledger, the /api/ideas routes, and
 * the discrete system-prompt announcement. The browser is a same-origin
 * asynchronous view over that service, mounted through the ./client entry.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
export declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const IDEAS_GUIDANCE = "dsh-plugin-ideas-manager is installed (generic idea manager, \"Ideas\" board in the sidebar under New Session): Host-authoritative /api/ideas ledger per workspace; capture ideas and triage them on a 3-column kanban (open / archived / declined) with tags, value/effort scores and manual rank; one-directional markdown export (ledger -> IDEAS.md / IDEAS-ARCHIVE.md); optional TaskBoard mirror when the task-board plugin is present (create -> backlog, move, decline -> archive; closing the loop to done is manual). The board is autonomous without the task-board plugin. When the user mentions ideas / backlog / idees / notes, collaborate through this board.";
/**
 * Settings namespace of the ideas announcement capability — the section the
 * web settings surface will edit (P1). Spelled here rather than imported: the
 * browser half spells the same value and must not depend on a Host package.
 */
export declare const IDEAS_SETTINGS_NAMESPACE: "ideas";
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
    /** Master switch for the plugin (browser half + host routes). */
    enabled?: boolean;
    /**
     * When true, a system-prompt section announces the board to every agent.
     * Set false (default) to keep the board silent in prompts.
     */
    announceToAgent?: boolean;
    /** Whether the TaskBoard mirror is attempted when the bridge is detected (P2). */
    autoMirror?: boolean;
}
export declare const Config: z<Config>;
/**
 * Register the ideas host: ledger + routes, plus the announcement section
 * gated on the composition entry's `announceToAgent`.
 * @param ctx - the plugin context (webServer + systemPrompt injected).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export declare const apply: typeof applyImpl;
declare function applyImpl(ctx: Context, config?: Config): void;
export {};
