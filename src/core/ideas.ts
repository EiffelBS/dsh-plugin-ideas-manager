/**
 * Ideas domain model: idea lifecycle statuses, the idea record shape, and the
 * pure validation helpers the protocol gate, the host ledger, and the tests
 * share. Framework-free (no cordis, no runtime imports) so the model is
 * unit-testable in isolation.
 */

/**
 * Idea lifecycle status, one per kanban column. `underReview` is the review
 * gate: an idea whose work is done but whose acceptance by a human is still
 * pending (entered automatically when the mirrored task card passes `done`).
 * Review approved → `deliver`; review rejected → a `followUp` request (child idea) or
 * `decline`.
 */
export type IdeaStatus = 'open' | 'underReview' | 'archived' | 'declined'

/**
 * Lifecycle of one launched execution (idea #66), backend-neutral: the
 * TaskBoard card and the planned direct-session launch both settle into one of
 * these three states. `undefined` on the record means "no run observed".
 */
export type IdeaRunStatus = 'running' | 'done' | 'failed'

/** The three run states, as a lookup for normalization. */
export const IDEA_RUN_STATUSES: readonly IdeaRunStatus[] = ['running', 'done', 'failed']

/** One idea label: the name is the badge and the filter key, the optional prompt line rides the TaskBoard mirror when connected. */
export interface IdeaTag {
  /** Display name; trimmed, non-empty, unique within the idea. */
  name: string
  /**
   * Prompt line injected ahead of the mirrored TaskBoard card. Absent (or
   * blank after trimming) keeps the tag display-only.
   */
  promptPrefix?: string
}

/** Maximum number of tags carried by one idea. */
export const IDEA_TAG_LIMIT = 8
/** Maximum length of a tag name. */
export const TAG_NAME_MAX_LENGTH = 32
/** Maximum length of a tag's injected prompt line. */
export const TAG_PROMPT_MAX_LENGTH = 200
/** Maximum length of an idea title. */
export const IDEA_TITLE_MAX_LENGTH = 200
/** Maximum size of an idea body (bytes). */
export const IDEA_BODY_MAX_BYTES = 32 * 1024
/**
 * Maximum number of ids ONE relation kind may hold on one idea (idea #106).
 * A relation is a statement the human makes; past roughly twenty the edge list
 * stops being a statement and becomes a second board, which is the failure mode
 * the near-duplicate flag was careful not to build.
 */
export const IDEA_RELATION_LIMIT = 20
/** Maximum length of one referenced idea id in a relation list. */
export const IDEA_RELATION_ID_MAX_LENGTH = 256
/**
 * Maximum length of the compact card summary: the abstract the ideas-analyst
 * produces and the TaskBoard mirror ships as the card description.
 */
export const IDEA_SUMMARY_MAX_LENGTH = 300
/**
 * Hard byte budget of one delivery note (idea #91): the short note a finished
 * run leaves behind so the review gate has something to decide on. Bounded
 * because it is harvested from a model answer — a 40 KB closing message would
 * otherwise land in the ledger, in every snapshot and in the markdown export.
 * Roughly 2 KiB reads as "what was delivered" without becoming a second body.
 */
export const DELIVERY_NOTE_MAX_BYTES = 2 * 1024

/* --- per-idea activity log (idea #92) --- */

/**
 * One line of an idea's own history: what happened, when, and who did it.
 *
 * `IdeaRecord` otherwise keeps only the last state, so "declined because …"
 * survives only as long as somebody wrote it into the body. The log is what
 * makes an idea remember its life, and it is deliberately tiny per entry:
 * a verb, a timestamp, an actor and a one-line summary.
 */
export interface IdeaEvent {
  /** When it happened (ms epoch). */
  at: number
  /** Short verb label (`create`, `triage`, `review`, `launch`, …). */
  verb: string
  /**
   * Who acted: `human`, `run` (a Host-written transition such as a launch
   * settle), or `agent:<initiator>` when the caller asserted an initiator
   * label (the analyst sessions, the `ideas_*` tools).
   */
  actor: string
  /** One line, bounded; never a second body. */
  summary: string
}

/**
 * Cap of the per-idea activity log. 50 entries is roughly two months of a
 * busy idea; past that the oldest lines fall off and the ledger document stays
 * the size the exports and snapshots were designed for.
 */
export const IDEA_EVENT_LIMIT = 50
/** Maximum length of one activity verb label. */
export const IDEA_EVENT_VERB_MAX_LENGTH = 32
/** Maximum length of an actor label (`agent:` prefix included). */
export const IDEA_EVENT_ACTOR_MAX_LENGTH = 128
/** Maximum length of one activity summary line. */
export const IDEA_EVENT_SUMMARY_MAX_LENGTH = 200

/** Actor label of a caller that asserted no initiator (the board UI, the API). */
export const IDEA_ACTOR_HUMAN = 'human'
/** Actor label of a Host-written transition (launch settle, review gate). */
export const IDEA_ACTOR_RUN = 'run'

/**
 * Resolve the actor label of one mutation. The initiator is the envelope field
 * the write channel already carries: absent means "the human in front of the
 * board", present means an agent stamped its own label. A host-only override
 * (`run`) marks the transitions the Host itself writes.
 * @param initiator - asserted envelope initiator, if any.
 * @param override - explicit actor for a Host-written transition.
 * @returns the bounded actor label.
 */
export function ideaEventActor(initiator: string | undefined, override?: 'human' | 'run'): string {
  if (override !== undefined) return override
  const trimmed = initiator?.trim()
  if (trimmed === undefined || trimmed === '') return IDEA_ACTOR_HUMAN
  return `agent:${trimmed}`.slice(0, IDEA_EVENT_ACTOR_MAX_LENGTH)
}

/**
 * Whether an unknown value is a well-formed activity entry.
 *
 * Strict on the four keys it owns — every one of them must be present and of
 * the right type, so a truncated or half-written entry is refused — and
 * deliberately tolerant of unknown keys, because this guard runs on PERSISTED
 * logs: an entry a later version wrote with an extra field is still history
 * worth keeping, and {@link normalizeIdeaEvents} rebuilds it from the four keys
 * this returns, dropping whatever else travelled with it.
 */
export function isIdeaEvent(value: unknown): value is IdeaEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return false
  return typeof event.verb === 'string' && event.verb !== ''
    && typeof event.actor === 'string' && event.actor !== ''
    && typeof event.summary === 'string'
}

/** Build one well-formed entry, bounding every free-text field. */
export function ideaEvent(at: number, verb: string, actor: string, summary: string): IdeaEvent {
  return {
    at,
    verb: verb.trim().slice(0, IDEA_EVENT_VERB_MAX_LENGTH) || 'update',
    actor: actor.trim().slice(0, IDEA_EVENT_ACTOR_MAX_LENGTH) || IDEA_ACTOR_HUMAN,
    summary: summary.replace(/\s+/g, ' ').trim().slice(0, IDEA_EVENT_SUMMARY_MAX_LENGTH),
  }
}

/**
 * Append one entry to a bounded log and drop what falls off the tail. The
 * input list is never mutated: the ledger keeps one immutable record per
 * revision.
 * @param events - the current log (any length; undefined = empty).
 * @param entry - the entry to append.
 * @returns the new log, at most {@link IDEA_EVENT_LIMIT} entries long.
 */
export function appendIdeaEvent(events: readonly IdeaEvent[] | undefined, entry: IdeaEvent): IdeaEvent[] {
  const next = [...(events ?? []), entry]
  return next.length > IDEA_EVENT_LIMIT ? next.slice(next.length - IDEA_EVENT_LIMIT) : next
}

/**
 * Repair a persisted activity log: drop malformed entries, bound every field
 * and keep only the last {@link IDEA_EVENT_LIMIT}. This is also the schema
 * migration for documents written before the log existed — such a row simply
 * has no `events` field, and the first append creates it.
 * @param value - the raw stored value.
 * @returns the repaired log, or undefined when nothing usable remains.
 */
export function normalizeIdeaEvents(value: unknown): IdeaEvent[] | undefined {
  if (!Array.isArray(value)) return undefined
  const events: IdeaEvent[] = []
  for (const entry of value) {
    if (!isIdeaEvent(entry)) continue
    const repaired = ideaEvent(entry.at, entry.verb, entry.actor, entry.summary)
    if (repaired.summary === '') continue
    events.push(repaired)
  }
  if (events.length === 0) return undefined
  return events.length > IDEA_EVENT_LIMIT ? events.slice(events.length - IDEA_EVENT_LIMIT) : events
}

/** Whether an unknown value is a well-formed tag (strict: the wire gate). */
export function isIdeaTag(value: unknown): value is IdeaTag {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const tag = value as Record<string, unknown>
  if (Object.keys(tag).some(key => key !== 'name' && key !== 'promptPrefix')) return false
  if (typeof tag.name !== 'string') return false
  const name = tag.name.trim()
  if (name === '' || name.length > TAG_NAME_MAX_LENGTH) return false
  if (tag.promptPrefix !== undefined && typeof tag.promptPrefix !== 'string') return false
  return tag.promptPrefix === undefined || (tag.promptPrefix as string).trim().length <= TAG_PROMPT_MAX_LENGTH
}

/**
 * Whether an unknown value is a well-formed tag list (strict: the wire gate).
 * An empty list is rejected — clearing tags is expressed by omitting the field
 * (create) or by an explicit null (update), never by an empty array.
 */
export function isIdeaTagList(value: unknown): value is IdeaTag[] {
  return Array.isArray(value) && value.length > 0 && value.length <= IDEA_TAG_LIMIT && value.every(isIdeaTag)
}

/**
 * Repair a persisted tag list: keep the well-formed entries, trim, drop
 * blanks and repeats, cap the count, and collapse a blank prompt line to
 * "display-only". Returns undefined when nothing usable remains, so the caller
 * clears the field instead of storing an empty array.
 */
export function normalizeTags(value: unknown): IdeaTag[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags: IdeaTag[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    if (typeof row.name !== 'string') continue
    const name = row.name.trim()
    if (name === '' || name.length > TAG_NAME_MAX_LENGTH || seen.has(name)) continue
    const raw = typeof row.promptPrefix === 'string' ? row.promptPrefix.trim() : ''
    const promptPrefix = raw === '' ? undefined : raw.slice(0, TAG_PROMPT_MAX_LENGTH)
    seen.add(name)
    tags.push(promptPrefix === undefined ? { name } : { name, promptPrefix })
    if (tags.length >= IDEA_TAG_LIMIT) break
  }
  return tags.length === 0 ? undefined : tags
}

/** All valid statuses (closed union guard). */
export const ALL_IDEA_STATUSES: readonly IdeaStatus[] = [
  'open', 'underReview', 'archived', 'declined',
]

/** The kanban columns in display order (underReview sits between open and archived). */
export const IDEA_COLUMNS: readonly IdeaStatus[] = ['open', 'underReview', 'archived', 'declined']

/** Brand an unknown string as an idea status; undefined when it is not one. */
export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return typeof value === 'string' && (ALL_IDEA_STATUSES as readonly string[]).includes(value)
}

/** Brand an unknown string as a run status; undefined when it is not one. */
export function isIdeaRunStatus(value: unknown): value is IdeaRunStatus {
  return typeof value === 'string' && (IDEA_RUN_STATUSES as readonly string[]).includes(value)
}

/** Normalize one optional target string: trim; blank collapses to undefined. */
export function normalizeOptionalId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Normalize a stored card summary: trim, blank collapses to undefined, hard
 * cap at IDEA_SUMMARY_MAX_LENGTH. The wire gate accepts any string; this is
 * the single place that enforces the size contract on persisted values.
 */
export function normalizeSummary(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return trimmed.slice(0, IDEA_SUMMARY_MAX_LENGTH)
}

/**
 * Normalize a harvested delivery note (idea #91): trim, blank collapses to
 * undefined (an absent note is honest — the review gate says so in the UI), and
 * the text is cut at DELIVERY_NOTE_MAX_BYTES **UTF-8 bytes**, never mid
 * code point, with a trailing ellipsis marking the cut. Same discipline as
 * `normalizeSummary`: the wire accepts any string, this is the one place that
 * enforces the size contract on a persisted value.
 */
export function normalizeDeliveryNote(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  const encoder = new TextEncoder()
  if (encoder.encode(trimmed).byteLength <= DELIVERY_NOTE_MAX_BYTES) return trimmed
  let bytes = 0
  let end = 0
  for (const character of trimmed) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > DELIVERY_NOTE_MAX_BYTES) break
    bytes += size
    end += character.length
  }
  return `${trimmed.slice(0, end).trimEnd()}…`
}

/* --- generic relations between ideas (idea #106) --- */

/**
 * The relation kinds STORED on a record, in the order the board prints them.
 *
 * `blockedBy` is deliberately NOT here: it is the inverse of `blocks`, derived
 * at read time by {@link ideaBlockedBy}. Two spellings of one edge would be two
 * independent facts that drift — the same reason `followUp` is stored on the
 * child alone and both directions are presented. See docs/architecture.md.
 */
export const IDEA_RELATION_KINDS = ['relatesTo', 'blocks'] as const

/** One stored relation kind. */
export type IdeaRelationKind = (typeof IDEA_RELATION_KINDS)[number]

/**
 * Whether an unknown value is a well-formed relation list (the wire gate).
 * An EMPTY list is legal here — unlike tags, where an empty array is a
 * confusing way of saying "clear" — because an empty relation list simply means
 * "this kind of edge was cleared", and the board never sends one by accident.
 */
export function isIdeaRelationList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= IDEA_RELATION_LIMIT
    && value.every(entry => typeof entry === 'string'
      && entry.trim() !== ''
      && entry.length <= IDEA_RELATION_ID_MAX_LENGTH)
}

/**
 * Repair a persisted relation list: trim, drop blanks and repeats, cap at
 * {@link IDEA_RELATION_LIMIT}. Returns undefined when nothing usable remains, so
 * the caller omits the field rather than storing an empty array — which is also
 * this schema's migration: a document written before relations existed simply
 * has no `relatesTo` / `blocks` key, and the first write creates it.
 */
export function normalizeRelationIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id === '' || id.length > IDEA_RELATION_ID_MAX_LENGTH || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= IDEA_RELATION_LIMIT) break
  }
  return ids.length === 0 ? undefined : ids
}

/**
 * One relation list rewritten for a row that changed identity in a merge:
 * `fromId` becomes `toId`, duplicates collapse, and any edge that would point
 * at the row itself is dropped. That last rule is why a merge can never leave an
 * idea related to itself — the failure a self-link makes invisible afterwards.
 *
 * @param list - the row's stored list (absent = no edge of this kind).
 * @param rowId - the id of the row the list belongs to.
 * @param fromId - the id that disappears (the merge loser).
 * @param toId - the id that inherits it (the merge survivor).
 */
export function repointedRelationIds(
  list: readonly string[] | undefined,
  rowId: string,
  fromId: string,
  toId: string,
): string[] | undefined {
  if (list === undefined) return undefined
  const ids: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const id = raw === fromId ? toId : raw
    if (id === '' || id === rowId || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= IDEA_RELATION_LIMIT) break
  }
  return ids.length === 0 ? undefined : ids
}

/** `blocks` adjacency of a whole document, for the cycle check. */
export function blocksGraphOf(ideas: readonly IdeaRecord[]): Map<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>()
  for (const idea of ideas) {
    if (idea.blocks !== undefined) graph.set(idea.id, idea.blocks)
  }
  return graph
}

/**
 * The `blocks` chain that adding `from blocks to` would close, or undefined
 * when the edge is safe.
 *
 * `blocks` is the one relation where a cycle is expressible and meaningless
 * ("A waits for B" and "B waits for A" says nothing), so it is refused ON WRITE
 * rather than discovered at render time. The path is returned so the refusal
 * can NAME it: "A blocks B, B blocks C, C blocks A" is an answer a human can
 * act on, where "invalid relation" is not.
 *
 * The graph is already acyclic (every write checks), so the walk is bounded by
 * the number of ideas in the document.
 */
export function blockCyclePath(
  blocks: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): string[] | undefined {
  if (from === to) return [to]
  const seen = new Set<string>()
  const walk = (node: string, path: readonly string[]): string[] | undefined => {
    if (seen.has(node)) return undefined
    seen.add(node)
    for (const next of blocks.get(node) ?? []) {
      if (next === from) return [...path, node, from]
      const deeper = walk(next, [...path, node])
      if (deeper !== undefined) return deeper
    }
    return undefined
  }
  return walk(to, [])
}

/**
 * The ideas that block `ideaId`: the `blockedBy` side of the stored `blocks`
 * edges. Derived, never stored, so a card can answer "what is this waiting on?"
 * from a poll that only carries the stored direction.
 */
export function ideaBlockedBy(
  ideas: readonly Pick<IdeaRecord, 'id' | 'blocks'>[],
  ideaId: string,
): string[] {
  const blockers: string[] = []
  for (const idea of ideas) {
    if (idea.id === ideaId) continue
    if (idea.blocks?.includes(ideaId) === true) blockers.push(idea.id)
  }
  return blockers
}

/** The `relatesTo` edge set of one row, including the edges other rows state about it. */
export function ideaRelatedTo(
  ideas: readonly Pick<IdeaRecord, 'id' | 'relatesTo'>[],
  ideaId: string,
): string[] {
  const related = new Set<string>()
  for (const idea of ideas) {
    if (idea.id === ideaId) continue
    for (const id of idea.relatesTo ?? []) {
      if (id === ideaId) related.add(idea.id)
    }
  }
  for (const id of ideas.find(idea => idea.id === ideaId)?.relatesTo ?? []) {
    if (id !== ideaId) related.add(id)
  }
  return [...related]
}

/**
 * The relation lists a merge hands to the survivor: its own edges first, then
 * the loser's. Duplicate ids collapse, the cap holds, and the survivor's own id
 * is dropped, so the result is always a legal relation list and the union can
 * never make an idea relate to itself.
 *
 * `blocks` unions the same way — a surviving idea cannot both wait for and be
 * waited on by the same idea, and {@link normalizeRelationIds} keeps the single
 * edge. The caller is responsible for the acyclicity that a union can break
 * (re-pointing an edge can close a loop); this function does not check, because
 * it is a pure list operation and the cycle rule belongs to the write.
 */
export function mergedIdeaRelations(
  survivor: IdeaRecord,
  loser: IdeaRecord,
): { relatesTo?: string[]; blocks?: string[] } {
  const self = survivor.id
  const union = (a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined =>
    normalizeRelationIds([...(a ?? []), ...(b ?? [])])?.filter(id => id !== self)
  const relatesTo = union(survivor.relatesTo, loser.relatesTo)
  const blocks = union(survivor.blocks, loser.blocks)
  return {
    ...(relatesTo === undefined ? {} : { relatesTo }),
    ...(blocks === undefined ? {} : { blocks }),
  }
}

/**
 * Rank group of an idea: its manual rank is a position RELATIVE to the other
 * ideas of the same (status, workspace) pair — the "rank by workspace" model.
 * The workspace-less ideas (workspaceId undefined) share one generic group, so
 * the board and the Priorities view rank them against each other only. Used by
 * both the host (triage/reorder re-rank) and the client (order rebuilds).
 */
export function rankGroupKey(status: IdeaStatus, workspaceId: string | undefined): string {
  return `${status}\u0000${workspaceId ?? ''}`
}

/**
 * Structural subset the ordering helpers read (idea #34): satisfied by both
 * the full IdeaRecord and the deferred-body IdeaListRow, so client sorts and
 * drop rebuilds never need the voluminous `body` field.
 */
export interface RankableIdea {
  /** Stable idea id. */
  id: string
  /** Current column. */
  status: IdeaStatus
  /** Workspace peer-set discriminator (absent = generic group). */
  workspaceId?: string
  /** Manual rank inside the (status, workspace) group (absent = unranked). */
  rank?: number
}

/** Prior analysis preserved by a re-analyze run (one level deep). */
export interface AnalysisAudit {
  /** When the re-analyze cycle was started (ms epoch). */
  at: number
  /** The idea title BEFORE the re-analysis replaced it. */
  title: string
  /** The idea body BEFORE the re-analysis replaced it. */
  body: string
  /** The card summary BEFORE the re-analysis replaced it. */
  summary?: string
  /** The label set BEFORE the re-analysis replaced it. */
  tags?: IdeaTag[]
  /** The priority scores BEFORE the re-triage replaced them. */
  value?: number
  effort?: number
  rationale?: string
}

/** One idea on the board. */
export interface IdeaRecord {
  /** Stable idea id (uuid or import identifier). */
  id: string
  /** Short display title (<= 200 chars). */
  title: string
  /** Longer body shown in the detail view (<= 32 KiB). */
  body: string
  /**
   * Compact card abstract (<= 300 chars) produced by the ideas-analyst: the
   * TaskBoard mirror ships it as the card DESCRIPTION, so the snapshot never
   * carries the full analysis twice (it already rides the card prompt + this
   * ledger). Optional: the mirror derives a body excerpt when absent.
   */
  summary?: string
  /** Current column. */
  status: IdeaStatus
  /** Manual rank used by the board ordering (1..n after a reorder). */
  rank?: number
  /** Optional value score (0..10-ish; pure number, no scale enforced). */
  value?: number
  /** Optional effort estimate (pure number). */
  effort?: number
  /**
   * Triage justification for the current rank (who/when/why). Written by the
   * T1 triage flow; the Priorities view renders it when present.
   */
  rationale?: string
  /** Idea labels. */
  tags?: IdeaTag[]
  /**
   * Generic relations (idea #106) — "this is adjacent to that, read the other
   * one". A list of idea ids, capped at {@link IDEA_RELATION_LIMIT}.
   *
   * Stored in ONE direction per edge, like `followUpOfId`: the board presents
   * the reverse side too ({@link ideaRelatedTo} unions the incoming edges), so
   * a statement is never written twice and the two spellings cannot drift.
   * The ledger re-imposes the symmetry in the same commit that writes a list,
   * so each edge appears on both endpoints without either row being the truth.
   *
   * Addditive and lazy: `IDEAS_SCHEMA_VERSION` stays 1, a document written
   * before this field has none, and nothing is back-filled — inventing edges
   * for old ideas would be worse than admitting there were none.
   */
  relatesTo?: string[]
  /**
   * "This cannot land before that one" — a list of idea ids, capped at
   * {@link IDEA_RELATION_LIMIT}. The ONLY direction that is stored: the
   * `blockedBy` side is derived ({@link ideaBlockedBy}), never written, because
   * two spellings of one edge would be two independent facts.
   *
   * A cycle is refused ON WRITE ({@link blockCyclePath}) rather than detected at
   * render time, and a `delete` drops the edges that pointed at the removed row
   * rather than leaving a dangling id.
   */
  blocks?: string[]
  /** Workspace this idea belongs to (absent = generic). */
  workspaceId?: string
  /** Mirror link to the TaskBoard card id when the bridge is active (P2). */
  taskBoardId?: string
  /**
   * LAST OBSERVED status of the linked TaskBoard card (follow-up work):
   * the under-review poll records it on the idea, and a card whose task
   * failed shows a "Task failed" badge while the idea deliberately stays in
   * the backlog (a failed run delivered nothing, so the review gate does
   * not apply and the human decides whether to retry the task or the idea).
   * System field like `taskBoardId`: never written by the idea verbs. Kept
   * as the last observation (not cleared when the card temporarily vanishes
   * from a probe - the mirror self-heals a dangling link on the next write).
   */
  taskBoardStatus?: string
  /**
   * State of the LATEST LAUNCHED EXECUTION of this idea (idea #66), kept
   * deliberately separate from `taskBoardStatus` (the raw card observation):
   * the launch lifecycle is backend-neutral, so the future direct-session
   * backend can feed the same field without overloading a TaskBoard-shaped
   * mirror status. `undefined` means "never launched (or no observation yet)";
   * `running` is stamped by the launch route, the settle is written by the
   * run poll. A failed run leaves the idea OPEN on purpose: it delivered
   * nothing, so the review gate does not apply.
   * System field like `taskBoardId`: never written by the idea verbs.
   */
  runStatus?: IdeaRunStatus
  /**
   * Id of the session a direct launch (v2 backend) created for the current
   * run, so a `running` state survives a board reload (idea #66 decision D5).
   * The TaskBoard backend does NOT write it: that session id is owned by the
   * task-board runner. System field, host-written only.
   */
  runSessionId?: string
  /**
   * DELIVERY NOTE of the latest finished run (idea #91): the last thing the
   * run said, harvested at settle time, bounded to
   * {@link DELIVERY_NOTE_MAX_BYTES}. Its whole job is to give the review gate
   * something to decide on — today a finished run lands in `underReview` and
   * the only way to learn what happened is to open the session.
   *
   * Two rules, both deliberate:
   *  - it is HARVESTED, never authored: the host reads it off the run, so an
   *    absent note is a truth (a card backend that exposes no output, a
   *    session with no assistant answer) and the UI says so instead of
   *    inventing one. Never a model-generated summary either — that would be
   *    the run describing itself rather than what it said;
   *  - it is host-written only, exactly like `runStatus` / `runSessionId` /
   *    `taskBoardId`: the wire gate rejects it on `update`, and `import`
   *    carries it only as already-harvested text.
   */
  deliveryNote?: string
  /**
   * Review rejected: id of the parent idea this idea is a follow-up of (set by
   * the `followUp` verb; the child carries the summary + justification and
   * stays open while the parent is archived).
   */
  followUpOfId?: string
  /**
   * Stable capture sequence (1-based) assigned by the ledger at create — the
   * "#N" human reference of the old IDEAS.md process. Absent on imported
   * rows without a sequence.
   */
  ideaNumber?: number
  /** When the idea was delivered (archived + deliveredAt by the deliver verb). */
  deliveredAt?: number
  /** Decision note recorded when an idea is declined. */
  decision?: string
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
  /** When the idea was archived or declined (ms epoch). */
  archivedAt?: number
  /**
   * Re-analyze cycle stamp (ms epoch): set by the `reanalyze` verb when a
   * human-triggered analyst re-run starts. The analyst's own update+triage
   * writes the new content; the stamp stays as the audit marker.
   */
  reanalyzeAt?: number
  /**
   * Prior analysis preserved by the latest re-analyze cycle: the title/body/
   * tags/priority opinion the card carried BEFORE the analyst overwrote them.
   * One level deep (the latest prior analysis only) so the ledger stays
   * bounded — re-analyze replaces deliberately, never destroys history.
   */
  analysisAudit?: AnalysisAudit
  /**
   * Bounded, append-only activity log (idea #92): the last
   * {@link IDEA_EVENT_LIMIT} things that happened to this idea — who acted,
   * when, and in one line what changed. The record above keeps only the last
   * state, so without this an idea cannot answer "why was this declined?".
   *
   * Never written by an agent: the verbs append their own entry host-side, so
   * an update cannot smuggle an invented history through the wire gate the way
   * it could smuggle a title. `import` carries the log as already-recorded
   * history, exactly like it carries a harvested delivery note.
   */
  events?: IdeaEvent[]
}

/** Input for creating an idea. */
export interface NewIdeaInput {
  /** Short display title. */
  title: string
  /** Longer body. */
  body: string
  /** Optional compact abstract (<= 300 chars); the mirror's card description. */
  summary?: string
  /** Workspace the idea belongs to; empty/absent = generic. */
  workspaceId?: string
  /** Manual rank (optional). */
  rank?: number
  /** Optional value score. */
  value?: number
  /** Optional effort estimate. */
  effort?: number
  /** Optional triage justification for the rank (recorded at capture). */
  rationale?: string
  /** Optional idea labels. */
  tags?: IdeaTag[]
}

/** Structural shape check of one idea row (status left unvalidated). */
export function isIdeaRecordShape(value: unknown): value is Omit<IdeaRecord, 'status'> & { status: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return false
  if (typeof record.title !== 'string' || typeof record.body !== 'string') return false
  if (record.summary !== undefined && typeof record.summary !== 'string') return false
  if (record.deliveryNote !== undefined && typeof record.deliveryNote !== 'string') return false
  if (typeof record.createdAt !== 'number' || typeof record.updatedAt !== 'number') return false
  if (record.rank !== undefined && (typeof record.rank !== 'number' || !Number.isFinite(record.rank))) return false
  if (record.value !== undefined && (typeof record.value !== 'number' || !Number.isFinite(record.value))) return false
  if (record.effort !== undefined && (typeof record.effort !== 'number' || !Number.isFinite(record.effort))) return false
  if (record.rationale !== undefined && typeof record.rationale !== 'string') return false
  if (record.workspaceId !== undefined && typeof record.workspaceId !== 'string') return false
  if (record.taskBoardId !== undefined && typeof record.taskBoardId !== 'string') return false
  if (record.taskBoardStatus !== undefined && typeof record.taskBoardStatus !== 'string') return false
  if (record.runStatus !== undefined && !isIdeaRunStatus(record.runStatus)) return false
  if (record.runSessionId !== undefined && typeof record.runSessionId !== 'string') return false
  if (record.followUpOfId !== undefined && typeof record.followUpOfId !== 'string') return false
  if (record.ideaNumber !== undefined && (typeof record.ideaNumber !== 'number' || !Number.isFinite(record.ideaNumber))) return false
  if (record.rationale !== undefined && typeof record.rationale !== 'string') return false
  if (record.deliveredAt !== undefined && typeof record.deliveredAt !== 'number') return false
  if (record.decision !== undefined && typeof record.decision !== 'string') return false
  if (record.archivedAt !== undefined && typeof record.archivedAt !== 'number') return false
  if (record.reanalyzeAt !== undefined && typeof record.reanalyzeAt !== 'number') return false
  if (record.analysisAudit !== undefined) {
    const audit = record.analysisAudit as Record<string, unknown>
    if (typeof audit !== 'object' || audit === null || Array.isArray(audit)) return false
    if (typeof audit.at !== 'number' || typeof audit.title !== 'string' || typeof audit.body !== 'string') return false
    if (audit.summary !== undefined && typeof audit.summary !== 'string') return false
    if (audit.tags !== undefined && !Array.isArray(audit.tags)) return false
  }
  if (record.tags !== undefined && !Array.isArray(record.tags)) return false
  if (record.relatesTo !== undefined && !Array.isArray(record.relatesTo)) return false
  if (record.blocks !== undefined && !Array.isArray(record.blocks)) return false
  if (record.events !== undefined && !Array.isArray(record.events)) return false
  return true
}

/** An idea record is structurally valid if every row round-trips the UI. */
export function isIdeaRecord(value: unknown): value is IdeaRecord {
  if (!isIdeaRecordShape(value)) return false
  const record = value as Record<string, unknown>
  if (!isIdeaStatus(record.status)) return false
  if (record.tags !== undefined && !isIdeaTagList(record.tags)) return false
  if (record.relatesTo !== undefined && !isIdeaRelationList(record.relatesTo)) return false
  if (record.blocks !== undefined && !isIdeaRelationList(record.blocks)) return false
  return true
}

/** Normalize an unknown persisted status back into the closed status union. */
export function normalizeStatus(status: unknown): IdeaStatus {
  return isIdeaStatus(status) ? status : 'open'
}

/** Create an idea from user input (starts 'open'). */
export function createIdea(input: NewIdeaInput, now: number, id: string): IdeaRecord {
  const tags = normalizeTags(input.tags)
  const rationale = input.rationale?.trim()
  const summary = normalizeSummary(input.summary)
  return {
    id,
    title: input.title.trim().slice(0, IDEA_TITLE_MAX_LENGTH),
    body: input.body.trim(),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    ...(summary === undefined ? {} : { summary }),
    ...(input.rank === undefined ? {} : { rank: input.rank }),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(rationale === undefined || rationale === '' ? {} : { rationale }),
    ...(normalizeOptionalId(input.workspaceId) === undefined ? {} : { workspaceId: normalizeOptionalId(input.workspaceId) }),
    ...(tags === undefined ? {} : { tags }),
  }
}

/** Clone an idea with an updated status and a fresh updatedAt. */
export function withStatus(idea: IdeaRecord, status: IdeaStatus, now: number): IdeaRecord {
  return { ...idea, status, updatedAt: now }
}

/* --- merge (duplicate reconciliation) --- */

/**
 * How a merge settles the LOSER's rank onto the survivor. The merge itself is
 * unconditional — the loser's tags, its follow-up lineage and its card are
 * reconciled either way — so the only genuinely open question is the position
 * the survivor ends up at inside the open backlog.
 */
export const IDEAS_MERGE_MODES = ['keepTargetRank', 'takeSourceRank'] as const
/** One merge rank disposition. */
export type IdeaMergeMode = (typeof IDEAS_MERGE_MODES)[number]

/** Whether an unknown string is a well-formed merge mode (the wire gate). */
export function isIdeaMergeMode(value: unknown): value is IdeaMergeMode {
  return typeof value === 'string' && (IDEAS_MERGE_MODES as readonly string[]).includes(value)
}

/**
 * Hard cap of the decision note a merge writes on the archived loser. The note
 * is built from bounded pieces (the survivor's `#N` plus a title already capped
 * at {@link IDEA_TITLE_MAX_LENGTH}), so this only guards a hand-forged record:
 * the ledger must never grow an unbounded free-text field on a verb.
 */
export const MERGE_DECISION_MAX_LENGTH = 320

/**
 * The label set a merge hands to the survivor: the survivor's own labels first
 * (so a duplicate name keeps the survivor's `promptPrefix` — the losing card's
 * prompt line must not rewrite a card the runner already owns), then the
 * loser's. {@link normalizeTags} deduplicates by name, trims and caps the
 * result at {@link IDEA_TAG_LIMIT}, so the union is always a legal tag list.
 *
 * @returns the reconciled labels, or undefined when the union is empty (the
 *   caller omits the field rather than storing an empty list).
 */
export function mergedIdeaTags(survivor: IdeaRecord, loser: IdeaRecord): IdeaTag[] | undefined {
  return normalizeTags([...(survivor.tags ?? []), ...(loser.tags ?? [])])
}

/* --- near-duplicate signal (read-only flag) --- */

/**
 * One cheap signal that fired between two ideas. Deliberately a closed pair:
 * the report says WHICH cheap evidence produced the score, so a reader can
 * disagree with it, and a future signal is an additive union member rather
 * than a silent change of meaning.
 */
export type IdeaSimilarSignal = 'title' | 'tags'

/**
 * Hard cap of the candidates one near-duplicate report may carry. A report is
 * a *bounded* candidate set for a human (and for the analyst prompt), never a
 * full similarity ranking of the workspace.
 */
export const IDEAS_SIMILAR_MAX_CANDIDATES = 20

/**
 * Combined score below which a pair is not reported at all. Chosen so that one
 * shared tag out of eight (0.3 with no title overlap) stays noise, while a
 * perfect title match (0.7) or a clear overlap on both axes clears the bar.
 */
export const IDEAS_SIMILAR_MIN_SCORE = 0.34

/** Weight of the normalized-title signal in the combined score. */
export const IDEAS_SIMILAR_TITLE_WEIGHT = 0.7

/** One scored candidate of a near-duplicate report. */
export interface IdeaSimilarCandidate {
  /** The candidate idea id. */
  id: string
  /** Stable `#N` human reference, absent on an imported row without one. */
  ideaNumber?: number
  /** The candidate's own title (never its body: this is a metadata signal). */
  title: string
  /** Combined 0..1 signal score, rounded to 3 decimals. */
  score: number
  /** Which cheap signals actually fired; a reader may weigh them differently. */
  signals: IdeaSimilarSignal[]
}

/**
 * The near-duplicate report for ONE anchor idea. Purely derived from the
 * current ledger revision: it is a FLAG, never an action, and nothing on the
 * board is written because of it.
 */
export interface IdeaSimilarReport {
  /** The anchor idea id as requested. */
  ideaId: string
  /** False when the anchor does not exist (distinct from "no candidates"). */
  found: boolean
  /** Open same-workspace peers the scan actually compared (its real size). */
  scanned: number
  /** Candidates at or above {@link IDEAS_SIMILAR_MIN_SCORE}, strongest first. */
  candidates: IdeaSimilarCandidate[]
  /** True when at least one candidate cleared the floor: the near-duplicate flag. */
  flagged: boolean
}

/**
 * A run of ideographic script (Han, Kana, Hangul): those scripts have no word
 * separators, so a whole-title "word" would make two unrelated CJK titles look
 * as unrelated as two unrelated English ones while hiding the real overlap.
 */
const IDEOGRAPHIC_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u

/**
 * Comparison tokens of one title: lowercased, split on every non-alphanumeric
 * boundary, duplicates collapsed. An ideographic run is split per CHARACTER so
 * CJK titles overlap at the character level; every other script keeps its
 * words. Nothing is stemmed and nothing is fuzzy — this is a cheap signal, and
 * a real judgement belongs to a human or to the analyst.
 */
export function ideaTitleTokens(title: string): Set<string> {
  const tokens = new Set<string>()
  for (const part of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (part === '') continue
    if (IDEOGRAPHIC_RUN.test(part)) {
      for (const character of part) tokens.add(character)
    } else {
      tokens.add(part)
    }
  }
  return tokens
}

/** Comparison tokens of one label set (names lowercased, order irrelevant). */
function ideaTagTokens(tags: readonly IdeaTag[] | undefined): Set<string> {
  const tokens = new Set<string>()
  for (const tag of tags ?? []) {
    const name = tag.name.trim().toLowerCase()
    if (name !== '') tokens.add(name)
  }
  return tokens
}

/**
 * Dice coefficient of two token sets: `2 * shared / (|a| + |b|)`. Symmetric,
 * 0 when either side is empty, and linear in the smaller set — the shape that
 * makes "one shared word out of five" read as a real overlap rather than as
 * either nothing or everything.
 */
function diceCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const token of small) if (large.has(token)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/**
 * Combined near-duplicate score of one pair: a weighted sum of the title
 * overlap ({@link IDEAS_SIMILAR_TITLE_WEIGHT}) and the label overlap. Rounded
 * to 3 decimals so the wire payload is stable and a report never carries
 * float noise the reader would have to interpret.
 */
export function ideaSimilarity(anchor: IdeaRecord, other: IdeaRecord): { score: number; signals: IdeaSimilarSignal[] } {
  const titleScore = diceCoefficient(ideaTitleTokens(anchor.title), ideaTitleTokens(other.title))
  const tagScore = diceCoefficient(ideaTagTokens(anchor.tags), ideaTagTokens(other.tags))
  const signals: IdeaSimilarSignal[] = []
  if (titleScore > 0) signals.push('title')
  if (tagScore > 0) signals.push('tags')
  const score = Math.round((IDEAS_SIMILAR_TITLE_WEIGHT * titleScore + (1 - IDEAS_SIMILAR_TITLE_WEIGHT) * tagScore) * 1000) / 1000
  return { score, signals }
}

/**
 * Scan the OPEN BACKLOG OF THE ANCHOR'S OWN WORKSPACE for near-duplicates.
 *
 * Scope is deliberate and narrow: the anchor itself, every non-open row and
 * every other workspace are excluded, so the flag means "this backlog already
 * holds something like this", never "some idea somewhere scored highly". The
 * workspace-less ideas form one generic group, exactly like
 * {@link rankGroupKey}.
 *
 * `limit` clamps into 1..{@link IDEAS_SIMILAR_MAX_CANDIDATES}. The whole scan
 * is O(open peers) token comparisons and runs only when a caller asks for it —
 * it is deliberately NOT part of the default snapshot, so the board's 2.5 s
 * poll neither pays for it nor grows by it (see docs/architecture.md).
 *
 * @returns the report, or undefined only when `ideaId` is blank.
 */
export function findIdeaSimilar(
  ideas: readonly IdeaRecord[],
  ideaId: string,
  limit: number = IDEAS_SIMILAR_MAX_CANDIDATES,
): IdeaSimilarReport {
  const anchor = ideas.find(idea => idea.id === ideaId)
  if (anchor === undefined) return { ideaId, found: false, scanned: 0, candidates: [], flagged: false }
  const anchorWorkspace = anchor.workspaceId ?? ''
  const peers = ideas.filter(idea =>
    idea.id !== anchor.id
    && idea.status === 'open'
    && (idea.workspaceId ?? '') === anchorWorkspace)
  const scored: Array<IdeaSimilarCandidate & { createdAt: number }> = []
  for (const peer of peers) {
    const { score, signals } = ideaSimilarity(anchor, peer)
    if (score < IDEAS_SIMILAR_MIN_SCORE) continue
    scored.push({
      id: peer.id,
      ...(peer.ideaNumber === undefined ? {} : { ideaNumber: peer.ideaNumber }),
      title: peer.title,
      score,
      signals,
      createdAt: peer.createdAt,
    })
  }
  // Strongest first; ties broken by the older idea, then by id so two runs of
  // the same revision always answer identically.
  scored.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const maximum = Math.min(IDEAS_SIMILAR_MAX_CANDIDATES, Math.max(1, Math.trunc(limit)))
  const candidates = scored.slice(0, maximum).map(({ createdAt: _createdAt, ...candidate }) => candidate)
  return {
    ideaId,
    found: true,
    scanned: peers.length,
    candidates,
    flagged: candidates.length > 0,
  }
}
