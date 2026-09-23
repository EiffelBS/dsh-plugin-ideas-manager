/**
 * Ideas host service: owns the ledger and fans its change notifications out to
 * the SSE route, and (P2) schedules the optional one-way TaskBoard mirror.
 * The board is a passive Host-authoritative store (unlike the task board's
 * execution runner) — the only timer is the under-review poll, which watches
 * for mirrored task cards passing `done` and moves the linked idea to
 * `underReview` (the review gate). No other background work runs.
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

import { IdeasHostLedger, type LedgerApplyResult } from './host-ledger.ts'
import { TaskBoardMirror } from './taskboard-bridge.ts'
import type { IdeaRecord } from './core/ideas.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasSnapshot,
} from './protocol.ts'

/** How often the under-review poll re-reads the task-board card statuses. */
const UNDER_REVIEW_POLL_MS = 30_000

/** Apply response: the fresh snapshot, plus the generated export when asked. */
export interface IdeasApplyResponse {
  state: IdeasSnapshot
  export?: { ideasMd: string; archiveMd: string }
}

/** Mirror kinds the ideas actions map to (undefined = no mirror). */
type MirrorKind = 'create' | 'update' | 'archive' | 'restore'

export class IdeasHostService {
  readonly ledger: IdeasHostLedger
  private readonly listeners = new Set<() => void>()
  private readonly mirror: TaskBoardMirror | undefined
  private readonly autoMirror: boolean
  private readonly pendingMirrors: Promise<void>[] = []
  /** Per-idea mirror chains (idea #35): ops for one idea id run in order. */
  private readonly mirrorChains = new Map<string, Promise<void>>()
  private active = true
  private disposed = false
  private reviewPoll: ReturnType<typeof setInterval> | undefined

  constructor(options: {
    ledger?: IdeasHostLedger
    dir?: string
    mirror?: TaskBoardMirror
    autoMirror?: boolean
  } = {}) {
    this.ledger = options.ledger ?? new IdeasHostLedger(options.dir === undefined ? {} : { dir: options.dir })
    this.mirror = options.mirror
    this.autoMirror = options.autoMirror ?? true
    this.ledger.subscribe(() => { this.emit() })
  }

  setActive(active: boolean): void {
    this.active = active
    this.emit()
  }

  snapshot(): IdeasSnapshot {
    const state = this.ledger.snapshot()
    return {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: state.revision,
      ideas: state.ideas,
    }
  }

  /** One full record for the deferred-body read (idea #34); undefined when absent. */
  idea(id: string): IdeaRecord | undefined {
    return this.ledger.idea(id)
  }

  /** SSE frame payload; deliberately skips the ideas deep-clone of {@link snapshot}. */
  eventPayload(): IdeasEventPayload {
    return this.ledger.summary()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: IdeasAction, initiator?: string): IdeasApplyResponse {
    // P0: the initiator is accepted for contract parity and recorded by the
    // ledger cache only; P1 adds the audit stamp to created/updated ideas.
    void initiator
    if (!this.active) throw new Error('ideas plugin is disabled')
    const result: LedgerApplyResult = this.ledger.applyRequest(requestId, action)
    if (!result.replayed) this.scheduleMirror(action, result.state.ideas)
    const state = result.state
    return {
      state: {
        schemaVersion: IDEAS_SCHEMA_VERSION,
        revision: state.revision,
        ideas: state.ideas,
      },
      ...(result.export === undefined ? {} : { export: result.export }),
    }
  }

  /**
   * Test seam: wait for every scheduled mirror op to settle. The production
   * path never awaits mirrors (they are fire-and-forget), so this blocks only
   * when a test calls it.
   */
  async flushMirror(): Promise<void> {
    while (this.pendingMirrors.length > 0) {
      const batch = this.pendingMirrors.splice(0)
      await Promise.allSettled(batch)
    }
  }

  /**
   * Start the under-review poll: every `intervalMs` the mirror's task-card
   * statuses are read, the LAST OBSERVED status of every open idea's linked
   * card is recorded on the idea (a `failed` task leaves the idea in the
   * backlog behind a "Task failed" badge), and any open idea whose card is
   * `done` moves to `underReview` (the review gate). No-op when the mirror
   * is absent or autoMirror is off.
   */
  startUnderReviewPoll(intervalMs: number = UNDER_REVIEW_POLL_MS): void {
    if (this.reviewPoll !== undefined || this.mirror === undefined || !this.autoMirror) return
    this.reviewPoll = setInterval(() => { void this.pollUnderReviewTransitions() }, intervalMs)
  }

  /**
   * One poll pass (exposed for tests). Two jobs on the SAME status read:
   *  - record the last observed status of every open idea's linked card
   *    (follow-up work: the "Task failed" badge; the setter is a no-op on
   *    an unchanged observation, so the 30 s poll never churns the revision;
   *    a card missing from one probe keeps its last observation because the
   *    mirror self-heals a dangling link on the next write);
   *  - move an open idea whose card is `done` to `underReview` (the review
   *    gate - unchanged behavior).
   * Best-effort: any failure is ignored.
   */
  async pollUnderReviewTransitions(): Promise<void> {
    if (this.mirror === undefined || !this.autoMirror || this.disposed) return
    let statuses: Map<string, string> | undefined
    try {
      statuses = await this.mirror.fetchTaskStatuses()
    } catch (error) {
      console.error(`[dsh-plugin-ideas-manager] under-review poll failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (statuses === undefined) return
    for (const idea of this.ledger.snapshot().ideas) {
      if (idea.status !== 'open' || idea.taskBoardId === undefined) continue
      const observed = statuses.get(idea.taskBoardId)
      if (observed !== undefined && observed !== idea.taskBoardStatus) {
        try {
          this.ledger.setTaskBoardStatus(idea.id, observed)
        } catch (error) {
          console.error(`[dsh-plugin-ideas-manager] task status sync failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (observed !== 'done') continue
      try {
        // A fresh request id per transition (the ledger dedupes replays); the
        // move to underReview mirrors nothing - the card is already done.
        this.ledger.applyRequest(`under-review-${idea.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
          kind: 'move',
          ideaId: idea.id,
          status: 'underReview',
        })
      } catch (error) {
        console.error(`[dsh-plugin-ideas-manager] under-review transition failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.reviewPoll !== undefined) {
      clearInterval(this.reviewPoll)
      this.reviewPoll = undefined
    }
    this.ledger.dispose()
    this.listeners.clear()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Schedule the mirror for one applied action. The affected idea is read from
   * the POST-commit snapshot; the mirror op runs on that idea's chain (see
   * enqueueMirror) and binds the resolved card id when the idea is not yet
   * bound (covers both the create path and the bridge-activated-later
   * self-heal).
   */
  private scheduleMirror(action: IdeasAction, ideas: readonly IdeaRecord[]): void {
    if (!this.autoMirror || this.mirror === undefined) return
    // The followUp verb creates a NEW open idea (the child): its card mirrors
    // as a fresh create, while the parent card is already done (nothing to
    // archive). Every other action mirrors on its own idea id.
    if (action.kind === 'followUp') {
      const child = ideas.find(item => item.followUpOfId === action.ideaId)
      if (child === undefined) return
      this.enqueueMirror(child.id, 'create', child)
      return
    }
    const kind = mirrorKindOf(action)
    if (kind === undefined) return
    const ideaId = actionIdeaId(action)
    const idea = ideas.find(item => item.id === ideaId)
    if (idea === undefined) return
    this.enqueueMirror(idea.id, kind, idea)
  }

  /**
   * Queue one mirror op on its idea's chain (idea #35): ops for the SAME idea
   * id run strictly in submission order — a create always completes (and
   * binds) before a following update even starts — while ops for different
   * ideas still run concurrently. `runMirror` never rejects, so a failed link
   * cannot wedge the chain; `run` is tracked from schedule time so
   * flushMirror waits for the whole chain, not just its tail link.
   */
  private enqueueMirror(ideaId: string, kind: MirrorKind, idea: IdeaRecord): void {
    const previous = (this.mirrorChains.get(ideaId) ?? Promise.resolve()).catch(() => undefined)
    const run = previous.then(async () => await this.runMirror(kind, idea))
    this.mirrorChains.set(ideaId, run)
    this.pendingMirrors.push(run)
    void run.finally(() => {
      const index = this.pendingMirrors.indexOf(run)
      if (index >= 0) this.pendingMirrors.splice(index, 1)
      if (this.mirrorChains.get(ideaId) === run) this.mirrorChains.delete(ideaId)
    })
  }

  private runMirror(kind: MirrorKind, captured: IdeaRecord): Promise<void> {
    return (async () => {
      // Fresh read at execution time (idea #35): a queued op mirrors the idea
      // AS IT IS NOW — including the taskBoardId a previous op on the same
      // chain just bound — so a record captured before that bind can never
      // make two links both see "unbound" and both create a card. Falls back
      // to the captured record when the idea was deleted meanwhile (delete
      // mirrors nothing, the captured content is still the mirror target).
      const idea = this.ledger.snapshot().ideas.find(item => item.id === captured.id) ?? captured
      try {
        switch (kind) {
          case 'create': {
            const taskId = await this.mirror!.mirrorCreate(idea)
            this.ledger.bindTaskBoardId(idea.id, taskId)
            return
          }
          case 'update': {
            const taskId = await this.mirror!.mirrorUpdate(idea)
            this.ledger.bindTaskBoardId(idea.id, taskId)
            return
          }
          case 'archive': {
            const taskId = await this.mirror!.mirrorArchive(idea)
            this.ledger.bindTaskBoardId(idea.id, taskId)
            return
          }
          case 'restore': {
            await this.mirror!.mirrorRestore(idea)
          }
        }
      } catch (error) {
        // The task-board plugin being absent is the normal autonomous state
        // — the whole mirror is optional: stay silent. Any other failure is
        // logged and never rolls back the idea.
        if (this.mirror!.isUnavailable) return
        console.error(`[dsh-plugin-ideas-manager] mirror ${kind} failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }
}

function mirrorKindOf(action: IdeasAction): MirrorKind | undefined {
  switch (action.kind) {
    case 'create':
      return 'create'
    case 'update':
      return 'update'
    case 'move':
      // Only an archived destination mirrors as an archive; moving an idea to
      // underReview mirrors nothing (the card already passed done), and a
      // move back to open restores the card.
      return action.status === 'archived' ? 'archive' : action.status === 'open' ? 'restore' : undefined
    case 'decline':
    case 'deliver':
      // A delivered idea leaves the backlog exactly like a declined one: the
      // bound card is archived (the card's done still needs the author's
      // closure run — done is runner-owned).
      return 'archive'
    case 'restore':
      return 'restore'
    case 'followUp':
      // Handled in scheduleMirror directly (the child idea mirrors as create).
      return undefined
    case 'delete':
    case 'reorder':
    case 'triage':
    case 'reanalyze':
    case 'import':
    case 'export':
      // delete: documented no-op — the card outlives the idea; reorder and
      // triage change ranking/opinions, not the card's life; reanalyze only
      // stamps the audit cycle; import and export do not cross the mirror
      // boundary.
      return undefined
  }
}

/** The mirrored idea of an action, for the POST-commit lookup. */
function actionIdeaId(action: IdeasAction): string | undefined {
  switch (action.kind) {
    case 'create':
      return action.id
    case 'update':
    case 'move':
    case 'decline':
    case 'deliver':
    case 'triage':
    case 'followUp':
    case 'restore':
    case 'delete':
    case 'reanalyze':
      return action.ideaId
    case 'reorder':
    case 'import':
    case 'export':
      return undefined
  }
}