/**
 * Ideas host service: owns the ledger and fans its change notifications out to
 * the SSE route, and (P2) schedules the optional one-way TaskBoard mirror.
 * The board is a passive Host-authoritative store (unlike the task board's
 * execution runner) — the only timer is the run poll, which watches for
 * mirrored task cards passing `done` and moves the linked idea to
 * `underReview` (the review gate). No other background work runs.
 *
 * Launch (idea #66): the mirror is also an EXECUTION entry point, but only on
 * an explicit human request (`launchIdea` / POST /api/ideas/launch) — the
 * passivity above is unchanged: no idea mutation ever starts a run, and `done`
 * stays runner-owned. Two execution backends share that one entry point: the
 * mirrored card when the task-board plugin is present, otherwise a FRESH direct
 * session (v2) started through the Host `typertGateway`. Both settle from this
 * service's run poll, so a launch keeps going — and keeps being observed — when
 * the browser tab is closed.
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
import { SessionRunner, SessionLaunchError } from './session-runner.ts'
import { TaskBoardMirror, TaskBoardUnavailableError } from './taskboard-bridge.ts'
import type { IdeaRecord, IdeaRunStatus } from './core/ideas.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasSnapshot,
} from './protocol.ts'

/** How often the run poll re-reads the task-board card statuses. */
const UNDER_REVIEW_POLL_MS = 30_000

/** How long a launch request id replays its first outcome (idea #66). */
const LAUNCH_DEDUPE_TTL_MS = 60_000
/** Bounded launch replay cache (the ledger action cache is NOT reused: a launch is not a ledger mutation). */
const MAX_LAUNCH_CACHE = 64

/** Answer of a launch (idea #66): backend-neutral on purpose, so the card
 *  backend and the direct-session backend serve the same route with the same
 *  shape. */
export interface IdeasLaunchResult {
  ok: true
  /** Backend-neutral run handle: the card id, or the session id for a direct run. */
  runId: string
  /** TaskBoard card id, undefined for a backend that owns no card (v2). */
  taskId?: string
  /** Always `running` on a fresh accept: the settle is written by the poll. */
  runStatus: IdeaRunStatus
}

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
  private sessions: SessionRunner | undefined
  private readonly pendingMirrors: Promise<void>[] = []
  /** Per-idea mirror chains (idea #35): ops for one idea id run in order. */
  private readonly mirrorChains = new Map<string, Promise<void>>()
  /** Launch replays: requestId -> {at, result} (idea #66, in-memory only). */
  private readonly launchCache = new Map<string, { at: number; result: IdeasLaunchResult }>()
  /** Direct-session runs in flight: sessionId -> ideaId (idea #66 v2). */
  private readonly sessionRuns = new Map<string, string>()
  /** Set once the poll re-attached to a persisted in-flight run. */
  private sessionRunsReattached = false
  private active = true
  private disposed = false
  private reviewPoll: ReturnType<typeof setInterval> | undefined

  constructor(options: {
    ledger?: IdeasHostLedger
    dir?: string
    mirror?: TaskBoardMirror
    autoMirror?: boolean
    /** Direct-session backend; absent when the Host serves no session gateway. */
    sessions?: SessionRunner
  } = {}) {
    this.ledger = options.ledger ?? new IdeasHostLedger(options.dir === undefined ? {} : { dir: options.dir })
    this.mirror = options.mirror
    this.autoMirror = options.autoMirror ?? true
    this.sessions = options.sessions
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
   * Start the run poll: every `intervalMs` the mirror's task-card statuses are
   * read, the LAST OBSERVED status of every open idea's linked card is recorded
   * on the idea (a `failed` task leaves the idea in the backlog behind a "Task
   * failed" badge), the generic `runStatus` follows that same observation, and
   * any open idea whose card is `done` moves to `underReview` (the review
   * gate). No-op when the mirror is absent or autoMirror is off.
   */
  /**
   * Arm the run poll. It is the ONE background timer of the service and it
   * serves both execution backends: the card statuses (mirror on) and the
   * session roster (gateway present). It stays disarmed when neither backend
   * exists, so a deployment with neither runs no timer at all.
   */
  startUnderReviewPoll(intervalMs: number = UNDER_REVIEW_POLL_MS): void {
    if (this.reviewPoll !== undefined || this.disposed) return
    if ((this.mirror === undefined || !this.autoMirror) && this.sessions === undefined) return
    this.reviewPoll = setInterval(() => { void this.pollRunTransitions() }, intervalMs)
  }

  /**
   * Attach the direct-session backend LATE (the `typertGateway` is an injected
   * service, so it can appear after the plugin applied) and arm the poll if it
   * was waiting for this. Safe to call with the same runner twice.
   */
  attachSessions(sessions: SessionRunner): void {
    if (this.disposed) return
    this.sessions = sessions
    this.startUnderReviewPoll()
  }

  /**
   * One poll pass (exposed for tests): each backend settles from its own
   * single read, and a backend that is absent simply does nothing.
   */
  async pollRunTransitions(): Promise<void> {
    if (this.disposed) return
    await this.pollCardRuns()
    await this.pollSessionRuns()
  }

  /**
   * Card-backed runs. Three jobs on the SAME status read:
   *  - record the last observed status of every open idea's linked card
   *    (follow-up work: the "Task failed" badge; the setter is a no-op on
   *    an unchanged observation, so the 30 s poll never churns the revision;
   *    a card missing from one probe keeps its last observation because the
   *    mirror self-heals a dangling link on the next write);
   *  - feed the backend-neutral `runStatus` (idea #66) from that observation:
   *    `running` / `done` / `failed` map straight across, and a card observed
   *    OUTSIDE a run (back in `backlog`/`todo`) clears the stamp. Both setters
   *    are no-ops on an unchanged value, so the idle poll stays free;
   *  - move an open idea whose card is `done` to `underReview` (the review
   *    gate - unchanged behavior).
   *
   * A run IN FLIGHT is always followed, even on an idea that has left the
   * backlog: a launch started while the idea was already under review (or
   * archived) used to leave its `runStatus: 'running'` forever, because the
   * observation scope below is the OPEN column. Tracking starts on `open`
   * only, and stops only when the stamp clears, so a non-open idea is never
   * newly watched (no churn on the closed columns).
   *
   * Best-effort: any failure is ignored.
   */
  private async pollCardRuns(): Promise<void> {
    if (this.mirror === undefined || !this.autoMirror) return
    let statuses: Map<string, string> | undefined
    try {
      statuses = await this.mirror.fetchTaskStatuses()
    } catch (error) {
      console.error(`[dsh-plugin-ideas-manager] run poll failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (statuses === undefined) return
    for (const idea of this.ledger.snapshot().ideas) {
      if (idea.taskBoardId === undefined) continue
      const observed = statuses.get(idea.taskBoardId)
      const tracking = idea.status === 'open' || idea.runStatus !== undefined
      if (idea.status === 'open' && observed !== undefined && observed !== idea.taskBoardStatus) {
        try {
          this.ledger.setTaskBoardStatus(idea.id, observed)
        } catch (error) {
          console.error(`[dsh-plugin-ideas-manager] task status sync failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (tracking && observed !== undefined && observed !== idea.runStatus) {
        try {
          this.ledger.setRunStatus(idea.id, runStatusOf(observed))
        } catch (error) {
          console.error(`[dsh-plugin-ideas-manager] run status sync failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (idea.status !== 'open' || observed !== 'done') continue
      try {
        // Same settle helper as the direct-session backend, so the review gate
        // reads identically for a finished run whatever ran it.
        this.settleRun(idea.id, 'done')
      } catch (error) {
        console.error(`[dsh-plugin-ideas-manager] under-review transition failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Launch the idea's execution (idea #66) through the resolved execution
   * backend: the mirrored card whenever the task-board plugin is present (the
   * card is created when the idea has none yet), otherwise a FRESH direct
   * session — the Host-serves-no-task-board case. Both paths are AWAITED,
   * ordered writes: they run on the idea's mirror chain (so a queued
   * create/update can never interleave between the model patch and the run),
   * and the caller gets the outcome instead of a fire-and-forget log line. The
   * response contract is identical for both, so the browser and the write
   * channel cannot tell which one ran.
   *
   * @throws when the plugin is disabled, no backend is available, the idea is
   *   unknown, or the backend refuses the run (the message carries its own
   *   reason: `task is already running or missing`, `workspace not found`,
   *   `session selectModel rejected: ...`).
   */
  async launchIdea(ideaId: string, model?: string, requestId?: string): Promise<IdeasLaunchResult> {
    if (!this.active) throw new Error('ideas plugin is disabled')
    const captured = this.ledger.idea(ideaId)
    if (captured === undefined) throw new Error('idea not found')
    // A replayed request id answers the FIRST outcome without re-posting the
    // run. This is NOT the ledger action cache: a launch is not a ledger
    // mutation, and the cache is persisted with the document (idea #66 D1).
    if (requestId !== undefined) {
      const replay = this.launchCache.get(requestId)
      if (replay !== undefined) {
        if (Date.now() - replay.at <= LAUNCH_DEDUPE_TTL_MS) return replay.result
        this.launchCache.delete(requestId)
      }
    }
    // Fresh read at execution time, same discipline as runMirror: a queued
    // launch sees the idea as it is NOW, including a card id a previous op on
    // this chain just bound.
    const idea = this.ledger.idea(ideaId) ?? captured
    // Backend resolution (idea #66): the card wins whenever the task-board
    // plugin is present AND the mirror is on — including for an idea that has
    // no card YET, because `launchTask` mints it (that is what lets a freshly
    // captured idea run, and it keeps the card as the single run of record).
    // The direct session is the fallback, and it is a RUNTIME one: a board that
    // turns out to be absent at launch time (plugin uninstalled since boot,
    // bridge disabled) falls through to a fresh session instead of a dead end,
    // as long as the Host serves a session gateway.
    const viaCard = this.mirror !== undefined && this.autoMirror
    if (!viaCard && this.sessions === undefined) throw new TaskBoardMirrorDisabledError()
    const outcome = await this.enqueueChain(ideaId, async (): Promise<{ runId: string; taskId?: string }> => {
      const fresh = this.ledger.idea(ideaId) ?? idea
      if (!viaCard) return await this.launchInSession(fresh, model)
      try {
        const taskId = await this.mirror!.launchTask(fresh, model)
        this.ledger.bindTaskBoardId(ideaId, taskId)
        this.ledger.setRunStatus(ideaId, 'running')
        return { runId: taskId, taskId }
      } catch (error) {
        if (this.sessions === undefined || !(error instanceof TaskBoardUnavailableError)) throw error
        // The card could not run; the session can. Same route, same shape, and
        // the human sees a run rather than a 503 on a board that is simply gone.
        return await this.launchInSession(fresh, model)
      }
    })
    const result: IdeasLaunchResult = { ok: true, runId: outcome.runId, runStatus: 'running' }
    if (outcome.taskId !== undefined) result.taskId = outcome.taskId
    if (requestId !== undefined) {
      this.rememberLaunch(requestId, result)
    }
    return result
  }

  /**
   * Direct-session launch: create the session, stamp the run, and register it
   * for settling. `runSessionId` is written with the stamp so a restarted Host
   * re-attaches (see {@link pollSessionRuns}).
   */
  private async launchInSession(idea: IdeaRecord, model?: string): Promise<{ runId: string }> {
    const sessionId = await this.sessions!.launchIdea(idea, model)
    this.ledger.setRunStatus(idea.id, 'running')
    this.ledger.setRunSession(idea.id, sessionId)
    this.sessionRuns.set(sessionId, idea.id)
    this.sessionRunsReattached = true
    return { runId: sessionId }
  }

  /**
   * Settle the direct-session runs in flight, from ONE roster read per tick.
   * A session that stops running settles `done`; one that disappeared settles
   * `failed` (the Host closed it under us — the closest observable there is to
   * a cancelled run). An unknown roster (booting or unavailable runtime)
   * settles nothing: the run stays `running` rather than being invented as
   * finished. Card-backed runs never come through here.
   *
   * On the first tick after a restart, the in-memory tracker is re-seeded from
   * the ledger (`runStatus: 'running'` + `runSessionId`), which is what makes a
   * direct run survive the Host restarting mid-execution.
   */
  private async pollSessionRuns(): Promise<void> {
    if (this.sessions === undefined || this.disposed) return
    if (!this.sessionRunsReattached) {
      this.sessionRunsReattached = true
      for (const idea of this.ledger.snapshot().ideas) {
        if (idea.runStatus === 'running' && idea.runSessionId !== undefined) {
          this.sessionRuns.set(idea.runSessionId, idea.id)
        }
      }
    }
    if (this.sessionRuns.size === 0) return
    let roster: ReadonlyMap<string, boolean>
    try {
      roster = await this.sessions.listRunning()
    } catch (error) {
      console.error(`[dsh-plugin-ideas-manager] session roster read failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const [sessionId, ideaId] of [...this.sessionRuns]) {
      const running = roster.get(sessionId)
      if (running === true) continue
      this.sessionRuns.delete(sessionId)
      try {
        this.settleRun(ideaId, running === false ? 'done' : 'failed')
      } catch (error) {
        console.error(`[dsh-plugin-ideas-manager] run settle failed for ${ideaId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Write a settled run and, for a finished one, open the review gate. Shared
   * by both backends: a direct run that completes is finished work, so on a
   * card-less board the idea must still reach `underReview` for the human —
   * otherwise the review gate would silently depend on the task-board plugin.
   */
  private settleRun(ideaId: string, status: 'done' | 'failed'): void {
    this.ledger.setRunStatus(ideaId, status)
    this.ledger.setRunSession(ideaId, undefined)
    if (status !== 'done') return
    if (this.ledger.idea(ideaId)?.status !== 'open') return
    // A fresh request id per transition (the ledger dedupes replays); the move
    // to underReview mirrors nothing - the card is already done.
    this.ledger.applyRequest(`under-review-${ideaId}-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
      kind: 'move',
      ideaId,
      status: 'underReview',
    })
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
    this.launchCache.clear()
    this.sessionRuns.clear()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Record a launch outcome for replay, bounded by TTL and entry count. */
  private rememberLaunch(requestId: string, result: IdeasLaunchResult): void {
    const now = Date.now()
    this.launchCache.set(requestId, { at: now, result })
    for (const [key, entry] of this.launchCache) {
      if (now - entry.at > LAUNCH_DEDUPE_TTL_MS) this.launchCache.delete(key)
    }
    while (this.launchCache.size > MAX_LAUNCH_CACHE) {
      this.launchCache.delete(this.launchCache.keys().next().value as string)
    }
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
    void this.enqueueChain(ideaId, async () => { await this.runMirror(kind, idea) })
  }

  /**
   * Queue one operation on its idea's chain (idea #35): ops for the SAME idea
   * id run strictly in submission order — a create always completes (and
   * binds) before a following update even starts — while ops for different
   * ideas still run concurrently. Mirror ops never reject (`runMirror`); a
   * launch DOES, and its rejection travels back to the awaiting route. `run`
   * is tracked from schedule time so flushMirror waits for the whole chain,
   * not just its tail link.
   *
   * The cleanup is attached with `then(cleanup, cleanup)` on purpose: a
   * `.finally()` copy of a rejected launch promise would itself be an unhandled
   * rejection.
   */
  private enqueueChain<T>(ideaId: string, run: () => Promise<T>): Promise<T> {
    const previous = (this.mirrorChains.get(ideaId) ?? Promise.resolve()).catch(() => undefined)
    const chained = previous.then(run)
    // `chainTail` never rejects, so both the chain map and the flush list hold
    // a settled-safe promise while `chained` carries the real outcome to the
    // awaiting caller. A `.finally()` copy of a rejected launch promise would
    // itself be an unhandled rejection — hence the two-argument `then`.
    const chainTail = chained.then(() => undefined, () => undefined)
    this.mirrorChains.set(ideaId, chainTail)
    this.pendingMirrors.push(chainTail)
    const cleanup = (): void => {
      const index = this.pendingMirrors.indexOf(chainTail)
      if (index >= 0) this.pendingMirrors.splice(index, 1)
      if (this.mirrorChains.get(ideaId) === chainTail) this.mirrorChains.delete(ideaId)
    }
    void chainTail.then(cleanup, cleanup)
    return chained
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

/**
 * The TaskBoard mirror cannot launch because it is not installed in this
 * process, or because auto-mirror is off: a 409 the board renders as
 * "TaskBoard integration is off", distinct from a 503 (the plugin is absent or
 * stopped answering) so the human knows whether to fix a setting or install
 * something.
 */
export class TaskBoardMirrorDisabledError extends Error {
  constructor() {
    super('task-board mirror is disabled')
  }
}

/**
 * Map a raw task-board status observation onto the backend-neutral run
 * lifecycle (idea #66). The three RUNNING/DONE/FAILED values map one-to-one; a
 * card sitting outside a run (backlog/todo/archived) means "no run in flight",
 * which CLEARS the stamp so a re-armed card does not keep a stale `running`.
 */
function runStatusOf(observed: string): IdeaRunStatus | undefined {
  if (observed === 'running' || observed === 'done' || observed === 'failed') return observed
  return undefined
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