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
import { type IdeaRecord } from './core/ideas.ts';
import { type IdeasExport } from './export-markdown.ts';
import { IDEAS_SCHEMA_VERSION, type IdeasAction } from './protocol.ts';
export declare const IDEAS_LEDGER_DIR_NAME = "ideas";
export declare const IDEAS_LEDGER_FILE_NAME = "ledger-v2.json";
export declare const IDEAS_LOCK_FILE_NAME = "ledger-v2.lock";
/** Apply result: the post-commit state, plus the export payload when asked. */
export interface LedgerApplyResult {
    state: LedgerState;
    export?: IdeasExport;
    /**
     * True when the request id was already cached (a replay): nothing was
     * re-executed, so the caller must not re-run side effects such as the
     * TaskBoard mirror.
     */
    replayed?: boolean;
}
/** Read view of the ledger. */
export interface LedgerState {
    schemaVersion: typeof IDEAS_SCHEMA_VERSION;
    revision: number;
    ideas: IdeaRecord[];
}
export declare class IdeasHostLedger {
    private document;
    private readonly requestCache;
    private readonly listeners;
    private readonly now;
    private readonly dir;
    private readonly file;
    private readonly lockDir;
    private readonly lockOwnerFile;
    private readonly lockToken;
    private disposed;
    constructor(options?: {
        dir?: string;
        now?: () => number;
    });
    subscribe(listener: () => void): () => void;
    snapshot(): LedgerState;
    summary(): {
        revision: number;
    };
    dispose(): void;
    /**
     * Apply one action with request-id dedupe: the same requestId replayed with
     * the same action returns the current state without mutating. The cache is
     * persisted with every commit, so a Host restart cannot replay a mutation.
     */
    applyRequest(requestId: string, action: IdeasAction): LedgerApplyResult;
    /**
     * Host-internal association written only by the TaskBoard mirror: records
     * the mirrored card id on an idea. `taskBoardId` is a system field — the
     * protocol gate never accepts it from the wire — so this path bypasses
     * `applyRequest` while keeping the same commit + notify discipline (it
     * bumps the revision and re-parses the document like any mutation).
     * @returns true when the document changed and was committed.
     */
    bindTaskBoardId(ideaId: string, taskBoardId: string): boolean;
    private apply;
    private acquireLock;
    private readLockOwner;
    private releaseLock;
    private load;
    private normalizeDocument;
    /** Quarantine an unreadable document and start from an empty ledger. */
    private recoverCorrupt;
    /** Atomic tmp+rename write; the tmp path never survives a successful commit. */
    private writeAtomic;
    /** Persist a mutation and its request-cache snapshot in one atomic write. */
    private commit;
    private notify;
}
