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
import type { IdeasStatsSource } from './core/ideas-stats.ts';
import { IdeasBackupStore, type SnapshotFile, type SnapshotRead, type SnapshotReason } from './backup.ts';
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
/**
 * Activity-log provenance of one mutation (idea #92). `actor` is the explicit
 * override for a Host-written transition; when absent, `initiator` decides
 * (`human` with no initiator, `agent:<initiator>` otherwise).
 */
export interface IdeaActionAudit {
    /** Envelope initiator asserted by the caller, if any. */
    initiator?: string;
    /** Explicit actor for a transition the Host itself writes. */
    actor?: 'human' | 'run';
}
/**
 * Where a restore takes its document from: a snapshot file of the backup folder
 * (the local case) or an inline document handed over by a caller (the portable
 * import). Both end in the SAME validation and the SAME adoption path — a
 * downloaded file is not a second-class document.
 */
export type LedgerRestoreSource = {
    name: string;
} | {
    document: string;
};
/** Outcome of {@link IdeasHostLedger.restore}. A refusal is never an exception. */
export type LedgerRestoreResult = {
    ok: true;
    /** Revision of the restored board (always above the one it replaced). */
    revision: number;
    /** How many ideas the restored document holds. */
    ideas: number;
    /** Label of what was restored (the file name, or the import). */
    source: string;
    /** The displaced ledger, kept as a snapshot of its own. */
    displaced: SnapshotFile;
    /**
     * Record keys the restored file carried that THIS build does not know
     * (empty in the normal case). They were not restored: the reader is a
     * whitelist, and a restore that quietly dropped data would be the one
     * failure a backup must never produce.
     */
    unknownFields: string[];
} | {
    ok: false;
    /** Stable machine code (the HTTP layer maps it to a status). */
    reason: string;
    /** Human sentence naming what is wrong and what was left alone. */
    message: string;
    /** Ideas whose run is still in flight (run-in-flight refusals only). */
    running?: IdeaRecord[];
    /** Where a broken snapshot was moved aside, when the store could. */
    quarantined?: string;
};
/** Outcome of {@link IdeasHostLedger.takeSnapshot}. */
export interface LedgerSnapshotResult {
    snapshot: SnapshotFile;
    /** How many ideas the snapshot holds. */
    ideas: number;
    /** How many older snapshots the retention policy removed. */
    pruned: number;
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
/**
 * Every key `readIdeaRow` copies off an incoming record.
 *
 * This literal is the forward-compatibility contract. The record reader is a
 * WHITELIST rebuild (it refuses to trust an arbitrary object), so a field a
 * build does not know is dropped — correctly, but silently, and that silence is
 * how a restore would quietly lose data written by a NEWER plugin. Two things
 * make it non-silent:
 *
 *  - anything present on the row and absent from this list is REPORTED (see
 *    `LedgerValidation.unknownFields`), so a partial restore always says what it
 *    did not carry; and
 *  - `tests/idea-95-backup.test.ts` asserts this list equals the key set of a
 *    fully populated record, so adding a field without naming it here breaks the
 *    suite instead of quietly surviving a release.
 *
 * Keep it in step with the reader, and treat a mismatch as a missing release
 * step — the ledger's field surface is what a backup is made of.
 */
export declare const KNOWN_IDEA_FIELDS: ReadonlySet<string>;
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
    /**
     * The snapshot folder, INSIDE the ledger folder so it can only ever be
     * reached through the ledger that owns the lock. It deliberately holds no
     * lock of its own: two writers would be worse than none, and the parent
     * ledger already refuses to boot a second Host on the same home.
     */
    private readonly backups;
    private disposed;
    constructor(options?: {
        dir?: string;
        now?: () => number;
        backups?: IdeasBackupStore;
    });
    subscribe(listener: () => void): () => void;
    snapshot(): LedgerState;
    summary(): {
        revision: number;
    };
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
    statsSource(): IdeasStatsSource;
    /**
     * One idea, deep-cloned like a snapshot row (idea #34): the deferred-body
     * read GET /api/ideas/idea?id= clones a SINGLE record instead of paying
     * the whole-ledger snapshot clone for one card.
     */
    idea(id: string): IdeaRecord | undefined;
    /** Absolute path of the snapshot folder (diagnostics; never a UI string). */
    backupDir(): string;
    /** Snapshot folder listing, newest first. Never parses a file. */
    snapshots(): SnapshotFile[];
    /** One snapshot of the folder by name (undefined when it is not there). */
    snapshotFile(name: string): SnapshotFile | undefined;
    /** Raw snapshot document for the download route; never throws. */
    readSnapshot(name: string): SnapshotRead;
    /** Ideas whose execution is in flight (a restore refuses while any is). */
    runningIdeas(): IdeaRecord[];
    /**
     * Take a snapshot of the CURRENT document.
     *
     * Written through this instance on purpose: the single-writer lock is what
     * makes a snapshot trustworthy, and there is no supported way to produce one
     * beside a live ledger. The document is serialized from memory (never copied
     * off disk), so a snapshot can never catch the file mid-rename, and the
     * retention policy runs right after the write so the folder stays bounded.
     */
    takeSnapshot(reason?: SnapshotReason): LedgerSnapshotResult;
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
    restore(source: LedgerRestoreSource): LedgerRestoreResult;
    /**
     * Serialize the document exactly as it is persisted, plus the snapshot stamp
     * that says what the file is. The stamp is additive and ignored by the
     * validator, so a snapshot stays a faithful copy of the live document — the
     * same bytes an export moves between machines.
     */
    private serializeDocument;
    dispose(): void;
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
    applyRequest(requestId: string, action: IdeasAction, audit?: IdeaActionAudit): LedgerApplyResult;
    /**
     * Host-internal activity entry (idea #92): the transitions that never pass
     * through an action verb — a launch accepted, a run settled, a harvested
     * delivery note — are exactly the ones a reader most wants in the timeline.
     * Same system-field discipline as `bindTaskBoardId` and the same
     * no-op-on-unchanged rule, so an idle poll cannot churn the revision.
     *
     * @returns true when the document changed and was committed.
     */
    recordEvent(ideaId: string, verb: string, summary: string): boolean;
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
    setDeliveryNote(ideaId: string, note: string | undefined): boolean;
    private apply;
    private acquireLock;
    private readLockOwner;
    private releaseLock;
    private load;
    private normalizeDocument;
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
