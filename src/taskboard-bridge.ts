/**
 * P2 TaskBoard bridge: OPTIONAL one-way mirror from the ideas ledger to the
 * dsh-task-board plugin, discovered at runtime — never a hard import. The
 * ideas Host calls its OWN origin's /api/task-board routes over loopback with
 * the family same-origin markers, exactly like a browser tab would, so the
 * bridge works whenever the task-board plugin is registered on the same
 * process and degrades to silent no-ops when it is not.
 *
 * Mapping (frozen design decision): idea create -> task create + move to
 * `backlog` (the card is `read-only`); idea update -> task update; idea
 * decline / move-to-archived -> task archive; idea restore -> task restore;
 * idea delete -> no-op (the card outlives the idea — closing the loop to
 * `done` is a manual run, never automated). Every failure is logged and the
 * ideas ledger stays the source of truth: the mirror never rolls back a
 * committed idea mutation.
 *
 * Duplicate guard (idea #35 — "update must never mean create"): card ids are
 * DETERMINISTIC (`idea-` + idea.id, see mirrorCardIdFor), a bound idea is
 * only ever re-created when a NON-EMPTY snapshot proves the card gone, and
 * every ensureTask decision is logged with ideaId + binding + snapshot size +
 * branch. A transiently empty/unreadable snapshot therefore keeps the binding
 * and attempts the patch instead of minting a second card, and re-running any
 * path re-touches the same card id instead of duplicating it.
 */

import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { IdeaRecord } from './core/ideas.ts'

export const TASK_BOARD_API_PREFIX = '/api/task-board'
/** Read-only permission stamped on every mirrored card. */
const MIRROR_TASK_PERMISSION = 'read-only' as const
/** How often a failed/negative availability probe is retried. */
const PROBE_RETRY_MS = 30_000
/** Per-self-request timeout; the mirror is best-effort and must not hang. */
const TRANSPORT_TIMEOUT_MS = 10_000
/**
 * Cap on mirror response bodies — BOTH routes answer a full task-board
 * SNAPSHOT (every card's description + prompt), so the size grows with the
 * board: the production board measured 190,947 bytes once idea #35's
 * rewritten card landed and its task ran, past the former 128 KiB ceiling.
 * Crossing the cap used to `res.destroy()` WITHOUT settling the promise:
 * every snapshot read hung silently (no log line — a pending promise never
 * throws), the under-review poll stopped moving ideas to `underReview`, and
 * bound-idea mirror updates stalled with it. 16 MiB sits far above any real
 * board, and the overflow path now REJECTS (see HttpTaskBoardTransport), so
 * a cap can degrade a read but never hang a caller again.
 */
const RESPONSE_CAP_BYTES = 16 * 1024 * 1024

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

/**
 * Deterministic TaskBoard card id for an idea: `idea-` + idea.id.
 *
 * Idempotence (idea #35): re-running any mirror path targets the SAME card id
 * instead of minting a fresh `idea-${randomUUID()}` on every re-execution —
 * a re-analyze or a lost binding can no longer produce a second card. The
 * task-board host ledger REFUSES `create` of an existing id (HTTP 400
 * `task id already exists`), so callers pair this id with get-before-create:
 * consult the snapshot first and adopt an already-present card rather than
 * issuing the create.
 */
export function mirrorCardIdFor(idea: IdeaRecord): string {
  return `idea-${idea.id}`
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
  private readonly getBase: () => string
  private readonly maxResponseBytes: number
  private readonly timeoutMs: number

  /**
   * @param getBase - lazily resolved origin (http://127.0.0.1:port); the
   *   listen port is only known once the web server has bound its socket.
   * @param limits - test seams for the response cap and request timeout.
   */
  constructor(getBase: () => string, limits: { maxResponseBytes?: number; timeoutMs?: number } = {}) {
    this.getBase = getBase
    this.maxResponseBytes = limits.maxResponseBytes ?? RESPONSE_CAP_BYTES
    this.timeoutMs = limits.timeoutMs ?? TRANSPORT_TIMEOUT_MS
  }

  getState(): Promise<TaskBoardHttpResult> {
    return this.exchange('GET', `${TASK_BOARD_API_PREFIX}/state`)
  }

  postAction(envelope: TaskBoardActionEnvelope): Promise<TaskBoardHttpResult> {
    return this.exchange('POST', `${TASK_BOARD_API_PREFIX}/action`, JSON.stringify(envelope))
  }

  /**
   * One self-request. The promise SETTLES ON EVERY PATH — resolved with the
   * parsed reply, or rejected on overflow, early close, socket error, or
   * timeout. The former implementation destroyed an oversized response
   * without settling, which hung the caller forever and silently stalled the
   * under-review poll once the production snapshot passed 128 KiB.
   */
  private async exchange(method: 'GET' | 'POST', path: string, body?: string): Promise<TaskBoardHttpResult> {
    const base = this.getBase().replace(/\/$/, '')
    return new Promise<TaskBoardHttpResult>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (!settled) { settled = true; reject(error) }
      }
      const succeed = (result: TaskBoardHttpResult): void => {
        if (!settled) { settled = true; resolve(result) }
      }
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
            if (settled) return
            size += chunk.length
            if (size > this.maxResponseBytes) {
              res.destroy()
              outgoing.destroy()
              fail(new Error(`task-board response too large (> ${this.maxResponseBytes} bytes)`))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            if (settled) return
            const raw = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown
            try {
              parsed = raw === '' ? undefined : JSON.parse(raw)
            } catch {
              parsed = raw
            }
            succeed({ status: res.statusCode ?? 0, ...(parsed === undefined ? {} : { body: parsed }) })
          })
          res.on('error', (error) => fail(error as Error))
          // A response closed before 'end' (server restart, reset mid-body)
          // must reject — never linger as a pending promise.
          res.on('close', () => { fail(new Error('task-board response closed before completion')) })
        },
      )
      outgoing.setTimeout(this.timeoutMs)
      // Make the timeout FATAL: without this handler the 'timeout' event was
      // never fatal and a stalled self-request would hang the caller forever.
      outgoing.on('timeout', () => {
        outgoing.destroy(new Error(`task-board request timed out after ${this.timeoutMs} ms`))
      })
      outgoing.on('error', (error) => fail(error as Error))
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
   * Resolve the task id a mirror operation must target; the caller rebinds
   * the idea to the returned id. Decision ladder (idea #35 — "update must
   * never mean create"), logged with ideaId + binding + snapshot size +
   * branch on every path so a duplicate can be discriminated after the fact:
   *
   * Bound idea:
   *  - snapshot unknown (task-board absent / malformed body) or EMPTY ->
   *    keep the binding and target it. An empty or unreadable snapshot never
   *    proves a deletion; the patch attempt that follows fails into the
   *    service log instead of being "healed" by a create. This closes the
   *    transient-snapshot duplicate factory.
   *  - bound id present -> patch it (the normal path).
   *  - bound id absent from a NON-EMPTY snapshot -> the card was deleted
   *    out-of-band: the sanctioned rebuild, using the DETERMINISTIC id and
   *    logged as a visible event (recreating an already-bound idea is never
   *    silent again).
   *
   * Unbound idea (fresh create, or a binding never written):
   *  - get-before-create: adopt the deterministic card when the snapshot
   *    already holds it (a previous create whose bind did not land), only
   *    otherwise create it. Self-heal of the legacy orphan case, no duplicate.
   *
   * @returns the task id to bind on the idea.
   */
  async ensureTask(idea: IdeaRecord): Promise<string> {
    if (!await this.availableNow()) throw new TaskBoardUnavailableError()
    const cardId = mirrorCardIdFor(idea)
    const bound = idea.taskBoardId === undefined || idea.taskBoardId === '' ? undefined : idea.taskBoardId
    const statuses = await this.fetchTaskStatuses()
    const tasks = statuses === undefined ? '?' : String(statuses.size)
    if (bound !== undefined) {
      if (statuses === undefined) {
        this.decision(idea, bound, tasks, 'trust-binding-snapshot-unknown')
        return bound
      }
      if (statuses.size === 0) {
        this.decision(idea, bound, tasks, 'trust-binding-snapshot-empty')
        return bound
      }
      if (statuses.has(bound)) {
        this.decision(idea, bound, tasks, 'patch-bound-card')
        return bound
      }
      if (statuses.has(cardId)) {
        // The binding points at a gone legacy card while the deterministic
        // card already exists (an earlier rebuild): adopt it, never create.
        this.decision(idea, bound, tasks, 'adopt-deterministic-card')
        return cardId
      }
      this.decision(idea, bound, tasks, 'recreate-deleted-card')
      return this.createCard(idea, cardId)
    }
    if (statuses !== undefined && statuses.size > 0 && statuses.has(cardId)) {
      this.decision(idea, undefined, tasks, 'adopt-existing-card')
      return cardId
    }
    this.decision(idea, undefined, tasks, 'create-card')
    return this.createCard(idea, cardId)
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

  /**
   * Idea create -> task create (read-only, backlog) + move to backlog.
   * Routed through ensureTask so a create re-executed after a lost bind
   * adopts the card already on the board instead of duplicating it.
   */
  async mirrorCreate(idea: IdeaRecord): Promise<string> {
    if (!await this.availableNow()) throw new TaskBoardUnavailableError()
    return this.ensureTask(idea)
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

  /** One ensureTask decision, always visible in the service log (idea #35). */
  private decision(idea: IdeaRecord, bound: string | undefined, tasks: string, branch: string): void {
    this.log(`ensureTask idea=${idea.id} bound=${bound ?? '-'} tasks=${tasks} branch=${branch}`)
  }

  /**
   * Create the card at `taskId` (the DETERMINISTIC mirrorCardIdFor id — never
   * a fresh uuid) and move it to backlog. The id is passed in rather than
   * minted so no code path can accidentally re-introduce a random id.
   */
  private async createCard(idea: IdeaRecord, taskId: string): Promise<string> {
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

  /**
   * The executable prompt = the tag prompt lines, one per line; when no tag
   * carries a prompt line, a mission prompt derived from the card itself.
   * The fallback is mandatory: Task Board launches a run with
   * `task.prompt !== '' ? task.prompt : task.title` (the description is never
   * injected into the session), so an empty prompt would ship the card's bare
   * TITLE to the launched agent — unexploitable for the common idea whose tags
   * are all plain names. The body is the captured spec, so it becomes the run
   * instruction instead.
   */
  private taskPrompt(idea: IdeaRecord): string {
    if (idea.tags !== undefined) {
      const lines = idea.tags.map(tag => tag.promptPrefix?.trim() ?? '').filter(line => line !== '')
      if (lines.length > 0) return lines.join('\n')
    }
    const numeral = idea.ideaNumber === undefined ? '' : ` #${String(idea.ideaNumber)}`
    return `You are implementing the idea below${numeral} — "${idea.title}" — from the DSH Ideas board. Work in the current workspace directory.\n\nThe idea's spec (Body):\n${idea.body}`
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