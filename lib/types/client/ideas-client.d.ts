/**
 * Framework-free client controller for the ideas board: holds the open flag
 * and the latest Host snapshot, refreshes through the transport, and notifies
 * subscribers (the sidebar row and the React board). No React, no cordis —
 * the DOM mounts at the edges only.
 */
import type { IdeaStatus } from '../core/ideas.ts';
import type { IdeasSnapshot } from '../protocol.ts';
import type { IdeasHostTransport } from './host-api.ts';
import type { SessionLauncher } from './session-queue.ts';
import type { ActiveWorkspaceSource } from './session-context.ts';
import type { WorkspacesSource, WorkspaceViewLite } from './workspaces.ts';
/** Client-side patch accepted by `updateIdea`. */
export interface IdeaClientPatch {
    title?: string;
    body?: string;
    value?: number;
    effort?: number;
    rationale?: string;
    /** Present means "replace the label set"; an empty array clears it. */
    tags?: string[];
    /** Present (including an empty string) replaces the workspace; '' = generic. */
    workspaceId?: string;
}
export declare class IdeasClient {
    private readonly transport;
    boardOpen: boolean;
    snapshot: IdeasSnapshot | undefined;
    error: string | undefined;
    pending: boolean;
    /**
     * Phase 3: optional "Start AI analysis and create the idea" launcher,
     * resolved from the DSH session controller. Undefined keeps the plain
     * manual Create for workspace-targeted captures.
     */
    sessionLauncher: SessionLauncher | undefined;
    private readonly listeners;
    private unsubscribeEvents;
    private workspaces;
    private readonly workspacesSource;
    private readonly activeWorkspaceSource;
    private unsubscribeWorkspaces;
    private unsubscribeActive;
    constructor(transport: IdeasHostTransport, workspacesSource: WorkspacesSource | undefined, activeWorkspaceSource?: ActiveWorkspaceSource);
    /** The workspace of the current session (undefined when unknown). */
    get activeWorkspace(): WorkspaceViewLite | undefined;
    /** Current DSH registry rows (id + label); empty when the service is absent. */
    get workspaceOptions(): readonly WorkspaceViewLite[];
    subscribe(listener: () => void): () => void;
    toggleBoard(): void;
    closeBoard(): void;
    /** Initial load + short-poll refresh while the board is open. */
    start(): void;
    dispose(): void;
    refresh(): Promise<void>;
    createIdea(input: {
        title: string;
        body: string;
        tags?: string[];
        value?: number;
        effort?: number;
        rationale?: string;
        workspaceId?: string;
        /** 1-based position inside the open backlog (capture triage opinion). */
        rank?: number;
    }): Promise<void>;
    updateIdea(ideaId: string, patch: IdeaClientPatch): Promise<void>;
    moveIdea(ideaId: string, status: Extract<IdeaStatus, 'open' | 'underReview' | 'archived'>): Promise<void>;
    declineIdea(ideaId: string, decision?: string): Promise<void>;
    /** Mark an open idea delivered: archived + deliveredAt, card mirror archived. */
    deliverIdea(ideaId: string): Promise<void>;
    /**
     * Record the priority opinion (value/effort/rationale) and re-insert the
     * idea at the suggested rank inside the open backlog (transactional re-rank).
     */
    triageIdea(ideaId: string, patch: {
        value?: number;
        effort?: number;
        rationale?: string;
        rank?: number;
    }): Promise<void>;
    /**
     * Recette NOK: create a child follow-up idea (linked to `ideaId` and
     * carrying the summary + justification) and archive the parent — one atomic
     * commit. The parent must currently be under review.
     */
    followUpIdea(ideaId: string, input: {
        title: string;
        body: string;
    }): Promise<void>;
    restoreIdea(ideaId: string): Promise<void>;
    /**
     * Start an analyst re-run on an existing idea (human-triggered): the Host
     * stamps the cycle and preserves the current content as the prior-analysis
     * audit trail; the caller then launches a fresh analyst session whose
     * update+triage overwrite the card.
     */
    reanalyzeIdea(ideaId: string): Promise<void>;
    deleteIdea(ideaId: string): Promise<void>;
    reorderIdea(orderedIds: string[]): Promise<void>;
    /** Republish the DSH registry rows and wake the board (catalog refresh). */
    private syncWorkspaces;
    /** Post one action, adopt the Host snapshot, and expose errors. */
    private run;
    private emit;
}
