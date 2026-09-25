/**
 * /api/ideas wire protocol: prefix, envelope types, and the strict exactKeys
 * action parser. Follows the dsh-task-board discipline (bounded requestId,
 * closed `kind` unions, exactKeys on every object, forbidden executable
 * fields on the import path) so the ideas API behaves identically to the
 * sibling families without importing any of their code.
 */

import {
  createIdea,
  isIdeaStatus,
  isIdeaTagList,
  normalizeTags,
  type IdeaRecord,
  type IdeaStatus,
  type IdeaTag,
  type NewIdeaInput,
} from './core/ideas.ts'

export const IDEAS_SCHEMA_VERSION = 1 as const
export const IDEAS_API_PREFIX = '/api/ideas'

/** Snapshot served by GET /api/ideas/state. */
export interface IdeasSnapshot {
  schemaVersion: typeof IDEAS_SCHEMA_VERSION
  revision: number
  ideas: IdeaRecord[]
}

/* --- list projection (idea #34: deferred body loading) --- */

/**
 * Hard cap of the list-view body excerpt: enough for a readable card
 * preview and a useful board search, small enough that a 140-card snapshot
 * stays a fraction of the full payload - the voluminous analyses ride
 * GET /api/ideas/idea?id= on demand (edit / follow-up / re-analyze) and the
 * full GET /api/ideas/state (deep search, backups) instead.
 */
export const BODY_EXCERPT_MAX_LENGTH = 280

/**
 * One list-view row: the full record minus the fields the list never shows
 * (`body`, `analysisAudit`) plus a short `bodyExcerpt` teaser. The MISSING
 * `body` field is deliberate: TypeScript then refuses every render/search
 * site that would silently grow back a full-body dependency, and the edit
 * modal can never save a partial body by accident (it always edits a full
 * IdeaRecord fetched through GET /api/ideas/idea).
 */
export type IdeaListRow = Omit<IdeaRecord, 'body' | 'analysisAudit'> & {
  /** Leading, whitespace-collapsed slice of the body (never the analysis). */
  bodyExcerpt: string
}

/** Snapshot served by GET /api/ideas/state?view=list (and action views). */
export interface IdeasListSnapshot {
  schemaVersion: typeof IDEAS_SCHEMA_VERSION
  revision: number
  ideas: IdeaListRow[]
}

/* --- bounded filtered reads (idea #65) --- */

/** Read projection selected by `GET /api/ideas/state?view=`. */
export type IdeasReadView = 'summary' | 'detail'

/** Default number of rows in a bounded read. */
export const IDEAS_READ_DEFAULT_LIMIT = 100
/** Hard row cap for one bounded read. */
export const IDEAS_READ_MAX_LIMIT = 200
/** Hard UTF-8 byte cap for one selected idea body. */
export const IDEAS_READ_MAX_BODY_BYTES = 4 * 1024
/** Hard UTF-8 byte cap for one bounded-read JSON response. */
export const IDEAS_READ_MAX_RESPONSE_BYTES = 512 * 1024
/** Hard cap for each repeated selector group. */
export const IDEAS_READ_MAX_SELECTORS = 100

/**
 * Optional top-level fields a bounded read may select. Identity and timestamp
 * fields are always present (revision is top-level); `analysisAudit` is
 * intentionally unavailable in
 * this projection because it can carry a second full body. The frozen raw
 * single-idea route remains the explicit full-detail escape hatch.
 */
export const IDEAS_READ_SELECTABLE_FIELDS = [
  'summary', 'rank', 'value', 'effort', 'rationale', 'tags', 'workspaceId',
  'taskBoardId', 'taskBoardStatus', 'followUpOfId', 'deliveredAt', 'decision',
  'archivedAt', 'reanalyzeAt', 'body',
] as const

/** One optional field accepted by the bounded field selector. */
export type IdeasReadField = (typeof IDEAS_READ_SELECTABLE_FIELDS)[number]

/** Fields always present on a bounded row, independent of field selection. */
type IdeasReadCore = Pick<IdeaRecord, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'> & {
  ideaNumber?: number
  body?: string
  /** True only on this row when its selected body was shortened. */
  bodyTruncated?: true
}

/** One projected row. Unselected and absent optional record fields are omitted. */
export type IdeasReadRow = IdeasReadCore & Partial<Omit<IdeaRecord, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'ideaNumber' | 'body' | 'analysisAudit'>>

/** Caller-facing bounded-read query. Defaults are summary + 100 rows. */
export interface IdeasReadQuery {
  view?: IdeasReadView
  workspaceId?: string
  status?: readonly IdeaStatus[]
  ids?: readonly string[]
  numbers?: readonly number[]
  fields?: readonly IdeasReadField[]
  /** Requested body cap in UTF-8 bytes (0 omits content while keeping the key). */
  bodyLimit?: number
  limit?: number
  offset?: number
}

/** Fully defaulted and validated bounded-read query. */
export interface NormalizedIdeasReadQuery {
  view: IdeasReadView
  workspaceId?: string
  status: IdeaStatus[]
  ids: string[]
  numbers: number[]
  fields: IdeasReadField[]
  bodyLimit: number
  limit: number
  offset: number
}

/** Explicit row, body, and pagination metadata for a bounded read. */
export interface IdeasReadMetadata {
  view: IdeasReadView
  fields: readonly IdeasReadField[]
  bodyLimitBytes: number
  limit: number
  offset: number
  matched: number
  returned: number
  rowTruncated: boolean
  nextOffset: number | null
  bodyTruncated: boolean
  omittedFields: Array<IdeasReadField | 'analysisAudit'>
}

/** Response served by `GET /api/ideas/state?view=summary|detail`. */
export interface IdeasReadSnapshot {
  schemaVersion: typeof IDEAS_SCHEMA_VERSION
  revision: number
  ideas: IdeasReadRow[]
  meta: IdeasReadMetadata
}

const SUMMARY_READ_FIELDS: IdeasReadField[] = [
  'summary', 'workspaceId', 'tags', 'taskBoardId', 'followUpOfId',
]
const DETAIL_READ_FIELDS = IDEAS_READ_SELECTABLE_FIELDS.filter(
  (field): field is IdeasReadField => field !== 'body',
)

const READ_QUERY_KEYS = new Set([
  'view', 'workspaceId', 'status', 'id', 'number', 'fields', 'bodyLimit', 'limit', 'offset',
])

function uniqueBoundedStrings(
  values: readonly string[],
  maximum: number,
): string[] | undefined {
  const unique = [...new Set(values)]
  return unique.length <= maximum ? unique : undefined
}

function queryValues(params: URLSearchParams, key: string, splitCommas = true): string[] {
  const values = splitCommas
    ? params.getAll(key).flatMap(value => value.split(','))
    : params.getAll(key)
  return values.map(value => value.trim())
}

function queryInteger(params: URLSearchParams, key: string, fallback: number, minimum: number, maximum: number): number | undefined {
  const raw = params.get(key)
  if (raw === null) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
}

/**
 * Parse and bound the additive read query. `status`, `id`, `number`, and
 * `fields` are repeatable; `status` and `fields` also accept comma-separated
 * lists. Unknown keys and out-of-range values reject instead of silently
 * broadening a read.
 */
export function parseIdeasReadQuery(params: URLSearchParams): NormalizedIdeasReadQuery | undefined {
  if ([...params.keys()].some(key => !READ_QUERY_KEYS.has(key))) return undefined
  const rawView = params.get('view')
  if (rawView !== null && rawView !== 'summary' && rawView !== 'detail') return undefined
  const view = rawView ?? 'summary'
  const rawWorkspace = params.get('workspaceId')
  const workspaceId = rawWorkspace?.trim()
  if (params.has('workspaceId') && (workspaceId === undefined || workspaceId === '' || workspaceId.length > 256)) return undefined
  const rawStatuses = queryValues(params, 'status')
  if (rawStatuses.length > IDEAS_READ_MAX_SELECTORS || rawStatuses.some(status => !isIdeaStatus(status))) return undefined
  const rawIds = queryValues(params, 'id', false)
  if (rawIds.length > IDEAS_READ_MAX_SELECTORS || rawIds.some(id => id === '' || id.length > 256)) return undefined
  const rawNumbers = queryValues(params, 'number', false)
  if (rawNumbers.length > IDEAS_READ_MAX_SELECTORS || rawNumbers.some(value => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) return undefined
  const rawFields = queryValues(params, 'fields')
  if (rawFields.length > IDEAS_READ_SELECTABLE_FIELDS.length || rawFields.some(field => !(IDEAS_READ_SELECTABLE_FIELDS as readonly string[]).includes(field))) return undefined
  const limit = queryInteger(params, 'limit', IDEAS_READ_DEFAULT_LIMIT, 1, IDEAS_READ_MAX_LIMIT)
  const offset = queryInteger(params, 'offset', 0, 0, 1_000_000)
  const bodyLimit = queryInteger(params, 'bodyLimit', 0, 0, IDEAS_READ_MAX_BODY_BYTES)
  if (limit === undefined || offset === undefined || bodyLimit === undefined) return undefined

  const fields = uniqueBoundedStrings(rawFields as IdeasReadField[], IDEAS_READ_SELECTABLE_FIELDS.length) as IdeasReadField[] | undefined
  const ids = uniqueBoundedStrings(rawIds, IDEAS_READ_MAX_SELECTORS)
  const numbers = uniqueBoundedStrings(rawNumbers.map(String), IDEAS_READ_MAX_SELECTORS)?.map(Number)
  const status = uniqueBoundedStrings(rawStatuses, IDEAS_READ_MAX_SELECTORS) as IdeaStatus[] | undefined
  if (fields === undefined || ids === undefined || numbers === undefined || status === undefined) return undefined
  return {
    view,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    status,
    ids,
    numbers,
    fields: rawFields.length === 0 ? [...(view === 'detail' ? DETAIL_READ_FIELDS : SUMMARY_READ_FIELDS)] : fields,
    bodyLimit,
    limit,
    offset,
  }
}

/** Serialize a bounded-read query for the browser transport. */
export function ideasReadSearchParams(query: IdeasReadQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.view !== undefined) params.set('view', query.view)
  if (query.workspaceId !== undefined) params.set('workspaceId', query.workspaceId)
  for (const status of query.status ?? []) params.append('status', status)
  for (const id of query.ids ?? []) params.append('id', id)
  for (const number of query.numbers ?? []) params.append('number', String(number))
  for (const field of query.fields ?? []) params.append('fields', field)
  if (query.bodyLimit !== undefined) params.set('bodyLimit', String(query.bodyLimit))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  return params
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** Slice by UTF-8 bytes without splitting a Unicode code point. */
function bodyPrefix(body: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (utf8Bytes(body) <= maximumBytes) return { value: body, truncated: false }
  let bytes = 0
  let end = 0
  for (const character of body) {
    const size = utf8Bytes(character)
    if (bytes + size > maximumBytes) break
    bytes += size
    end += character.length
  }
  return { value: body.slice(0, end), truncated: true }
}

function projectReadRow(
  idea: IdeaRecord,
  query: NormalizedIdeasReadQuery,
  selected: ReadonlySet<IdeasReadField>,
): IdeasReadRow {
  const row: IdeasReadRow = {
    id: idea.id,
    title: idea.title,
    status: idea.status,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
    ...(idea.ideaNumber === undefined ? {} : { ideaNumber: idea.ideaNumber }),
  }
  for (const field of query.fields) {
    if (field === 'body' || !Object.prototype.hasOwnProperty.call(idea, field)) continue
    Object.assign(row, { [field]: idea[field] })
  }
  if (selected.has('body')) {
    const body = bodyPrefix(idea.body, query.bodyLimit)
    row.body = body.value
    if (body.truncated) row.bodyTruncated = true
  }
  return row
}

function readResponse(
  revision: number,
  rows: IdeasReadRow[],
  query: NormalizedIdeasReadQuery,
  matched: number,
  omittedFields: Array<IdeasReadField | 'analysisAudit'>,
): IdeasReadSnapshot {
  const bodyTruncated = rows.some(row => row.bodyTruncated === true)
  const returned = rows.length
  const next = query.offset + returned
  const rowTruncated = next < matched
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision,
    ideas: rows,
    meta: {
      view: query.view,
      fields: [...query.fields],
      bodyLimitBytes: query.bodyLimit,
      limit: query.limit,
      offset: query.offset,
      matched,
      returned,
      rowTruncated,
      nextOffset: rowTruncated ? next : null,
      bodyTruncated,
      omittedFields,
    },
  }
}

function validReadQuery(input: IdeasReadQuery): boolean {
  const statusValid = (input.status ?? []).every(status => isIdeaStatus(status))
  const idsValid = (input.ids ?? []).every(id => id !== '' && id.length <= 256)
  const numbersValid = (input.numbers ?? []).every(number => Number.isSafeInteger(number) && number > 0)
  const fieldsValid = (input.fields ?? []).every(field => (IDEAS_READ_SELECTABLE_FIELDS as readonly string[]).includes(field))
  const bounded = (value: number | undefined, minimum: number, maximum: number): boolean =>
    value === undefined || (Number.isSafeInteger(value) && value >= minimum && value <= maximum)
  return (input.workspaceId === undefined || (input.workspaceId !== '' && input.workspaceId.length <= 256))
    && (input.status?.length ?? 0) <= IDEAS_READ_MAX_SELECTORS
    && (input.ids?.length ?? 0) <= IDEAS_READ_MAX_SELECTORS
    && (input.numbers?.length ?? 0) <= IDEAS_READ_MAX_SELECTORS
    && (input.fields?.length ?? 0) <= IDEAS_READ_SELECTABLE_FIELDS.length
    && statusValid
    && idsValid
    && numbersValid
    && fieldsValid
    && bounded(input.bodyLimit, 0, IDEAS_READ_MAX_BODY_BYTES)
    && bounded(input.limit, 1, IDEAS_READ_MAX_LIMIT)
    && bounded(input.offset, 0, 1_000_000)
}

/**
 * Project a source-of-truth snapshot into a bounded filtered read. No cache
 * or mutable view state is introduced: every response is derived from the
 * current ledger revision. If selected fields would exceed the hard wire
 * budget, trailing rows are omitted and `nextOffset` makes that explicit.
 */
export function buildIdeasReadSnapshot(snapshot: IdeasSnapshot, input: IdeasReadQuery = {}): IdeasReadSnapshot {
  if (!validReadQuery(input)) throw new Error('invalid-query')
  const query: NormalizedIdeasReadQuery = {
    view: input.view ?? 'summary',
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    status: [...new Set(input.status ?? [])],
    ids: [...new Set(input.ids ?? [])],
    numbers: [...new Set(input.numbers ?? [])],
    fields: [...new Set(input.fields ?? (input.view === 'detail' ? DETAIL_READ_FIELDS : SUMMARY_READ_FIELDS))],
    bodyLimit: input.bodyLimit ?? 0,
    limit: input.limit ?? IDEAS_READ_DEFAULT_LIMIT,
    offset: input.offset ?? 0,
  }
  const statuses = new Set(query.status)
  const ids = new Set(query.ids)
  const numbers = new Set(query.numbers)
  const hasSelector = ids.size > 0 || numbers.size > 0
  const matchedIdeas = snapshot.ideas.filter(idea =>
    (query.workspaceId === undefined || idea.workspaceId === query.workspaceId)
    && (statuses.size === 0 || statuses.has(idea.status))
    && (!hasSelector || ids.has(idea.id) || (idea.ideaNumber !== undefined && numbers.has(idea.ideaNumber))),
  )
  const selected = new Set<IdeasReadField>(query.fields)
  const omittedFields: Array<IdeasReadField | 'analysisAudit'> = [
    ...IDEAS_READ_SELECTABLE_FIELDS.filter(field => !selected.has(field)),
    'analysisAudit',
  ]
  const rows = matchedIdeas
    .slice(query.offset, query.offset + query.limit)
    .map(idea => projectReadRow(idea, query, selected))
  let response = readResponse(snapshot.revision, rows, query, matchedIdeas.length, omittedFields)
  // The hard response cap is a final guard for field-rich imported records:
  // drop trailing rows until the complete JSON envelope fits.
  while (rows.length > 0 && utf8Bytes(JSON.stringify(response)) > IDEAS_READ_MAX_RESPONSE_BYTES) {
    rows.pop()
    response = readResponse(snapshot.revision, rows, query, matchedIdeas.length, omittedFields)
  }
  return response
}

/**
 * Leading slice of a body for previews and search: whitespace collapses to
 * single spaces (this is a teaser, not markdown structure), the cut lands on
 * a word boundary when one is reasonably close, and a truncated excerpt
 * carries an ellipsis.
 */
export function bodyExcerptOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= BODY_EXCERPT_MAX_LENGTH) return flat
  const cut = flat.slice(0, BODY_EXCERPT_MAX_LENGTH)
  const lastSpace = cut.lastIndexOf(' ')
  const text = lastSpace > BODY_EXCERPT_MAX_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${text}…`
}

/** Project one full record to its list row (drops body + analysisAudit). */
export function toListRow(idea: IdeaRecord): IdeaListRow {
  // The omit pattern: `analysisAudit` is intentionally unused (dropped),
  // `body` only feeds the excerpt.
  const { body, analysisAudit, ...rest } = idea
  void analysisAudit
  return { ...rest, bodyExcerpt: bodyExcerptOf(body) }
}

/**
 * Project a full snapshot to the list view. Shared by the host (the
 * `?view=list` state route) and the client (action responses still carry
 * the FULL snapshot - the POST /api/ideas/action contract is frozen - and
 * are projected here at the transport edge).
 */
export function toListSnapshot(snapshot: IdeasSnapshot): IdeasListSnapshot {
  return {
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    ideas: snapshot.ideas.map(toListRow),
  }
}

/** SSE event frame: revision only, never the idea list. */
export interface IdeasEventPayload {
  revision: number
}

export type IdeasAction =
  | { kind: 'import'; sourceId: string; ideas: IdeaRecord[] }
  | { kind: 'create'; id: string; input: NewIdeaInput }
  | { kind: 'update'; ideaId: string; patch: IdeaUpdatePatch }
  | { kind: 'move'; ideaId: string; status: Extract<IdeaStatus, 'open' | 'underReview' | 'archived'> }
  | { kind: 'decline'; ideaId: string; decision?: string }
  | { kind: 'deliver'; ideaId: string }
  | { kind: 'triage'; ideaId: string; patch: TriagePatch }
  | {
      kind: 'followUp'
      ideaId: string
      /** The child idea: title/body (the summary + justification, composed by the UI). */
      input: FollowUpInput
    }
  | { kind: 'restore'; ideaId: string }
  | { kind: 'delete'; ideaId: string }
  | {
      kind: 'reanalyze'
      ideaId: string
    }
  | { kind: 'reorder'; orderedIds: string[] }
  | { kind: 'export'; workspaceId?: string }

export interface IdeasActionEnvelope {
  requestId: string
  action: IdeasAction
  /**
   * Session id of the DSH session issuing the action, for the audit trail.
   * Client-asserted, not a trust boundary; parsed only as a bounded non-empty
   * string.
   */
  initiator?: string
}

/** Patch accepted by `update`; a null `tags` clears the label set. */
export interface IdeaUpdatePatch {
  title?: string
  body?: string
  /** Compact card summary (<= 300 chars enforced by the ledger); null clears. */
  summary?: string | null
  rank?: number
  value?: number
  effort?: number
  rationale?: string
  tags?: IdeaTagListOrNull
  workspaceId?: string
}

type IdeaTagListOrNull = IdeaTag[] | null

/**
 * Triage patch: the priority opinion (value/effort/rationale) plus the
 * suggested 1-based rank where the idea should sit INSIDE the open backlog.
 * The host applies the scores and re-inserts the idea at that rank, shifting
 * the rest — never a plain append (see the guidance protocol).
 */
export interface TriagePatch {
  value?: number
  effort?: number
  rationale?: string
  rank?: number
}

/**
 * Input of the `followUp` verb: the child idea raised when the review of an
 * under-review idea is NOK. The UI composes `body` as the parent summary +
 * the requested follow-up justification; the host links the child
 * (`followUpOfId`), inherits the parent workspace, and archives the parent —
 * atomically, in one commit.
 */
export interface FollowUpInput {
  title: string
  body: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

const FORBIDDEN_IMPORT_FIELDS = new Set(['args', 'command', 'executable', 'powershell', 'shell'])

function hasForbiddenImportField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenImportField)
  const row = record(value)
  if (row === undefined) return false
  return Object.entries(row).some(([key, nested]) => FORBIDDEN_IMPORT_FIELDS.has(key.toLowerCase()) || hasForbiddenImportField(nested))
}

function importedIdea(value: unknown): IdeaRecord | undefined {
  const input = record(value)
  if (input === undefined || hasForbiddenImportField(input)) return undefined
  const row = { ...input }
  if (typeof row.title !== 'string' || typeof row.body !== 'string') return undefined
  if (typeof row.id !== 'string' || row.id === '') return undefined
  if (typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number') return undefined
  if (!isIdeaStatus(row.status)) return undefined
  if (row.tags !== undefined && !isIdeaTagList(row.tags)) return undefined
  if (row.rank !== undefined && row.rank !== null && (typeof row.rank !== 'number' || !Number.isFinite(row.rank))) return undefined
  if (row.value !== undefined && row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value))) return undefined
  if (row.effort !== undefined && row.effort !== null && (typeof row.effort !== 'number' || !Number.isFinite(row.effort))) return undefined
  if (row.rationale !== undefined && row.rationale !== null && typeof row.rationale !== 'string') return undefined
  if (row.decision !== undefined && row.decision !== null && typeof row.decision !== 'string') return undefined
  if (row.ideaNumber !== undefined && row.ideaNumber !== null && (typeof row.ideaNumber !== 'number' || !Number.isFinite(row.ideaNumber))) return undefined
  if (row.deliveredAt !== undefined && row.deliveredAt !== null && typeof row.deliveredAt !== 'number') return undefined
  for (const key of ['workspaceId', 'taskBoardId'] as const) {
    if (row[key] !== undefined && typeof row[key] !== 'string') return undefined
  }
  if (row.taskBoardStatus !== undefined && row.taskBoardStatus !== null
      && (typeof row.taskBoardStatus !== 'string' || row.taskBoardStatus.length > 32)) return undefined
  if (row.archivedAt !== undefined && row.archivedAt !== null && typeof row.archivedAt !== 'number') return undefined
  if (row.followUpOfId !== undefined && row.followUpOfId !== null && typeof row.followUpOfId !== 'string') return undefined
  if (row.reanalyzeAt !== undefined && row.reanalyzeAt !== null && typeof row.reanalyzeAt !== 'number') return undefined
  if (row.summary !== undefined && row.summary !== null && typeof row.summary !== 'string') return undefined
  if (row.analysisAudit !== undefined && row.analysisAudit !== null && !isAnalysisAudit(row.analysisAudit)) return undefined
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status as IdeaStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    ...(typeof row.rank === 'number' ? { rank: row.rank } : {}),
    ...(typeof row.value === 'number' ? { value: row.value } : {}),
    ...(typeof row.effort === 'number' ? { effort: row.effort } : {}),
    ...(typeof row.rationale === 'string' ? { rationale: row.rationale } : {}),
    ...(typeof row.decision === 'string' ? { decision: row.decision } : {}),
    ...(typeof row.ideaNumber === 'number' ? { ideaNumber: row.ideaNumber } : {}),
    ...(typeof row.deliveredAt === 'number' ? { deliveredAt: row.deliveredAt } : {}),
    ...(isIdeaTagList(row.tags) ? { tags: row.tags } : {}),
    ...(typeof row.workspaceId === 'string' ? { workspaceId: row.workspaceId } : {}),
    ...(typeof row.taskBoardId === 'string' ? { taskBoardId: row.taskBoardId } : {}),
    ...(typeof row.taskBoardStatus === 'string' ? { taskBoardStatus: row.taskBoardStatus.toLowerCase() } : {}),
    ...(typeof row.followUpOfId === 'string' ? { followUpOfId: row.followUpOfId } : {}),
    ...(typeof row.archivedAt === 'number' ? { archivedAt: row.archivedAt } : {}),
  ...(typeof row.reanalyzeAt === 'number' ? { reanalyzeAt: row.reanalyzeAt } : {}),
  ...(isAnalysisAudit(row.analysisAudit) ? { analysisAudit: row.analysisAudit } : {}),
  }
}

function createInput(value: unknown): value is NewIdeaInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['title', 'body', 'summary', 'workspaceId', 'rank', 'value', 'effort', 'rationale', 'tags'])) return false
  if (typeof input.title !== 'string' || typeof input.body !== 'string') return false
  if (!optionalString(input.workspaceId)) return false
  if (!optionalString(input.rationale)) return false
  if (!optionalString(input.summary)) return false
  if (!optionalFiniteNumber(input.rank) || !optionalFiniteNumber(input.value) || !optionalFiniteNumber(input.effort)) return false
  return input.tags === undefined || isIdeaTagList(input.tags)
}

function updatePatch(value: unknown): value is IdeaUpdatePatch {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['title', 'body', 'summary', 'rank', 'value', 'effort', 'rationale', 'tags', 'workspaceId'])) return false
  for (const key of ['title', 'body', 'workspaceId', 'rationale'] as const) {
    if (!optionalString(patch[key])) return false
  }
  // The summary is a plain string; null (like a blank value) clears it — the
  // ledger caps the stored value at IDEA_SUMMARY_MAX_LENGTH.
  if (patch.summary !== undefined && patch.summary !== null && typeof patch.summary !== 'string') return false
  for (const key of ['rank', 'value', 'effort'] as const) {
    if (patch[key] !== undefined && (typeof patch[key] !== 'number' || !Number.isFinite(patch[key] as number))) return false
  }
  // null clears the label set; a present array must be a well-formed list.
  if (patch.tags !== undefined && patch.tags !== null && !isIdeaTagList(patch.tags)) return false
  return true
}

function triagePatch(value: unknown): value is TriagePatch {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['value', 'effort', 'rationale', 'rank'])) return false
  if (!optionalString(patch.rationale)) return false
  for (const key of ['value', 'effort', 'rank'] as const) {
    if (!optionalFiniteNumber(patch[key])) return false
  }
  return true
}

function followUpInput(value: unknown): value is FollowUpInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['title', 'body'])) return false
  return typeof input.title === 'string' && typeof input.body === 'string'
}

/** Whether an unknown value is a well-formed preserved prior analysis. */
function isAnalysisAudit(value: unknown): value is IdeaRecord['analysisAudit'] {
  const audit = record(value)
  if (audit === undefined || !exactKeys(audit, ['at', 'title', 'body', 'summary', 'tags', 'value', 'effort', 'rationale'])) return false
  if (typeof audit.at !== 'number' || typeof audit.title !== 'string' || typeof audit.body !== 'string') return false
  if (audit.summary !== undefined && typeof audit.summary !== 'string') return false
  if (audit.tags !== undefined && !isIdeaTagList(audit.tags)) return false
  for (const key of ['value', 'effort'] as const) {
    if (audit[key] !== undefined && (typeof audit[key] !== 'number' || !Number.isFinite(audit[key] as number))) return false
  }
  return audit.rationale === undefined || typeof audit.rationale === 'string'
}

function reorderList(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every(item => typeof item === 'string' && item !== '')
}

export function parseActionEnvelope(value: unknown): IdeasActionEnvelope | undefined {
  const envelope = record(value)
  if (envelope === undefined || !exactKeys(envelope, ['requestId', 'action', 'initiator'])) return undefined
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '' || envelope.requestId.length > 256) return undefined
  if (envelope.initiator !== undefined && (typeof envelope.initiator !== 'string' || envelope.initiator.trim() === '' || envelope.initiator.length > 256)) return undefined
  const action = record(envelope.action)
  if (action === undefined || typeof action.kind !== 'string') return undefined
  const ideaId = typeof action.ideaId === 'string' && action.ideaId !== '' ? action.ideaId : undefined
  switch (action.kind) {
    case 'import':
      if (!exactKeys(action, ['kind', 'sourceId', 'ideas'])) return undefined
      if (typeof action.sourceId !== 'string' || action.sourceId === '' || !Array.isArray(action.ideas)) return undefined
      {
        const ideas = action.ideas.map(importedIdea)
        return ideas.every((idea): idea is IdeaRecord => idea !== undefined)
          ? { requestId: envelope.requestId, action: { kind: 'import', sourceId: action.sourceId, ideas } }
          : undefined
      }
    case 'create': {
      if (!exactKeys(action, ['kind', 'id', 'input'])) return undefined
      if (typeof action.id !== 'string' || action.id === '' || !createInput(action.input)) return undefined
      // Run the input through the same normalization the ledger applies so a
      // create can never smuggle a malformed tag set past the wire.
      const input = action.input as NewIdeaInput
      const tags = normalizeTags(input.tags)
      const sanitized: NewIdeaInput = tags === undefined ? { ...input, tags: undefined } : { ...input, tags }
      return { requestId: envelope.requestId, action: { kind: 'create', id: action.id as string, input: sanitized } }
    }
    case 'update': {
      if (!exactKeys(action, ['kind', 'ideaId', 'patch'])) return undefined
      if (ideaId === undefined || !updatePatch(action.patch)) return undefined
      return { requestId: envelope.requestId, action: { kind: 'update', ideaId, patch: action.patch as IdeaUpdatePatch } }
    }
    case 'move':
      if (!exactKeys(action, ['kind', 'ideaId', 'status'])) return undefined
      if (ideaId === undefined) return undefined
      return action.status === 'open' || action.status === 'underReview' || action.status === 'archived'
        ? { requestId: envelope.requestId, action: { kind: 'move', ideaId, status: action.status } }
        : undefined
    case 'decline': {
      if (!exactKeys(action, ['kind', 'ideaId', 'decision'])) return undefined
      if (ideaId === undefined || !optionalString(action.decision)) return undefined
      return action.decision === undefined
        ? { requestId: envelope.requestId, action: { kind: 'decline', ideaId } }
        : { requestId: envelope.requestId, action: { kind: 'decline', ideaId, decision: action.decision } }
    }
    case 'deliver':
      if (!exactKeys(action, ['kind', 'ideaId'])) return undefined
      return ideaId === undefined ? undefined : { requestId: envelope.requestId, action: { kind: 'deliver', ideaId } }
    case 'triage': {
      if (!exactKeys(action, ['kind', 'ideaId', 'patch'])) return undefined
      if (ideaId === undefined || !triagePatch(action.patch)) return undefined
      return { requestId: envelope.requestId, action: { kind: 'triage', ideaId, patch: action.patch as TriagePatch } }
    }
    case 'followUp': {
      if (!exactKeys(action, ['kind', 'ideaId', 'input'])) return undefined
      if (ideaId === undefined || !followUpInput(action.input)) return undefined
      return { requestId: envelope.requestId, action: { kind: 'followUp', ideaId, input: action.input as FollowUpInput } }
    }
    case 'restore':
    case 'delete':
      if (!exactKeys(action, ['kind', 'ideaId'])) return undefined
      return ideaId === undefined ? undefined : { requestId: envelope.requestId, action: { kind: action.kind, ideaId } as IdeasAction }
    case 'reanalyze':
      if (!exactKeys(action, ['kind', 'ideaId'])) return undefined
      return ideaId === undefined ? undefined : { requestId: envelope.requestId, action: { kind: 'reanalyze', ideaId } }
    case 'reorder':
      if (!exactKeys(action, ['kind', 'orderedIds'])) return undefined
      return reorderList(action.orderedIds)
        ? { requestId: envelope.requestId, action: { kind: 'reorder', orderedIds: action.orderedIds as string[] } }
        : undefined
    case 'export':
      if (!exactKeys(action, ['kind', 'workspaceId'])) return undefined
      return (action.workspaceId === undefined || typeof action.workspaceId === 'string')
        ? { requestId: envelope.requestId, action: { kind: 'export', ...(action.workspaceId === undefined ? {} : { workspaceId: action.workspaceId }) } }
        : undefined
    default:
      return undefined
  }
}

/** Convenience used by tests: build an idea record exactly as the ledger stores it. */
export function ideaFromInput(id: string, input: NewIdeaInput, now: number): IdeaRecord {
  return createIdea(input, now, id)
}

/* --- plugin display settings (GET/POST /api/ideas/config) --- */

/**
 * Panel tabs, mirror of BOARD_TABS (src/client/tabs.ts): spelled here so the
 * host bundle never pulls the client model — same discipline as the defaults.
 */
export const IDEAS_TABS = ['overview', 'priorities', 'delivered'] as const
/** One panel tab id. */
export type IdeasTab = (typeof IDEAS_TABS)[number]

/** Card densities offered by the settings row. */
export const IDEAS_DENSITIES = ['comfortable', 'compact'] as const
/** One card-density mode. */
export type IdeasDensity = (typeof IDEAS_DENSITIES)[number]

/**
 * Interface languages of the panel: `auto` follows the DSH shell language
 * (the shipped default), the others pin the panel to one dictionary
 * independently of the shell. DSH serves en + zh today, so `auto` gives an
 * English panel on an English shell and a Chinese one on a Chinese shell;
 * `fr` exists for a French-reading operator and future-proofs a French shell.
 */
export const IDEAS_LANGUAGES = ['auto', 'en', 'fr', 'zh'] as const
/** One panel language choice. */
export type IdeasLanguage = (typeof IDEAS_LANGUAGES)[number]

/** Bound of the remembered workspace scope (aligned on the envelope ids). */
export const WORKSPACE_SCOPE_MAX_LENGTH = 256

/** Resolved display-settings value served by the config routes. */
export interface IdeasSettingsValue {
  /** Visible tag-filter rows on the board (clamped to 1..5). */
  tagRows: number
  /** Panel tab opened at board start (mirror of BOARD_TABS). */
  defaultTab: IdeasTab
  /** Render card descriptions as markdown at open (session toggle stays free). */
  renderMarkdown: boolean
  /** Reopen on the last selected workspace scope instead of all workspaces. */
  rememberWorkspaceScope: boolean
  /** Last workspace scope kept while rememberWorkspaceScope is on ('' = all). */
  workspaceScope: string
  /** Ask for an in-place confirmation before Deliver / Decline. */
  confirmLifecycle: boolean
  /** Hide the Declined kanban column (declined cards leave the board view). */
  hideDeclinedColumn: boolean
  /** Kanban card density. */
  cardDensity: IdeasDensity
  /** Panel interface language: `auto` follows the DSH shell, else pinned. */
  language: IdeasLanguage
  /** Minimum width (px) a kanban column can be dragged to (idea #53). */
  columnMinWidth: number
  /** Maximum width (px) a kanban column can be dragged to (idea #53). */
  columnMaxWidth: number
}

/** Patch accepted by POST /api/ideas/config (exact keys, values sanitized). */
export type IdeasSettingsPatch = Partial<IdeasSettingsValue>

/**
 * Wire view of the plugin settings. `available` is false when the deployment
 * serves no settings document (no host settings service) — the client keeps
 * the defaults then, exactly like the Side card fallback. `revision` fences
 * the next write (absent while unavailable).
 */
export interface IdeasSettingsView {
  available: boolean
  value: IdeasSettingsValue
  revision?: number
}

/** Default bounds of the resizable kanban columns (idea #53), in pixels. */
export const COLUMN_MIN_WIDTH_DEFAULT = 200
// Max default raised twice by 20% from the original 640 (now 922) so a wide
// column has room to hold dense cards without wrapping; the option ceiling
// moves up by the same amount.
export const COLUMN_MAX_WIDTH_DEFAULT = 922
/** Inclusive bounds of the columnMinWidth option (settings row). */
export const COLUMN_MIN_WIDTH_RANGE = { min: 120, max: 480 } as const
/** Inclusive bounds of the columnMaxWidth option (settings row). */
export const COLUMN_MAX_WIDTH_RANGE = { min: 240, max: 1382 } as const

/**
 * Defaults the browser half keeps when no settings surface answers. Spelled
 * here rather than imported from the host entry so the client bundle never
 * pulls the Node-side module — same discipline as IDEAS_SETTINGS_NAMESPACE.
 */
export const IDEAS_SETTINGS_DEFAULTS: IdeasSettingsValue = {
  tagRows: 3,
  defaultTab: 'overview',
  renderMarkdown: true,
  rememberWorkspaceScope: false,
  workspaceScope: '',
  confirmLifecycle: false,
  hideDeclinedColumn: false,
  cardDensity: 'comfortable',
  language: 'auto',
  columnMinWidth: COLUMN_MIN_WIDTH_DEFAULT,
  columnMaxWidth: COLUMN_MAX_WIDTH_DEFAULT,
}

/** Inclusive bounds of the tagRows option (settings row: 1..5). */
export const TAG_ROWS_MIN = 1
export const TAG_ROWS_MAX = 5

/**
 * Clamp an unknown input to a legal tagRows value: finite numbers round to
 * the nearest integer and clamp into 1..5; anything else falls back to the
 * default. Hand-edited settings and hand-crafted wire values can never store
 * or render an illegal row count (the clamp, not the schema, is the guard —
 * a schema range would reject a bad stored section at registration).
 */
export function clampTagRows(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return IDEAS_SETTINGS_DEFAULTS.tagRows
  return Math.min(TAG_ROWS_MAX, Math.max(TAG_ROWS_MIN, Math.round(value)))
}

/**
 * Clamp an unknown input to a legal minimum column width: finite numbers round
 * and clamp into the range; anything else falls back to the default. Same guard
 * discipline as clampTagRows — the clamp, not a schema range, is the boundary.
 */
export function clampColumnMinWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COLUMN_MIN_WIDTH_DEFAULT
  return Math.min(COLUMN_MIN_WIDTH_RANGE.max, Math.max(COLUMN_MIN_WIDTH_RANGE.min, Math.round(value)))
}

/** Clamp an unknown input to a legal maximum column width (see the min twin). */
export function clampColumnMaxWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COLUMN_MAX_WIDTH_DEFAULT
  return Math.min(COLUMN_MAX_WIDTH_RANGE.max, Math.max(COLUMN_MAX_WIDTH_RANGE.min, Math.round(value)))
}

/** Unknown -> one of `allowed`, else the fallback (enum fields). */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/** Unknown -> a real boolean, else the fallback. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Sanitize a raw section into a COMPLETE legal value: both read paths (host
 * viewOf, client loadConfig) run every field through its guard, so a
 * hand-edited document or a corrupt wire can never widen what the UI renders.
 * Policy on READS: numbers clamp, enums/booleans fall back to the default,
 * strings bound. (Writes are stricter: a non-boolean rejects — see
 * parseSettingsBody.)
 */
export function sanitizeSettings(raw: unknown): IdeasSettingsValue {
  const row = record(raw) ?? {}
  return {
    tagRows: clampTagRows(row.tagRows),
    defaultTab: oneOf(row.defaultTab, IDEAS_TABS, IDEAS_SETTINGS_DEFAULTS.defaultTab),
    renderMarkdown: booleanOr(row.renderMarkdown, IDEAS_SETTINGS_DEFAULTS.renderMarkdown),
    rememberWorkspaceScope: booleanOr(row.rememberWorkspaceScope, IDEAS_SETTINGS_DEFAULTS.rememberWorkspaceScope),
    workspaceScope: typeof row.workspaceScope === 'string'
      ? row.workspaceScope.slice(0, WORKSPACE_SCOPE_MAX_LENGTH)
      : IDEAS_SETTINGS_DEFAULTS.workspaceScope,
    confirmLifecycle: booleanOr(row.confirmLifecycle, IDEAS_SETTINGS_DEFAULTS.confirmLifecycle),
    hideDeclinedColumn: booleanOr(row.hideDeclinedColumn, IDEAS_SETTINGS_DEFAULTS.hideDeclinedColumn),
    cardDensity: oneOf(row.cardDensity, IDEAS_DENSITIES, IDEAS_SETTINGS_DEFAULTS.cardDensity),
    language: oneOf(row.language, IDEAS_LANGUAGES, IDEAS_SETTINGS_DEFAULTS.language),
    columnMinWidth: clampColumnMinWidth(row.columnMinWidth),
    columnMaxWidth: clampColumnMaxWidth(row.columnMaxWidth),
  }
}

/** Every patchable field (exactKeys allow-list of the write body). */
const SETTINGS_PATCH_KEYS = [
  'tagRows', 'defaultTab', 'renderMarkdown', 'rememberWorkspaceScope',
  'workspaceScope', 'confirmLifecycle', 'hideDeclinedColumn', 'cardDensity',
  'language', 'columnMinWidth', 'columnMaxWidth',
] as const

/**
 * Strict parser for the config write body ({ patch, expectedRevision? }).
 * Unknown keys reject; booleans must be REAL booleans (no meaningful clamp —
 * a non-boolean is a corrupt wire); tagRows clamps and the enums sanitize to
 * their default (the lenient read policy); workspaceScope is a bounded
 * string. An absent field yields an empty patch (a no-op merge that still
 * carries the revision fence).
 */
export function parseSettingsBody(value: unknown): { patch: IdeasSettingsPatch; expectedRevision: number | undefined } | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['patch', 'expectedRevision'])) return undefined
  if (!optionalFiniteNumber(body.expectedRevision)) return undefined
  const raw = record(body.patch)
  if (raw === undefined || !exactKeys(raw, SETTINGS_PATCH_KEYS)) return undefined
  const patch: IdeasSettingsPatch = {}
  for (const key of SETTINGS_PATCH_KEYS) {
    const field = raw[key]
    if (field === undefined) continue
    if (key === 'renderMarkdown' || key === 'rememberWorkspaceScope' || key === 'confirmLifecycle' || key === 'hideDeclinedColumn') {
      if (typeof field !== 'boolean') return undefined
      patch[key] = field
    } else if (key === 'workspaceScope') {
      if (typeof field !== 'string') return undefined
      patch.workspaceScope = field.slice(0, WORKSPACE_SCOPE_MAX_LENGTH)
    } else if (key === 'tagRows') {
      if (typeof field !== 'number' || !Number.isFinite(field)) return undefined
      patch.tagRows = clampTagRows(field)
    } else if (key === 'defaultTab') {
      patch.defaultTab = oneOf(field, IDEAS_TABS, IDEAS_SETTINGS_DEFAULTS.defaultTab)
    } else if (key === 'language') {
      patch.language = oneOf(field, IDEAS_LANGUAGES, IDEAS_SETTINGS_DEFAULTS.language)
    } else if (key === 'columnMinWidth') {
      if (typeof field !== 'number' || !Number.isFinite(field)) return undefined
      patch.columnMinWidth = clampColumnMinWidth(field)
    } else if (key === 'columnMaxWidth') {
      if (typeof field !== 'number' || !Number.isFinite(field)) return undefined
      patch.columnMaxWidth = clampColumnMaxWidth(field)
    } else {
      patch.cardDensity = oneOf(field, IDEAS_DENSITIES, IDEAS_SETTINGS_DEFAULTS.cardDensity)
    }
  }
  return { patch, expectedRevision: body.expectedRevision as number | undefined }
}
