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
  workspaceId: string
  /** Display title of the target workspace, for the analyst's context. */
  workspaceTitle: string
  title: string
  body: string
  tags: readonly string[]
  value?: number
  effort?: number
  rationale?: string
  /** Human-suggested 1-based rank inside the workspace's open backlog. */
  rank?: number
}

/** Result of handing the capture to a session. */
export interface AiLaunchResult {
  /** True when the prompt was queued into the new session. */
  accepted: boolean
}

/**
 * The write face the board uses to launch an AI capture. Resolved once per
 * page from the cordis "sessions" service; undefined degrades to manual.
 */
export interface SessionLauncher {
  launch(input: AiCaptureInput): Promise<AiLaunchResult>
}

/** Cordis service name (same face the active-workspace hint already reads). */
export const SESSIONS_SERVICE = 'sessions'

/** Minimal duck-typed faces of the DSH session controller we actually use. */
interface DshPromptSession {
  prompt(
    content: readonly { type: 'text'; text: string }[],
    mode: 'queue',
  ): Promise<{ ok: boolean; value?: { accepted: true }; error?: unknown }>
}
interface DshSessionsController {
  create(opts?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  scope(id: string): unknown
  sessionOf(ctx: unknown): DshPromptSession | undefined
}

/** Origin the analysing session must address (the page's own server origin). */
function pageOrigin(): string {
  if (typeof window !== 'undefined') {
    const origin = window.location?.origin
    if (typeof origin === 'string' && origin !== '') return origin
  }
  return 'http://127.0.0.1'
}

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
export function buildAnalysisPrompt(input: AiCaptureInput, origin: string): string {
  const tagsHuman = input.tags.length === 0 ? '—' : input.tags.join(', ')
  const tagsJson = input.tags.map(tag => `{"name": "${tag}"}`).join(', ')
  const opinionFields = [
    `value: ${input.value === undefined ? 'not set (you decide)' : String(input.value)} (scale 1..3)`,
    `effort: ${input.effort === undefined ? 'not set (you decide)' : String(input.effort)} (scale 1..3)`,
    `rationale: ${input.rationale === undefined ? 'not set (you decide)' : input.rationale}`,
    `suggested rank: ${input.rank === undefined ? 'not set (you decide)' : String(input.rank)}`,
  ].join('\n')

  return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}).

A human captured a draft idea and asked you to analyze it and persist the full analysis as an idea card. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog and follow its methodology for the analysis, the title, the tags, the priority opinion and the report. If the skill is not available, follow the write-channel contract below and use your own judgement for the analysis.

=== The human's draft ===
Title: ${input.title}
Body (draft — you replace it with your analysis):
${input.body}
Tags (human suggestion): ${tagsHuman}

=== The human's priority hints (adjust when your analysis justifies it, and justify the final choice) ===
${opinionFields}

=== Write channel (THIS contract is authoritative — do not go read plugin sources) ===
Server origin: ${origin}. Every request must carry:
  Origin: ${origin}
  Sec-Fetch-Site: same-origin
  Content-Type: application/json

GET ${origin}/api/ideas/state
-> 200 { "revision": <int>, "ideas": [ <IdeaRecord>... ] }

POST ${origin}/api/ideas/action
Envelope, exact keys:
  { "requestId": "<fresh uuid, unique per action>", "initiator": "plugin:ideas-manager:ai-capture", "action": <verb> }

Verbs:
CREATE:
  { "kind": "create", "id": "<fresh uuid>", "input": {
      "title": "<final title>",
      "body": "<your full markdown analysis, quotes/backslashes escaped>",
      "tags": [${tagsJson}],
      "workspaceId": "${input.workspaceId}" } }
  IMPORTANT: "tags" is an array of OBJECTS { "name": "..." } — an array of plain strings is REJECTED with 400 invalid-action.

UPDATE (only when you merge the capture into an existing duplicate):
  { "kind": "update", "ideaId": "<id>", "patch": {
      "title": "<final title>", "body": "<your analysis>", "tags": [ { "name": "..." } ] } }

TRIAGE (priority opinion + rank):
  { "kind": "triage", "ideaId": "<id>", "patch": {
      "value": <1|2|3>, "effort": <1|2|3>, "rank": <position>, "rationale": "<one or two sentences>" } }
  Omit "rank" from the patch when the idea is not open.

=== Procedure ===
1. GET the state. Dedupe against the ideas of THIS workspace only (as the skill explains — never create a duplicate).
2. Each action uses a FRESH requestId (a replayed requestId is deduped — a no-op).
3. Read the created/updated card's "id" and its "ideaNumber" from the 200 response of the action.

=== Rules ===
- Never read or modify an idea of another workspace; never touch the "no workspace" group.
- The channel refuses requests missing the headers above (403), and bodies over 64 KiB.
- When you use PowerShell against the channel, send each JSON body as UTF-8 bytes ([Text.Encoding]::UTF8.GetBytes(...)) so accents survive the round-trip.`

}

/**
 * Defensively resolve the session launcher from a client context. Returns
 * undefined when the "sessions" service is absent or does not expose the
 * create/scope/sessionOf surface — callers then keep the manual Create.
 */
export function resolveSessionLauncher(ctx: { get(name: string): unknown }): SessionLauncher | undefined {
  try {
    const service = ctx.get(SESSIONS_SERVICE)
    if (typeof service !== 'object' || service === null) return undefined
    const face = service as Partial<DshSessionsController>
    if (typeof face.create !== 'function' || typeof face.scope !== 'function' || typeof face.sessionOf !== 'function') {
      return undefined
    }
    const controller = face as DshSessionsController
    return {
      launch: async (input: AiCaptureInput): Promise<AiLaunchResult> => {
        const sessionId = await controller.create({ workspaceId: input.workspaceId })
        const scopeCtx = controller.scope(sessionId)
        const session = scopeCtx === undefined ? undefined : controller.sessionOf(scopeCtx)
        if (session === undefined) throw new Error('session-face-unavailable')
        const result = await session.prompt(
          [{ type: 'text', text: buildAnalysisPrompt(input, pageOrigin()) }],
          'queue',
        )
        if (result.ok !== true) throw new Error('session-prompt-rejected')
        return { accepted: true }
      },
    }
  } catch {
    return undefined
  }
}
