/**
 * Portable synchronization contract for the ideas ledger.
 *
 * This format is deliberately separate from the disaster-recovery snapshot. A
 * snapshot replaces a whole ledger; a sync package carries one workspace's
 * portable idea content and is adopted additively by a Host that has explicitly
 * confirmed the workspace mapping. The pure three-way planner lives in
 * `sync-merge.ts`; this module owns the portable and machine-local contracts.
 */

import { IDEA_RELATION_ID_MAX_LENGTH, type IdeaRecord } from './core/ideas.ts'
import { parseImportedIdea, type IdeasSnapshotInfo } from './protocol.ts'

/** Discriminator that keeps a sync package out of the backup/restore path. */
export const IDEAS_SYNC_FORMAT = 'dsh-ideas-sync'
/** Version of the sync package envelope, independent of the ledger schema. */
export const IDEAS_SYNC_VERSION = 1 as const
/** Bound of a device, snapshot, or sync-key identifier. */
export const IDEAS_SYNC_ID_MAX_LENGTH = 128
/** Bound of a local DSH workspace id. */
export const IDEAS_SYNC_WORKSPACE_ID_MAX_LENGTH = 256
/** Backstop for the machine-local workspace mapping table. */
export const IDEAS_SYNC_MAPPING_LIMIT = 256
/** Number of recent exchanged snapshots retained as possible common ancestors. */
export const IDEAS_SYNC_SNAPSHOT_CACHE_LIMIT = 4
/** Byte cap for one cached ancestor, matching the portable package budget. */
export const IDEAS_SYNC_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024

/**
 * Idea fields that belong to the destination machine, never to package identity.
 *
 * `ideaNumber` is a local display number. `workspaceId` is a local DSH UUID.
 * The remaining fields are live execution pointers or observations from another
 * Host and must never become active state on import.
 */
export const IDEAS_SYNC_LOCAL_IDEA_FIELDS = [
  'workspaceId',
  'ideaNumber',
  'taskBoardId',
  'taskBoardStatus',
  'runStatus',
  'runSessionId',
] as const

/**
 * Every other persisted idea field is portable content. The literal list is the
 * package's forward-compatibility surface: a new record field must be classified
 * here or in the local list, and the tests assert their union equals the backup
 * field surface.
 */
export const IDEAS_SYNC_PORTABLE_IDEA_FIELDS = [
  'id',
  'title',
  'body',
  'status',
  'createdAt',
  'updatedAt',
  'summary',
  'rank',
  'value',
  'effort',
  'rationale',
  'decision',
  'deliveredAt',
  'archivedAt',
  'deliveryNote',
  'followUpOfId',
  'tags',
  'reanalyzeAt',
  'analysisAudit',
  'events',
  'relatesTo',
  'blocks',
] as const

/** Portable projection of one idea; local numbering and execution state are absent by type. */
export type IdeasSyncIdea = Omit<IdeaRecord, (typeof IDEAS_SYNC_LOCAL_IDEA_FIELDS)[number]>

/** One bounded snapshot retained for a later common-ancestor lookup. */
export interface IdeasSyncSnapshotCache {
  snapshotId: string
  ideas: IdeasSyncIdea[]
}

/** One explicitly confirmed machine-local mapping. */
export interface IdeasSyncWorkspaceMapping {
  /** Portable workspace identity shared by every machine that opts in. */
  syncKey: string
  /** The local DSH workspace UUID this Host writes onto imported ideas. */
  workspaceId: string
  /** When the human confirmed this pairing. */
  confirmedAt: number
  /** Last package snapshot adopted into this local workspace; null before the first import. */
  baseSnapshotId: string | null
  /**
   * Recent snapshots exchanged in either direction. An incoming base id is
   * resolved only here; an evicted or unknown id selects conservative two-way
   * mode rather than inventing a common ancestor.
   */
  snapshots: IdeasSyncSnapshotCache[]
}

/** Machine-local synchronization state persisted with the ledger document. */
export interface IdeasSyncState {
  /** Stable identity of this ledger Home, carried by every exported package. */
  deviceId: string
  /** Confirmed portable-key to local-workspace pairings. */
  workspaces: IdeasSyncWorkspaceMapping[]
}

/** Versioned, additive package envelope. It is never a ledger snapshot. */
export interface IdeasSyncPackage {
  format: typeof IDEAS_SYNC_FORMAT
  version: typeof IDEAS_SYNC_VERSION
  deviceId: string
  snapshotId: string
  /** Snapshot this exporting Host had most recently adopted for the workspace. */
  baseSnapshotId: string | null
  createdAt: number
  workspace: {
    /** Portable workspace identity. */
    syncKey: string
    /** Diagnostic origin only; never used to match a destination workspace. */
    sourceWorkspaceId: string
  }
  ideas: IdeasSyncIdea[]
}

/** One workspace row in the additive sync overview. */
export interface IdeasSyncWorkspaceView {
  workspaceId: string
  ideaCount: number
  syncKey?: string
  confirmed: boolean
  confirmedAt?: number
  baseSnapshotId?: string | null
}

/** GET /api/ideas/sync. */
export interface IdeasSyncOverview {
  ok: true
  deviceId: string
  workspaces: IdeasSyncWorkspaceView[]
}

/** A confirmed mapping returned by POST /api/ideas/sync/workspaces. */
export interface IdeasSyncMappingResponse {
  ok: true
  mapping: IdeasSyncWorkspaceMapping
}

/** POST /api/ideas/sync/export. */
export interface IdeasSyncExportResponse {
  ok: true
  package: IdeasSyncPackage
}

/** One explicit decision for a conflict emitted by the merge planner. */
export interface IdeasSyncConflictResolution {
  conflictId: string
  /** `clear` removes an optional conflicted field or relation. */
  choice: 'local' | 'remote' | 'clear'
}

/** POST /api/ideas/sync/plan and the optional decisions on import. */
export interface IdeasSyncPlanRequest {
  package: IdeasSyncPackage
  resolutions?: IdeasSyncConflictResolution[]
  /** Ledger revision the read-only preview was computed against. */
  expectedRevision?: number
}

/** POST /api/ideas/sync/plan. */
export interface IdeasSyncPlanResponse {
  ok: true
  /** Ledger revision this preview describes; apply must carry the same value. */
  revision: number
  plan: import('./sync-merge.ts').IdeasSyncMergePlan
}

/** POST /api/ideas/sync/import. */
export interface IdeasSyncImportResponse {
  ok: true
  snapshotId: string
  syncKey: string
  workspaceId: string
  /** Newly created rows; all other incoming rows are counted as skipped. */
  imported: number
  skipped: number
  revision: number
  plan: import('./sync-merge.ts').IdeasSyncMergePlan
  /** Board snapshot written before the one atomic apply commit. */
  displaced?: IdeasSnapshotInfo
}

/** Stable refusal codes served by the additive sync routes. */
export type IdeasSyncErrorCode =
  | 'invalid-sync-workspace'
  | 'invalid-sync-export'
  | 'invalid-sync-package'
  | 'sync-workspace-unconfirmed'
  | 'sync-key-conflict'
  | 'sync-workspace-conflict'
  | 'sync-preview-stale'
  | 'sync-idea-conflict'
  | 'sync-reference-missing'
  | 'sync-relation-invalid'
  | 'sync-resolution-invalid'
  | 'sync-snapshot-failed'
  | 'sync-apply-failed'

/** A normal refusal answer; the ledger is unchanged in every case. */
export interface IdeasSyncRefusal {
  ok: false
  error: IdeasSyncErrorCode
  message: string
  /** Present for merge refusals so a caller can present every explicit decision. */
  plan?: import('./sync-merge.ts').IdeasSyncMergePlan
}

/** Request body of POST /api/ideas/sync/workspaces. */
export interface IdeasSyncWorkspaceRequest {
  workspaceId: string
  /** Omit to mint a new key for a workspace that has none. */
  syncKey?: string
  /** Must be literally true: names and paths are never matched automatically. */
  confirm: true
  /** Replace a different existing key for this workspace and reset its sync history. */
  replaceExisting?: boolean
}

/** Request body of POST /api/ideas/sync/export. */
export interface IdeasSyncExportRequest {
  workspaceId: string
}

/** Request body of POST /api/ideas/sync/import. */
export interface IdeasSyncImportRequest {
  package: IdeasSyncPackage
  resolutions?: IdeasSyncConflictResolution[]
  /** Revision of the preview the human inspected; a mismatch refuses the apply. */
  expectedRevision?: number
}

const PACKAGE_KEYS = [
  'format', 'version', 'deviceId', 'snapshotId', 'baseSnapshotId',
  'createdAt', 'workspace', 'ideas',
] as const
const PACKAGE_WORKSPACE_KEYS = ['syncKey', 'sourceWorkspaceId'] as const
const SYNC_STATE_KEYS = ['deviceId', 'workspaces'] as const
const SYNC_MAPPING_KEYS = ['syncKey', 'workspaceId', 'confirmedAt', 'baseSnapshotId', 'snapshots'] as const
const SYNC_SNAPSHOT_KEYS = ['snapshotId', 'ideas'] as const
const RESOLUTION_KEYS = ['conflictId', 'choice'] as const
const WORKSPACE_REQUEST_KEYS = ['workspaceId', 'syncKey', 'confirm', 'replaceExisting'] as const
const EXPORT_REQUEST_KEYS = ['workspaceId'] as const
const PLAN_REQUEST_KEYS = ['package', 'resolutions', 'expectedRevision'] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= IDEAS_SYNC_ID_MAX_LENGTH
    && !/\s/.test(value)
}

function isSyncKey(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)
}

function isWorkspaceId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed !== '' && trimmed.length <= IDEAS_SYNC_WORKSPACE_ID_MAX_LENGTH
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSnapshotId(value: unknown): value is string | null {
  return value === null || isBoundedId(value)
}

/** Strict portable-row list parser shared by packages and ancestor cache entries. */
function parsePortableIdeas(value: unknown): IdeasSyncIdea[] | undefined {
  if (!Array.isArray(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > IDEAS_SYNC_SNAPSHOT_MAX_BYTES) {
    return undefined
  }
  const seen = new Set<string>()
  const ideas: IdeasSyncIdea[] = []
  for (const entry of value) {
    const portable = record(entry)
    if (portable === undefined || !exactKeys(portable, IDEAS_SYNC_PORTABLE_IDEA_FIELDS)) return undefined
    const idea = parseImportedIdea(entry)
    if (idea === undefined || idea.id.length > IDEA_RELATION_ID_MAX_LENGTH || seen.has(idea.id)) return undefined
    seen.add(idea.id)
    ideas.push(idea as IdeasSyncIdea)
  }
  return ideas
}

/** Create the empty machine-local state with a caller-supplied stable device id. */
export function createIdeasSyncState(deviceId: string): IdeasSyncState {
  return { deviceId, workspaces: [] }
}

/** Strict validator for persisted sync state used by the restore path. */
export function parseIdeasSyncState(value: unknown): IdeasSyncState | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, SYNC_STATE_KEYS)) return undefined
  if (!isBoundedId(row.deviceId) || !Array.isArray(row.workspaces)) return undefined
  if (row.workspaces.length > IDEAS_SYNC_MAPPING_LIMIT) return undefined
  const keys = new Set<string>()
  const workspaceIds = new Set<string>()
  const workspaces: IdeasSyncWorkspaceMapping[] = []
  for (const value of row.workspaces) {
    const mapping = record(value)
    if (mapping === undefined || !exactKeys(mapping, SYNC_MAPPING_KEYS)) return undefined
    if (!isSyncKey(mapping.syncKey) || !isWorkspaceId(mapping.workspaceId)) return undefined
    if (!isTimestamp(mapping.confirmedAt) || !isSnapshotId(mapping.baseSnapshotId)) return undefined
    if (keys.has(mapping.syncKey) || workspaceIds.has(mapping.workspaceId)) return undefined
    const snapshots: IdeasSyncSnapshotCache[] = []
    const snapshotIds = new Set<string>()
    if (mapping.snapshots !== undefined) {
      if (!Array.isArray(mapping.snapshots) || mapping.snapshots.length > IDEAS_SYNC_SNAPSHOT_CACHE_LIMIT) return undefined
      for (const value of mapping.snapshots) {
        const snapshot = record(value)
        if (snapshot === undefined || !exactKeys(snapshot, SYNC_SNAPSHOT_KEYS)) return undefined
        if (!isBoundedId(snapshot.snapshotId) || snapshotIds.has(snapshot.snapshotId)) return undefined
        const ideas = parsePortableIdeas(snapshot.ideas)
        if (ideas === undefined) return undefined
        snapshotIds.add(snapshot.snapshotId)
        snapshots.push({ snapshotId: snapshot.snapshotId, ideas })
      }
    }
    keys.add(mapping.syncKey)
    workspaceIds.add(mapping.workspaceId)
    workspaces.push({
      syncKey: mapping.syncKey,
      workspaceId: mapping.workspaceId.trim(),
      confirmedAt: mapping.confirmedAt,
      baseSnapshotId: mapping.baseSnapshotId,
      snapshots,
    })
  }
  return { deviceId: row.deviceId, workspaces }
}

/**
 * Lenient boot reader. A malformed mapping is dropped rather than bricking the
 * board; a missing state gets the caller's newly minted stable device id. The
 * strict restore path uses parseIdeasSyncState and refuses a malformed state.
 */
export function normalizeIdeasSyncState(value: unknown, fallbackDeviceId: string): IdeasSyncState {
  const parsed = parseIdeasSyncState(value)
  return parsed ?? createIdeasSyncState(fallbackDeviceId)
}

/** Deep copy of the machine-local identity and bounded ancestor cache. */
export function cloneIdeasSyncState(state: IdeasSyncState): IdeasSyncState {
  return JSON.parse(JSON.stringify(state)) as IdeasSyncState
}

/** Project one ledger row to portable content, dropping every machine-local field. */
export function portableIdeaOf(idea: IdeaRecord): IdeasSyncIdea {
  const {
    workspaceId,
    ideaNumber,
    taskBoardId,
    taskBoardStatus,
    runStatus,
    runSessionId,
    ...portable
  } = idea
  void workspaceId
  void ideaNumber
  void taskBoardId
  void taskBoardStatus
  void runStatus
  void runSessionId
  return JSON.parse(JSON.stringify(portable)) as IdeasSyncIdea
}

/** Build a package from Host-owned full records, never from a client projection. */
export function buildIdeasSyncPackage(options: {
  ideas: readonly IdeaRecord[]
  mapping: IdeasSyncWorkspaceMapping
  deviceId: string
  snapshotId: string
  createdAt: number
}): IdeasSyncPackage {
  return {
    format: IDEAS_SYNC_FORMAT,
    version: IDEAS_SYNC_VERSION,
    deviceId: options.deviceId,
    snapshotId: options.snapshotId,
    baseSnapshotId: options.mapping.baseSnapshotId,
    createdAt: options.createdAt,
    workspace: {
      syncKey: options.mapping.syncKey,
      sourceWorkspaceId: options.mapping.workspaceId,
    },
    ideas: options.ideas
      .filter(idea => idea.workspaceId === options.mapping.workspaceId)
      .map(portableIdeaOf),
  }
}

/** Strict package validator. Local execution fields are refused, not silently dropped. */
export function parseIdeasSyncPackage(value: unknown): IdeasSyncPackage | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, PACKAGE_KEYS)) return undefined
  if (row.format !== IDEAS_SYNC_FORMAT || row.version !== IDEAS_SYNC_VERSION) return undefined
  if (!isBoundedId(row.deviceId) || !isBoundedId(row.snapshotId)) return undefined
  if (!isSnapshotId(row.baseSnapshotId) || !isTimestamp(row.createdAt)) return undefined
  const workspace = record(row.workspace)
  if (workspace === undefined || !exactKeys(workspace, PACKAGE_WORKSPACE_KEYS)) return undefined
  if (!isSyncKey(workspace.syncKey) || !isWorkspaceId(workspace.sourceWorkspaceId)) return undefined
  const ideas = parsePortableIdeas(row.ideas)
  if (ideas === undefined) return undefined
  return {
    format: IDEAS_SYNC_FORMAT,
    version: IDEAS_SYNC_VERSION,
    deviceId: row.deviceId,
    snapshotId: row.snapshotId,
    baseSnapshotId: row.baseSnapshotId,
    createdAt: row.createdAt,
    workspace: {
      syncKey: workspace.syncKey,
      sourceWorkspaceId: workspace.sourceWorkspaceId.trim(),
    },
    ideas,
  }
}

/** Strict parser for the explicit workspace-confirmation body. */
export function parseIdeasSyncWorkspaceRequest(value: unknown): IdeasSyncWorkspaceRequest | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, WORKSPACE_REQUEST_KEYS)) return undefined
  if (!isWorkspaceId(row.workspaceId) || row.confirm !== true) return undefined
  if (row.syncKey !== undefined && !isSyncKey(row.syncKey)) return undefined
  if (row.replaceExisting !== undefined && typeof row.replaceExisting !== 'boolean') return undefined
  return {
    workspaceId: row.workspaceId.trim(),
    ...(row.syncKey === undefined ? {} : { syncKey: row.syncKey }),
    confirm: true,
    ...(row.replaceExisting === true ? { replaceExisting: true } : {}),
  }
}

/** Strict parser for the export body. */
export function parseIdeasSyncExportRequest(value: unknown): IdeasSyncExportRequest | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, EXPORT_REQUEST_KEYS) || !isWorkspaceId(row.workspaceId)) return undefined
  return { workspaceId: row.workspaceId.trim() }
}

/** Retain one exchanged snapshot without growing the ledger without bound. */
export function cacheIdeasSyncSnapshot(
  mapping: IdeasSyncWorkspaceMapping,
  snapshotId: string,
  ideas: readonly IdeasSyncIdea[],
): IdeasSyncSnapshotCache[] {
  const copied = JSON.parse(JSON.stringify(ideas)) as IdeasSyncIdea[]
  if (new TextEncoder().encode(JSON.stringify(copied)).byteLength > IDEAS_SYNC_SNAPSHOT_MAX_BYTES) {
    throw new Error('synchronization snapshot exceeds the ancestor-cache byte limit')
  }
  const retained = mapping.snapshots.filter(snapshot => snapshot.snapshotId !== snapshotId)
  retained.push({ snapshotId, ideas: copied })
  return retained.slice(-IDEAS_SYNC_SNAPSHOT_CACHE_LIMIT)
}

/** Strict parser for explicit conflict decisions. */
export function parseIdeasSyncConflictResolutions(value: unknown): IdeasSyncConflictResolution[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1024) return undefined
  const seen = new Set<string>()
  const resolutions: IdeasSyncConflictResolution[] = []
  for (const entry of value) {
    const row = record(entry)
    if (row === undefined || !exactKeys(row, RESOLUTION_KEYS)) return undefined
    if (typeof row.conflictId !== 'string' || row.conflictId.length === 0 || row.conflictId.length > 1024 || seen.has(row.conflictId)) return undefined
    if (row.choice !== 'local' && row.choice !== 'remote' && row.choice !== 'clear') return undefined
    seen.add(row.conflictId)
    resolutions.push({ conflictId: row.conflictId, choice: row.choice })
  }
  return resolutions
}

/** Shared strict parser for read-only planning and applying a package. */
export function parseIdeasSyncPlanRequest(value: unknown): IdeasSyncPlanRequest | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, PLAN_REQUEST_KEYS)) return undefined
  const parsed = parseIdeasSyncPackage(row.package)
  const resolutions = parseIdeasSyncConflictResolutions(row.resolutions)
  if (row.expectedRevision !== undefined && !isTimestamp(row.expectedRevision)) return undefined
  return parsed === undefined || resolutions === undefined
    ? undefined
    : {
        package: parsed,
        resolutions,
        ...(row.expectedRevision === undefined ? {} : { expectedRevision: row.expectedRevision }),
      }
}

/** Strict parser for the import body, including the versioned package validator. */
export function parseIdeasSyncImportRequest(value: unknown): IdeasSyncImportRequest | undefined {
  return parseIdeasSyncPlanRequest(value)
}
