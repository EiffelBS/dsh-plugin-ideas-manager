/**
 * Launch an idea's execution from the board (idea #66, v1 = TaskBoard).
 *
 * One capability, two possible execution backends: today the mirrored
 * TaskBoard card (the Host owns the mirror, so the browser asks
 * `POST /api/ideas/launch` and never touches /api/task-board itself), later a
 * direct chat session with no board at all. The button and the modal resolve a
 * backend through {@link resolveLaunchBackend}, so adding the second backend is
 * a new class here and NOT a component change.
 *
 * Visibility is a PURE predicate ({@link canLaunch}) so the whole
 * status x task-status x workspace matrix is unit-testable without a DOM, and
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
 */
export function canLaunch(idea: LaunchTarget): boolean {
  if (idea.status !== 'open') return false
  if (idea.workspaceId === undefined || idea.workspaceId === '') return false
  if (idea.taskBoardId === undefined || idea.taskBoardId === '') return false
  if (idea.runStatus === 'running') return false
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
  readonly id: 'taskboard' | 'session'
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
 * The TaskBoard backend: the Host mirrors and RUNS, this side only asks.
 * Rejects with the host's own message (`task is already running or missing`,
 * `archived task is read-only`, `taskboard-unavailable`, ...) so the board can
 * show what actually refused the launch instead of a generic failure.
 */
export class TaskBoardLaunchBackend implements LaunchBackend {
  readonly id = 'taskboard' as const

  constructor(private readonly transport: IdeasHostTransport) {}

  /**
   * Capability detection, not a health probe: the Host owns the
   * task-board-plugin-present question (it feature-detects it on every mirror
   * op). A transport without the method is an older host and simply gets no
   * button; a live refusal arrives as a rejected launch, which the modal shows.
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
 * Backends in resolution order. v2 appends the direct-session backend here
 * (and only here) — the button, the modal, the error surface and the run
 * lifecycle are already backend-neutral.
 */
export function launchBackends(transport: IdeasHostTransport): LaunchBackend[] {
  return [new TaskBoardLaunchBackend(transport)]
}

/** The first backend able to run this idea, or undefined (no button). */
export async function resolveLaunchBackend(idea: LaunchTarget, transport: IdeasHostTransport): Promise<LaunchBackend | undefined> {
  if (!canLaunch(idea)) return undefined
  for (const backend of launchBackends(transport)) {
    if (await backend.available(idea)) return backend
  }
  return undefined
}
