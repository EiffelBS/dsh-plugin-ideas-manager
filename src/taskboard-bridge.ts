/**
 * P2 TaskBoard bridge: OPTIONAL one-way mirror from the ideas ledger to the
 * dsh-task-board plugin, discovered at runtime — never a hard import. The
 * ideas Host calls its OWN origin's /api/task-board routes over loopback with
 * the family same-origin markers, exactly like a browser tab would, so the
 * bridge works whenever the task-board plugin is registered on the same
 * process and degrades to silent no-ops when it is not.
 *
 * Mapping (frozen in HANDOVER §2.3): idea create -> task create + move to
 * `backlog` (the card is `read-only`); idea update -> task update; idea
 * decline / move-to-archived -> task archive; idea restore -> task restore;
 * idea delete -> no-op (the card outlives the idea — closing the loop to
 * `done` is a manual run, never automated). Every failure is logged and the
 * ideas ledger stays the source of truth: the mirror never rolls back a
 * committed idea mutation.
 */

import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { IdeaRecord } from './core/ideas.ts'

export const TASK_BOARD_API_PREFIX = '/api/task-board'
/** Read-only permission stamped on every mirrored card (HANDOVER §1). */
const MIRROR_TASK_PERMISSION = 'read-only' as const
/** How often a failed/negative availability probe is retried. */
const PROBE_RETRY_MS = 30_000
/** Per-self-request timeout; the mirror is best-effort and must not hang. */
const TRANSPORT_TIMEOUT_MS = 10_000
/** Cap on mirror response bodies (a snapshot could be large; we only read status). */
const RESPONSE_CAP_BYTES = 128 * 1024

/** Local mirror of the task-board action union (never imported from the package). */
export type TaskBoardAction =
  | { kind: 'create'; id: string; input: TaskBoardNewTaskInput }
  | { kind: 'update'; taskId: string; patch: TaskBoardTaskPatch }
  | { kind: 'move'; taskId: string; status: 'backlog' }
  | { kind: 'archive'; taskId: string }
  | { kind: 'restore'; taskId: string }

/** Local mirror of the task-board action envelope. */
export interface TaskBoardActionEnvelope {
  requestId: string
  action: TaskBoardAction
}

/** Local mirror of NewTaskInput — only the fields the ideas mirror sets. */
export interface TaskBoardNewTaskInput {
  title: string
  description: string
  prompt: string
  workspaceId?: string
  permission?: typeof MIRROR_TASK_PERMISSION
  tags?: { name: string; promptPrefix?: string }[]
}

/** Local mirror of the task update patch — only the fields ideas control. */
export interface TaskBoardTaskPatch {
  title?: string
  description?: string
  prompt?: string
  workspaceId?: string | null
  tags?: { name: string; promptPrefix?: string }[] | null
}

/** Local mirror of a task-board task row — only the fields the poll reads. */
export interface TaskBoardTaskLite {
  id: string
  status: string
}

/** A self-request result: HTTP status plus an optional parsed JSON body. */
export interface TaskBoardHttpResult {
  status: number
  body?: unknown
}

/** Injectable HTTP surface for the bridge (tests substitute a fake). */
export interface TaskBoardTransport {
  /** Feature-detect probe: GET /api/task-board/state. */
  getState(): Promise<TaskBoardHttpResult>
  /** Mirror write: POST /api/task-board/action. */
  postAction(envelope: TaskBoardActionEnvelope): Promise<TaskBoardHttpResult>
}

/**
 * Real transport: one loopback self-request per call to the Host's own
 * origin, carrying the browser same-origin markers so the task-board route
 * fence (socket + Host + Origin equality) accepts it without a token.
 */
export class HttpTaskBoardTransport implements TaskBoardTransport {
  /**
   * @param getBase - lazily resolved origin (http://127.0.0.1:port); the
   *   listen port is only known once the web server has bound its socket.
   */
  constructor(private readonly getBase: () => string) {}

  getState(): Promise<TaskBoardHttpResult> {
    return this.exchange('GET', `${TASK_BOARD_API_PREFIX}/state`)
  }

  postAction(envelope: TaskBoardActionEnvelope): Promise<TaskBoardHttpResult> {
    return this.exchange('POST', `${TASK_BOARD_API_PREFIX}/action`, JSON.stringify(envelope))
  }

  private async exchange(method: 'GET' | 'POST', path: string, body?: string): Promise<TaskBoardHttpResult> {
    const base = this.getBase().replace(/\/$/, '')
    return new Promise<TaskBoardHttpResult>((resolve, reject) => {
      const url = new URL(base + path)
      const headers: Record<string, string> = {
        origin: base,
        'sec-fetch-site': 'same-origin',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }
      const outgoing = httpRequest(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > RESPONSE_CAP_BYTES) {
              res.destroy()
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown
            try {
              parsed = raw === '' ? undefined : JSON.parse(raw)
            } catch {
              parsed = raw
            }
            resolve({ status: res.statusCode ?? 0, ...(parsed === undefined ? {} : { body: parsed }) })
          })
          res.on('error', (error) => reject(error as Error))
        },
      )
      outgoing.setTimeout(TRANSPORT_TIMEOUT_MS)
      outgoing.on('error', (error) => reject(error as Error))
      if (body !== undefined) outgoing.write(body)
      outgoing.end()
    })
  }
}

/** Mirror options; every seam is injectable for tests. */
export interface TaskBoardMirrorOptions {
  transport: TaskBoardTransport
  now?: () => number
  /** Log line sink; defaults to console.error (best-effort noise is fine). */
  log?: (message: string) => void
}

/**
 * The one-way mirror. Availability is feature-detected on first use and
 * re-probed after a failure/absence with a bounded backoff. All methods throw
 * on transport failure — the service catches, logs, and never rolls back.
 */
export class TaskBoardMirror {
  private readonly log: (message: string) => void
  private readonly now: () => number
  private available = false
  private lastProbeAt = 0

  constructor(private readonly options: TaskBoardMirrorOptions) {
    this.log = options.log ?? ((message: string) => { console.error(`[dsh-plugin-ideas-manager] mirror: ${message}`) })
    this.now = options.now ?? Date.now
  }

  /**
   * Feature-detect the task-board plugin. Positive probes are cached; a
   * failure is retried at most once per backoff window.
   */
  async availableNow(): Promise<boolean> {
    if (this.available) return true
    if (this.now() - this.lastProbeAt < PROBE_RETRY_MS) return false
    this.lastProbeAt = this.now()
    try {
      const result = await this.options.transport.getState()
      if (result.status === 200) {
        this.available = true
        return true
      }
      this.log(`task-board unavailable (GET ${TASK_BOARD_API_PREFIX}/state -> ${result.status}); mirror inactive`)
      return false
    } catch (error) {
      this.log(`task-board probe failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Resolve the bound task id, creating + moving the card to backlog when the
   * idea is not yet mirrored (the ladder used by update/decline too, so a
   * bridge activated after an idea's creation still catches it up).
   * @returns the task id to bind on the idea.
   */
  async ensureTask(idea: IdeaRecord): Promise<string> {
    if (!await this.availableNow()) throw new TaskBoardUnavailableError()
    if (idea.taskBoardId !== undefined && idea.taskBoardId !== '') return idea.taskBoardId
    return this.createCard(idea)
  }

  /**
   * Read the current status of every task card: task id -> status. Returns
   * undefined when the task-board is absent or the snapshot is malformed —
   * the under-review poll treats that as "nothing to do" (best-effort, like
   * the rest of the bridge).
   */
  async fetchTaskStatuses(): Promise<Map<string, string> | undefined> {
    if (!await this.availableNow()) return undefined
    const result = await this.options.transport.getState()
    if (result.status !== 200 || typeof result.body !== 'object' || result.body === null) return undefined
    const tasks = (result.body as { tasks?: unknown }).tasks
    if (!Array.isArray(tasks)) return undefined
    const byId = new Map<string, string>()
    for (const task of tasks) {
      if (typeof task !== 'object' || task === null) continue
      const row = task as { id?: unknown; status?: unknown }
      if (typeof row.id === 'string' && typeof row.status === 'string') byId.set(row.id, row.status)
    }
    return byId
  }

  /** Idea create -> task create (read-only, backlog) + move to backlog. */
  async mirrorCreate(idea: IdeaRecord): Promise<string> {
    if (!await this.availableNow()) throw new TaskBoardUnavailableError()
    return this.createCard(idea)
  }

  /** Idea update -> task update; self-heals an unbound idea by creating it first. */
  async mirrorUpdate(idea: IdeaRecord): Promise<string> {
    const taskId = await this.ensureTask(idea)
    await this.post({
      kind: 'update',
      taskId,
      patch: this.taskPatch(idea),
    })
    return taskId
  }

  /** Idea decline / move-to-archived -> task archive. */
  async mirrorArchive(idea: IdeaRecord): Promise<string> {
    const taskId = await this.ensureTask(idea)
    await this.post({ kind: 'archive', taskId })
    return taskId
  }

  /** Idea restore -> task restore (no-op when the idea was never bound). */
  async mirrorRestore(idea: IdeaRecord): Promise<void> {
    if (idea.taskBoardId === undefined || idea.taskBoardId === '') return
    await this.post({ kind: 'restore', taskId: idea.taskBoardId })
  }

  /** The task-board plugin is not registered or did not answer. */
  get isUnavailable(): boolean {
    return !this.available
  }

  private async createCard(idea: IdeaRecord): Promise<string> {
    const taskId = `idea-${randomUUID()}`
    await this.post({
      kind: 'create',
      id: taskId,
      input: {
        title: idea.title,
        description: idea.body,
        prompt: this.taskPrompt(idea),
        permission: MIRROR_TASK_PERMISSION,
        ...(idea.workspaceId === undefined ? {} : { workspaceId: idea.workspaceId }),
        ...(idea.tags === undefined || idea.tags.length === 0 ? {} : { tags: idea.tags }),
      },
    })
    await this.post({ kind: 'move', taskId, status: 'backlog' })
    return taskId
  }

  private taskPatch(idea: IdeaRecord): TaskBoardTaskPatch {
    return {
      title: idea.title,
      description: idea.body,
      prompt: this.taskPrompt(idea),
      workspaceId: idea.workspaceId,
      ...(idea.tags === undefined || idea.tags.length === 0 ? {} : { tags: idea.tags }),
    }
  }

  /** The executable prompt = the tag prompt lines, one per line. */
  private taskPrompt(idea: IdeaRecord): string {
    if (idea.tags === undefined) return ''
    return idea.tags.map(tag => tag.promptPrefix?.trim() ?? '').filter(line => line !== '').join('\n')
  }

  private async post(action: TaskBoardAction): Promise<void> {
    const requestId = `ideas-mirror-${randomUUID()}`
    const result = await this.options.transport.postAction({ requestId, action })
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`task-board ${action.kind} -> ${result.status}`)
    }
  }
}

/** Thrown when the task-board plugin is absent; the service logs and moves on. */
export class TaskBoardUnavailableError extends Error {
  constructor() {
    super('task-board plugin is not available')
  }
}