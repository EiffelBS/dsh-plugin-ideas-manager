/** Pure state machine for the synchronization section of the Backup tab. */

import type {
  IdeasSyncConflictResolution,
  IdeasSyncExportResponse,
  IdeasSyncImportResponse,
  IdeasSyncOverview,
  IdeasSyncPackage,
  IdeasSyncPlanResponse,
} from '../sync.ts'
import type { IdeasSyncConflict } from '../sync-merge.ts'

export type SyncPhase = 'idle' | 'mapping' | 'preview' | 'applying' | 'success'

export interface SyncUiError {
  code?: string
  message: string
}

export interface SyncUiState {
  phase: SyncPhase
  overview: IdeasSyncOverview | undefined
  exportWorkspaceId: string
  exported: IdeasSyncExportResponse | undefined
  incoming: IdeasSyncPackage | undefined
  incomingName: string | undefined
  incomingSyncKey: string | undefined
  preview: IdeasSyncPlanResponse | undefined
  resolutions: IdeasSyncConflictResolution[]
  mappingWorkspaceId: string
  exportConsent: boolean
  mappingConsent: boolean
  applyConsent: boolean
  rollbackConsent: boolean
  bulkChoice: 'local' | 'remote' | undefined
  pending: boolean
  rollbackPending: boolean
  stale: boolean
  error: SyncUiError | undefined
  result: IdeasSyncImportResponse | undefined
}

export type SyncUiAction =
  | { type: 'overview'; overview: IdeasSyncOverview }
  | { type: 'export-workspace'; workspaceId: string }
  | { type: 'export-consent'; consent: boolean }
  | { type: 'exported'; exported: IdeasSyncExportResponse }
  | { type: 'mapping-required'; incoming: IdeasSyncPackage; name: string; syncKey: string }
  | { type: 'mapping-workspace'; workspaceId: string }
  | { type: 'mapping-consent'; consent: boolean }
  | { type: 'preview'; preview: IdeasSyncPlanResponse; resolutions: IdeasSyncConflictResolution[]; incoming: IdeasSyncPackage; name: string }
  | { type: 'stale-import'; incoming: IdeasSyncPackage; name: string }
  | { type: 'pending'; pending: boolean }
  | { type: 'stale'; stale: boolean }
  | { type: 'error'; error: SyncUiError }
  | { type: 'apply-consent'; consent: boolean }
  | { type: 'bulk-choice'; choice: 'local' | 'remote' }
  | { type: 'bulk-cancel' }
  | { type: 'applying' }
  | { type: 'applied'; result: IdeasSyncImportResponse }
  | { type: 'rollback-consent'; consent: boolean }
  | { type: 'rollback-pending'; pending: boolean }
  | { type: 'reset-import' }
  | { type: 'reset' }

export function initialSyncUiState(): SyncUiState {
  return {
    phase: 'idle',
    overview: undefined,
    exportWorkspaceId: '',
    exported: undefined,
    incoming: undefined,
    incomingName: undefined,
    incomingSyncKey: undefined,
    preview: undefined,
    resolutions: [],
    mappingWorkspaceId: '',
    exportConsent: false,
    mappingConsent: false,
    applyConsent: false,
    rollbackConsent: false,
    bulkChoice: undefined,
    pending: false,
    rollbackPending: false,
    stale: false,
    error: undefined,
    result: undefined,
  }
}

export function syncUiReducer(state: SyncUiState, action: SyncUiAction): SyncUiState {
  switch (action.type) {
    case 'overview':
      return {
        ...state,
        overview: action.overview,
        exportWorkspaceId: state.exportWorkspaceId || action.overview.workspaces[0]?.workspaceId || '',
      }
    case 'export-workspace':
      return { ...state, exportWorkspaceId: action.workspaceId, exportConsent: false, exported: undefined, error: undefined }
    case 'export-consent':
      return { ...state, exportConsent: action.consent }
    case 'exported':
      return { ...state, exported: action.exported, error: undefined }
    case 'mapping-required':
      return {
        ...state,
        phase: 'mapping',
        incoming: action.incoming,
        incomingName: action.name,
        incomingSyncKey: action.syncKey,
        preview: undefined,
        resolutions: [],
        mappingWorkspaceId: '',
        exportConsent: false,
        mappingConsent: false,
        applyConsent: false,
        stale: false,
        error: undefined,
        result: undefined,
      }
    case 'mapping-workspace':
      return { ...state, mappingWorkspaceId: action.workspaceId, mappingConsent: false }
    case 'mapping-consent':
      return { ...state, mappingConsent: action.consent }
    case 'preview':
      return {
        ...state,
        phase: 'preview',
        preview: action.preview,
        resolutions: action.resolutions,
        incoming: action.incoming,
        incomingName: action.name,
        incomingSyncKey: action.incoming.workspace.syncKey,
        exportConsent: false,
        applyConsent: false,
        bulkChoice: undefined,
        stale: false,
        error: undefined,
      }
    case 'stale-import':
      return {
        ...state,
        phase: 'preview',
        incoming: action.incoming,
        incomingName: action.name,
        incomingSyncKey: action.incoming.workspace.syncKey,
        exportConsent: false,
        applyConsent: false,
        stale: true,
      }
    case 'pending':
      return { ...state, pending: action.pending }
    case 'stale':
      return { ...state, stale: action.stale, applyConsent: false }
    case 'error':
      return {
        ...state,
        phase: state.phase === 'applying' ? 'preview' : state.phase,
        pending: false,
        error: action.error,
        applyConsent: false,
      }
    case 'apply-consent':
      return { ...state, applyConsent: action.consent }
    case 'bulk-choice':
      return { ...state, bulkChoice: action.choice, applyConsent: false }
    case 'bulk-cancel':
      return { ...state, bulkChoice: undefined }
    case 'applying':
      return { ...state, phase: 'applying', pending: true, error: undefined }
    case 'applied':
      return {
        ...state,
        phase: 'success',
        pending: false,
        stale: false,
        result: action.result,
        preview: action.result.plan === undefined ? state.preview : { ok: true, revision: action.result.revision, plan: action.result.plan },
        error: undefined,
      }
    case 'rollback-consent':
      return { ...state, rollbackConsent: action.consent }
    case 'rollback-pending':
      return { ...state, rollbackPending: action.pending }
    case 'reset-import':
      return {
        ...state,
        phase: 'idle',
        incoming: undefined,
        incomingName: undefined,
        incomingSyncKey: undefined,
        preview: undefined,
        resolutions: [],
        mappingWorkspaceId: '',
        exportConsent: false,
        mappingConsent: false,
        applyConsent: false,
        rollbackConsent: false,
        stale: false,
        error: undefined,
        result: undefined,
      }
    case 'reset':
      return initialSyncUiState()
  }
}

export interface SyncPlanCounts {
  create: number
  update: number
  delete: number
  unchanged: number
  conflict: number
  mappings: number
  duplicates: number
}

export function syncPlanCounts(preview: IdeasSyncPlanResponse | undefined): SyncPlanCounts {
  const counts: SyncPlanCounts = { create: 0, update: 0, delete: 0, unchanged: 0, conflict: 0, mappings: 0, duplicates: 0 }
  if (preview === undefined) return counts
  for (const operation of preview.plan.operations) {
    if (operation.action !== 'conflict') counts[operation.action] += 1
  }
  counts.mappings = 1
  counts.duplicates = preview.plan.duplicateCandidates.length
  counts.conflict = preview.plan.conflicts.length + preview.plan.invalidResolutions.length
  return counts
}

export function canApplySync(state: SyncUiState, currentRevision: number | undefined): boolean {
  const preview = state.preview
  return state.phase === 'preview'
    && !state.pending
    && !state.stale
    && state.applyConsent
    && preview !== undefined
    && preview.plan.ready
    && preview.plan.conflicts.length === 0
    && preview.plan.invalidResolutions.length === 0
    && (currentRevision === undefined || currentRevision === preview.revision)
}

const REQUIRED_FIELDS = new Set(['title', 'body', 'status', 'createdAt'])

/** Whole-idea existence and backlog order cannot be cleared. */
export function syncConflictAllowsClear(conflict: { kind: string; field?: string }): boolean {
  if (conflict.kind === 'delete-edit' || conflict.kind === 'order') return false
  return conflict.field === undefined || !REQUIRED_FIELDS.has(conflict.field)
}

/** Apply one explicit side to every current conflict, preserving unrelated decisions. */
export function bulkSyncResolutions(
  conflicts: readonly IdeasSyncConflict[],
  choice: 'local' | 'remote',
  existing: readonly IdeasSyncConflictResolution[] = [],
): IdeasSyncConflictResolution[] {
  const currentIds = new Set(conflicts.map(conflict => conflict.conflictId))
  return [
    ...existing.filter(resolution => !currentIds.has(resolution.conflictId)),
    ...conflicts.map(conflict => ({ conflictId: conflict.conflictId, choice })),
  ]
}
