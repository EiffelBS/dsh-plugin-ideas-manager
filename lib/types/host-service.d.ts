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
 * and a replayed request id never re-mirrors. Mirror operations are
 * SERIALIZED PER IDEA ID (one promise chain per idea): a create followed by
 * an update runs one at a time in submission order, and each op re-reads the
 * fresh ledger state at execution time, so a queued link can never race its
 * predecessor into seeing "unbound" and minting a second card (idea #35).
 * The bound card id is persisted on the idea through the ledger's internal
 * `bindTaskBoardId` path (the wire gate never accepts taskBoardId).
 */
import { IdeasHostLedger } from './host-ledger.ts';
import { TaskBoardMirror } from './taskboard-bridge.ts';
import type { IdeaRecord } from './core/ideas.ts';
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
    /** Per-idea mirror chains (idea #35): ops for one idea id run in order. */
    private readonly mirrorChains;
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
    /** One full record for the deferred-body read (idea #34); undefined when absent. */
    idea(id: string): IdeaRecord | undefined;
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
     * statuses are read, the LAST OBSERVED status of every open idea's linked
     * card is recorded on the idea (a `failed` task leaves the idea in the
     * backlog behind a "Task failed" badge), and any open idea whose card is
     * `done` moves to `underReview` (the recette gate). No-op when the mirror
     * is absent or autoMirror is off.
     */
    startUnderReviewPoll(intervalMs?: number): void;
    /**
     * One poll pass (exposed for tests). Two jobs on the SAME status read:
     *  - record the last observed status of every open idea's linked card
     *    (recette follow-up: the "Task failed" badge; the setter is a no-op on
     *    an unchanged observation, so the 30 s poll never churns the revision;
     *    a card missing from one probe keeps its last observation because the
     *    mirror self-heals a dangling link on the next write);
     *  - move an open idea whose card is `done` to `underReview` (the recette
     *    gate - unchanged behavior).
     * Best-effort: any failure is ignored.
     */
    pollUnderReviewTransitions(): Promise<void>;
    dispose(): void;
    private emit;
    /**
     * Schedule the mirror for one applied action. The affected idea is read from
     * the POST-commit snapshot; the mirror op runs on that idea's chain (see
     * enqueueMirror) and binds the resolved card id when the idea is not yet
     * bound (covers both the create path and the bridge-activated-later
     * self-heal).
     */
    private scheduleMirror;
    /**
     * Queue one mirror op on its idea's chain (idea #35): ops for the SAME idea
     * id run strictly in submission order — a create always completes (and
     * binds) before a following update even starts — while ops for different
     * ideas still run concurrently. `runMirror` never rejects, so a failed link
     * cannot wedge the chain; `run` is tracked from schedule time so
     * flushMirror waits for the whole chain, not just its tail link.
     */
    private enqueueMirror;
    private runMirror;
}
