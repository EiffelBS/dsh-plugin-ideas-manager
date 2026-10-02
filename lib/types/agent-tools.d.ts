/**
 * Agent tools for the Ideas board (idea #92).
 *
 * Until now an agent that wanted to write an idea had to hand-build the
 * `{requestId, action, initiator}` envelope, survive the PowerShell/BOM traps
 * of doing it from a shell, and know the re-rank policy by heart. These six
 * tools are the DSH-native counterpart of the board UI, exactly as the task
 * board's own `task_board_*` tools are: any session can capture, triage, launch
 * and settle idea work without a browser.
 *
 * Three rules make this surface trustworthy rather than merely convenient:
 *
 *  - **One path, not two.** A tool never re-implements a verb. It builds the
 *    same JSON envelope the HTTP route accepts and hands it to
 *    {@link parseActionEnvelope} (or {@link parseLaunchBody} for a launch)
 *    BEFORE calling the Host service, so the wire gate that refuses an unknown
 *    key refuses it here too, and a tool call and an HTTP call cannot drift.
 *  - **No HTTP loopback.** Every call goes straight to the Host service object
 *    inside the Host process; nothing leaves the machine and nothing depends on
 *    the web server being up.
 *  - **An agent cannot forge the Host's own bookkeeping.** `runStatus`,
 *    `runSessionId` and `taskBoardId` are host-written system fields the wire
 *    gate never accepts from an idea verb; {@link writableAction} re-checks
 *    them here so the invariant survives a future refactor of the gate.
 *
 * Domain refusals come back as `ok:false` values the model can read and act on
 * rather than as thrown errors, and every read is bounded.
 *
 * Deliberately absent: any way to confirm a permission, raise a card, or take
 * the mirror's own decisions. Those are the human's.
 *
 * @module dsh-plugin-ideas-manager/agent-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IdeaRecord } from './core/ideas.ts';
import { type IdeasSnapshot } from './protocol.ts';
/**
 * The initiator the tools stamp on every write. It is what makes an agent's
 * write readable as one in the idea's own activity log ("an agent did this"),
 * exactly like the analyst sessions' `ai-capture` / `ai-reanalyze` labels.
 */
export declare const IDEAS_TOOL_INITIATOR = "plugin:ideas-manager:agent-tool";
/** Registered tool names, in registration order. */
export declare const IDEAS_TOOL_NAMES: readonly ["ideas_list", "ideas_get", "ideas_capture", "ideas_triage", "ideas_launch", "ideas_review"];
/**
 * The narrow Host face the tools need. `IdeasHostService` satisfies it
 * structurally, so tests and a future host drive the same surface.
 */
export interface IdeasToolHost {
    /** Current full ledger snapshot (metadata; the tools project it themselves). */
    snapshot(): IdeasSnapshot;
    /** One full record, or undefined when the id is unknown. */
    idea(id: string): IdeaRecord | undefined;
    /** Submit one confirmed Host action (the same call POST /api/ideas/action makes). */
    apply(requestId: string, action: unknown, initiator?: string): unknown;
    /** Start an execution (the same call POST /api/ideas/launch makes). */
    launchIdea(ideaId: string, model?: string, requestId?: string): Promise<unknown>;
}
/** One model-facing content block (structurally the DSH `ContentBlock` text node). */
interface ToolTextBlock {
    type: 'text';
    text: string;
}
/** Execution identity the registry passes to a tool body (duck-typed on purpose). */
export interface IdeasToolRunContext {
    signal?: AbortSignal;
    agent?: unknown;
}
/**
 * A registry-ready tool definition. Declared structurally, not imported from
 * `@deepseek-ai/dsh-tools`: the registry consumes `{name, description,
 * parameters, output, execute}` and nothing else, and this plugin must keep
 * booting on a Host that serves no tools service at all — so it must not make
 * the tools package a load-time dependency of its own entry point.
 */
export interface IdeasToolDefinition {
    readonly name: string;
    readonly description: string;
    /** Model-facing parameter schema: a compiled object-rooted JSON Schema. */
    readonly parameters: Record<string, unknown>;
    readonly output: {
        /** Canonical output schema; `{}` is the standard unconstrained-JSON form. */
        readonly schema: Record<string, unknown>;
        render(args: unknown, value: unknown): ToolTextBlock[];
    };
    execute(args: unknown, exec: IdeasToolRunContext): Promise<unknown>;
}
/**
 * Whether an action the tools are about to submit carries a host-written system
 * field. Belt and braces over the wire gate: if the gate is ever relaxed, this
 * stays the reason an agent cannot forge a run stamp or claim a card.
 * @param action - the action object about to be submitted.
 */
export declare function carriesSystemField(action: unknown): boolean;
/**
 * Build the six ideas tools for one Host service.
 * @param host - the Host service face (satisfied by `IdeasHostService`).
 * @returns the tool definitions, in {@link IDEAS_TOOL_NAMES} order.
 */
export declare function buildIdeasTools(host: IdeasToolHost): IdeasToolDefinition[];
/** The registry face the agent tools register into. */
export interface IdeasToolRegistry {
    register(definition: IdeasToolDefinition): () => void;
}
/**
 * Resolve the optional agent-tool registry. The board deliberately does not
 * INJECT it: a deployment whose runtime serves no tools service must still
 * mount the whole board and lose only the agent-tool surface — the same
 * tolerance the optional session gateway gets.
 * @param ctx - the plugin context.
 * @returns the registry, or undefined when this deployment serves none.
 */
export declare function resolveToolRegistry(ctx: Context): IdeasToolRegistry | undefined;
/**
 * Register the six `ideas_*` tools, and only when the board is enabled.
 *
 * Registration is idempotent per registry and disposed with the fiber that owns
 * it: a `tools` service that activates (or is replaced) after this row is
 * followed through scoped injection where the runtime serves one, and a
 * capture-only context registers through the direct resolution. A missing
 * registry is a downgrade to "no agent tools", never a boot failure — the board
 * and its routes keep working exactly as before.
 *
 * @param ctx - the plugin context.
 * @param host - the Host service face the tools drive.
 * @param isEnabled - live master switch; a disabled board answers no tool call.
 */
export declare function installIdeasAgentTools(ctx: Context, host: IdeasToolHost, isEnabled: () => boolean): void;
export {};
