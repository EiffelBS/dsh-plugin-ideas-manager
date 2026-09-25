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
import { type IdeaRecord, type IdeaRunStatus } from './core/ideas.ts';
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
    /**
     * One idea, deep-cloned like a snapshot row (idea #34): the deferred-body
     * read GET /api/ideas/idea?id= clones a SINGLE record instead of paying
     * the whole-ledger snapshot clone for one card.
     */
    idea(id: string): IdeaRecord | undefined;
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
    /**
     * Host-internal mirrored-task STATUS (follow-up work): records the last
     * status observed by the under-review poll so a card whose TaskBoard task
     * failed can show a badge while the idea stays in the backlog. Same
     * system-field discipline as `bindTaskBoardId` (never accepted from the
     * idea verbs), same commit + notify, and a no-op when the observation did
     * not change (the 30 s poll must not churn the revision while idle).
     * @returns true when the document changed and was committed.
     */
    setTaskBoardStatus(ideaId: string, status: string | undefined): boolean;
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
    setRunStatus(ideaId: string, status: IdeaRunStatus | undefined): boolean;
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
    setRunSession(ideaId: string, sessionId: string | undefined): boolean;
    private apply;
    private acquireLock;
    private readLockOwner;
    private releaseLock;
    private load;
    private normalizeDocument;
    /** Quarantine an unreadable document and start from an empty ledger. */
    private recoverCorrupt;
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
    private writeAtomic;
    /** Persist a mutation and its request-cache snapshot in one atomic write. */
    private commit;
    private notify;
}
