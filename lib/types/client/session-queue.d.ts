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
}
/** Result of handing the capture to a session. */
export interface AiLaunchResult {
    /** True when the prompt was queued into the new session. */
    accepted: boolean;
}
/**
 * The write face the board uses to launch an AI capture. Resolved once per
 * page from the cordis "sessions" service; undefined degrades to manual.
 */
export interface SessionLauncher {
    launch(input: AiCaptureInput): Promise<AiLaunchResult>;
}
/** Cordis service name (same face the active-workspace hint already reads). */
export declare const SESSIONS_SERVICE = "sessions";
/**
 * The Phase 3 launch prompt (short form). The analysis methodology (body
 * structure, title policy, tag format, per-workspace relative rank semantics,
 * dedupe, report rules) lives in the `ideas-analyst` skill the Host installs
 * at `<dshHome>/skills/ideas-analyst/SKILL.md` (user-dsh root — every session
 * sees it); the ANALYSING session loads it from the catalog itself. The prompt
 * therefore carries ONLY what the skill cannot know: the per-capture data (the
 * workspace, the human draft, priority hints) and the write-channel contract —
 * whose server origin is dynamic in this page, and whose exact envelope must
 * never drift from the wire gate the server enforces, so it is authored here,
 * not in the skill.
 *
 * This keeps the prompt minimal: with the skill present the agent has nothing
 * duplicated to reconcile; only if the skill is missing (never installed, or
 * an older engine without the file) does a one-line fallback ask it to follow
 * the channel and use its own judgement — never a full re-statement of the
 * methodology.
 */
export declare function buildAnalysisPrompt(input: AiCaptureInput, origin: string): string;
/**
 * Defensively resolve the session launcher from a client context. Returns
 * undefined when the "sessions" service is absent or does not expose the
 * create/scope/sessionOf surface — callers then keep the manual Create.
 */
export declare function resolveSessionLauncher(ctx: {
    get(name: string): unknown;
}): SessionLauncher | undefined;
