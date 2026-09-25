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

import type { IdeaStatus } from '../core/ideas.ts'

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
 * A selectable model for the analysing session. The `provider` is the Host
 * model-provider group id; `model` is the model id inside that group —
 * together they form the `ModelSelection` the session controller installs for
 * a Session (`selectModel`). `label` is the display string for the picker.
 */
export interface ModelChoice {
  provider: string
  model: string
  reasoningEffort?: string
  label: string
}

/** Result of handing the capture to a session. */
export interface AiLaunchResult {
  /** True when the prompt was queued into the new session. */
  accepted: boolean
}

/**
 * The existing idea handed back to the analyst for a RE-ANALYZE run (idea #30
 * flow): a fresh DSH session re-reads the stored card and overwrites it with a
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
 * The write face the board uses to launch an AI capture. Resolved once per
 * page from the cordis "sessions" service; undefined degrades to manual.
 */
export interface SessionLauncher {
  launch(input: AiCaptureInput): Promise<AiLaunchResult>
  /** Re-run the analyst on an existing idea (idea #30 flow); same session mechanics. */
  launchReanalyze(input: ReanalyzeInput): Promise<AiLaunchResult>
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
  models: readonly { id: string; name: string; description?: string }[]
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
 * The RE-ANALYZE launch prompt (idea #30 flow). Same split as the capture
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

=== Stored priority opinion (re-decide it and justify the final choice) ===
${opinion}`
}

/**
 * Flatten the Host model catalog into unordered picker choices, one per model
 * in every provider group, labelled `provider · model`. Reflects the catalog
 * faithfully: when `modelCatalog()` is absent or fails, returns [] so the
 * board hides the model picker and the analysing session uses its default.
 */
function modelChoicesOf(controller: DshSessionsController): Promise<ModelChoice[]> {
  if (typeof controller.modelCatalog !== 'function') return Promise.resolve([])
  return controller.modelCatalog()
    .then(result => {
      if (!result.ok || result.value === undefined) return []
      const groupRows: ModelChoice[] = []
      for (const group of result.value.groups ?? []) {
        for (const model of group.models ?? []) {
          groupRows.push({
            provider: group.id,
            model: model.id,
            label: `${group.name} · ${model.name}`,
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
        // Idea #30 flow: re-run the analyst on an EXISTING idea — same session
        // mechanics, dedicated prompt (the overrides carry the no-create /
        // no-recursion rules and the ai-reanalyze initiator).
        launchAnalystSession(controller, modelSource, input, buildReanalysisPrompt(input, pageOrigin())),
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
