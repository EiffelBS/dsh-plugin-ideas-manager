/**
 * P1 Host ledger: the authoritative idea store persisted at
 * `~/.dsh/ideas/ledger-v2.json` (one shared ledger document; each idea may
 * carry a workspaceId intended for that workspace).
 *
 * Discipline follows the dsh-task-board Host ledger with one deliberate
 * deviation: every write uses path-based node:fs calls (writeFileSync /
 * renameSync / mkdirSync), never the descriptor-based APIs (openSync /
 * fsyncSync), so the same code passes both inside the DSH sandbox and in the
 * live host. Atomicity: a mutation goes to `ledger-v2.json.tmp-<pid>` and is
 * rename()d over the document (atomic on NTFS/POSIX). Durability tradeoff:
 * there is no fsync without a descriptor — a crash between rename and the
 * next boot is recovered by the corrupt/quarantine path, never by a lost
 * revision. Exclusivity: the lock is a DIRECTORY (`ledger-v2.lock/`) created
 * with mkdirSync (mkdir is atomic + exclusive on every platform), holding an
 * owner marker { pid, token, startedAt } for liveness checks. This matches
 * the family guarantees (single writer, stale takeover, loud refusal while
 * another live host owns the ledger) without descriptor APIs.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createIdea, isIdeaRunStatus, normalizeStatus, normalizeSummary, normalizeTags, rankGroupKey, withStatus, type IdeaRecord, type IdeaRunStatus } from './core/ideas.ts'
import { dshHome } from './dsh-home.ts'
import { buildIdeasExport, type IdeasExport } from './export-markdown.ts'
import { IDEAS_SCHEMA_VERSION, type FollowUpInput, type IdeaUpdatePatch, type IdeasAction } from './protocol.ts'

export const IDEAS_LEDGER_DIR_NAME = 'ideas'
export const IDEAS_LEDGER_FILE_NAME = 'ledger-v2.json'
export const IDEAS_LOCK_FILE_NAME = 'ledger-v2.lock'
const LOCK_OWNER_FILE = 'owner.json'
const MAX_REQUEST_CACHE = 256

interface PersistedRequest {
  requestId: string
  fingerprint: string
}

interface LedgerDocument {
  schemaVersion: typeof IDEAS_SCHEMA_VERSION
  revision: number
  ideas: IdeaRecord[]
  importedSources: string[]
  recentRequests: PersistedRequest[]
  /** Next capture sequence — the stable "#N" idea number (1-based). */
  ideaSequence: number
}

/** On-disk document with an unknown schema until the load branches decide. */
type ParsedLedgerDocument = Omit<Partial<LedgerDocument>, 'schemaVersion'> & { schemaVersion?: unknown }

/** Apply result: the post-commit state, plus the export payload when asked. */
export interface LedgerApplyResult {
  state: LedgerState
  export?: IdeasExport
  /**
   * True when the request id was already cached (a replay): nothing was
   * re-executed, so the caller must not re-run side effects such as the
   * TaskBoard mirror.
   */
  replayed?: boolean
}

/** Read view of the ledger. */
export interface LedgerState {
  schemaVersion: typeof IDEAS_SCHEMA_VERSION
  revision: number
  ideas: IdeaRecord[]
}

interface LockRecord {
  token: string
  pid: number
  startedAt: number
}

function cloneIdeas(ideas: readonly IdeaRecord[]): IdeaRecord[] {
  return JSON.parse(JSON.stringify(ideas)) as IdeaRecord[]
}

/** Cheap liveness probe: the zero signal throws when the process is gone. */
function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Normalize an optional id: trim; blank collapses to undefined. */
function normalizeOptionalId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Normalize a mirrored task status: trim, lowercase, cap 32 chars; blank collapses to undefined. */
function normalizeTaskBoardStatus(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed === undefined || trimmed === '') return undefined
  return trimmed.slice(0, 32)
}

/**
 * Normalize a persisted run status (idea #66): the closed union only — an
 * unknown persisted value is DROPPED rather than stored, so a hand-edited
 * ledger can never put the board in a state the run poll cannot reason about.
 */
function normalizeRunStatus(value: unknown): IdeaRunStatus | undefined {
  return isIdeaRunStatus(value) ? value : undefined
}

/** Structural repair of a persisted idea list (mirrors the import repair). */
function parseHostIdeas(rows: readonly unknown[]): IdeaRecord[] {
  const ideas: IdeaRecord[] = []
  for (const value of rows) {
    if (typeof value !== 'object' || value === null) continue
    const row = value as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id === '' || typeof row.title !== 'string' || row.title.trim() === '') continue
    const idea: IdeaRecord = {
      id: row.id,
      title: row.title.trim(),
      body: typeof row.body === 'string' ? row.body.trim() : '',
      status: normalizeStatus(row.status),
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    }
    const summary = normalizeSummary(typeof row.summary === 'string' ? row.summary : undefined)
    if (summary !== undefined) idea.summary = summary
    if (typeof row.rank === 'number' && Number.isFinite(row.rank)) idea.rank = row.rank
    if (typeof row.value === 'number' && Number.isFinite(row.value)) idea.value = row.value
    if (typeof row.effort === 'number' && Number.isFinite(row.effort)) idea.effort = row.effort
    if (typeof row.rationale === 'string' && row.rationale.trim() !== '') idea.rationale = row.rationale.trim()
    if (typeof row.decision === 'string' && row.decision.trim() !== '') idea.decision = row.decision.trim()
    if (typeof row.ideaNumber === 'number' && Number.isFinite(row.ideaNumber)) idea.ideaNumber = row.ideaNumber
    if (typeof row.deliveredAt === 'number') idea.deliveredAt = row.deliveredAt
    if (typeof row.archivedAt === 'number') idea.archivedAt = row.archivedAt
    const workspaceId = typeof row.workspaceId === 'string' ? normalizeOptionalId(row.workspaceId) : undefined
    if (workspaceId !== undefined) idea.workspaceId = workspaceId
    const taskBoardId = typeof row.taskBoardId === 'string' ? normalizeOptionalId(row.taskBoardId) : undefined
    if (taskBoardId !== undefined) idea.taskBoardId = taskBoardId
    const taskBoardStatus = normalizeTaskBoardStatus(typeof row.taskBoardStatus === 'string' ? row.taskBoardStatus : undefined)
    if (taskBoardStatus !== undefined) idea.taskBoardStatus = taskBoardStatus
    const runStatus = normalizeRunStatus(row.runStatus)
    if (runStatus !== undefined) idea.runStatus = runStatus
    const runSessionId = typeof row.runSessionId === 'string' ? normalizeOptionalId(row.runSessionId) : undefined
    if (runSessionId !== undefined) idea.runSessionId = runSessionId
    if (typeof row.followUpOfId === 'string' && row.followUpOfId.trim() !== '') idea.followUpOfId = row.followUpOfId.trim()
    const tags = normalizeTags(row.tags)
    if (tags !== undefined) idea.tags = tags
    if (typeof row.reanalyzeAt === 'number') idea.reanalyzeAt = row.reanalyzeAt
    const audit = auditOf(row.analysisAudit)
    if (audit !== undefined) idea.analysisAudit = audit
    ideas.push(idea)
  }
  return ideas
}

/** Structural repair of a persisted prior-analysis snapshot (undefined when unusable). */
function auditOf(value: unknown): IdeaRecord['analysisAudit'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.at !== 'number' || typeof row.title !== 'string' || typeof row.body !== 'string') return undefined
  const tags = normalizeTags(row.tags)
  const summary = normalizeSummary(typeof row.summary === 'string' ? row.summary : undefined)
  return {
    at: row.at,
    title: row.title,
    body: row.body,
    ...(summary === undefined ? {} : { summary }),
    ...(tags === undefined ? {} : { tags }),
    ...(typeof row.value === 'number' ? { value: row.value } : {}),
    ...(typeof row.effort === 'number' ? { effort: row.effort } : {}),
    ...(typeof row.rationale === 'string' && row.rationale.trim() !== '' ? { rationale: row.rationale.trim() } : {}),
  }
}

export class IdeasHostLedger {
  private document: LedgerDocument
  private readonly requestCache = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly dir: string
  private readonly file: string
  private readonly lockDir: string
  private readonly lockOwnerFile: string
  private readonly lockToken = randomUUID()
  private disposed = false

  constructor(options: { dir?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.dir = options.dir ?? join(dshHome(), IDEAS_LEDGER_DIR_NAME)
    this.file = join(this.dir, IDEAS_LEDGER_FILE_NAME)
    this.lockDir = join(this.dir, IDEAS_LOCK_FILE_NAME)
    this.lockOwnerFile = join(this.lockDir, LOCK_OWNER_FILE)
    this.acquireLock()
    try {
      this.document = this.load()
    } catch (error) {
      this.releaseLock()
      throw error
    }
    // Restore the dedupe cache from the persisted tail so a replayed request
    // id (e.g. a client retry after a Host restart) returns the cached state
    // instead of re-executing its mutation.
    for (const entry of this.document.recentRequests) {
      this.requestCache.set(entry.requestId, entry.fingerprint)
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(): LedgerState {
    return {
      schemaVersion: this.document.schemaVersion,
      revision: this.document.revision,
      ideas: cloneIdeas(this.document.ideas),
    }
  }

  summary(): { revision: number } {
    return { revision: this.document.revision }
  }

  /**
   * One idea, deep-cloned like a snapshot row (idea #34): the deferred-body
   * read GET /api/ideas/idea?id= clones a SINGLE record instead of paying
   * the whole-ledger snapshot clone for one card.
   */
  idea(id: string): IdeaRecord | undefined {
    const found = this.document.ideas.find(idea => idea.id === id)
    if (found === undefined) return undefined
    return cloneIdeas([found])[0]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.releaseLock()
  }

  /**
   * Apply one action with request-id dedupe: the same requestId replayed with
   * the same action returns the current state without mutating. The cache is
   * persisted with every commit, so a Host restart cannot replay a mutation.
   */
  applyRequest(requestId: string, action: IdeasAction): LedgerApplyResult {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex')
    const cached = this.requestCache.get(requestId)
    if (cached !== undefined) {
      if (cached !== fingerprint) throw new Error('request id was reused with a different action')
      return { state: this.snapshot(), replayed: true }
    }
    this.requestCache.set(requestId, fingerprint)
    while (this.requestCache.size > MAX_REQUEST_CACHE) this.requestCache.delete(this.requestCache.keys().next().value as string)
    try {
      const result = this.apply(action)
      result.state = this.snapshot()
      return result
    } catch (error) {
      this.requestCache.delete(requestId)
      throw error
    }
  }

  /**
   * Host-internal association written only by the TaskBoard mirror: records
   * the mirrored card id on an idea. `taskBoardId` is a system field — the
   * protocol gate never accepts it from the wire — so this path bypasses
   * `applyRequest` while keeping the same commit + notify discipline (it
   * bumps the revision and re-parses the document like any mutation).
   * @returns true when the document changed and was committed.
   */
  bindTaskBoardId(ideaId: string, taskBoardId: string): boolean {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const trimmed = taskBoardId.trim()
    if (trimmed === '') return false
    if (!this.document.ideas.some(idea => idea.id === ideaId)) return false
    const before = this.document.ideas
    this.document.ideas = this.document.ideas.map(idea => idea.id === ideaId ? { ...idea, taskBoardId: trimmed } : idea)
    if (this.document.ideas === before) return false
    this.commit()
    return true
  }

  /**
   * Host-internal mirrored-task STATUS (follow-up work): records the last
   * status observed by the under-review poll so a card whose TaskBoard task
   * failed can show a badge while the idea stays in the backlog. Same
   * system-field discipline as `bindTaskBoardId` (never accepted from the
   * idea verbs), same commit + notify, and a no-op when the observation did
   * not change (the 30 s poll must not churn the revision while idle).
   * @returns true when the document changed and was committed.
   */
  setTaskBoardStatus(ideaId: string, status: string | undefined): boolean {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const next = normalizeTaskBoardStatus(status)
    const current = this.document.ideas.find(idea => idea.id === ideaId)
    if (current === undefined) return false
    if (current.taskBoardStatus === next) return false
    // `taskBoardStatus: undefined` is intentional: the JSON persist/clone
    // drops the key entirely, which is how a cleared observation is stored.
    this.document.ideas = this.document.ideas.map(idea => idea.id === ideaId ? { ...idea, taskBoardStatus: next } : idea)
    this.commit()
    return true
  }

  /**
   * Host-internal LAUNCH-LIFECYCLE stamp (idea #66): `running` is written by
   * the launch route the moment the execution is accepted, the settled state by
   * the run poll. Same system-field discipline as `bindTaskBoardId` (the
   * protocol gate never accepts `runStatus` from the wire) and the same
   * no-op-on-unchanged rule, so an idle poll cannot churn the revision.
   *
   * `undefined` CLEARS the stamp (a card observed outside a run, e.g. back in
   * `backlog`): the JSON persist/clone drops the key entirely, exactly like a
   * cleared `taskBoardStatus`.
   *
   * @returns true when the document changed and was committed.
   */
  setRunStatus(ideaId: string, status: IdeaRunStatus | undefined): boolean {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const current = this.document.ideas.find(idea => idea.id === ideaId)
    if (current === undefined) return false
    if (current.runStatus === status) return false
    this.document.ideas = this.document.ideas.map(idea => idea.id === ideaId ? { ...idea, runStatus: status } : idea)
    this.commit()
    return true
  }

  /**
   * Host-internal SESSION id of the latest launched run (idea #66 v2): written
   * with the `running` stamp by a direct-session launch, cleared when the run
   * settles. Same system-field discipline as `bindTaskBoardId`.
   *
   * Its real job is RESTART SAFETY: the in-memory run tracker is empty after a
   * Host restart, so the poll re-attaches to a run still in flight from the
   * `running` + `runSessionId` pair. Without it a restart mid-run would freeze
   * the idea on `running` forever.
   *
   * @returns true when the document changed and was committed.
   */
  setRunSession(ideaId: string, sessionId: string | undefined): boolean {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const current = this.document.ideas.find(idea => idea.id === ideaId)
    if (current === undefined) return false
    const next = sessionId === undefined || sessionId === '' ? undefined : sessionId
    if (current.runSessionId === next) return false
    this.document.ideas = this.document.ideas.map(idea => idea.id === ideaId ? { ...idea, runSessionId: next } : idea)
    this.commit()
    return true
  }

  private apply(action: IdeasAction): LedgerApplyResult {
    const now = this.now()
    const beforeIdeas = this.document.ideas
    switch (action.kind) {
      case 'create': {
        if (this.document.ideas.some(idea => idea.id === action.id)) throw new Error('idea id already exists')
        let idea = createIdea(action.input, now, action.id)
        if (idea.title.trim() === '') throw new Error('title is required')
        // The stable capture sequence: the "#N" human reference of the old
        // IDEAS.md process, monotonic and persisted with the document.
        this.document.ideaSequence += 1
        idea = { ...idea, ideaNumber: this.document.ideaSequence }
        this.document.ideas = [...this.document.ideas, idea]
        break
      }
      case 'update': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (action.patch.title !== undefined && action.patch.title !== null) {
          if (action.patch.title.trim() === '') throw new Error('title is required')
        }
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? applyPatch(item, action.patch, this.now())
          : item)
        break
      }
      case 'move': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (action.status === idea.status) break
        const archivedAt = action.status === 'archived' ? now : undefined
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? { ...withStatus(item, action.status, now), ...(archivedAt === undefined ? {} : { archivedAt }) }
          : item)
        break
      }
      case 'decline': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (idea.status !== 'declined') {
          const decision = action.decision === undefined ? undefined : blankToUndefined(action.decision)
          this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
            ? { ...withStatus(item, 'declined', now), archivedAt: now, ...(decision === undefined ? {} : { decision }) }
            : item)
        }
        break
      }
      case 'deliver': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        // Both an open idea and an under-review idea (review approved) can be
        // delivered; anything already closed is a no-op.
        if (idea.status !== 'open' && idea.status !== 'underReview') break
        // Delivered ideas leave the open backlog: same column as archived, but
        // stamped as a delivery (the lifecycle distinguishes delivered vs
        // abandoned; both render in the Archived column).
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? { ...withStatus(item, 'archived', now), archivedAt: now, deliveredAt: now }
          : item)
        break
      }
      case 'triage': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        let next: IdeaRecord = { ...idea, updatedAt: now }
        if (action.patch.value !== undefined) next.value = action.patch.value
        if (action.patch.effort !== undefined) next.effort = action.patch.effort
        if (action.patch.rationale !== undefined) {
          const rationale = action.patch.rationale.trim()
          next.rationale = rationale === '' ? undefined : rationale
        }
        let ideas = this.document.ideas.map(item => item.id === action.ideaId ? next : item)
        if (idea.status === 'open') {
          // Re-rank INSIDE the idea's own workspace group: the suggested 1-based
          // position is relative to the other open ideas of the same workspace
          // (the workspace-less ideas form one generic group). Other workspace
          // groups and the closed columns keep their ranks — the classic
          // "rank by workspace" semantic of the Priorities view.
          const ordered = triageOrderedIds(ideas, action.ideaId, action.patch.rank)
          const rankById = new Map(ordered.map((id, index) => [id, index + 1]))
          ideas = ideas.map(item => ({ ...item, rank: rankById.get(item.id) ?? item.rank }))
        }
        this.document.ideas = ideas
        break
      }
      case 'followUp': {
        const parent = this.document.ideas.find(item => item.id === action.ideaId)
        if (parent === undefined) throw new Error('idea not found')
        // A follow-up is the review-rejected answer to an under-review idea: the
        // parent leaves the backlog (archived, not declined — the work was not
        // rejected, it needs rework) while the child re-enters it open.
        if (parent.status !== 'underReview') throw new Error('follow-up requires an under-review idea')
        const input = blankToUndefined(action.input.title) ?? ''
        if (input.trim() === '') throw new Error('title is required')
        const childId = randomUUID()
        this.document.ideaSequence += 1
        const child = {
          ...createIdea(
            {
              title: action.input.title,
              body: action.input.body,
              ...(parent.workspaceId === undefined ? {} : { workspaceId: parent.workspaceId }),
            },
            now,
            childId,
          ),
          ideaNumber: this.document.ideaSequence,
          followUpOfId: parent.id,
        }
        this.document.ideas = [
          ...this.document.ideas.map(item => item.id === parent.id
            ? { ...withStatus(item, 'archived', now), archivedAt: now }
            : item),
          child,
        ]
        break
      }
      case 'restore': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (idea.status === 'open') break
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? { ...withStatus(item, 'open', now), archivedAt: undefined }
          : item)
        break
      }
      case 'delete': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        this.document.ideas = this.document.ideas.filter(item => item.id !== action.ideaId)
        break
      }
      case 'reanalyze': {
        // The human-triggered start of an analyst re-run: stamp the cycle and
        // preserve the CURRENT content as the prior-analysis audit trail. The
        // analyst's own update+triage later writes the new content over the
        // card; the audit keeps re-analysis deliberate (never destroying
        // history). One level deep: the previous audit is superseded.
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        const audit: IdeaRecord['analysisAudit'] = {
          at: now,
          title: idea.title,
          body: idea.body,
          ...(idea.summary === undefined ? {} : { summary: idea.summary }),
          ...(idea.tags === undefined ? {} : { tags: idea.tags }),
          ...(idea.value === undefined ? {} : { value: idea.value }),
          ...(idea.effort === undefined ? {} : { effort: idea.effort }),
          ...(idea.rationale === undefined ? {} : { rationale: idea.rationale }),
        }
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? { ...item, reanalyzeAt: now, analysisAudit: audit, updatedAt: now }
          : item)
        break
      }
      case 'reorder': {
        const present = new Set(this.document.ideas.map(idea => idea.id))
        const ordered = action.orderedIds.filter(id => present.has(id))
        // Ranks are relative to the (status, workspace) group: each idea takes
        // the position of its own group in the provided order, so workspace A
        // re-ranks independently of workspace B (the workspace-less ideas form
        // one generic group). Ideas absent from the list keep their rank.
        const byId = new Map(this.document.ideas.map(idea => [idea.id, idea]))
        const counters = new Map<string, number>()
        const rankById = new Map<string, number>()
        for (const id of ordered) {
          const item = byId.get(id)
          if (item === undefined) continue
          const key = rankGroupKey(item.status, item.workspaceId)
          const next = (counters.get(key) ?? 0) + 1
          counters.set(key, next)
          rankById.set(id, next)
        }
        this.document.ideas = this.document.ideas.map(idea => ({
          ...idea,
          rank: rankById.get(idea.id) ?? idea.rank,
        }))
        break
      }
      case 'import': {
        if (this.document.importedSources.includes(action.sourceId)) return { state: this.snapshot() }
        const merged = new Map(this.document.ideas.map(idea => [idea.id, idea]))
        let maxImportedNumber = 0
        for (const idea of parseHostIdeas(action.ideas)) {
          if (typeof idea.ideaNumber === 'number' && idea.ideaNumber > maxImportedNumber) {
            maxImportedNumber = idea.ideaNumber
          }
          merged.set(idea.id, merged.has(idea.id)
            ? { ...merged.get(idea.id)!, ...idea, updatedAt: now }
            : idea)
        }
        this.document.ideas = [...merged.values()]
        // An import may carry ideaNumbers (storage migration, resync from another
        // host): keep the sequence past the largest imported number so the next
        // create never re-issues a number already in use.
        if (maxImportedNumber > this.document.ideaSequence) {
          this.document.ideaSequence = maxImportedNumber
        }
        this.document.importedSources = [...this.document.importedSources, action.sourceId]
        break
      }
      case 'export':
        return { state: this.snapshot(), export: buildIdeasExport(this.document.ideas, action.workspaceId) }
    }
    if (this.document.ideas !== beforeIdeas) this.commit()
    return { state: this.snapshot() }
  }

  // --- persistence ----------------------------------------------------------

  private acquireLock(): void {
    mkdirSync(this.dir, { recursive: true })
    const candidate: LockRecord = { token: this.lockToken, pid: process.pid, startedAt: this.now() }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // mkdir is the atomic + exclusive create primitive (works with the
        // path-based fs surface on every platform).
        mkdirSync(this.lockDir)
        try {
          writeFileSync(this.lockOwnerFile, `${JSON.stringify(candidate)}\n`)
        } catch {
          // The lock is held even if the owner marker cannot be written; the
          // liveness probe below then treats an unreadable marker as stale.
        }
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = this.readLockOwner()
        const pid = typeof owner?.pid === 'number' ? owner.pid : undefined
        if (pid !== undefined && processIsAlive(pid)) {
          throw new Error(`ideas ledger is already owned by process ${pid}; if this PID was reused after a crash and no other DSH host is running, remove ${this.lockDir} manually and retry`)
        }
        // Stale (dead owner, unreadable marker, or PID-table reuse): take over.
        try { unlinkSync(this.lockOwnerFile) } catch { }
        try { rmdirSync(this.lockDir) } catch { }
      }
    }
    throw new Error(`ideas ledger lock could not be acquired: ${this.lockDir}`)
  }

  private readLockOwner(): Partial<LockRecord> | undefined {
    try {
      return JSON.parse(readFileSync(this.lockOwnerFile, 'utf8')) as Partial<LockRecord>
    } catch {
      return undefined
    }
  }

  private releaseLock(): void {
    try {
      if (!existsSync(this.lockDir)) return
      const owner = this.readLockOwner()
      if (owner === undefined || owner.token === this.lockToken) {
        try { unlinkSync(this.lockOwnerFile) } catch { }
        try { rmdirSync(this.lockDir) } catch { }
      }
    } catch {
      // A missing or externally replaced lock must not block disposal.
    }
  }

  private load(): LedgerDocument {
    const existed = existsSync(this.file)
    let parsed: ParsedLedgerDocument
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ParsedLedgerDocument
    } catch (error) {
      return this.recoverCorrupt(existed, error)
    }
    try {
      if (parsed.schemaVersion !== IDEAS_SCHEMA_VERSION || !Array.isArray(parsed.ideas)) {
        throw new Error('unsupported ledger schema')
      }
      return this.normalizeDocument(parsed)
    } catch (error) {
      return this.recoverCorrupt(existed, error)
    }
  }

  private normalizeDocument(parsed: ParsedLedgerDocument): LedgerDocument {
    return {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: Number.isSafeInteger(parsed.revision) && (parsed.revision ?? -1) >= 0 ? parsed.revision as number : 0,
      ideas: parseHostIdeas(Array.isArray(parsed.ideas) ? parsed.ideas : []),
      ideaSequence: Number.isSafeInteger(parsed.ideaSequence) && (parsed.ideaSequence ?? -1) >= 0
        ? parsed.ideaSequence as number
        : 0,
      importedSources: Array.isArray(parsed.importedSources)
        ? parsed.importedSources.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
        : [],
      recentRequests: Array.isArray(parsed.recentRequests)
        ? parsed.recentRequests.flatMap((entry): PersistedRequest[] => {
            if (typeof entry !== 'object' || entry === null) return []
            const request = entry as { requestId?: unknown; fingerprint?: unknown }
            return typeof request.requestId === 'string' && request.requestId !== '' && typeof request.fingerprint === 'string'
              ? [{ requestId: request.requestId, fingerprint: request.fingerprint }]
              : []
          }).slice(-MAX_REQUEST_CACHE)
        : [],
    }
  }

  /** Quarantine an unreadable document and start from an empty ledger. */
  private recoverCorrupt(existed: boolean, error: unknown): LedgerDocument {
    if (existed) {
      const quarantineName = `${this.file}.corrupt-${this.now()}-${process.pid}-${randomUUID()}`
      try { renameSync(this.file, quarantineName) } catch {
        // Quarantine is best effort; an empty ledger still starts below.
      }
    }
    const document: LedgerDocument = {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 0,
      ideas: [],
      importedSources: [],
      recentRequests: [],
      ideaSequence: 0,
    }
    try {
      this.writeAtomic(document)
    } catch {
      // A write failure must not hide the startup error below.
    }
    console.error(`[dsh-plugin-ideas-manager] corrupt ideas ledger was quarantined: ${error instanceof Error ? error.message : String(error)}`)
    return document
  }

  /**
   * Atomic tmp+rename write; the tmp path never survives a successful commit.
   *
   * Windows fallback: a transient EPERM on `renameSync` (an AV scanner or an
   * indexer holding the destination for a few ms) would otherwise fail the
   * user's whole action with a 400. When the rename fails we write the very
   * same bytes straight to the final file and drop the tmp - the same
   * mitigation the settings store already applies (host-settings.persist,
   * "Windows EPERM rename flake"). The window without atomicity is one write
   * on a file the single-writer lock already protects, and the reader
   * quarantines an unparsable document on the next boot if the process dies
   * mid-write - the discipline the whole file system relies on.
   */
  private writeAtomic(document: LedgerDocument): void {
    const tmpFile = `${this.file}.tmp-${process.pid}`
    const text = `${JSON.stringify(document, null, 2)}\n`
    writeFileSync(tmpFile, text)
    try {
      renameSync(tmpFile, this.file)
    } catch {
      try {
        writeFileSync(this.file, text)
      } finally {
        try { unlinkSync(tmpFile) } catch { /* best effort */ }
      }
    }
  }

  /** Persist a mutation and its request-cache snapshot in one atomic write. */
  private commit(): void {
    this.document.revision += 1
    this.document.recentRequests = [...this.requestCache].map(([requestId, fingerprint]) => ({
      requestId,
      fingerprint,
    })).slice(-MAX_REQUEST_CACHE)
    this.writeAtomic(this.document)
    // Re-parse so later mutations start from the same plain values they read.
    this.document = JSON.parse(JSON.stringify(this.document)) as LedgerDocument
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Apply one update patch to an idea (a null `tags` clears the label set). */
function applyPatch(idea: IdeaRecord, patch: IdeaUpdatePatch, now: number): IdeaRecord {
  const next: IdeaRecord = { ...idea, updatedAt: now }
  if (patch.title !== undefined && patch.title !== null) next.title = patch.title.trim()
  if (patch.body !== undefined && patch.body !== null) next.body = patch.body.trim()
  // A present summary (string or null) REPLACES the stored value: blank/null
  // clears it, anything else is trimmed and capped at the 300-char contract.
  if (patch.summary !== undefined) {
    next.summary = patch.summary === null ? undefined : normalizeSummary(patch.summary)
  }
  if (patch.workspaceId !== undefined && patch.workspaceId !== null) {
    const workspaceId = patch.workspaceId.trim()
    next.workspaceId = workspaceId === '' ? undefined : workspaceId
  } else if (patch.workspaceId === null) {
    next.workspaceId = undefined
  }
  if (patch.rank !== undefined) next.rank = patch.rank
  if (patch.value !== undefined) next.value = patch.value
  if (patch.effort !== undefined) next.effort = patch.effort
  if (patch.rationale !== undefined) {
    const rationale = patch.rationale.trim()
    next.rationale = rationale === '' ? undefined : rationale
  }
  if (patch.tags !== undefined) {
    next.tags = patch.tags === null ? undefined : normalizeTags(patch.tags)
  }
  return next
}

/** Trim to undefined when blank (the wire keeps rationale/decision optional). */
function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Helper of `apply`: rank-sorted rows (unranked last). */
function rankOrdered(ideas: readonly IdeaRecord[]): IdeaRecord[] {
  return [...ideas].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
}

/**
 * New rank order of the MOVED IDEA'S OWN WORKSPACE GROUP after inserting
 * `movedId` at `rank` (1-based) inside the open ideas of that group; a missing
 * rank appends. Only the group's ids are returned: the triage caller maps
 * `rankById` over the whole document and keeps every other group's rank
 * untouched (`?? item.rank`). Other workspace groups and the closed columns
 * are never re-ranked by a triage.
 */
function triageOrderedIds(
  ideas: readonly IdeaRecord[],
  movedId: string,
  rank: number | undefined,
): string[] {
  const moved = ideas.find(idea => idea.id === movedId)
  if (moved === undefined) return []
  const groupKey = rankGroupKey('open', moved.workspaceId)
  const openOthers = rankOrdered(ideas.filter(idea =>
    idea.status === 'open'
    && idea.id !== movedId
    && rankGroupKey('open', idea.workspaceId) === groupKey)).map(idea => idea.id)
  const maxRank = openOthers.length + 1
  const position = rank === undefined ? maxRank : Math.min(Math.max(1, Math.trunc(rank)), maxRank)
  openOthers.splice(position - 1, 0, movedId)
  return openOthers
}