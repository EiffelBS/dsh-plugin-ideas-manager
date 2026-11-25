/** Pure state machine for the synchronization section of the Backup tab. */
import type { IdeasSyncConflictResolution, IdeasSyncExportResponse, IdeasSyncImportResponse, IdeasSyncOverview, IdeasSyncPackage, IdeasSyncPlanResponse } from '../sync.ts';
import type { IdeasSyncConflict } from '../sync-merge.ts';
export type SyncPhase = 'idle' | 'mapping' | 'preview' | 'applying' | 'success';
export interface SyncUiError {
    code?: string;
    message: string;
}
export interface SyncUiState {
    phase: SyncPhase;
    overview: IdeasSyncOverview | undefined;
    exportWorkspaceId: string;
    exported: IdeasSyncExportResponse | undefined;
    incoming: IdeasSyncPackage | undefined;
    incomingName: string | undefined;
    incomingSyncKey: string | undefined;
    preview: IdeasSyncPlanResponse | undefined;
    resolutions: IdeasSyncConflictResolution[];
    mappingWorkspaceId: string;
    exportConsent: boolean;
    mappingConsent: boolean;
    replaceConsent: boolean;
    applyConsent: boolean;
    rollbackConsent: boolean;
    bulkChoice: 'local' | 'remote' | undefined;
    pending: boolean;
    rollbackPending: boolean;
    stale: boolean;
    error: SyncUiError | undefined;
    result: IdeasSyncImportResponse | undefined;
}
export type SyncUiAction = {
    type: 'overview';
    overview: IdeasSyncOverview;
} | {
    type: 'export-workspace';
    workspaceId: string;
} | {
    type: 'export-consent';
    consent: boolean;
} | {
    type: 'exported';
    exported: IdeasSyncExportResponse;
} | {
    type: 'mapping-required';
    incoming: IdeasSyncPackage;
    name: string;
    syncKey: string;
} | {
    type: 'mapping-workspace';
    workspaceId: string;
} | {
    type: 'mapping-consent';
    consent: boolean;
} | {
    type: 'replace-consent';
    consent: boolean;
} | {
    type: 'preview';
    preview: IdeasSyncPlanResponse;
    resolutions: IdeasSyncConflictResolution[];
    incoming: IdeasSyncPackage;
    name: string;
} | {
    type: 'stale-import';
    incoming: IdeasSyncPackage;
    name: string;
} | {
    type: 'pending';
    pending: boolean;
} | {
    type: 'stale';
    stale: boolean;
} | {
    type: 'error';
    error: SyncUiError;
} | {
    type: 'apply-consent';
    consent: boolean;
} | {
    type: 'bulk-choice';
    choice: 'local' | 'remote';
} | {
    type: 'bulk-cancel';
} | {
    type: 'applying';
} | {
    type: 'applied';
    result: IdeasSyncImportResponse;
} | {
    type: 'rollback-consent';
    consent: boolean;
} | {
    type: 'rollback-pending';
    pending: boolean;
} | {
    type: 'reset-import';
} | {
    type: 'reset';
};
export declare function initialSyncUiState(): SyncUiState;
export declare function syncUiReducer(state: SyncUiState, action: SyncUiAction): SyncUiState;
export interface SyncPlanCounts {
    create: number;
    update: number;
    delete: number;
    unchanged: number;
    conflict: number;
    mappings: number;
    duplicates: number;
}
export declare function syncPlanCounts(preview: IdeasSyncPlanResponse | undefined): SyncPlanCounts;
export declare function canApplySync(state: SyncUiState, currentRevision: number | undefined): boolean;
/** Whole-idea existence and backlog order cannot be cleared. */
export declare function syncConflictAllowsClear(conflict: {
    kind: string;
    field?: string;
}): boolean;
/** Apply one explicit side to every current conflict, preserving unrelated decisions. */
export declare function bulkSyncResolutions(conflicts: readonly IdeasSyncConflict[], choice: 'local' | 'remote', existing?: readonly IdeasSyncConflictResolution[]): IdeasSyncConflictResolution[];
