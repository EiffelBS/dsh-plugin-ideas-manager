/**
 * Deterministic, read-only three-way planning for portable idea synchronization.
 *
 * The planner never chooses a winner from a wall-clock timestamp. It compares
 * both sides with a resolved common ancestor, treats rank as workspace-relative
 * order, and emits explicit conflicts instead of dropping data. Application is
 * deliberately elsewhere: the Host ledger reuses its ordinary transitions under
 * its existing single-writer lock and pre-apply snapshot discipline.
 */
import { type IdeaRecord } from './core/ideas.ts';
import { type IdeasSyncConflictResolution, type IdeasSyncIdea, type IdeasSyncPackage, type IdeasSyncSnapshotCache } from './sync.ts';
export type IdeasSyncMergeMode = 'three-way' | 'two-way';
export type IdeasSyncPlanAction = 'create' | 'update' | 'delete' | 'unchanged' | 'conflict';
export type IdeasSyncConflictKind = 'same-field' | 'two-way-difference' | 'delete-edit' | 'tag-definition' | 'tag-limit' | 'relation-limit' | 'order' | 'reference-missing' | 'self-reference' | 'dependency-cycle' | 'follow-up-cycle';
export type IdeasSyncMergeField = 'title' | 'body' | 'status' | 'createdAt' | 'updatedAt' | 'summary' | 'value' | 'effort' | 'rationale' | 'decision' | 'deliveredAt' | 'archivedAt' | 'deliveryNote' | 'reanalyzeAt' | 'analysisAudit' | 'events' | 'tags' | 'relatesTo' | 'blocks' | 'followUpOfId' | 'rank';
export interface IdeasSyncConflict {
    conflictId: string;
    kind: IdeasSyncConflictKind;
    /** Empty for a workspace-level ordering conflict. */
    ideaId: string;
    field?: IdeasSyncMergeField;
    /** Tag name for a tag-definition conflict. */
    tagName?: string;
    local?: unknown;
    incoming?: unknown;
    base?: unknown;
    message: string;
    /** A supplied decision was parsed but could not make this conflict valid. */
    resolutionError?: string;
}
export interface IdeasSyncPlanOperation {
    ideaId: string;
    action: IdeasSyncPlanAction;
    local?: IdeasSyncIdea;
    incoming?: IdeasSyncIdea;
    merged?: IdeasSyncIdea;
    changedFields: IdeasSyncMergeField[];
}
export interface IdeasSyncDuplicateCandidate {
    candidateId: string;
    localId: string;
    incomingId: string;
    score: number;
    signals: Array<'title' | 'tags'>;
    /** Existing per-idea merge semantics, proposed only and never applied by planning. */
    proposedMerge: {
        kind: 'merge';
        sourceId: string;
        targetId: string;
        mode: 'keepTargetRank';
    };
}
export interface IdeasSyncMergePlan {
    format: 'dsh-ideas-merge-plan';
    version: 1;
    mode: IdeasSyncMergeMode;
    incomingSnapshotId: string;
    baseSnapshotId: string | null;
    ancestorSnapshotId: string | null;
    workspaceId: string;
    syncKey: string;
    operations: IdeasSyncPlanOperation[];
    ideas: IdeasSyncIdea[];
    conflicts: IdeasSyncConflict[];
    invalidResolutions: string[];
    duplicateCandidates: IdeasSyncDuplicateCandidate[];
    /** Complete open-backlog order when an unambiguous remote reorder is accepted. */
    reorder: {
        status: 'open';
        orderedIds: string[];
    } | null;
    ready: boolean;
}
export interface IdeasSyncMergeInput {
    /** Full destination rows; machine-local fields are ignored by comparison. */
    localIdeas: readonly IdeaRecord[];
    workspaceId: string;
    incoming: IdeasSyncPackage;
    /** Resolved ancestor rows, or undefined when baseSnapshotId is unavailable. */
    ancestorIdeas?: readonly IdeasSyncIdea[];
    resolutions?: readonly IdeasSyncConflictResolution[];
}
/** Build a deterministic plan without writing or mutating any input. */
export declare function planIdeasSyncMerge(input: IdeasSyncMergeInput): IdeasSyncMergePlan;
/** Resolve one cached ancestor by the exact snapshot id carried by the package. */
export declare function ideasSyncAncestor(snapshots: readonly IdeasSyncSnapshotCache[], incoming: IdeasSyncPackage): readonly IdeasSyncIdea[] | undefined;
