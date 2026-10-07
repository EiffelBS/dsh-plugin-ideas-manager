/**
 * Phase 3 — "Start AI analysis and create the idea": a workspace-targeted
 * capture is handed to a fresh DSH session instead of being created manually.
 * The modal closes immediately (non-blocking, like the manual Create); the
 * new session analyses the idea, writes it to the ledger through the agent
 * write channel (POST /api/ideas/action over loopback, see
 * docs/agent-write-channel.md), applies a priority opinion + per-workspace
 * rank, and reports the ranking decision to the human in the session.
 *
 * The DSH session controller is consumed DEFENSIVELY (duck-typed and
 * optional), mirroring the workspaces/session-context discipline: when the
 * "sessions" service is absent or malformed the resolver returns undefined
 * and the board keeps the plain manual Create for workspace-targeted captures.
 */
import type { IdeaEvent, IdeaSimilarSignal, IdeaStatus } from '../core/ideas.ts';
/**
 * The captured idea handed to the analysing session. The human's priority
 * opinion fields (value/effort/rationale/rank) are optional: the analyst
 * honors them when set and decides them otherwise.
 */
export interface AiCaptureInput {
    /** Target workspace of the new idea (never the generic group). */
    workspaceId: string;
    /** Display title of the target workspace, for the analyst's context. */
    workspaceTitle: string;
    title: string;
    body: string;
    tags: readonly string[];
    value?: number;
    effort?: number;
    rationale?: string;
    /** Human-suggested 1-based rank inside the workspace's open backlog. */
    rank?: number;
    /** Optional explicit model selection for the analysing session (provider + model). */
    model?: ModelChoice;
}
/**
 * One adapter-owned reasoning effort level, as the catalog's
 * `reasoning.efforts` entries expose it. The ids are opaque adapter strings
 * (`ReasoningEffortId` is a branded `string`), never a fixed enumeration —
 * the picker reads them from the catalog and never hardcodes a list.
 */
export interface ReasoningEffortOption {
    id: string;
    name: string;
    description?: string;
}
/**
 * A selectable model for the analysing session. The `provider` is the Host
 * model-provider group id; `model` is the model id inside that group —
 * together they form the `ModelSelection` the session controller installs for
 * a Session (`selectModel`). `label` is the display string for the picker.
 *
 * `reasoningEffort` is the effort the picker preselects (the model's catalog
 * `defaultEffort` when present); `reasoningEfforts` is the full list of
 * levels the model declares, empty when it declares none. Both come from the
 * catalog, so a model without reasoning support carries neither.
 */
export interface ModelChoice {
    provider: string;
    model: string;
    reasoningEffort?: string;
    reasoningEfforts?: readonly ReasoningEffortOption[];
    label: string;
}
/** Result of handing the capture to a session. */
export interface AiLaunchResult {
    /** True when the prompt was queued into the new session. */
    accepted: boolean;
}
/**
 * The existing idea handed back to the analyst for a RE-ANALYZE run:
 * a fresh DSH session re-reads the stored card and overwrites it with a
 * new analysis through the same write channel (update + triage on the SAME
 * idea id — never a create, never a recursive re-analysis: every run is
 * triggered by an explicit human click on the board).
 */
export interface ReanalyzeInput {
    /** Target workspace of the idea (the session runs in it). */
    workspaceId: string;
    /** Display title of the target workspace, for the analyst's context. */
    workspaceTitle: string;
    /** The stored idea id the analyst MUST update (never create). */
    ideaId: string;
    /** The stable "#N" human reference of the idea (resolved and verified by the analyst). */
    ideaNumber?: number;
    title: string;
    /** Compact stored metadata; the analyst still reloads it from the list projection first. */
    summary?: string;
    status: 'open' | 'underReview' | 'archived' | 'declined';
    /** Mirrored TaskBoard card id, when one exists. */
    taskBoardId?: string;
    tags: readonly string[];
    /** Current stored priority opinion (the analyst re-decides them). */
    value?: number;
    effort?: number;
    rationale?: string;
    /**
     * The idea's recorded activity log, oldest first. Handed to the
     * analyst so a re-analysis reads the real past — "declined on 2026-09-20
     * because …" — instead of re-deriving a history it cannot see. Empty when the
     * board has recorded nothing for this idea yet.
     */
    activity?: readonly IdeaEvent[];
    /** Optional explicit model selection for the analysing session. */
    model?: ModelChoice;
}
/**
 * A session model selection: the provider + model (+ optional reasoning
 * effort) a session runs on. Mirrors the Host `ModelSelection` type.
 */
export interface ModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
/**
 * One candidate of a FIND SIMILAR run, as the board hands it over: the
 * server-computed cheap signal plus the identity the analyst needs to read
 * the candidate's real body. `score` is a heuristic the analyst is told to
 * distrust — it exists to bound and order the set, not to answer the question.
 */
export interface SimilarCandidateHint {
    /** The candidate idea id (the exact selector for the deferred-body read). */
    id: string;
    /** The stable "#N" human reference, absent on a row without one. */
    ideaNumber?: number;
    /** The candidate's title (never its body: this is metadata, not content). */
    title: string;
    /** The board's cheap 0..1 signal score — a ranking hint, never a verdict. */
    score: number;
    /** Which cheap signals fired (normalized title, tag overlap). */
    signals: readonly IdeaSimilarSignal[];
}
/**
 * The existing idea handed to a FIND SIMILAR run together with its bounded
 * candidate set. The judgement belongs to the analyst session; the board only
 * supplies the signal and the scope. This run NEVER writes — not even when
 * two candidates turn out to be the same idea.
 */
export interface FindSimilarInput {
    /** Target workspace of the idea (the session runs in it). */
    workspaceId: string;
    /** Display title of the target workspace, for the analyst's context. */
    workspaceTitle: string;
    /** The idea under review — the anchor of the scan. */
    ideaId: string;
    /** The stable "#N" human reference of the anchor, when it has one. */
    ideaNumber?: number;
    title: string;
    summary?: string;
    status: IdeaStatus;
    tags: readonly string[];
    /** The bounded candidate set, strongest first (already server-capped). */
    candidates: readonly SimilarCandidateHint[];
    /**
     * How many open same-workspace peers the scan actually compared. Handed to
     * the analyst so its report can say what was left out — a bounded set the
     * reader cannot see the bounds of would read as "these are all the similar
     * ideas", which is not what the board knows.
     */
    scanned: number;
    /** Optional explicit model selection for the judging session. */
    model?: ModelChoice;
}
/**
 * The write face the board uses to launch an AI capture. Resolved once per
 * page from the cordis "sessions" service; undefined degrades to manual.
 */
export interface SessionLauncher {
    launch(input: AiCaptureInput): Promise<AiLaunchResult>;
    /** Re-run the analyst on an existing idea; same session mechanics. */
    launchReanalyze(input: ReanalyzeInput): Promise<AiLaunchResult>;
    /**
     * Ask the analyst to judge a bounded near-duplicate candidate set (Find
     * similar). Same session mechanics again, dedicated prompt; it reports and
     * never writes.
     */
    launchFindSimilar(input: FindSimilarInput): Promise<AiLaunchResult>;
    /** List the models available for an analysing session (empty when unavailable). */
    listModels(): Promise<ModelChoice[]>;
    /**
     * The model selection of the CURRENT host session (the one the human is
     * talking in), read from its `modelSelection` projection. The board uses it
     * to preselect the model picker so an untouched picker matches the session
     * — never the catalog's first row. Undefined when the projection is absent
     * or malformed.
     */
    currentModel(): Promise<ModelSelection | undefined>;
}
/** Cordis service name (same face the active-workspace hint already reads). */
export declare const SESSIONS_SERVICE = "sessions";
/** Minimal duck-typed faces of the DSH session controller we actually use. */
interface DshPromptSession {
    prompt(content: readonly {
        type: 'text';
        text: string;
    }[], mode: 'queue'): Promise<{
        ok: boolean;
        value?: {
            accepted: true;
        };
        error?: unknown;
    }>;
}
/**
 * Defensive shape of the Host >= 0.1.7 `ClientSessionReference` returned by
 * `retainAgentScope(id)`: the retained record exposes the scoped context on
 * `binding.ctx` (NOT `binding.session` — that is the live Session object) and
 * the reference carries a synchronous, idempotent `release()`.
 */
interface RetainedAgentScope {
    binding?: {
        ctx?: unknown;
    };
    release?: () => void;
}
interface DshSessionsController {
    create(opts?: {
        workspaceId?: string;
        cwd?: string;
        sessionId?: string;
    }): Promise<string>;
    scope(id: string): unknown;
    sessionOf(ctx: unknown): DshPromptSession | undefined;
    /**
     * Optional identity retention (Host >= 0.1.7): retain the Agent scope of a
     * freshly created session SYNCHRONOUSLY, materializing it when it is not yet
     * catalogued. On Host <= 0.1.5 the method does not exist and `scope(id)`
     * still materializes on demand, so the caller falls back to it — typed as
     * optional so the face stays compatible with both Host definitions.
     */
    retainAgentScope?(id: string): RetainedAgentScope | undefined;
    /** Optional Host model catalog (the `remote.session.modelCatalog` RPC). */
    modelCatalog?(): Promise<{
        ok: boolean;
        value?: DshModelCatalog;
        error?: {
            code?: string;
            message?: string;
        };
    }>;
    /** Optional Session-local model selection (the `remote.session.selectModel` RPC). */
    selectModel?(selection: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
    }): Promise<{
        ok: boolean;
        value?: {
            selected: unknown;
        };
        error?: {
            code?: string;
            message?: string;
        };
    }>;
    /** Optional live session list (the `sessions.list` stream the shell exposes). */
    list?: {
        getSnapshot(): {
            current?: string;
            byId?: Record<string, {
                cwd?: string;
            }>;
        };
    };
    /** Optional per-session binding (the shell session controller's `binding(id)`). */
    binding?(id: string): {
        session?: {
            projections?: {
                faceOf(key: string): unknown;
            };
        };
    } | undefined;
}
/** Duck-typed shape of the Host model catalog (see `ModelCatalog` in DSH types). */
interface DshModelGroup {
    id: string;
    name: string;
    models: readonly {
        id: string;
        name: string;
        description?: string;
        reasoning?: DshModelReasoning;
    }[];
}
/** Duck-typed shape of the per-model `reasoning` block the catalog exposes. */
interface DshModelReasoning {
    efforts: readonly ReasoningEffortOption[];
    defaultEffort?: string;
}
interface DshModelCatalog {
    default?: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
    groups?: readonly DshModelGroup[];
}
/**
 * The cordis client context this plugin runs under. Only the pieces the model
 * picker needs are typed here: the `sessions` service (create/scope/sessionOf)
 * and, as a fallback source for the model catalog, the generated `remote.session`
 * namespace — the official client surface a selector uses (`modelCatalog` /
 * `selectModel`). Both are consumed defensively.
 */
interface LauncherClientContext {
    get(name: string): unknown;
    remote?: {
        session?: Partial<DshSessionsController>;
    };
}
/**
 * The Phase 3 launch prompt (minimal). Everything about how to analyze an idea
 * and how to write it back — the body structure, title policy, tag format,
 * per-workspace rank semantics, and the full write-channel contract (envelope,
 * verbs, limits, UTF-8) — lives in the `ideas-analyst` skill, which the
 * analysing session loads from its catalog itself.
 *
 * The prompt therefore carries only what the skill CANNOT know, because it is
 * per-capture or per-instance:
 *   - which workspace (title + id) the idea belongs to,
 *   - the human draft (title, body, suggested tags),
 *   - the optional priority hints,
 *   - the server **origin** (the address of the DSH web server hosting the
 *     board — it varies per instance, so only the prompt can supply it),
 *   - the bounded summary selector, which overrides an older first-wins
 *     installed skill during rollout.
 *
 * This keeps the prompt tiny and free of duplication: the skill is the single
 * source of the contract.
 */
export declare function buildAnalysisPrompt(input: AiCaptureInput, origin: string): string;
/**
 * The RE-ANALYZE launch prompt. Same split as the capture
 * prompt: the skill carries the methodology and the write-channel contract;
 * this prompt carries only what the skill cannot know — the target idea, the
 * workspace, and the server origin — plus the re-analysis overrides (which
 * idea id to update, which initiator to use, the no-create / no-recursion /
 * rank-churn rules).
 */
export declare function buildReanalysisPrompt(input: ReanalyzeInput, origin: string): string;
/**
 * The FIND SIMILAR launch prompt. Same split as the other two analyst
 * prompts: the skill carries the methodology, this prompt carries the anchor,
 * the bounded candidate set, the server origin — and the rules that make this
 * run a REPORT rather than an action.
 *
 * Two things the prompt is careful about:
 *  - the candidate scores are labelled a cheap signal the analyst must
 *    distrust, because a bounded set without that caveat reads as a verdict;
 *  - the merge verb is forbidden outright, and the report asks for a merge
 *    RECOMMENDATION instead. The human stays the one who merges.
 */
export declare function buildFindSimilarPrompt(input: FindSimilarInput, origin: string): string;
/**
 * Read the CURRENT host session's model selection from its `modelSelection`
 * projection (the same source the shell's own selector reads: `faceOf`
 * snapshot with `next = pending ?? lastUsed`). Defensive throughout: any
 * missing face returns undefined, so the board's preselect logic degrades to
 * the explicit "inherit session default" choice instead of guessing.
 */
export declare function currentSessionSelectionOf(controller: DshSessionsController): ModelSelection | undefined;
/**
 * Match a session selection against the picker's catalog choices so the board
 * can preselect the EXACT option the session runs on. The catalog choices are
 * keyed by provider+model; the label is the picker's `selModelKey`. Returns
 * undefined when the selection is unknown or not present in the catalog.
 */
export declare function matchSessionSelection(selection: ModelSelection | undefined, choices: readonly ModelChoice[]): ModelChoice | undefined;
/**
 * Match a stored `provider/model` launch target against the catalog choices,
 * so a picker can preselect the option a run would use anyway.
 *
 * The inverse of {@link modelTargetIdOf}, and therefore as strict: the target
 * must be a qualified `provider/model` and must exist in the catalog. A target
 * the catalog does not know returns undefined rather than guessing — a model
 * the deployment has dropped is exactly the case where the panel must show the
 * stored id as it is (and where the launch will refuse loudly) instead of
 * silently showing some other row.
 */
export declare function pickModelTarget(choices: readonly ModelChoice[], target: string | undefined): ModelChoice | undefined;
/**
 * Defensively resolve the session launcher from a client context. Returns
 * undefined when the "sessions" service is absent or does not expose the
 * create/scope/sessionOf surface — callers then keep the manual Create.
 *
 * The model picker is best-effort: the catalog and selection come from the
 * same `sessions` face when it also carries `modelCatalog`/`selectModel`,
 * otherwise from the generated `remote.session` namespace (the official
 * selector surface). When neither is available the picker hides and the
 * analysing session uses its Host default.
 */
export declare function resolveSessionLauncher(ctx: LauncherClientContext): SessionLauncher | undefined;
export {};
