/**
 * Ideas host service: owns the ledger and fans its change notifications out to
 * the SSE route, and (P2) schedules the optional one-way TaskBoard mirror.
 * The board is a passive Host-authoritative store (unlike the task board's
 * execution runner) — the only timer is the under-review poll, which watches
 * for mirrored task cards passing `done` and moves the linked idea to
 * `underReview` (the recette gate). No other background work runs.
 *
 * Mirror discipline (frozen design decision): the mirror is best-effort and
 * asynchronous — committed ideas never roll back, a failed mirror only logs,
 * and a replayed request id never re-mirrors. The bound card id is persisted
 * on the idea through the ledger's internal `bindTaskBoardId` path (the wire
 * gate never accepts taskBoardId).
 */
import { IdeasHostLedger } from './host-ledger.ts';
import { TaskBoardMirror } from './taskboard-bridge.ts';
import { type IdeasAction, type IdeasEventPayload, type IdeasSnapshot } from './protocol.ts';
/** Apply response: the fresh snapshot, plus the generated export when asked. */
export interface IdeasApplyResponse {
    state: IdeasSnapshot;
    export?: {
        ideasMd: string;
        archiveMd: string;
    };
}
export declare class IdeasHostService {
    readonly ledger: IdeasHostLedger;
    private readonly listeners;
    private readonly mirror;
    private readonly autoMirror;
    private readonly pendingMirrors;
    private active;
    private disposed;
    private reviewPoll;
    constructor(options?: {
        ledger?: IdeasHostLedger;
        dir?: string;
        mirror?: TaskBoardMirror;
        autoMirror?: boolean;
    });
    setActive(active: boolean): void;
    snapshot(): IdeasSnapshot;
    /** SSE frame payload; deliberately skips the ideas deep-clone of {@link snapshot}. */
    eventPayload(): IdeasEventPayload;
    subscribe(listener: () => void): () => void;
    apply(requestId: string, action: IdeasAction, initiator?: string): IdeasApplyResponse;
    /**
     * Test seam: wait for every scheduled mirror op to settle. The production
     * path never awaits mirrors (they are fire-and-forget), so this blocks only
     * when a test calls it.
     */
    flushMirror(): Promise<void>;
    /**
     * Start the under-review poll: every `intervalMs` the mirror's task-card
     * statuses are read and any open idea whose linked card is `done` moves to
     * `underReview` (the recette gate — the task is finished, human acceptance
     * still pending). No-op when the mirror is absent or autoMirror is off.
     */
    startUnderReviewPoll(intervalMs?: number): void;
    /** One poll pass (exposed for tests). Best-effort: any failure is ignored. */
    pollUnderReviewTransitions(): Promise<void>;
    dispose(): void;
    private emit;
    /**
     * Schedule the mirror for one applied action. The affected idea is read from
     * the POST-commit snapshot; the mirror op runs in the background and binds
     * the resolved card id when the idea is not yet bound (covers both the
     * create path and the bridge-activated-later self-heal).
     */
    private scheduleMirror;
    private runMirror;
}
