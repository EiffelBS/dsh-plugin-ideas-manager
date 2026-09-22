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
 * Input of the `followUp` verb: the child idea raised when the recette of an
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
