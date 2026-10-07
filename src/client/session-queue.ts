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

import type { IdeaEvent, IdeaSimilarSignal, IdeaStatus } from '../core/ideas.ts'

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
  /** Optional explicit model selection for the analysing session (provider + model). */
  model?: ModelChoice
}

/**
 * One adapter-owned reasoning effort level, as the catalog's
 * `reasoning.efforts` entries expose it. The ids are opaque adapter strings
 * (`ReasoningEffortId` is a branded `string`), never a fixed enumeration —
 * the picker reads them from the catalog and never hardcodes a list.
 */
export interface ReasoningEffortOption {
  id: string
  name: string
  description?: string
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
  provider: string
  model: string
  reasoningEffort?: string
  reasoningEfforts?: readonly ReasoningEffortOption[]
  label: string
}

/** Result of handing the capture to a session. */
export interface AiLaunchResult {
  /** True when the prompt was queued into the new session. */
  accepted: boolean
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
  workspaceId: string
  /** Display title of the target workspace, for the analyst's context. */
  workspaceTitle: string
  /** The stored idea id the analyst MUST update (never create). */
  ideaId: string
  /** The stable "#N" human reference of the idea (resolved and verified by the analyst). */
  ideaNumber?: number
  title: string
  /** Compact stored metadata; the analyst still reloads it from the list projection first. */
  summary?: string
  status: 'open' | 'underReview' | 'archived' | 'declined'
  /** Mirrored TaskBoard card id, when one exists. */
  taskBoardId?: string
  tags: readonly string[]
  /** Current stored priority opinion (the analyst re-decides them). */
  value?: number
  effort?: number
  rationale?: string
  /**
   * The idea's recorded activity log, oldest first. Handed to the
   * analyst so a re-analysis reads the real past — "declined on 2026-09-20
   * because …" — instead of re-deriving a history it cannot see. Empty when the
   * board has recorded nothing for this idea yet.
   */
  activity?: readonly IdeaEvent[]
  /** Optional explicit model selection for the analysing session. */
  model?: ModelChoice
}

/**
 * A session model selection: the provider + model (+ optional reasoning
 * effort) a session runs on. Mirrors the Host `ModelSelection` type.
 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * One candidate of a FIND SIMILAR run, as the board hands it over: the
 * server-computed cheap signal plus the identity the analyst needs to read
 * the candidate's real body. `score` is a heuristic the analyst is told to
 * distrust — it exists to bound and order the set, not to answer the question.
 */
export interface SimilarCandidateHint {
  /** The candidate idea id (the exact selector for the deferred-body read). */
  id: string
  /** The stable "#N" human reference, absent on a row without one. */
  ideaNumber?: number
  /** The candidate's title (never its body: this is metadata, not content). */
  title: string
  /** The board's cheap 0..1 signal score — a ranking hint, never a verdict. */
  score: number
  /** Which cheap signals fired (normalized title, tag overlap). */
  signals: readonly IdeaSimilarSignal[]
}

/**
 * The existing idea handed to a FIND SIMILAR run together with its bounded
 * candidate set. The judgement belongs to the analyst session; the board only
 * supplies the signal and the scope. This run NEVER writes — not even when
 * two candidates turn out to be the same idea.
 */
export interface FindSimilarInput {
  /** Target workspace of the idea (the session runs in it). */
  workspaceId: string
  /** Display title of the target workspace, for the analyst's context. */
  workspaceTitle: string
  /** The idea under review — the anchor of the scan. */
  ideaId: string
  /** The stable "#N" human reference of the anchor, when it has one. */
  ideaNumber?: number
  title: string
  summary?: string
  status: IdeaStatus
  tags: readonly string[]
  /** The bounded candidate set, strongest first (already server-capped). */
  candidates: readonly SimilarCandidateHint[]
  /**
   * How many open same-workspace peers the scan actually compared. Handed to
   * the analyst so its report can say what was left out — a bounded set the
   * reader cannot see the bounds of would read as "these are all the similar
   * ideas", which is not what the board knows.
   */
  scanned: number
  /** Optional explicit model selection for the judging session. */
  model?: ModelChoice
}

/**
 * The write face the board uses to launch an AI capture. Resolved once per
 * page from the cordis "sessions" service; undefined degrades to manual.
 */
export interface SessionLauncher {
  launch(input: AiCaptureInput): Promise<AiLaunchResult>
  /** Re-run the analyst on an existing idea; same session mechanics. */
  launchReanalyze(input: ReanalyzeInput): Promise<AiLaunchResult>
  /**
   * Ask the analyst to judge a bounded near-duplicate candidate set (Find
   * similar). Same session mechanics again, dedicated prompt; it reports and
   * never writes.
   */
  launchFindSimilar(input: FindSimilarInput): Promise<AiLaunchResult>
  /** List the models available for an analysing session (empty when unavailable). */
  listModels(): Promise<ModelChoice[]>
  /**
   * The model selection of the CURRENT host session (the one the human is
   * talking in), read from its `modelSelection` projection. The board uses it
   * to preselect the model picker so an untouched picker matches the session
   * — never the catalog's first row. Undefined when the projection is absent
   * or malformed.
   */
  currentModel(): Promise<ModelSelection | undefined>
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
/**
 * Defensive shape of the Host >= 0.1.7 `ClientSessionReference` returned by
 * `retainAgentScope(id)`: the retained record exposes the scoped context on
 * `binding.ctx` (NOT `binding.session` — that is the live Session object) and
 * the reference carries a synchronous, idempotent `release()`.
 */
interface RetainedAgentScope {
  binding?: { ctx?: unknown }
  release?: () => void
}
interface DshSessionsController {
  create(opts?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  scope(id: string): unknown
  sessionOf(ctx: unknown): DshPromptSession | undefined
  /**
   * Optional identity retention (Host >= 0.1.7): retain the Agent scope of a
   * freshly created session SYNCHRONOUSLY, materializing it when it is not yet
   * catalogued. On Host <= 0.1.5 the method does not exist and `scope(id)`
   * still materializes on demand, so the caller falls back to it — typed as
   * optional so the face stays compatible with both Host definitions.
   */
  retainAgentScope?(id: string): RetainedAgentScope | undefined
  /** Optional Host model catalog (the `remote.session.modelCatalog` RPC). */
  modelCatalog?(): Promise<{ ok: boolean; value?: DshModelCatalog; error?: { code?: string; message?: string } }>
  /** Optional Session-local model selection (the `remote.session.selectModel` RPC). */
  selectModel?(selection: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{
    ok: boolean
    value?: { selected: unknown }
    error?: { code?: string; message?: string }
  }>
  /** Optional live session list (the `sessions.list` stream the shell exposes). */
  list?: {
    getSnapshot(): { current?: string; byId?: Record<string, { cwd?: string }> }
  }
  /** Optional per-session binding (the shell session controller's `binding(id)`). */
  binding?(id: string): { session?: { projections?: { faceOf(key: string): unknown } } } | undefined
}

/** Duck-typed shape of the Host model catalog (see `ModelCatalog` in DSH types). */
interface DshModelGroup {
  id: string
  name: string
  models: readonly { id: string; name: string; description?: string; reasoning?: DshModelReasoning }[]
}
/** Duck-typed shape of the per-model `reasoning` block the catalog exposes. */
interface DshModelReasoning {
  efforts: readonly ReasoningEffortOption[]
  defaultEffort?: string
}
interface DshModelCatalog {
  default?: { provider: string; model: string; reasoningEffort?: string }
  groups?: readonly DshModelGroup[]
}

/**
 * The cordis client context this plugin runs under. Only the pieces the model
 * picker needs are typed here: the `sessions` service (create/scope/sessionOf)
 * and, as a fallback source for the model catalog, the generated `remote.session`
 * namespace — the official client surface a selector uses (`modelCatalog` /
 * `selectModel`). Both are consumed defensively.
 */
interface LauncherClientContext {
  get(name: string): unknown
  remote?: { session?: Partial<DshSessionsController> }
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
export function buildAnalysisPrompt(input: AiCaptureInput, origin: string): string {
  const tagsHuman = input.tags.length === 0 ? '—' : input.tags.join(', ')
  const opinionFields = [
    `value: ${input.value === undefined ? 'not set (you decide)' : String(input.value)} (scale 1..3)`,
    `effort: ${input.effort === undefined ? 'not set (you decide)' : String(input.effort)} (scale 1..3)`,
    `rationale: ${input.rationale === undefined ? 'not set (you decide)' : input.rationale}`,
    `suggested rank: ${input.rank === undefined ? 'not set (you decide)' : String(input.rank)}`,
  ].join('\n')

  return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}).

A human captured a draft idea and asked you to analyze it and persist the full analysis as an idea card in the ledger. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog and follow it: it specifies the analysis methodology, the priority opinion and rank, the final report, AND the full write-channel contract. The only thing the skill does not know is the server origin — it is ${origin}. If the skill is not available, persist the idea through the write channel described by that origin and use your own judgement for the analysis and the report.

Bounded-read override (also applies when an older first-wins skill file is installed): start with GET ${origin}/api/ideas/state?view=summary&workspaceId=${encodeURIComponent(input.workspaceId)}&status=open&status=archived. Follow meta.nextOffset until that filtered page is complete, inspect meta.omittedFields, and fetch the resolved target's complete body only through /api/ideas/idea?id=<target-id>. Never replace this with the full /state snapshot.

=== The human's draft ===
Title: ${input.title}
Body (draft — you replace it with your analysis):
${input.body}
Tags (human suggestion): ${tagsHuman}

=== The human's priority hints (adjust when your analysis justifies it, and justify the final choice) ===
${opinionFields}`
}

/**
 * The RE-ANALYZE launch prompt. Same split as the capture
 * prompt: the skill carries the methodology and the write-channel contract;
 * this prompt carries only what the skill cannot know — the target idea, the
 * workspace, and the server origin — plus the re-analysis overrides (which
 * idea id to update, which initiator to use, the no-create / no-recursion /
 * rank-churn rules).
 */
export function buildReanalysisPrompt(input: ReanalyzeInput, origin: string): string {
  const tagsHuman = input.tags.length === 0 ? "—" : input.tags.join(", ")
  const summary = input.summary ?? "—"
  const taskBoardLink = input.taskBoardId ?? "—"
  const opinion = [
    `value: ${input.value === undefined ? "not set" : String(input.value)} (scale 1..3)`,
    `effort: ${input.effort === undefined ? "not set" : String(input.effort)} (scale 1..3)`,
    `rationale: ${input.rationale ?? "not set"}`,
  ].join('\n')

  return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}). This is a RE-ANALYZE run: a human asked you to re-process an idea that ALREADY exists on the board. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog and follow it. It is the single source of the analysis methodology, bounded context-loading workflow, handoff format, escalation contract, final report, and write-channel contract.

=== Re-analysis overrides (precedence over the skill for this run) ===
- Envelope initiator: "plugin:ideas-manager:ai-reanalyze" (NOT ai-capture).
- NEVER use the create verb. The idea already exists.
- You MUST issue an update verb with ideaId ${input.ideaId} (your new title, full body, your summary, and tags), then triage the SAME ideaId.
- Keep the existing rank unless the fresh analysis justifies a change.
- Do NOT re-analyze again or launch anything recursive.

=== Exact target selector ===
- ideaId: ${input.ideaId}
- ideaNumber: ${input.ideaNumber === undefined ? "not assigned" : `#${input.ideaNumber}`}
- workspaceId: ${input.workspaceId}
- title hint: ${input.title}
- status hint: ${input.status}
- summary hint: ${summary}
- tags hint: ${tagsHuman}
- TaskBoard link: ${taskBoardLink}

Load summary metadata first with GET ${origin}/api/ideas/state?view=summary&id=${encodeURIComponent(input.ideaId)}. Inspect the response revision and meta before trusting the projection. Resolve this target by the exact ideaId, then verify the supplied ideaNumber (when present), workspaceId, and status before loading anything full. If any identity check fails, follow the skill escalation contract and do not write.

Then fetch ONLY the target with GET ${origin}/api/ideas/idea?id=${encodeURIComponent(input.ideaId)}. Analyze its complete current body. Load full bodies only for directly related follow-ups identified by followUpOfId; never load the full /state snapshot and never load an unrelated body.

=== What this idea has already been through (the board's activity log) ===
${renderActivity(input.activity)}
This is the REAL history, recorded by the board: read it before you write, and never contradict it. An idea that was already declined, delivered or archived-and-restored has a story — a re-analysis that ignores it will re-propose what was already refused. When the log contradicts the current body, believe the log and say so in your analysis.

=== Stored priority opinion (re-decide it and justify the final choice) ===
${opinion}`
}

/**
 * Render the activity log for the re-analysis prompt. Chronological, one line
 * per entry, oldest first — the order in which a reader of the board reads it.
 * An empty log reads as "nothing recorded yet", never as an omission.
 */
function renderActivity(activity: readonly IdeaEvent[] | undefined): string {
  if (activity === undefined || activity.length === 0) return '— nothing recorded yet (the idea predates the activity log, or nothing has happened to it since).'
  return activity
    .map(entry => `- ${new Date(entry.at).toISOString()} · ${entry.actor} · ${entry.verb}: ${entry.summary}`)
    .join('\n')
}

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
export function buildFindSimilarPrompt(input: FindSimilarInput, origin: string): string {
  const candidateLines = input.candidates.map((candidate, index) =>
    `${index + 1}. ${candidate.ideaNumber === undefined ? '(no number)' : `#${candidate.ideaNumber}`} — ${candidate.title}\n   ideaId: ${candidate.id} · score ${candidate.score.toFixed(2)} (signals: ${candidate.signals.join(', ') || 'none'})`)
  const candidateBlock = input.candidates.length === 0
    ? '— none. No open idea of this workspace scored above the floor for this idea.'
    : candidateLines.join('\n')

  return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}). This is a FIND SIMILAR run: a human asked you to judge whether this idea duplicates something already in this workspace's open backlog. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog. You are NOT producing an analysis for this run: your deliverable is a comparison and a verdict, never a card.

=== Find-similar overrides (precedence over the skill for this run) ===
- Write NOTHING. Never create, never update, never triage — and above all NEVER use the merge verb. A merge is the human's decision, not yours; this run reports, it does not act.
- Compare ONLY the candidates listed below. Do not go hunting for more: this bounded list is the whole scope of the question.
- If the human replies in a later turn, that reply — not this prompt — decides what happens next.

=== The idea under review ===
- ideaId: ${input.ideaId}
- ideaNumber: ${input.ideaNumber === undefined ? 'not assigned' : `#${input.ideaNumber}`}
- workspaceId: ${input.workspaceId}
- status: ${input.status}
- title hint: ${input.title}
- summary hint: ${input.summary ?? '—'}
- tags hint: ${input.tags.length === 0 ? '—' : input.tags.join(', ')}

Load its complete current body with GET ${origin}/api/ideas/idea?id=${encodeURIComponent(input.ideaId)}. Do not load the full /state snapshot.

=== The candidate set the board computed ===
The board compared this idea against ${input.scanned} open idea(s) of THIS workspace and kept those that scored above a low floor. These are the ${input.candidates.length} it kept:
${candidateBlock}

The score is a CHEAP SIGNAL, not a judgement: it is normalized-title overlap plus tag overlap. Distrust it in both directions — a high score is often two genuinely different ideas sharing vocabulary, and a low one is often the same idea worded differently. Read each candidate's REAL body with GET ${origin}/api/ideas/idea?id=<candidate-id> before you judge it. Load full bodies only for the candidates listed here.

=== Your report (the whole deliverable) ===
For EVERY candidate you weighed, write one line: its "#N" (or ideaId), its title, then DUPLICATE, RELATED BUT DISTINCT, or UNRELATED, with the reason in a few words. Then close with exactly one line: either "No duplicate found." or the single best merge pair you would recommend, written as "recommend merging <source> into <survivor>" — a recommendation the human acts on, never a merge you perform.

Report and stop.`
}

/**
 * Flatten the Host model catalog into unordered picker choices, one per model
 * in every provider group, labelled `provider · model`. Reflects the catalog
 * faithfully: when `modelCatalog()` is absent or fails, returns [] so the
 * board hides the model picker and the analysing session uses its default.
 *
 * The reasoning effort travels with the choice: `reasoningEffort` is the
 * model's catalog `defaultEffort` (what the picker preselects) and
 * `reasoningEfforts` is the declared level list (what the selector offers).
 * A model that declares no `reasoning` carries neither, so the board shows no
 * effort selector for it. The ids are adapter-owned strings, read here from
 * the catalog and never hardcoded.
 */
function modelChoicesOf(controller: DshSessionsController): Promise<ModelChoice[]> {
  if (typeof controller.modelCatalog !== 'function') return Promise.resolve([])
  return controller.modelCatalog()
    .then(result => {
      if (!result.ok || result.value === undefined) return []
      const groupRows: ModelChoice[] = []
      for (const group of result.value.groups ?? []) {
        for (const model of group.models ?? []) {
          const reasoning = model.reasoning
          groupRows.push({
            provider: group.id,
            model: model.id,
            label: `${group.name} · ${model.name}`,
            ...(reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: reasoning.defaultEffort }),
            ...(reasoning === undefined ? {} : { reasoningEfforts: reasoning.efforts }),
          })
        }
      }
      return groupRows
    })
    .catch(() => [] as ModelChoice[])
}

/**
 * Read the CURRENT host session's model selection from its `modelSelection`
 * projection (the same source the shell's own selector reads: `faceOf`
 * snapshot with `next = pending ?? lastUsed`). Defensive throughout: any
 * missing face returns undefined, so the board's preselect logic degrades to
 * the explicit "inherit session default" choice instead of guessing.
 */
export function currentSessionSelectionOf(controller: DshSessionsController): ModelSelection | undefined {
  try {
    const currentId = controller.list?.getSnapshot().current
    if (typeof currentId !== 'string' || currentId === '') return undefined
    const bound = controller.binding?.(currentId)
    if (bound === undefined) return undefined
    const face = bound.session?.projections?.faceOf('modelSelection')
    if (face === undefined) return undefined
    const snapshot = (face as { getSnapshot?: () => unknown }).getSnapshot?.()
    if (snapshot === undefined || snapshot === null) return undefined
    const projected = snapshot as { next?: ModelSelection | null; lastUsed?: ModelSelection | null }
    const selection = projected.next ?? projected.lastUsed
    if (selection === undefined || selection === null) return undefined
    if (typeof selection.provider !== 'string' || selection.provider === '') return undefined
    if (typeof selection.model !== 'string' || selection.model === '') return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Match a session selection against the picker's catalog choices so the board
 * can preselect the EXACT option the session runs on. The catalog choices are
 * keyed by provider+model; the label is the picker's `selModelKey`. Returns
 * undefined when the selection is unknown or not present in the catalog.
 */
export function matchSessionSelection(selection: ModelSelection | undefined, choices: readonly ModelChoice[]): ModelChoice | undefined {
  if (selection === undefined) return undefined
  const matched = choices.find(choice => choice.provider === selection.provider && choice.model === selection.model)
  if (matched === undefined) return undefined
  return {
    ...matched,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

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
export function pickModelTarget(choices: readonly ModelChoice[], target: string | undefined): ModelChoice | undefined {
  if (target === undefined) return undefined
  const trimmed = target.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return undefined
  const provider = trimmed.slice(0, slash)
  const model = trimmed.slice(slash + 1)
  return choices.find(choice => choice.provider === provider && choice.model === model)
}

/**
 * Shared session mechanics of both analyst launches (capture and re-analyze):
 * create the fresh session in the workspace, optionally install the selected
 * model, then queue the prompt. The Agent scope is reached Host-adaptively:
 * retained through `retainAgentScope` on Host >= 0.1.7 (where `scope(id)` is a
 * pure read), through the materializing `scope(id)` on Host <= 0.1.5 — and a
 * taken retention is ALWAYS released (missing face, prompt success or
 * failure). A model rejection is best-effort (the analyst still runs, on the
 * session default).
 */
async function launchAnalystSession(
  controller: DshSessionsController,
  modelSource: Partial<DshSessionsController> | undefined,
  input: { workspaceId: string; model?: ModelChoice },
  prompt: string,
): Promise<AiLaunchResult> {
  const sessionId = await controller.create({ workspaceId: input.workspaceId })
  if (input.model !== undefined) {
    const select = modelSource?.selectModel
    if (select !== undefined) {
      try {
        const selected = await select({
          sessionId,
          provider: input.model.provider,
          model: input.model.model,
          ...(input.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.model.reasoningEffort }),
        })
        if (selected.ok !== true) {
          console.warn(`[dsh-plugin-ideas-manager] selectModel rejected: ${selected.error?.code ?? 'unknown'}`)
        }
      } catch (error) {
        console.warn('[dsh-plugin-ideas-manager] selectModel failed', error)
      }
    }
  }
  // Host 0.1.7+: scope(id) is a PURE READ (the scope map is only populated by
  // retention), so a session created a moment ago is not visible through it
  // yet — materialization moved into identity retention. Retain the Agent
  // scope first (retainAgentScope materializes it: get(id) ?? materialize(id))
  // and take the context from the reference's binding. Fallback for Host
  // <= 0.1.5: no retainAgentScope there, scope(id) itself materializes on
  // demand — same call sequence as before this bridge.
  let retained: RetainedAgentScope | undefined
  try {
    if (typeof controller.retainAgentScope === 'function')
      retained = controller.retainAgentScope(sessionId)
  } catch (error) {
    console.warn('[dsh-plugin-ideas-manager] retainAgentScope failed', error)
  }
  let scopeCtx = retained?.binding?.ctx
  if (scopeCtx === undefined) scopeCtx = controller.scope(sessionId)
  const session = scopeCtx === undefined ? undefined : controller.sessionOf(scopeCtx)
  if (session === undefined) {
    retained?.release?.() // no prompt was queued: drop the retention before failing
    throw new Error('session-face-unavailable')
  }
  let result
  try {
    result = await session.prompt(
      [{ type: 'text', text: prompt }],
      'queue',
    )
  } finally {
    retained?.release?.() // always release the retention, success or failure
  }
  if (result.ok !== true) throw new Error('session-prompt-rejected')
  return { accepted: true }
}

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
export function resolveSessionLauncher(ctx: LauncherClientContext): SessionLauncher | undefined {
  try {
    const service = ctx.get(SESSIONS_SERVICE)
    if (typeof service !== 'object' || service === null) return undefined
    const face = service as Partial<DshSessionsController>
    if (typeof face.create !== 'function' || typeof face.scope !== 'function' || typeof face.sessionOf !== 'function') {
      return undefined
    }
    const controller = face as DshSessionsController
    // Model source: the action face when it also carries the model RPCs,
    // otherwise the generated remote.session namespace (the official selector
    // surface). Either `modelCatalog` (list) or `selectModel` (choose) may be
    // present independently; each use checks the exact function it needs.
    // Crucially, accessing `ctx.remote` throws when `remote` is not injected,
    // so it is read defensively — a missing model source only hides the picker,
    // it never disables the AI capture itself.
    let remoteSession: Partial<DshSessionsController> | undefined
    try {
      remoteSession = (ctx as { remote?: { session?: Partial<DshSessionsController> } }).remote?.session
    } catch {
      remoteSession = undefined
    }
    const hasModelRpcs = (candidate: Partial<DshSessionsController> | undefined): candidate is DshSessionsController =>
      candidate !== undefined && (typeof candidate.modelCatalog === 'function' || typeof candidate.selectModel === 'function')
    const modelSource = hasModelRpcs(controller) ? controller
      : hasModelRpcs(remoteSession) ? remoteSession
        : undefined
    return {
      launch: async (input: AiCaptureInput): Promise<AiLaunchResult> =>
        // Phase 3: NON-BLOCKING AI capture — the modal closes immediately, like
        // the manual Create; nothing stays pending. The fresh session analyses
        // the idea, creates or merges it in the target workspace through the
        // loopback write channel, applies a per-workspace rank and reports the
        // ranking decision to the human in the session.
        launchAnalystSession(controller, modelSource, input, buildAnalysisPrompt(input, pageOrigin())),
      launchReanalyze: async (input: ReanalyzeInput): Promise<AiLaunchResult> =>
        // re-run the analyst on an EXISTING idea — same session
        // mechanics, dedicated prompt (the overrides carry the no-create /
        // no-recursion rules and the ai-reanalyze initiator).
        launchAnalystSession(controller, modelSource, input, buildReanalysisPrompt(input, pageOrigin())),
      launchFindSimilar: async (input: FindSimilarInput): Promise<AiLaunchResult> =>
        // Find similar: a fresh session judges a BOUNDED candidate set and
        // reports. Same session mechanics, dedicated prompt (the overrides
        // carry the write-nothing / no-merge rules), so it can never mutate
        // the board on its own.
        launchAnalystSession(controller, modelSource, input, buildFindSimilarPrompt(input, pageOrigin())),
      listModels: () => modelSource === undefined ? Promise.resolve([]) : modelChoicesOf(modelSource),
      // The current host session's model: read straight from its
      // `modelSelection` projection (defensively). The board preselects the
      // picker with this so an untouched picker matches the session — the
      // cost-surprise only ever came from rolling to the catalog's first row.
      currentModel: () => Promise.resolve(currentSessionSelectionOf(controller)),
    }
  } catch {
    return undefined
  }
}
