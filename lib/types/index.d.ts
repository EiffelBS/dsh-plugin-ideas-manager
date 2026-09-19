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
export declare const IDEAS_GUIDANCE = "dsh-plugin-ideas-manager is installed (generic idea manager, \"Ideas\" board in the sidebar under New Session): a Host-authoritative /api/ideas ledger, one idea record per workspace (workspaceId; absent = generic), rendered as a 3-column kanban (open / archived / declined) with an Overview tab and a ranked Priorities tab. The ledger is the SOURCE OF TRUTH for ideas \u2014 it replaces any IDEAS.md / IDEAS-ARCHIVE.md file convention; the markdown export is a generated view only (ledger -> IDEAS.md / IDEAS-ARCHIVE.md), never parsed back. When the user mentions ideas / backlog / idees / notes, collaborate through this board.\n\nWorkflow: (1) CAPTURE into the ledger, never into a markdown file: title + a body holding the analysis as markdown (context, value, effort, first-step sketch / execution info, risks). (2) On capture, record a PRIORITY OPINION: set value + effort levels and suggest a rank. (3) RE-RANK the whole open backlog against the current project state on every material change (new idea, delivery, scope change): the Priorities ranking stays the current best ordering, never a plain append; re-rank only on material change and ranks stay advisory (scheduling is the author's call). (4) LIFECYCLE: delivered ideas leave the open backlog with a record of the delivery; declined ideas leave with a decision note. (5) TaskBoard mirror (when the task-board plugin is present; one-way, best-effort): capture -> backlog card, updates -> card update, decline -> archive; delivered cards are closed by the author's closure run (done is runner-owned \u2014 never automate idea -> done from here). The board is autonomous without the task-board plugin.";
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
