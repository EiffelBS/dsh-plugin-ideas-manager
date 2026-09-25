/**
 * Framework-free client controller for the ideas board: holds the open flag
 * and the latest Host snapshot, refreshes through the transport, and notifies
 * subscribers (the sidebar row and the React board). No React, no cordis —
 * the DOM mounts at the edges only.
 */
import type { IdeaRecord, IdeaStatus } from '../core/ideas.ts';
import { type IdeasListSnapshot, type IdeasReadQuery, type IdeasReadSnapshot, type IdeasSettingsPatch, type IdeasSettingsView } from '../protocol.ts';
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
    /** Board state as LIST rows (bodies deferred, idea #34). */
    snapshot: IdeasListSnapshot | undefined;
    error: string | undefined;
    pending: boolean;
    /** Display settings (tag rows ...); the spelled defaults until the config route answers. */
    config: IdeasSettingsView;
    /** Last config write failure verbatim ('settings-conflict' | wire message); cleared on success. */
    configError: string | undefined;
    /** Whether a config write is in flight (the settings row disables its input). */
    configPending: boolean;
    /** Whether the first config load has SETTLED (available or not) — the board
     *  applies persisted preferences once, guarded on this flag. */
    configLoaded: boolean;
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
    /** Full records fetched on demand (body + audit), keyed by idea id (idea #34). */
    private readonly fullRecords;
    /** Highest revision whose full snapshot already filled {@link fullRecords}. */
    private searchIndexedAtRevision;
    /** In-flight deep-search index load (at most one at a time). */
    private searchIndexLoad;
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
    /**
     * Load the display settings once at start(). A transport without the
     * capability, an older Host (404), or a fence refusal all land on the same
     * graceful outcome: `available: false` and the spelled defaults — the board
     * must never depend on the settings surface.
     */
    loadConfig(): Promise<void>;
    /**
     * Push the `language` setting to the i18n lookup (0.4.0): the panel language
     * is plugin-owned and independent of the DSH shell language. Called on every
     * config load and save, so switching the row re-renders the whole panel in
     * the chosen language (and a failed load falls back to `auto` = the shell).
     */
    private applyInterfaceLanguage;
    /**
     * Persist a settings patch (revision-fenced by the view the client holds).
     * Failures surface verbatim as `configError` ('settings-conflict' and
     * 'settings-unavailable' are wire codes the section localizes); the stored
     * value only moves on success, so the settings row reverts for free.
     */
    saveConfig(patch: IdeasSettingsPatch): Promise<void>;
    /**
     * Run one bounded filtered read without changing board state. This is the
     * common agent/client path: summary-first metadata, explicit fields, and a
     * capped body slice all arrive with revision and truncation metadata. The
     * raw full snapshot and single-idea detail methods remain available for
     * backward compatibility and deep workflows.
     */
    readIdeas(query?: IdeasReadQuery): Promise<IdeasReadSnapshot>;
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
     * Review rejected: create a child follow-up idea (linked to `ideaId` and
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
    /**
     * Start the idea's execution (idea #66) through the Host, which owns the
     * mirrored card. NOT a ledger mutation: no `pending` banner for the whole
     * board, no revision write here (the host stamps `runStatus` itself) — but a
     * refresh follows so the card status the poll will publish is not the only
     * visible change. A refusal is surfaced on the board's error bar verbatim
     * (`task is already running or missing`, `taskboard-unavailable`, ...) and
     * rethrown for the modal to keep the human in place.
     *
     * `model` is the `provider/model` target id, or undefined to let the run
     * keep the session default.
     *
     * @throws when the transport predates the launch route (`launch-unavailable`).
     */
    launchIdea(ideaId: string, model?: string): Promise<void>;
    reorderIdea(orderedIds: string[]): Promise<void>;
    /** Republish the DSH registry rows and wake the board (catalog refresh). */
    private syncWorkspaces;
    /** Post one action, adopt the Host snapshot, and expose errors. */
    private run;
    /**
     * Adopt a fresh snapshot (idea #34): an IDLE refresh - same revision, the
     * Host bumps it on every commit - keeps the SAME reference, so the board's
     * setSnapshot bails out by Object.is and React rebuilds nothing on the
     * 2.5 s short-poll tick that found no change. The revision is the Host's
     * single source of truth: equal revision means identical content (replayed
     * requests and no-op applies return the current state verbatim).
     * @returns whether the snapshot reference actually moved.
     */
    private adopt;
    private emit;
    /**
     * Full record behind one list row (idea #34 deferred body): the edit
     * modal, the follow-up composer and the re-analyze input read the WHOLE
     * body here, fetched once per change. Cached until the row's updatedAt
     * moves - every commit stamps updatedAt on changed ideas - so the entry
     * self-invalidates after each action.
     */
    fetchIdea(row: Pick<IdeaRecord, 'id' | 'updatedAt'>): Promise<IdeaRecord>;
    /** The whole body when its full record is loaded (deep search), else undefined. */
    cachedBodyOf(id: string): string | undefined;
    /**
     * Deep-search index (idea #34): the list snapshot carries only excerpts,
     * so the FIRST active search loads the full snapshot ONCE per revision and
     * fills the record cache; matchesFilter then scans whole bodies exactly
     * like before the projection. Idle boards and clean filters never pay it.
     * Never rejects (a failed load logs and lets the next keystroke retry), so
     * callers can fire-and-forget; the record cache - not the snapshot - is
     * the deliverable (adopt() stays the only snapshot mutator).
     */
    ensureSearchIndex(): Promise<void>;
    /** Surface a transport/UI failure through the board's existing error bar. */
    reportError(message: string): void;
}
