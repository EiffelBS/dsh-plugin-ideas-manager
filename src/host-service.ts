/**
 * Ideas host service: owns the ledger and fans its change notifications out to
 * the SSE route, and (P2) schedules the optional one-way TaskBoard mirror.
 * No timers, no sessions — the ideas board is a passive Host-authoritative
 * store (unlike the task board's execution runner).
 *
 * Mirror discipline (frozen in HANDOVER §2.3): the mirror is best-effort and
 * asynchronous — committed ideas never roll back, a failed mirror only logs,
 * and a replayed request id never re-mirrors. The bound card id is persisted
 * on the idea through the ledger's internal `bindTaskBoardId` path (the wire
 * gate never accepts taskBoardId).
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
  private active = true
  private disposed = false

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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ledger.dispose()
    this.listeners.clear()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Schedule the mirror for one applied action. The affected idea is read from
   * the POST-commit snapshot; the mirror op runs in the background and binds
   * the resolved card id when the idea is not yet bound (covers both the
   * create path and the bridge-activated-later self-heal).
   */
  private scheduleMirror(action: IdeasAction, ideas: readonly IdeaRecord[]): void {
    if (!this.autoMirror || this.mirror === undefined) return
    const kind = mirrorKindOf(action)
    if (kind === undefined) return
    const ideaId = actionIdeaId(action)
    const idea = ideas.find(item => item.id === ideaId)
    if (idea === undefined) return
    const run = this.runMirror(kind, idea)
    this.pendingMirrors.push(run)
    void run.finally(() => {
      const index = this.pendingMirrors.indexOf(run)
      if (index >= 0) this.pendingMirrors.splice(index, 1)
    })
  }

  private runMirror(kind: MirrorKind, idea: IdeaRecord): Promise<void> {
    return (async () => {
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
        // (HANDOVER §2.3, "tout fonctionne sauf le miroir"): stay silent. Any
        // other failure is logged and never rolls back the idea.
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
      return action.status === 'archived' ? 'archive' : 'restore'
    case 'decline':
    case 'deliver':
      // A delivered idea leaves the backlog exactly like a declined one: the
      // bound card is archived (the card's done still needs the author's
      // closure run — done is runner-owned).
      return 'archive'
    case 'restore':
      return 'restore'
    case 'delete':
    case 'reorder':
    case 'triage':
    case 'import':
    case 'export':
      // delete: documented no-op — the card outlives the idea; reorder and
      // triage change ranking/opinions, not the card's life; import and
      // export do not cross the mirror boundary.
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
    case 'restore':
    case 'delete':
      return action.ideaId
    case 'reorder':
    case 'import':
    case 'export':
      return undefined
  }
}