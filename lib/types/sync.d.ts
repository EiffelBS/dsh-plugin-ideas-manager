/**
 * Portable synchronization contract for the ideas ledger.
 *
 * This format is deliberately separate from the disaster-recovery snapshot. A
 * snapshot replaces a whole ledger; a sync package carries one workspace's
 * portable idea content and is adopted additively by a Host that has explicitly
 * confirmed the workspace mapping. The pure three-way planner lives in
 * `sync-merge.ts`; this module owns the portable and machine-local contracts.
 */
import { type IdeaRecord } from './core/ideas.ts';
import { type IdeasSnapshotInfo } from './protocol.ts';
/** Discriminator that keeps a sync package out of the backup/restore path. */
export declare const IDEAS_SYNC_FORMAT = "dsh-ideas-sync";
/** Version of the sync package envelope, independent of the ledger schema. */
export declare const IDEAS_SYNC_VERSION: 1;
/** Bound of a device, snapshot, or sync-key identifier. */
export declare const IDEAS_SYNC_ID_MAX_LENGTH = 128;
/** Bound of a local DSH workspace id. */
export declare const IDEAS_SYNC_WORKSPACE_ID_MAX_LENGTH = 256;
/** Backstop for the machine-local workspace mapping table. */
export declare const IDEAS_SYNC_MAPPING_LIMIT = 256;
/** Number of recent exchanged snapshots retained as possible common ancestors. */
export declare const IDEAS_SYNC_SNAPSHOT_CACHE_LIMIT = 4;
/** Byte cap for one cached ancestor, matching the portable package budget. */
export declare const IDEAS_SYNC_SNAPSHOT_MAX_BYTES: number;
/**
 * Idea fields that belong to the destination machine, never to package identity.
 *
 * `ideaNumber` is a local display number. `workspaceId` is a local DSH UUID.
 * The remaining fields are live execution pointers or observations from another
 * Host and must never become active state on import.
 */
export declare const IDEAS_SYNC_LOCAL_IDEA_FIELDS: readonly ["workspaceId", "ideaNumber", "taskBoardId", "taskBoardStatus", "runStatus", "runSessionId"];
/**
 * Every other persisted idea field is portable content. The literal list is the
 * package's forward-compatibility surface: a new record field must be classified
 * here or in the local list, and the tests assert their union equals the backup
 * field surface.
 */
export declare const IDEAS_SYNC_PORTABLE_IDEA_FIELDS: readonly ["id", "title", "body", "status", "createdAt", "updatedAt", "summary", "rank", "value", "effort", "rationale", "decision", "deliveredAt", "archivedAt", "deliveryNote", "followUpOfId", "tags", "reanalyzeAt", "analysisAudit", "events", "relatesTo", "blocks"];
/** Portable projection of one idea; local numbering and execution state are absent by type. */
export type IdeasSyncIdea = Omit<IdeaRecord, (typeof IDEAS_SYNC_LOCAL_IDEA_FIELDS)[number]>;
/** One bounded snapshot retained for a later common-ancestor lookup. */
export interface IdeasSyncSnapshotCache {
    snapshotId: string;
    ideas: IdeasSyncIdea[];
}
/** One explicitly confirmed machine-local mapping. */
export interface IdeasSyncWorkspaceMapping {
    /** Portable workspace identity shared by every machine that opts in. */
    syncKey: string;
    /** The local DSH workspace UUID this Host writes onto imported ideas. */
    workspaceId: string;
    /** When the human confirmed this pairing. */
    confirmedAt: number;
    /** Last package snapshot adopted into this local workspace; null before the first import. */
    baseSnapshotId: string | null;
    /**
     * Recent snapshots exchanged in either direction. An incoming base id is
     * resolved only here; an evicted or unknown id selects conservative two-way
     * mode rather than inventing a common ancestor.
     */
    snapshots: IdeasSyncSnapshotCache[];
}
/** Machine-local synchronization state persisted with the ledger document. */
export interface IdeasSyncState {
    /** Stable identity of this ledger Home, carried by every exported package. */
    deviceId: string;
    /** Confirmed portable-key to local-workspace pairings. */
    workspaces: IdeasSyncWorkspaceMapping[];
}
/** Versioned, additive package envelope. It is never a ledger snapshot. */
export interface IdeasSyncPackage {
    format: typeof IDEAS_SYNC_FORMAT;
    version: typeof IDEAS_SYNC_VERSION;
    deviceId: string;
    snapshotId: string;
    /** Snapshot this exporting Host had most recently adopted for the workspace. */
    baseSnapshotId: string | null;
    createdAt: number;
    workspace: {
        /** Portable workspace identity. */
        syncKey: string;
        /** Diagnostic origin only; never used to match a destination workspace. */
        sourceWorkspaceId: string;
    };
    ideas: IdeasSyncIdea[];
}
/** One workspace row in the additive sync overview. */
export interface IdeasSyncWorkspaceView {
    workspaceId: string;
    ideaCount: number;
    syncKey?: string;
    confirmed: boolean;
    confirmedAt?: number;
    baseSnapshotId?: string | null;
}
/** GET /api/ideas/sync. */
export interface IdeasSyncOverview {
    ok: true;
    deviceId: string;
    workspaces: IdeasSyncWorkspaceView[];
}
/** A confirmed mapping returned by POST /api/ideas/sync/workspaces. */
export interface IdeasSyncMappingResponse {
    ok: true;
    mapping: IdeasSyncWorkspaceMapping;
}
/** POST /api/ideas/sync/export. */
export interface IdeasSyncExportResponse {
    ok: true;
    package: IdeasSyncPackage;
}
/** One explicit decision for a conflict emitted by the merge planner. */
export interface IdeasSyncConflictResolution {
    conflictId: string;
    /** `clear` removes an optional conflicted field or relation. */
    choice: 'local' | 'remote' | 'clear';
}
/** POST /api/ideas/sync/plan and the optional decisions on import. */
export interface IdeasSyncPlanRequest {
    package: IdeasSyncPackage;
    resolutions?: IdeasSyncConflictResolution[];
    /** Ledger revision the read-only preview was computed against. */
    expectedRevision?: number;
}
/** POST /api/ideas/sync/plan. */
export interface IdeasSyncPlanResponse {
    ok: true;
    /** Ledger revision this preview describes; apply must carry the same value. */
    revision: number;
    plan: import('./sync-merge.ts').IdeasSyncMergePlan;
}
/** POST /api/ideas/sync/import. */
export interface IdeasSyncImportResponse {
    ok: true;
    snapshotId: string;
    syncKey: string;
    workspaceId: string;
    /** Newly created rows; all other incoming rows are counted as skipped. */
    imported: number;
    skipped: number;
    revision: number;
    plan: import('./sync-merge.ts').IdeasSyncMergePlan;
    /** Board snapshot written before the one atomic apply commit. */
    displaced?: IdeasSnapshotInfo;
}
/** Stable refusal codes served by the additive sync routes. */
export type IdeasSyncErrorCode = 'invalid-sync-workspace' | 'invalid-sync-export' | 'invalid-sync-package' | 'sync-workspace-unconfirmed' | 'sync-key-conflict' | 'sync-workspace-conflict' | 'sync-preview-stale' | 'sync-idea-conflict' | 'sync-reference-missing' | 'sync-relation-invalid' | 'sync-resolution-invalid' | 'sync-snapshot-failed' | 'sync-apply-failed';
/** A normal refusal answer; the ledger is unchanged in every case. */
export interface IdeasSyncRefusal {
    ok: false;
    error: IdeasSyncErrorCode;
    message: string;
    /** Present for merge refusals so a caller can present every explicit decision. */
    plan?: import('./sync-merge.ts').IdeasSyncMergePlan;
}
/** Request body of POST /api/ideas/sync/workspaces. */
export interface IdeasSyncWorkspaceRequest {
    workspaceId: string;
    /** Omit to mint a new key for a workspace that has none. */
    syncKey?: string;
    /** Must be literally true: names and paths are never matched automatically. */
    confirm: true;
    /** Replace a different existing key for this workspace and reset its sync history. */
    replaceExisting?: boolean;
}
/** Request body of POST /api/ideas/sync/export. */
export interface IdeasSyncExportRequest {
    workspaceId: string;
}
/** Request body of POST /api/ideas/sync/import. */
export interface IdeasSyncImportRequest {
    package: IdeasSyncPackage;
    resolutions?: IdeasSyncConflictResolution[];
    /** Revision of the preview the human inspected; a mismatch refuses the apply. */
    expectedRevision?: number;
}
/** Create the empty machine-local state with a caller-supplied stable device id. */
export declare function createIdeasSyncState(deviceId: string): IdeasSyncState;
/** Strict validator for persisted sync state used by the restore path. */
export declare function parseIdeasSyncState(value: unknown): IdeasSyncState | undefined;
/**
 * Lenient boot reader. A malformed mapping is dropped rather than bricking the
 * board; a missing state gets the caller's newly minted stable device id. The
 * strict restore path uses parseIdeasSyncState and refuses a malformed state.
 */
export declare function normalizeIdeasSyncState(value: unknown, fallbackDeviceId: string): IdeasSyncState;
/** Deep copy of the machine-local identity and bounded ancestor cache. */
export declare function cloneIdeasSyncState(state: IdeasSyncState): IdeasSyncState;
/** Project one ledger row to portable content, dropping every machine-local field. */
export declare function portableIdeaOf(idea: IdeaRecord): IdeasSyncIdea;
/** Build a package from Host-owned full records, never from a client projection. */
export declare function buildIdeasSyncPackage(options: {
    ideas: readonly IdeaRecord[];
    mapping: IdeasSyncWorkspaceMapping;
    deviceId: string;
    snapshotId: string;
    createdAt: number;
}): IdeasSyncPackage;
/** Strict package validator. Local execution fields are refused, not silently dropped. */
export declare function parseIdeasSyncPackage(value: unknown): IdeasSyncPackage | undefined;
/** Strict parser for the explicit workspace-confirmation body. */
export declare function parseIdeasSyncWorkspaceRequest(value: unknown): IdeasSyncWorkspaceRequest | undefined;
/** Strict parser for the export body. */
export declare function parseIdeasSyncExportRequest(value: unknown): IdeasSyncExportRequest | undefined;
/** Retain one exchanged snapshot without growing the ledger without bound. */
export declare function cacheIdeasSyncSnapshot(mapping: IdeasSyncWorkspaceMapping, snapshotId: string, ideas: readonly IdeasSyncIdea[]): IdeasSyncSnapshotCache[];
/** Strict parser for explicit conflict decisions. */
export declare function parseIdeasSyncConflictResolutions(value: unknown): IdeasSyncConflictResolution[] | undefined;
/** Shared strict parser for read-only planning and applying a package. */
export declare function parseIdeasSyncPlanRequest(value: unknown): IdeasSyncPlanRequest | undefined;
/** Strict parser for the import body, including the versioned package validator. */
export declare function parseIdeasSyncImportRequest(value: unknown): IdeasSyncImportRequest | undefined;
