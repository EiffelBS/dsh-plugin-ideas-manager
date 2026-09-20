/**
 * Ideas domain model: idea lifecycle statuses, the idea record shape, and the
 * pure validation helpers the protocol gate, the host ledger, and the tests
 * share. Framework-free (no cordis, no runtime imports) so the model is
 * unit-testable in isolation.
 */

/**
 * Idea lifecycle status, one per kanban column. `underReview` is the recette
 * gate: an idea whose work is done but whose acceptance by a human is still
 * pending (entered automatically when the mirrored task card passes `done`).
 * Recette OK → `deliver`; recette NOK → a `followUp` request (child idea) or
 * `decline`.
 */
export type IdeaStatus = 'open' | 'underReview' | 'archived' | 'declined'

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

/** Normalize one optional target string: trim; blank collapses to undefined. */
export function normalizeOptionalId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
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

/** One idea on the board. */
export interface IdeaRecord {
  /** Stable idea id (uuid or import identifier). */
  id: string
  /** Short display title (<= 200 chars). */
  title: string
  /** Longer body shown in the detail view (<= 32 KiB). */
  body: string
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
  /** Workspace this idea belongs to (absent = generic). */
  workspaceId?: string
  /** Mirror link to the TaskBoard card id when the bridge is active (P2). */
  taskBoardId?: string
  /**
   * Recette NOK: id of the parent idea this idea is a follow-up of (set by
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
}

/** Input for creating an idea. */
export interface NewIdeaInput {
  /** Short display title. */
  title: string
  /** Longer body. */
  body: string
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
  if (typeof record.createdAt !== 'number' || typeof record.updatedAt !== 'number') return false
  if (record.rank !== undefined && (typeof record.rank !== 'number' || !Number.isFinite(record.rank))) return false
  if (record.value !== undefined && (typeof record.value !== 'number' || !Number.isFinite(record.value))) return false
  if (record.effort !== undefined && (typeof record.effort !== 'number' || !Number.isFinite(record.effort))) return false
  if (record.rationale !== undefined && typeof record.rationale !== 'string') return false
  if (record.workspaceId !== undefined && typeof record.workspaceId !== 'string') return false
  if (record.taskBoardId !== undefined && typeof record.taskBoardId !== 'string') return false
  if (record.followUpOfId !== undefined && typeof record.followUpOfId !== 'string') return false
  if (record.ideaNumber !== undefined && (typeof record.ideaNumber !== 'number' || !Number.isFinite(record.ideaNumber))) return false
  if (record.rationale !== undefined && typeof record.rationale !== 'string') return false
  if (record.deliveredAt !== undefined && typeof record.deliveredAt !== 'number') return false
  if (record.decision !== undefined && typeof record.decision !== 'string') return false
  if (record.archivedAt !== undefined && typeof record.archivedAt !== 'number') return false
  if (record.tags !== undefined && !Array.isArray(record.tags)) return false
  return true
}

/** An idea record is structurally valid if every row round-trips the UI. */
export function isIdeaRecord(value: unknown): value is IdeaRecord {
  if (!isIdeaRecordShape(value)) return false
  const record = value as Record<string, unknown>
  if (!isIdeaStatus(record.status)) return false
  if (record.tags !== undefined && !isIdeaTagList(record.tags)) return false
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
  return {
    id,
    title: input.title.trim().slice(0, IDEA_TITLE_MAX_LENGTH),
    body: input.body.trim(),
    status: 'open',
    createdAt: now,
    updatedAt: now,
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
