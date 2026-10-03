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

import type { Context } from '@deepseek-ai/cordis'
import type { IdeaRecord } from './core/ideas.ts'
import {
  buildIdeasReadSnapshot,
  parseActionEnvelope,
  parseLaunchBody,
  IDEAS_READ_DEFAULT_LIMIT,
  IDEAS_READ_MAX_LIMIT,
  type IdeasReadField,
  type IdeasSnapshot,
} from './protocol.ts'

/**
 * The initiator the tools stamp on every write. It is what makes an agent's
 * write readable as one in the idea's own activity log ("an agent did this"),
 * exactly like the analyst sessions' `ai-capture` / `ai-reanalyze` labels.
 */
export const IDEAS_TOOL_INITIATOR = 'plugin:ideas-manager:agent-tool'

/** Registered tool names, in registration order. */
export const IDEAS_TOOL_NAMES = [
  'ideas_list',
  'ideas_get',
  'ideas_capture',
  'ideas_triage',
  'ideas_launch',
  'ideas_review',
] as const

/**
 * The narrow Host face the tools need. `IdeasHostService` satisfies it
 * structurally, so tests and a future host drive the same surface.
 */
export interface IdeasToolHost {
  /** Current full ledger snapshot (metadata; the tools project it themselves). */
  snapshot(): IdeasSnapshot
  /** One full record, or undefined when the id is unknown. */
  idea(id: string): IdeaRecord | undefined
  /** Submit one confirmed Host action (the same call POST /api/ideas/action makes). */
  apply(requestId: string, action: unknown, initiator?: string): unknown
  /** Start an execution (the same call POST /api/ideas/launch makes). */
  launchIdea(ideaId: string, model?: string, requestId?: string): Promise<unknown>
}

/** One model-facing content block (structurally the DSH `ContentBlock` text node). */
interface ToolTextBlock {
  type: 'text'
  text: string
}

/** Execution identity the registry passes to a tool body (duck-typed on purpose). */
export interface IdeasToolRunContext {
  signal?: AbortSignal
  agent?: unknown
}

/**
 * A registry-ready tool definition. Declared structurally, not imported from
 * `@deepseek-ai/dsh-tools`: the registry consumes `{name, description,
 * parameters, output, execute}` and nothing else, and this plugin must keep
 * booting on a Host that serves no tools service at all — so it must not make
 * the tools package a load-time dependency of its own entry point.
 */
export interface IdeasToolDefinition {
  readonly name: string
  readonly description: string
  /** Model-facing parameter schema: a compiled object-rooted JSON Schema. */
  readonly parameters: Record<string, unknown>
  readonly output: {
    /** Canonical output schema; `{}` is the standard unconstrained-JSON form. */
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ToolTextBlock[]
  }
  execute(args: unknown, exec: IdeasToolRunContext): Promise<unknown>
}

/* --- JSON plumbing -------------------------------------------------------- */

/** Unconstrained JSON value the tools return (their output schema is the JSON node). */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Model-facing JSON rendering shared by every tool. */
function renderJson(_args: unknown, value: unknown): ToolTextBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** Mark an already JSON-safe projection as the tool's canonical value. */
function json(value: unknown): Json {
  return value as Json
}

/** A domain refusal the model is expected to read and act on. */
function refused(code: string, message: string): Json {
  return json({ ok: false, code, message })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A fresh replay key for one write (the ledger dedupes; a tool call never replays). */
function newRequestId(): string {
  return globalThis.crypto.randomUUID()
}

/* --- argument reading ----------------------------------------------------- */

/** Read one named string argument (blank collapses to undefined). */
function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read one named number argument (finite only). */
function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read a list of tag NAMES. The tool speaks names only: a prompt prefix is a
 * board-level decision an agent has no business making by accident, and the
 * wire tag object stays one shape away.
 */
function readTagNames(args: Record<string, unknown>): string[] | undefined {
  const value = args.tags
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names.length === 0 ? undefined : names
}

/* --- the shared write path ------------------------------------------------ */

/**
 * Host-written system fields: an idea verb NEVER accepts them from a caller,
 * so the tools never build one and never forward one.
 */
const FORBIDDEN_SYSTEM_FIELDS = ['runStatus', 'runSessionId', 'taskBoardId'] as const

/**
 * Whether an action the tools are about to submit carries a host-written system
 * field. Belt and braces over the wire gate: if the gate is ever relaxed, this
 * stays the reason an agent cannot forge a run stamp or claim a card.
 * @param action - the action object about to be submitted.
 */
export function carriesSystemField(action: unknown): boolean {
  if (typeof action !== 'object' || action === null) return false
  const seen = new Set<object>()
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_SYSTEM_FIELDS as readonly string[]).includes(key)) throw new Error(`field ${key} is host-written`)
      walk(entry)
    }
  }
  try {
    walk(action)
    return false
  } catch {
    return true
  }
}

/**
 * Submit one action through the EXACT wire gate the HTTP route uses. The
 * envelope is built, parsed and only then applied, so an invalid action is
 * refused identically whichever surface asked for it.
 * @param host - the Host service face.
 * @param action - the action object to submit.
 * @returns the Host answer, or a readable refusal.
 */
function submitAction(host: IdeasToolHost, action: Record<string, unknown>): Json {
  if (carriesSystemField(action)) {
    return refused('forbidden-field', 'runStatus, runSessionId and taskBoardId are written by the Host, never by a caller')
  }
  const envelope = parseActionEnvelope({ requestId: newRequestId(), action, initiator: IDEAS_TOOL_INITIATOR })
  if (envelope === undefined) return refused('invalid-action', 'the action envelope was refused by the wire gate')
  try {
    host.apply(envelope.requestId, envelope.action, envelope.initiator)
    return json({ ok: true })
  } catch (error) {
    return refused('refused', messageOf(error))
  }
}

/* --- projections ---------------------------------------------------------- */

/** Compact idea row for the model: identity, column, opinion, lineage, runs. */
function ideaSummary(idea: IdeaRecord): Record<string, unknown> {
  return {
    id: idea.id,
    ...(idea.ideaNumber === undefined ? {} : { number: `#${idea.ideaNumber}` }),
    title: idea.title,
    status: idea.status,
    ...(idea.summary === undefined ? {} : { summary: idea.summary }),
    ...(idea.workspaceId === undefined ? {} : { workspaceId: idea.workspaceId }),
    ...(idea.tags === undefined ? {} : { tags: idea.tags.map(tag => tag.name) }),
    ...(idea.value === undefined ? {} : { value: idea.value }),
    ...(idea.effort === undefined ? {} : { effort: idea.effort }),
    ...(idea.rank === undefined ? {} : { rank: idea.rank }),
    ...(idea.rationale === undefined ? {} : { rationale: idea.rationale }),
    ...(idea.taskBoardId === undefined ? {} : { taskBoardId: idea.taskBoardId }),
    ...(idea.runStatus === undefined ? {} : { runStatus: idea.runStatus }),
    ...(idea.followUpOfId === undefined ? {} : { followUpOfId: idea.followUpOfId }),
    ...(idea.deliveredAt === undefined ? {} : { deliveredAt: idea.deliveredAt }),
    ...(idea.decision === undefined ? {} : { decision: idea.decision }),
    ...(idea.events === undefined ? {} : { activity: idea.events }),
  }
}

/** The recorded activity of an idea, oldest first, as one timeline. */
function activityOf(idea: IdeaRecord): unknown[] {
  return (idea.events ?? []).map(entry => ({ at: entry.at, verb: entry.verb, actor: entry.actor, summary: entry.summary }))
}

/** Field list of the bounded list projection the tools read through. */
const LIST_FIELDS: IdeasReadField[] = [
  'summary', 'rank', 'value', 'effort', 'rationale', 'tags', 'workspaceId',
  'taskBoardId', 'taskBoardStatus', 'runStatus', 'deliveryNote',
  'followUpOfId', 'deliveredAt', 'decision',
]

/** Split a comma-separated status list, keeping only the closed union members. */
function readStatuses(args: Record<string, unknown>): string[] {
  const raw = readString(args, 'status')
  if (raw === undefined) return []
  return raw.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

/* --- tools ---------------------------------------------------------------- */

function buildListTool(host: IdeasToolHost): IdeasToolDefinition {
  return {
    name: 'ideas_list',
    description: [
      'Read the Ideas board: one bounded, filtered page of idea rows.',
      'Returns metadata only — title, column, tags, priority opinion, run state, lineage — never the descriptions; call ideas_get for one idea in full.',
      'The workspaceId, status (a comma-separated subset of open/underReview/archived/declined), tag and query filters are conjunctive.',
      'Follow meta.nextOffset while it is set to walk the whole match.',
      'Triggers: 想法, ideas, backlog, idees, 想法板, 看板, list ideas, what ideas do we have.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Restrict to one workspace (omit for every workspace, including the generic one).' },
        status: { type: 'string', description: 'Comma-separated columns: open, underReview, archived, declined.' },
        tag: { type: 'string', description: 'Keep only ideas carrying this tag name.' },
        query: { type: 'string', description: 'Case-insensitive substring over title, summary and description excerpt.' },
        limit: { type: 'integer', description: `Rows in this page (default ${IDEAS_READ_DEFAULT_LIMIT}, maximum ${IDEAS_READ_MAX_LIMIT}).` },
        offset: { type: 'integer', description: 'Zero-based offset into the matched set.' },
      },
      required: [],
    },
    output: { schema: {}, render: renderJson },
    async execute(args) {
      const raw = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      const snapshot = host.snapshot()
      const workspaceId = readString(raw, 'workspaceId')
      const query = readString(raw, 'query')?.toLowerCase()
      const tag = readString(raw, 'tag')?.toLowerCase()
      const statuses = readStatuses(raw)
      // Filter BEFORE the bounded projection, never after: the offset must index
      // the matched set, or a page would silently drop matching rows.
      const matched = snapshot.ideas.filter((idea) => {
        if (workspaceId !== undefined && idea.workspaceId !== workspaceId) return false
        if (statuses.length > 0 && !statuses.includes(idea.status)) return false
        if (tag !== undefined && !(idea.tags ?? []).some(entry => entry.name.toLowerCase() === tag)) return false
        if (query !== undefined) {
          const haystack = `${idea.title}\n${idea.summary ?? ''}\n${idea.body}`.toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      const limit = Math.min(Math.max(1, readNumber(raw, 'limit') ?? IDEAS_READ_DEFAULT_LIMIT), IDEAS_READ_MAX_LIMIT)
      const offset = Math.max(0, readNumber(raw, 'offset') ?? 0)
      const page = buildIdeasReadSnapshot({ ...snapshot, ideas: matched }, {
        fields: LIST_FIELDS,
        limit,
        offset,
      })
      return json({
        ok: true,
        revision: page.revision,
        matched: page.meta.matched,
        returned: page.ideas.length,
        nextOffset: page.meta.nextOffset,
        ideas: page.ideas,
      })
    },
  }
}

function buildGetTool(host: IdeasToolHost): IdeasToolDefinition {
  return {
    name: 'ideas_get',
    description: [
      'Read ONE idea in full: its complete description, its priority opinion, and its activity log (who did what, when — bounded to the last 50 entries).',
      'Also returns the compact rows of the follow-up ideas raised from this one.',
      'Triggers: 读取想法, 打开想法, idea detail, read idea, what happened to this idea.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ideaId: { type: 'string', description: 'Idea id, as reported by ideas_list or ideas_capture.' },
      },
      required: ['ideaId'],
    },
    output: { schema: {}, render: renderJson },
    async execute(args) {
      const raw = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      const ideaId = readString(raw, 'ideaId')
      if (ideaId === undefined) return refused('invalid-arguments', 'ideaId is required')
      const idea = host.idea(ideaId)
      if (idea === undefined) return refused('idea-not-found', `no idea with id ${ideaId}`)
      const followUps = host.snapshot().ideas
        .filter(entry => entry.followUpOfId === ideaId)
        .map(ideaSummary)
      return json({
        ok: true,
        idea: { ...idea, activity: activityOf(idea) },
        followUps,
      })
    },
  }
}

function buildCaptureTool(host: IdeasToolHost): IdeasToolDefinition {
  return {
    name: 'ideas_capture',
    description: [
      'Capture an idea into the ledger: a title (required) plus the analysis as markdown in the body.',
      'Record a priority opinion at the same time: value, effort, rationale and a suggested rank. The rank is the position in the OPEN BACKLOG OF THAT WORKSPACE; passing one re-ranks that backlog, it never appends blindly.',
      'Duplicates are your call: list the workspace first and capture into an existing idea with a triage instead of creating a second card.',
      'Triggers: 捕获想法, 记录想法, 记下来, capture idea, new idea, backlog idea, 想法板.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One clear sentence naming the idea.' },
        body: { type: 'string', description: 'The analysis as markdown (context, value, effort, first steps, risks).' },
        summary: { type: 'string', description: 'Compact abstract the card and the list show instead of the body.' },
        workspaceId: { type: 'string', description: 'Workspace this idea belongs to (omit for the generic backlog).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag NAMES (max 8, 32 chars each). No prompt lines.' },
        value: { type: 'number', description: 'Value score (1..3 by house convention).' },
        effort: { type: 'number', description: 'Effort score (1..3 by house convention).' },
        rationale: { type: 'string', description: 'Why this ranking, in one or two sentences.' },
        rank: { type: 'integer', description: '1-based position inside this workspace open backlog (appends when omitted).' },
      },
      required: ['title'],
    },
    output: { schema: {}, render: renderJson },
    async execute(args) {
      const raw = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      const title = readString(raw, 'title')
      if (title === undefined) return refused('invalid-arguments', 'title is required')
      // The id is minted by the caller-side envelope only for the ledger's own
      // create path: the action carries it so a replayed request id resolves to
      // the same card. `newRequestId()` above already guarantees freshness.
      const id = newRequestId()
      const workspaceId = readString(raw, 'workspaceId')
      const rank = readNumber(raw, 'rank')
      const value = readNumber(raw, 'value')
      const effort = readNumber(raw, 'effort')
      const rationale = readString(raw, 'rationale')
      const summary = readString(raw, 'summary')
      const tagNames = readTagNames(raw)
      const answer = submitAction(host, {
        kind: 'create',
        id,
        input: {
          title,
          body: typeof raw.body === 'string' ? raw.body : '',
          ...(summary === undefined ? {} : { summary }),
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(rank === undefined ? {} : { rank }),
          ...(value === undefined ? {} : { value }),
          ...(effort === undefined ? {} : { effort }),
          ...(rationale === undefined ? {} : { rationale }),
          ...(tagNames === undefined ? {} : { tags: tagNames.map(name => ({ name })) }),
        },
      })
      if (typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok !== true) return answer
      const idea = host.idea(id)
      if (idea === undefined) return refused('not-found', 'the idea was accepted but could not be read back')
      const groupSize = host.snapshot().ideas.filter(entry =>
        entry.status === 'open'
        && entry.workspaceId === idea.workspaceId).length
      return json({
        ok: true,
        idea: ideaSummary(idea),
        workspaceOpenBacklog: groupSize,
        nextStep: 'Re-rank the workspace open backlog on any material change (ideas_triage on the ideas whose position actually moved); ranks stay advisory.',
      })
    },
  }
}

function buildTriageTool(host: IdeasToolHost): IdeasToolDefinition {
  return {
    name: 'ideas_triage',
    description: [
      'Record a priority opinion on an OPEN idea: value, effort, rationale and/or a suggested rank, applied in one transaction.',
      'The rank is a position inside the open backlog of that idea workspace (1 = highest). Passing a rank re-ranks the whole group; omitting it keeps the current position and only records the opinion.',
      'Returns the resulting group ordering so the model sees the effect instead of guessing it.',
      'Triggers: 优先级, 排序, triage, re-rank, priority opinion, 想法排名.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ideaId: { type: 'string', description: 'Idea id to triage.' },
        value: { type: 'number', description: 'Value score (1..3 by house convention).' },
        effort: { type: 'number', description: 'Effort score (1..3 by house convention).' },
        rationale: { type: 'string', description: 'Why this ranking, in one or two sentences. An empty string clears it.' },
        rank: { type: 'integer', description: '1-based position inside this workspace open backlog.' },
      },
      required: ['ideaId'],
    },
    output: { schema: {}, render: renderJson },
    async execute(args) {
      const raw = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      const ideaId = readString(raw, 'ideaId')
      if (ideaId === undefined) return refused('invalid-arguments', 'ideaId is required')
      const before = host.idea(ideaId)
      if (before === undefined) return refused('idea-not-found', `no idea with id ${ideaId}`)
      const patch: Record<string, unknown> = {}
      const value = readNumber(raw, 'value')
      const effort = readNumber(raw, 'effort')
      const rank = readNumber(raw, 'rank')
      if (value !== undefined) patch.value = value
      if (effort !== undefined) patch.effort = effort
      if (raw.rationale !== undefined) patch.rationale = typeof raw.rationale === 'string' ? raw.rationale : ''
      if (rank !== undefined) patch.rank = rank
      if (Object.keys(patch).length === 0) return refused('nothing-to-record', 'pass value, effort, rationale and/or rank')
      const answer = submitAction(host, { kind: 'triage', ideaId, patch })
      if (typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok !== true) return answer
      const after = host.idea(ideaId)
      if (after === undefined) return refused('not-found', 'the triage was accepted but the idea could not be read back')
      const ordering = host.snapshot().ideas
        .filter(entry => entry.status === 'open' && entry.workspaceId === after.workspaceId)
        .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
        .slice(0, IDEAS_READ_MAX_LIMIT)
        .map((entry, index) => ({ rank: entry.rank ?? index + 1, id: entry.id, title: entry.title }))
      return json({ ok: true, idea: ideaSummary(after), groupOrdering: ordering })
    },
  }
}

function buildLaunchTool(host: IdeasToolHost): IdeasToolDefinition {
  return {
    name: 'ideas_launch',
    description: [
      'Start an execution of an idea: the Host resolves the backend — the mirrored TaskBoard card when the task-board plugin is present, otherwise a fresh session — and the run keeps going after this call returns.',
      'A finished run moves the idea to the review gate automatically; nothing polls from the tool side.',
      'A domain refusal (disabled mirror, board absent, unknown model) comes back as ok:false with its own reason.',
      'Triggers: 启动执行, 运行想法, launch idea, run this idea, 实现这个想法.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ideaId: { type: 'string', description: 'Idea id to run.' },
        model: { type: 'string', description: 'Model target as "provider/model" for THIS run. Omit it and the run takes the workspace\'s default launch model, then the session default — the same order the board itself uses.' },
      },
      required: ['ideaId'],
    },
    output: { schema: {}, render: renderJson },
    async execute(args) {
      const raw = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      const ideaId = readString(raw, 'ideaId')
      if (ideaId === undefined) return refused('invalid-arguments', 'ideaId is required')
      // The launch body goes through the launch route's own parser, so an
      // unknown key or an over-long model is refused exactly as over HTTP.
      const body = parseLaunchBody({ ideaId, model: readString(raw, 'model'), requestId: newRequestId() })
      if (body === undefined) return refused('invalid-arguments', 'ideaId is required and model must be a string')
      try {
        const result = await host.launchIdea(body.ideaId, body.model, body.requestId)
        return json({ ok: true, ...(result as Record<string, unknown>) })
      } catch (error) {
        return refused('refused', messageOf(error))
      }
    },
  }
}

/** The three review-gate verdicts, in the vocabulary the board itself uses. */
const REVIEW_VERDICTS = ['approve', 'followUp', 'decline'] as const

function buildReviewTool(host: IdeasToolHost): IdeasToolDefinition {
  return {
    name: 'ideas_review',
    description: [
      'Decide the review gate of an idea that finished its work.',
      'approve delivers it (archived and stamped). followUp archives it and creates a linked OPEN child whose body carries the parent summary plus your justification. decline refuses it outright and records the decision.',
      'Record the commits, the verification and anything the next reader needs in the child body or the decision text — the board stores them verbatim.',
      'Triggers: 验收, 通过, 拒绝, 需要跟进, review, approve, follow-up, decline, 想法验收.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ideaId: { type: 'string', description: 'The under-review idea id.' },
        verdict: { type: 'string', enum: [...REVIEW_VERDICTS], description: 'approve, followUp or decline.' },
        decision: { type: 'string', description: 'Decision note (decline reads it as the reason).' },
        childTitle: { type: 'string', description: 'Title of the follow-up idea (followUp only).' },
        childBody: { type: 'string', description: 'Body of the follow-up idea (followUp only): parent summary + justification.' },
      },
      required: ['ideaId', 'verdict'],
    },
    output: { schema: {}, render: renderJson },
    async execute(args) {
      const raw = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      const ideaId = readString(raw, 'ideaId')
      if (ideaId === undefined) return refused('invalid-arguments', 'ideaId is required')
      const verdict = readString(raw, 'verdict')
      if (verdict === undefined || !(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
        return refused('invalid-arguments', `verdict must be one of ${REVIEW_VERDICTS.join(', ')}`)
      }
      const before = host.idea(ideaId)
      if (before === undefined) return refused('idea-not-found', `no idea with id ${ideaId}`)
      const decision = readString(raw, 'decision')
      if (verdict === 'approve') {
        const answer = submitAction(host, { kind: 'deliver', ideaId })
        if (!isOk(answer)) return answer
        const after = host.idea(ideaId)
        return json({ ok: true, verdict, idea: after === undefined ? ideaSummary(before) : ideaSummary(after) })
      }
      if (verdict === 'decline') {
        const answer = submitAction(host, { kind: 'decline', ideaId, ...(decision === undefined ? {} : { decision }) })
        if (!isOk(answer)) return answer
        const after = host.idea(ideaId)
        return json({ ok: true, verdict, idea: after === undefined ? ideaSummary(before) : ideaSummary(after) })
      }
      const childTitle = readString(raw, 'childTitle')
      if (childTitle === undefined) return refused('invalid-arguments', 'a follow-up needs a childTitle')
      const childBody = typeof raw.childBody === 'string' ? raw.childBody : ''
      const answer = submitAction(host, {
        kind: 'followUp',
        ideaId,
        input: { title: childTitle, body: childBody },
      })
      if (!isOk(answer)) return answer
      const after = host.idea(ideaId)
      const child = host.snapshot().ideas.find(entry => entry.followUpOfId === ideaId)
      return json({
        ok: true,
        verdict,
        idea: after === undefined ? ideaSummary(before) : ideaSummary(after),
        ...(child === undefined ? {} : { followUp: ideaSummary(child) }),
      })
    },
  }
}

/** Whether a submission answered `{ok:true}`. */
function isOk(answer: Json): boolean {
  return typeof answer === 'object' && answer !== null && !Array.isArray(answer) && (answer as { ok?: unknown }).ok === true
}

/**
 * Build the six ideas tools for one Host service.
 * @param host - the Host service face (satisfied by `IdeasHostService`).
 * @returns the tool definitions, in {@link IDEAS_TOOL_NAMES} order.
 */
export function buildIdeasTools(host: IdeasToolHost): IdeasToolDefinition[] {
  return [
    buildListTool(host),
    buildGetTool(host),
    buildCaptureTool(host),
    buildTriageTool(host),
    buildLaunchTool(host),
    buildReviewTool(host),
  ]
}

/* --- registration --------------------------------------------------------- */

/** The registry face the agent tools register into. */
export interface IdeasToolRegistry {
  register(definition: IdeasToolDefinition): () => void
}

/**
 * Resolve the optional agent-tool registry. The board deliberately does not
 * INJECT it: a deployment whose runtime serves no tools service must still
 * mount the whole board and lose only the agent-tool surface — the same
 * tolerance the optional session gateway gets.
 * @param ctx - the plugin context.
 * @returns the registry, or undefined when this deployment serves none.
 */
export function resolveToolRegistry(ctx: Context): IdeasToolRegistry | undefined {
  try {
    const tools = ctx.get('tools') as IdeasToolRegistry | undefined
    return tools !== undefined && typeof tools.register === 'function' ? tools : undefined
  } catch {
    return undefined
  }
}

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
export function installIdeasAgentTools(ctx: Context, host: IdeasToolHost, isEnabled: () => boolean): void {
  let disposeTools: (() => void) | undefined
  const setToolsEnabled = (active: boolean): void => {
    if (!active) {
      disposeTools?.()
      disposeTools = undefined
      return
    }
    if (disposeTools !== undefined) return
    const registry = resolveToolRegistry(ctx)
    if (registry === undefined) return
    let tools: IdeasToolDefinition[]
    try {
      tools = buildIdeasTools(host)
    } catch (error) {
      console.error(`[dsh-plugin-ideas-manager] agent tools could not be built: ${messageOf(error)}`)
      return
    }
    const disposers: Array<() => void> = []
    for (const tool of tools) {
      try {
        disposers.push(registry.register(tool))
      } catch (error) {
        console.error(`[dsh-plugin-ideas-manager] agent tool ${tool.name} could not be registered: ${messageOf(error)}`)
      }
    }
    disposeTools = () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }

  setToolsEnabled(isEnabled())
  const scopedInject = (ctx as { inject?: (names: readonly string[], callback: (scoped: Context) => unknown) => unknown }).inject
  if (typeof scopedInject === 'function') {
    scopedInject.call(ctx, ['tools'], () => {
      setToolsEnabled(isEnabled())
      // Cordis unloads and re-runs this callback when the injected service's
      // provider fiber changes, and the old registry dies with its provider.
      // Releasing the guard here is what lets the callback register into the
      // NEW registry instead of short-circuiting on the stale disposer.
      return () => {
        disposeTools?.()
        disposeTools = undefined
      }
    })
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], () => {
      setToolsEnabled(isEnabled())
      return () => {
        disposeTools?.()
        disposeTools = undefined
      }
    })
  }
}