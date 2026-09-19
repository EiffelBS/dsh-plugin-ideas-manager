/**
 * P1 Host ledger: the authoritative idea store persisted at
 * `~/.dsh/ideas/ledger-v2.json` (one shared ledger document; each idea may
 * carry a workspaceId — see HANDOVER §2.1).
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
import { createIdea, normalizeStatus, normalizeTags, withStatus, type IdeaRecord } from './core/ideas.ts'
import { dshHome } from './dsh-home.ts'
import { buildIdeasExport, type IdeasExport } from './export-markdown.ts'
import { IDEAS_SCHEMA_VERSION, type IdeaUpdatePatch, type IdeasAction } from './protocol.ts'

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
    if (typeof row.rank === 'number' && Number.isFinite(row.rank)) idea.rank = row.rank
    if (typeof row.value === 'number' && Number.isFinite(row.value)) idea.value = row.value
    if (typeof row.effort === 'number' && Number.isFinite(row.effort)) idea.effort = row.effort
    if (typeof row.rationale === 'string' && row.rationale.trim() !== '') idea.rationale = row.rationale.trim()
    if (typeof row.archivedAt === 'number') idea.archivedAt = row.archivedAt
    const workspaceId = typeof row.workspaceId === 'string' ? normalizeOptionalId(row.workspaceId) : undefined
    if (workspaceId !== undefined) idea.workspaceId = workspaceId
    const taskBoardId = typeof row.taskBoardId === 'string' ? normalizeOptionalId(row.taskBoardId) : undefined
    if (taskBoardId !== undefined) idea.taskBoardId = taskBoardId
    const tags = normalizeTags(row.tags)
    if (tags !== undefined) idea.tags = tags
    ideas.push(idea)
  }
  return ideas
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

  private apply(action: IdeasAction): LedgerApplyResult {
    const now = this.now()
    const beforeIdeas = this.document.ideas
    switch (action.kind) {
      case 'create': {
        if (this.document.ideas.some(idea => idea.id === action.id)) throw new Error('idea id already exists')
        const idea = createIdea(action.input, now, action.id)
        if (idea.title.trim() === '') throw new Error('title is required')
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
          this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
            ? { ...withStatus(item, 'declined', now), archivedAt: now }
            : item)
        }
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
      case 'reorder': {
        const present = new Set(this.document.ideas.map(idea => idea.id))
        const ordered = action.orderedIds.filter(id => present.has(id))
        const rankById = new Map(ordered.map((id, index) => [id, index + 1]))
        this.document.ideas = this.document.ideas.map(idea => ({
          ...idea,
          rank: rankById.get(idea.id) ?? idea.rank,
        }))
        break
      }
      case 'import': {
        if (this.document.importedSources.includes(action.sourceId)) return { state: this.snapshot() }
        const merged = new Map(this.document.ideas.map(idea => [idea.id, idea]))
        for (const idea of parseHostIdeas(action.ideas)) {
          merged.set(idea.id, merged.has(idea.id)
            ? { ...merged.get(idea.id)!, ...idea, updatedAt: now }
            : idea)
        }
        this.document.ideas = [...merged.values()]
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
    }
    try {
      this.writeAtomic(document)
    } catch {
      // A write failure must not hide the startup error below.
    }
    console.error(`[dsh-plugin-ideas-manager] corrupt ideas ledger was quarantined: ${error instanceof Error ? error.message : String(error)}`)
    return document
  }

  /** Atomic tmp+rename write; the tmp path never survives a successful commit. */
  private writeAtomic(document: LedgerDocument): void {
    const tmpFile = `${this.file}.tmp-${process.pid}`
    writeFileSync(tmpFile, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(tmpFile, this.file)
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
  if (patch.workspaceId !== undefined && patch.workspaceId !== null) {
    const workspaceId = patch.workspaceId.trim()
    next.workspaceId = workspaceId === '' ? undefined : workspaceId
  } else if (patch.workspaceId === null) {
    next.workspaceId = undefined
  }
  if (patch.rank !== undefined) next.rank = patch.rank
  if (patch.value !== undefined) next.value = patch.value
  if (patch.effort !== undefined) next.effort = patch.effort
  if (patch.tags !== undefined) {
    next.tags = patch.tags === null ? undefined : normalizeTags(patch.tags)
  }
  return next
}