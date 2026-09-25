/**
 * Launch an idea's execution from the board (idea #66).
 *
 * ONE entry point, TWO execution backends, and the choice belongs to the HOST:
 * `POST /api/ideas/launch` runs the mirrored TaskBoard card when the
 * task-board plugin is present and the idea is bound to one, and otherwise
 * starts a fresh direct session (v2). The browser never talks to
 * /api/task-board and never creates a session itself — a run must keep going,
 * and keep being observed, after the tab is closed. The response is
 * backend-neutral (`runId` is the card id or the session id; `taskId` is
 * absent for a backend that owns no card), so the modal, the button and the
 * error surface here are the same for both.
 *
 * Visibility is a PURE predicate ({@link canLaunch}) so the whole
 * status x card-status x workspace matrix is unit-testable without a DOM, and
 * the button disappears (never errors) whenever the flow cannot work.
 */

import type { IdeaRunStatus, IdeaStatus } from '../core/ideas.ts'
import type { ModelChoice } from './session-queue.ts'
import type { IdeasHostTransport } from './host-api.ts'

/** The fields a launch decision reads; both a list row and a full record fit. */
export interface LaunchTarget {
  id: string
  status: IdeaStatus
  /** A run needs a workspace: the task-board validates it against the registry. */
  workspaceId?: string
  /** Present once the mirror bound (or adopted) the card. */
  taskBoardId?: string
  /** Last observed card status; absent until the 30 s poll reports one. */
  taskBoardStatus?: string
  /** Backend-neutral lifecycle stamp of the latest launched run. */
  runStatus?: IdeaRunStatus
}

/**
 * Card statuses a launch may start from. `failed` is INCLUDED (decision D4):
 * the task-board accepts a run on a failed task, and without it a card whose
 * run failed could never be retried from our board — the human would have to
 * go to the TaskBoard itself, which is exactly what #66 removes.
 * `running` is excluded (the task-board would refuse anyway, with a less
 * helpful message), `done` and `archived` too. A not-yet-observed card
 * (undefined) stays launchable so a freshly captured idea is not gated behind
 * the first poll tick.
 */
export const LAUNCHABLE_TASK_STATUSES: readonly string[] = ['backlog', 'todo', 'failed']

/**
 * Whether the Launch affordance belongs on this card. Pure, synchronous, and
 * the single source of truth for the button (and its absence).
 *
 * A card is NOT required: on a Host that serves no task-board plugin no card is
 * ever mirrored, and the direct-session backend runs the idea without one. The
 * card status therefore only constrains a card that EXISTS — a card that is
 * `running` or `done` is the run of record, and starting a second, invisible
 * session next to it would be a lie, so the button stays hidden either way.
 */
export function canLaunch(idea: LaunchTarget): boolean {
  if (idea.status !== 'open') return false
  if (idea.workspaceId === undefined || idea.workspaceId === '') return false
  if (idea.runStatus === 'running') return false
  if (idea.taskBoardId === undefined || idea.taskBoardId === '') return true
  const status = idea.taskBoardStatus
  return status === undefined || LAUNCHABLE_TASK_STATUSES.includes(status)
}

/** What a backend answers after accepting a run. */
export interface LaunchOutcome {
  /** Backend-neutral run handle (v1: the mirrored card id). */
  runId: string
  /** TaskBoard card id, absent for a backend that owns no card (v2). */
  taskId?: string
  /** Always `running` on an accept; the settle is written by the Host poll. */
  runStatus: IdeaRunStatus
}

/**
 * One execution backend. `available` is a capability probe (kept async so a
 * backend may answer it with a real check later), never a UI state: when it
 * says no, the board simply shows no button.
 */
export interface LaunchBackend {
  readonly id: 'host'
  available(idea: LaunchTarget): Promise<boolean>
  launch(idea: LaunchTarget, model?: ModelChoice): Promise<LaunchOutcome>
}

/**
 * The `provider/model` target id the task-board stores on the task and the
 * runner pins on the fresh session. Built from a catalog choice, so the ids are
 * already qualified (a bare id would keep the session provider).
 */
export function modelTargetIdOf(model: ModelChoice | undefined): string | undefined {
  if (model === undefined) return undefined
  const target = `${model.provider}/${model.model}`.trim()
  return target === '' ? undefined : target
}

/**
 * The Host backend: the HOST resolves which execution actually runs (mirrored
 * card, or fresh direct session), and this side only asks. Rejects with the
 * chosen backend's own message (`task is already running or missing`,
 * `archived task is read-only`, `session create failed: …`,
 * `taskboard-unavailable`, ...) so the board can show what actually refused
 * the launch instead of a generic failure.
 */
export class HostLaunchBackend implements LaunchBackend {
  readonly id = 'host' as const

  constructor(private readonly transport: IdeasHostTransport) {}

  /**
   * Capability detection, not a health probe: the Host owns the
   * execution-backend question. A transport without the method is an older
   * host and simply gets no button; a live refusal arrives as a rejected
   * launch, which the modal shows.
   */
  async available(_idea: LaunchTarget): Promise<boolean> {
    return this.transport.launch !== undefined
  }

  async launch(idea: LaunchTarget, model?: ModelChoice): Promise<LaunchOutcome> {
    if (this.transport.launch === undefined) throw new Error('launch-unavailable')
    return await this.transport.launch(idea.id, modelTargetIdOf(model))
  }
}

/**
 * Backends in resolution order. There is ONE today — the Host picks the
 * execution backend per launch — and a remote runner would append here (and
 * only here), the button, the modal, the error surface and the run lifecycle
 * are already backend-neutral.
 */
export function launchBackends(transport: IdeasHostTransport): LaunchBackend[] {
  return [new HostLaunchBackend(transport)]
}

/** The first backend able to run this idea, or undefined (no button). */
export async function resolveLaunchBackend(idea: LaunchTarget, transport: IdeasHostTransport): Promise<LaunchBackend | undefined> {
  if (!canLaunch(idea)) return undefined
  for (const backend of launchBackends(transport)) {
    if (await backend.available(idea)) return backend
  }
  return undefined
}
