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
import { appendIdeaEvent, createIdea, ideaEvent, ideaEventActor, IDEA_ACTOR_RUN, isIdeaRunStatus, MERGE_DECISION_MAX_LENGTH, mergedIdeaTags, normalizeDeliveryNote, normalizeIdeaEvents, normalizeStatus, normalizeSummary, normalizeTags, rankGroupKey, withStatus, type IdeaRecord, type IdeaRunStatus } from './core/ideas.ts'
import type { IdeasStatsSource } from './core/ideas-stats.ts'
import { IdeasBackupStore, IDEAS_BACKUP_DIR_NAME, type SnapshotFile, type SnapshotRead, type SnapshotReason } from './backup.ts'
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

/**
 * Activity-log provenance of one mutation (idea #92). `actor` is the explicit
 * override for a Host-written transition; when absent, `initiator` decides
 * (`human` with no initiator, `agent:<initiator>` otherwise).
 */
export interface IdeaActionAudit {
  /** Envelope initiator asserted by the caller, if any. */
  initiator?: string
  /** Explicit actor for a transition the Host itself writes. */
  actor?: 'human' | 'run'
}

/**
 * Where a restore takes its document from: a snapshot file of the backup folder
 * (the local case) or an inline document handed over by a caller (the portable
 * import). Both end in the SAME validation and the SAME adoption path — a
 * downloaded file is not a second-class document.
 */
export type LedgerRestoreSource = { name: string } | { document: string }

/** Outcome of {@link IdeasHostLedger.restore}. A refusal is never an exception. */
export type LedgerRestoreResult =
  | {
      ok: true
      /** Revision of the restored board (always above the one it replaced). */
      revision: number
      /** How many ideas the restored document holds. */
      ideas: number
      /** Label of what was restored (the file name, or the import). */
      source: string
      /** The displaced ledger, kept as a snapshot of its own. */
      displaced: SnapshotFile
    }
  | {
      ok: false
      /** Stable machine code (the HTTP layer maps it to a status). */
      reason: string
      /** Human sentence naming what is wrong and what was left alone. */
      message: string
      /** Ideas whose run is still in flight (run-in-flight refusals only). */
      running?: IdeaRecord[]
      /** Where a broken snapshot was moved aside, when the store could. */
      quarantined?: string
    }

/** Outcome of {@link IdeasHostLedger.takeSnapshot}. */
export interface LedgerSnapshotResult {
  snapshot: SnapshotFile
  /** How many ideas the snapshot holds. */
  ideas: number
  /** How many older snapshots the retention policy removed. */
  pruned: number
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

/**
 * Structural repair of ONE persisted idea row: `ok: false` carries the reason
 * it could not be repaired, which is what a strict reader (a restore) reports
 * instead of silently dropping the row.
 *
 * The repair is the same one the boot path has always applied — a hand-edited
 * document must not brick the board — and it is TOLERANT of unknown keys: a
 * record written by a later version keeps its extra fields harmless.
 */
function readIdeaRow(value: unknown): { ok: true; idea: IdeaRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not a JSON object' }
  }
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '') return { ok: false, reason: 'no id' }
  if (typeof row.title !== 'string' || row.title.trim() === '') return { ok: false, reason: 'no title' }
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
  const deliveryNote = normalizeDeliveryNote(typeof row.deliveryNote === 'string' ? row.deliveryNote : undefined)
  if (deliveryNote !== undefined) idea.deliveryNote = deliveryNote
  if (typeof row.followUpOfId === 'string' && row.followUpOfId.trim() !== '') idea.followUpOfId = row.followUpOfId.trim()
  const tags = normalizeTags(row.tags)
  if (tags !== undefined) idea.tags = tags
  if (typeof row.reanalyzeAt === 'number') idea.reanalyzeAt = row.reanalyzeAt
  const audit = auditOf(row.analysisAudit)
  if (audit !== undefined) idea.analysisAudit = audit
  // Activity log (idea #92). This line IS the schema migration: a document
  // written before the field existed simply has no `events` key, and the
  // first recorded verb creates it — no version bump, no rewrite, and a
  // document carrying a hand-edited or over-long log is repaired rather than
  // quarantined.
  const events = normalizeIdeaEvents(row.events)
  if (events !== undefined) idea.events = events
  return { ok: true, idea }
}

/** Lenient repair of a persisted idea list (mirrors the import repair): unusable rows are dropped. */
function parseHostIdeas(rows: readonly unknown[]): IdeaRecord[] {
  const ideas: IdeaRecord[] = []
  for (const value of rows) {
    const read = readIdeaRow(value)
    if (read.ok) ideas.push(read.idea)
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

/** Error text of an unknown throwable (refusals carry their own sentence). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** JSON.parse without the throw (a snapshot that is not JSON is a refusal). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Human reference of one idea: `#12 title`, the label the board itself uses. */
function ideaReference(idea: IdeaRecord): string {
  return idea.ideaNumber === undefined ? `"${idea.title}"` : `#${idea.ideaNumber} "${idea.title}"`
}

/** Strict validation of a candidate ledger document (the restore path). */
type LedgerValidation =
  | { ok: true; document: LedgerDocument }
  | { ok: false; reason: string; message: string }

/**
 * Validate a document a caller wants to ADOPT as the whole board.
 *
 * This is deliberately the opposite of the boot path. At boot an unreadable
 * ledger is quarantined and the board starts empty, because a broken board must
 * still open; a restore is a deliberate act with a good copy in hand, so the
 * only acceptable failure is a refusal that names what is wrong. Every check
 * below therefore refuses rather than repairs:
 *
 *  - the schema version must be the one this host reads (an unknown version
 *    means the file was written by a different plugin generation, and guessing
 *    would corrupt the board);
 *  - the shape of every counter/list the document carries is checked, because
 *    `normalizeDocument` silently drops what it does not understand — fine for a
 *    boot, silently lossy for an import;
 *  - **every** record must survive `readIdeaRow`. A document where 2 of 40 rows
 *    are unusable is a half-broken document, and adopting it would look like a
 *    successful restore of a smaller board;
 *  - two records sharing an id would collapse into one, so that is refused too.
 */
function validateLedgerDocument(parsed: unknown): LedgerValidation {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'snapshot-shape', message: 'the file is not a ledger document (expected a JSON object)' }
  }
  const row = parsed as Record<string, unknown>
  if (row.schemaVersion !== IDEAS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'snapshot-schema',
      message: typeof row.schemaVersion === 'number'
        ? `the file uses ledger schema ${String(row.schemaVersion)}, this version of the plugin reads schema ${String(IDEAS_SCHEMA_VERSION)}`
        : 'the file carries no ledger schema version, so it is not an ideas ledger document',
    }
  }
  if (!Array.isArray(row.ideas)) {
    return { ok: false, reason: 'snapshot-shape', message: 'the ledger document carries no idea list' }
  }
  for (const key of ['revision', 'ideaSequence'] as const) {
    const value = row[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      return { ok: false, reason: 'snapshot-shape', message: `the ledger document has an unreadable "${key}" counter` }
    }
  }
  if (row.importedSources !== undefined
      && (!Array.isArray(row.importedSources) || row.importedSources.some(entry => typeof entry !== 'string'))) {
    return { ok: false, reason: 'snapshot-shape', message: 'the ledger document has an unreadable import history' }
  }
  if (row.recentRequests !== undefined && !Array.isArray(row.recentRequests)) {
    return { ok: false, reason: 'snapshot-shape', message: 'the ledger document has an unreadable request history' }
  }
  const seen = new Set<string>()
  for (const [index, value] of row.ideas.entries()) {
    const read = readIdeaRow(value)
    if (!read.ok) {
      return {
        ok: false,
        reason: 'snapshot-records',
        message: `record ${index + 1} of ${row.ideas.length} is unusable (${read.reason}), so the whole file was refused`,
      }
    }
    if (seen.has(read.idea.id)) {
      return {
        ok: false,
        reason: 'snapshot-records',
        message: `two records share the id ${read.idea.id}, so the whole file was refused`,
      }
    }
    seen.add(read.idea.id)
  }
  return { ok: true, document: normalizeParsedDocument(row) }
}

/**
 * Repair a parsed document into the live shape. Lenient BY DESIGN: this is the
 * boot path, where a field a document does not carry must not stop the board
 * from opening. The restore path validates the same fields strictly first
 * (see {@link validateLedgerDocument}) so nothing is silently dropped there.
 */
function normalizeParsedDocument(parsed: ParsedLedgerDocument): LedgerDocument {
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
  /**
   * The snapshot folder, INSIDE the ledger folder so it can only ever be
   * reached through the ledger that owns the lock. It deliberately holds no
   * lock of its own: two writers would be worse than none, and the parent
   * ledger already refuses to boot a second Host on the same home.
   */
  private readonly backups: IdeasBackupStore
  private disposed = false

  constructor(options: { dir?: string; now?: () => number; backups?: IdeasBackupStore } = {}) {
    this.now = options.now ?? Date.now
    this.dir = options.dir ?? join(dshHome(), IDEAS_LEDGER_DIR_NAME)
    this.file = join(this.dir, IDEAS_LEDGER_FILE_NAME)
    this.lockDir = join(this.dir, IDEAS_LOCK_FILE_NAME)
    this.lockOwnerFile = join(this.lockDir, LOCK_OWNER_FILE)
    this.backups = options.backups ?? new IdeasBackupStore(join(this.dir, IDEAS_BACKUP_DIR_NAME))
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
   * Read-only view of the current document for a PURE aggregate (idea #110),
   * without the deep clone every other reader pays.
   *
   * The one exception to "every reader gets its own copy", and it exists
   * because the health aggregate reads nothing but counters: cloning a
   * megabyte-wide document to produce forty numbers is precisely the waste the
   * bounded view was written to avoid. Two rules keep it safe:
   *  - the document reference is captured ONCE, so the revision and the rows
   *    always come from the same revision (a commit replaces the document
   *    wholesale rather than mutating it, so the array cannot tear);
   *  - the rows are typed `readonly`, so the only consumer this seam has —
   *    `buildIdeasStats` — cannot write through it even by accident.
   *
   * A route that needs to MUTATE an idea must keep using `applyRequest`, which
   * is the only writer in the process.
   */
  statsSource(): IdeasStatsSource {
    const document = this.document
    return { revision: document.revision, ideas: document.ideas }
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

  // --- snapshots and restore (idea #95) --------------------------------------

  /** Absolute path of the snapshot folder (diagnostics; never a UI string). */
  backupDir(): string {
    return this.backups.dir
  }

  /** Snapshot folder listing, newest first. Never parses a file. */
  snapshots(): SnapshotFile[] {
    return this.backups.list()
  }

  /** One snapshot of the folder by name (undefined when it is not there). */
  snapshotFile(name: string): SnapshotFile | undefined {
    return this.backups.list().find(file => file.name === name)
  }

  /** Raw snapshot document for the download route; never throws. */
  readSnapshot(name: string): SnapshotRead {
    return this.backups.read(name)
  }

  /** Ideas whose execution is in flight (a restore refuses while any is). */
  runningIdeas(): IdeaRecord[] {
    return cloneIdeas(this.document.ideas.filter(idea => idea.runStatus === 'running'))
  }

  /**
   * Take a snapshot of the CURRENT document.
   *
   * Written through this instance on purpose: the single-writer lock is what
   * makes a snapshot trustworthy, and there is no supported way to produce one
   * beside a live ledger. The document is serialized from memory (never copied
   * off disk), so a snapshot can never catch the file mid-rename, and the
   * retention policy runs right after the write so the folder stays bounded.
   */
  takeSnapshot(reason: SnapshotReason = 'manual'): LedgerSnapshotResult {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const at = this.now()
    const snapshot = this.backups.write(this.serializeDocument(reason, at), reason, at)
    return { snapshot, ideas: this.document.ideas.length, pruned: this.backups.prune() }
  }

  /**
   * Restore the board from a snapshot (local file) or from a document handed
   * over in full (the portable import).
   *
   * The order of the checks IS the contract, and each step is there for a
   * reason a real restore got wrong in this project before it had a supported
   * escape hatch:
   *
   *  1. **A run in flight refuses the whole restore.** The Host polls that run
   *     and writes its settle onto an idea that may no longer exist; worse, the
   *     displaced board could be one the run then resurrects. The refusal names
   *     the ideas involved so the human knows what to wait for.
   *  2. **Validate strictly, then displace, then adopt.** The boot path is
   *     lenient (an unreadable live ledger is quarantined and the board starts
   *     empty) because a broken board must still open; a restore is the
   *     opposite case — half a document adopted as a whole board is worse than
   *     a refusal, so every record must survive the repair.
   *  3. **The displaced document is written BEFORE anything is replaced.** If
   *     that write fails, nothing is restored: "the board you have now" always
   *     exists somewhere, and the panel can always go back to it.
   *  4. **The revision only ever moves forward** (commit() bumps it) so the
   *     browser's 2.5 s poll cannot mistake the restored board for the one it
   *     already holds, and **the dedupe cache is NOT rewound**: replaying a
   *     request id must keep meaning "this already ran", even though the board
   *     it ran on is gone.
   */
  restore(source: LedgerRestoreSource): LedgerRestoreResult {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const running = this.document.ideas.filter(idea => idea.runStatus === 'running')
    if (running.length > 0) {
      return {
        ok: false,
        reason: 'restore-run-in-flight',
        message: `an execution is still running on ${running.map(idea => ideaReference(idea)).join(', ')}; wait for it to finish before restoring a snapshot`,
        running: cloneIdeas(running),
      }
    }

    let text: string
    let label: string
    let file: SnapshotFile | undefined
    if ('document' in source) {
      text = source.document
      label = 'the imported ledger'
    } else {
      label = source.name
      const read = this.backups.read(source.name)
      if (!read.ok) {
        return {
          ok: false,
          reason: `snapshot-${read.reason}`,
          message: read.reason === 'not-found'
            ? `there is no snapshot named ${source.name} in the backups folder`
            : `the snapshot ${source.name} could not be read (${read.reason.replace('-', ' ')})`,
        }
      }
      text = read.text
      file = this.backups.list().find(candidate => candidate.name === source.name)
    }

    const parsed = parseJson(text)
    const validated = parsed === undefined
      ? { ok: false as const, reason: 'snapshot-unreadable', message: 'the file is not readable JSON, so it was not restored' }
      : validateLedgerDocument(parsed)
    if (!validated.ok) {
      const quarantined = file === undefined ? undefined : this.backups.quarantine(file)
      return {
        ok: false,
        reason: validated.reason,
        // The quarantine PATH stays host-side (it is on the `quarantined`
        // field): a refusal sentence is rendered by the settings panel, and no
        // user-facing line of this plugin names a filesystem location.
        message: quarantined === undefined
          ? validated.message
          : `${validated.message}; the unusable file was moved aside, renamed beside itself for evidence`,
        ...(quarantined === undefined ? {} : { quarantined }),
      }
    }

    const at = this.now()
    let displaced: SnapshotFile
    try {
      displaced = this.backups.write(this.serializeDocument('pre-restore', at), 'pre-restore', at)
    } catch (error) {
      // The whole point of displacing first is that the current board survives
      // the restore. If it cannot be kept, nothing is replaced.
      return {
        ok: false,
        reason: 'restore-not-saved',
        message: `the current board could not be kept as a snapshot (${messageOf(error)}), so nothing was restored`,
      }
    }

    this.document = { ...validated.document, revision: this.document.revision }
    this.commit()
    return {
      ok: true,
      revision: this.document.revision,
      ideas: this.document.ideas.length,
      source: label,
      displaced,
    }
  }

  /**
   * Serialize the document exactly as it is persisted, plus the snapshot stamp
   * that says what the file is. The stamp is additive and ignored by the
   * validator, so a snapshot stays a faithful copy of the live document — the
   * same bytes an export moves between machines.
   */
  private serializeDocument(reason: SnapshotReason, at: number): string {
    const stamp = {
      version: 1 as const,
      createdAt: at,
      reason,
      ideas: this.document.ideas.length,
      revision: this.document.revision,
    }
    return `${JSON.stringify({ ...this.document, snapshot: stamp }, null, 2)}\n`
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
   *
   * `audit` is the activity-log provenance of this mutation (idea #92): the
   * asserted envelope initiator becomes `agent:<initiator>`, its absence means
   * `human`, and the explicit `run` override marks a transition the Host itself
   * writes (the launch settle opening the review gate). It is NOT part of the
   * dedupe fingerprint on purpose: replaying a request id re-records nothing.
   */
  applyRequest(requestId: string, action: IdeasAction, audit?: IdeaActionAudit): LedgerApplyResult {
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
      const result = this.apply(action, ideaEventActor(audit?.initiator, audit?.actor))
      result.state = this.snapshot()
      return result
    } catch (error) {
      this.requestCache.delete(requestId)
      throw error
    }
  }

  /**
   * Host-internal activity entry (idea #92): the transitions that never pass
   * through an action verb — a launch accepted, a run settled, a harvested
   * delivery note — are exactly the ones a reader most wants in the timeline.
   * Same system-field discipline as `bindTaskBoardId` and the same
   * no-op-on-unchanged rule, so an idle poll cannot churn the revision.
   *
   * @returns true when the document changed and was committed.
   */
  recordEvent(ideaId: string, verb: string, summary: string): boolean {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const entry = ideaEvent(this.now(), verb, IDEA_ACTOR_RUN, summary)
    if (entry.summary === '') return false
    const current = this.document.ideas.find(idea => idea.id === ideaId)
    if (current === undefined) return false
    this.document.ideas = this.document.ideas.map(idea => idea.id === ideaId
      ? { ...idea, events: appendIdeaEvent(idea.events, entry) }
      : idea)
    this.commit()
    return true
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

  /**
   * Host-internal DELIVERY NOTE of the latest finished run (idea #91): the
   * text harvested off the run at settle time, bounded to
   * {@link DELIVERY_NOTE_MAX_BYTES}. Same system-field discipline as
   * `bindTaskBoardId` (the wire gate never accepts `deliveryNote` from
   * `update`) and the same no-op-on-unchanged rule, so a re-harvest of the
   * same answer cannot churn the revision.
   *
   * `undefined` CLEARS the stamp, exactly like the run fields: the JSON
   * persist/clone drops the key entirely.
   *
   * @returns true when the document changed and was committed.
   */
  setDeliveryNote(ideaId: string, note: string | undefined): boolean {
    if (this.disposed) throw new Error('ideas ledger is disposed')
    const current = this.document.ideas.find(idea => idea.id === ideaId)
    if (current === undefined) return false
    const next = normalizeDeliveryNote(note)
    if (current.deliveryNote === next) return false
    this.document.ideas = this.document.ideas.map(idea => idea.id === ideaId ? { ...idea, deliveryNote: next } : idea)
    this.commit()
    return true
  }

  private apply(action: IdeasAction, actor: string): LedgerApplyResult {
    const now = this.now()
    const beforeIdeas = this.document.ideas
    // Activity entries this mutation will append (idea #92). Filled per case
    // and applied ONCE after the switch, so the log and the state change in
    // one commit and a no-op verb records nothing.
    const recorded: Array<{ ideaId: string; verb: string; summary: string }> = []
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
        recorded.push({
          ideaId: idea.id,
          verb: 'create',
          summary: `Captured as #${this.document.ideaSequence}${idea.workspaceId === undefined ? '' : ` in ${idea.workspaceId}`}${idea.rank === undefined ? '' : ` at rank ${idea.rank}`}`,
        })
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
        recorded.push({ ideaId: action.ideaId, verb: 'update', summary: describePatch(action.patch) })
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
        recorded.push({ ideaId: action.ideaId, verb: 'move', summary: `Moved ${idea.status} → ${action.status}` })
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
          recorded.push({
            ideaId: action.ideaId,
            verb: 'decline',
            summary: `Declined${decision === undefined ? '' : ` — ${decision}`}`,
          })
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
        recorded.push({ ideaId: action.ideaId, verb: 'deliver', summary: 'Delivered — accepted, archived and stamped' })
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
        // One entry on the triaged idea only: the re-rank shifts its neighbours'
        // positions, which is the triage's effect rather than an event in their
        // own timeline.
        const finalRank = ideas.find(item => item.id === action.ideaId)?.rank
        recorded.push({
          ideaId: action.ideaId,
          verb: 'triage',
          summary: `Priority opinion recorded${formatLevel('value', next.value)}${formatLevel('effort', next.effort)}${finalRank === undefined ? '' : ` · rank ${finalRank} in its workspace group`}`,
        })
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
        const parentNumber = parent.ideaNumber === undefined ? '' : `#${parent.ideaNumber}`
        recorded.push({ ideaId: parent.id, verb: 'review', summary: `Review asked for a follow-up — archived in favour of #${this.document.ideaSequence}` })
        recorded.push({ ideaId: childId, verb: 'create', summary: `Created as the follow-up of ${parentNumber === '' ? 'its parent' : parentNumber}` })
        break
      }
      case 'merge': {
        // The AI capture flow promises to "create or merge a duplicate"; this
        // is that merge. One commit, like followUp: the LOSER is folded into
        // the idea that SURVIVES and is archived with a decision note naming
        // it. Nothing here rewrites the survivor's content — a duplicate
        // contributes labels, lineage and position, never a second body.
        const loser = this.document.ideas.find(item => item.id === action.sourceId)
        if (loser === undefined) throw new Error('source idea not found')
        const survivor = this.document.ideas.find(item => item.id === action.targetId)
        if (survivor === undefined) throw new Error('target idea not found')
        if (loser.id === survivor.id) throw new Error('merge requires two distinct ideas')
        // Same workspace or refuse. A merge that silently re-homed an idea
        // would move work between projects behind the human's back, which is
        // exactly what the workspace scoping exists to prevent. The
        // workspace-less ideas are one generic group, as in rankGroupKey.
        if ((loser.workspaceId ?? '') !== (survivor.workspaceId ?? '')) {
          throw new Error('merge requires both ideas in the same workspace')
        }

        // Labels: survivor first, so a duplicate name keeps the survivor's own
        // promptPrefix — the loser's prompt line must not rewrite a card the
        // task-board runner already owns.
        const tags = mergedIdeaTags(survivor, loser)
        // Lineage: the survivor inherits the loser's place in a follow-up
        // chain when it has none of its own, and every child of the loser is
        // re-pointed at the survivor. Both guards below exist to keep the
        // chain acyclic — inheriting would otherwise let a survivor become
        // its own parent.
        const inheritedParent = survivor.followUpOfId !== undefined || loser.followUpOfId === undefined || loser.followUpOfId === survivor.id
          ? undefined
          : loser.followUpOfId
        const survivorLabel = survivor.ideaNumber === undefined
          ? survivor.title
          : `#${survivor.ideaNumber} ${survivor.title}`
        const decision = `Merged as a duplicate of ${survivorLabel}`.slice(0, MERGE_DECISION_MAX_LENGTH)

        this.document.ideas = this.document.ideas.map(item => {
          if (item.id === survivor.id) {
            // Spread, never a reconstruction: `runStatus`, `runSessionId` and
            // `taskBoardId` are runner-owned system fields and this verb does
            // not touch them. A bound card is the task-board's, and the run
            // poll owns the stamps — a merge that reset either would orphan a
            // run the Host is still watching.
            return {
              ...item,
              ...(tags === undefined ? {} : { tags }),
              ...(inheritedParent === undefined ? {} : { followUpOfId: inheritedParent }),
              updatedAt: now,
            }
          }
          if (item.id === loser.id) {
            // The loser's own run stamps survive on the archived row exactly
            // as they are: a run that already settled on this idea still
            // reports its outcome on the card the human can restore.
            return { ...item, status: 'archived', archivedAt: now, decision, updatedAt: now }
          }
          if (item.followUpOfId === loser.id) return { ...item, followUpOfId: survivor.id, updatedAt: now }
          return item
        })

        // Rank, after the archive: `triageOrderedIds` re-numbers the SURVIVOR's
        // own open workspace group, and the loser has already left that group,
        // so a `takeSourceRank` merge cannot re-admit the idea it just retired.
        // An unranked loser has no position to give, so the mode degrades to
        // keeping the survivor's rank rather than demoting it to the bottom.
        if (action.mode === 'takeSourceRank' && survivor.status === 'open' && loser.rank !== undefined) {
          const ordered = triageOrderedIds(this.document.ideas, survivor.id, loser.rank)
          const rankById = new Map(ordered.map((id, index) => [id, index + 1]))
          this.document.ideas = this.document.ideas.map(item => ({
            ...item,
            rank: rankById.get(item.id) ?? item.rank,
          }))
        }

        const survivorRef = survivor.ideaNumber === undefined ? 'the surviving idea' : `#${survivor.ideaNumber}`
        const loserRef = loser.ideaNumber === undefined ? 'another idea' : `#${loser.ideaNumber}`
        recorded.push({ ideaId: loser.id, verb: 'merge', summary: `Merged into ${survivorRef} — archived as a duplicate` })
        recorded.push({
          ideaId: survivor.id,
          verb: 'merge',
          summary: `Took in ${loserRef} as a duplicate${action.mode === 'takeSourceRank' ? ', re-ranked at its position' : ''}`,
        })
        // Deliberately silent for the re-pointed children: they keep their
        // body and their status, and only their parent pointer moves — the
        // same reasoning that keeps `reorder` out of the log.
        break
      }
      case 'restore': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (idea.status === 'open') break
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? { ...withStatus(item, 'open', now), archivedAt: undefined }
          : item)
        recorded.push({ ideaId: action.ideaId, verb: 'restore', summary: `Restored from ${idea.status} to the open backlog` })
        break
      }
      case 'delete': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        this.document.ideas = this.document.ideas.filter(item => item.id !== action.ideaId)
        // No activity entry: the row that would carry it is the row being
        // removed. A delete is not an edit of an idea's life, it ends it.
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
        recorded.push({ ideaId: action.ideaId, verb: 'reanalyze', summary: 'AI re-analysis started — the previous analysis is kept' })
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
        // Deliberately silent: a reorder is a display re-ordering, it changes no
        // idea's content or state, and a drag would otherwise spend the bounded
        // log on noise.
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
        // Deliberately silent: the imported rows carry their own activity log,
        // and a source that predates the field simply has none. Recording an
        // "imported" line per row would bury that history and would double on a
        // merge that re-imports the same source with new content.
        break
      }
      case 'export':
        return { state: this.snapshot(), export: buildIdeasExport(this.document.ideas, action.workspaceId) }
    }
    if (recorded.length > 0) {
      const stamped = this.now()
      const byId = new Map(recorded.map(entry => [entry.ideaId, entry]))
      this.document.ideas = this.document.ideas.map(idea => {
        const entry = byId.get(idea.id)
        if (entry === undefined) return idea
        return {
          ...idea,
          events: appendIdeaEvent(idea.events, ideaEvent(stamped, entry.verb, actor, entry.summary)),
        }
      })
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
    return normalizeParsedDocument(parsed)
  }

  /**
   * Start from an empty ledger after a failed load.
   *
   * Two very different situations share this path and MUST NOT read the same in
   * the log: a document that existed and could not be parsed (something is wrong
   * and the file is set aside), and no document at all (the normal first boot of
   * a fresh install, where `readFileSync` throws ENOENT). Reporting the second as
   * "corrupt ledger quarantined" trains the reader to ignore the first, so the
   * genuinely alarming case arrives on a log full of harmless ones.
   */
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
    const reason = error instanceof Error ? error.message : String(error)
    if (existed) {
      console.error(`[dsh-plugin-ideas-manager] unreadable ideas ledger quarantined, starting empty: ${reason}`)
    } else {
      console.info(`[dsh-plugin-ideas-manager] no ideas ledger yet, created an empty one at ${this.file}`)
    }
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

/**
 * One-line summary of an `update` patch: the field names the caller actually
 * changed. Deliberately names fields, never values — a summary is a breadcrumb
 * back to the idea, and the timeline must never become a second copy of a body
 * (or quietly store the very content an update meant to replace).
 */
function describePatch(patch: IdeaUpdatePatch): string {
  const fields: string[] = []
  if (patch.title !== undefined && patch.title !== null) fields.push('title')
  if (patch.body !== undefined && patch.body !== null) fields.push('description')
  if (patch.summary !== undefined && patch.summary !== null) fields.push('summary')
  if (patch.tags !== undefined) fields.push(patch.tags === null ? 'tags cleared' : 'tags')
  if (patch.workspaceId !== undefined) fields.push('workspace')
  if (patch.value !== undefined) fields.push('value')
  if (patch.effort !== undefined) fields.push('effort')
  if (patch.rationale !== undefined) fields.push('rationale')
  if (patch.rank !== undefined) fields.push('rank')
  if (fields.length === 0) return 'Edited (no field changed)'
  return `Edited ${fields.join(', ')}`
}

/** Render one triage level, or nothing when the patch left it alone. */
function formatLevel(label: string, level: number | undefined): string {
  return level === undefined ? '' : ` · ${label} ${level}`
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