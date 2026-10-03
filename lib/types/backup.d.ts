/**
 * Snapshot folder of the ideas ledger: a plain, document-agnostic filesystem
 * store under `<DSH_HOME>/ideas/backups/`.
 *
 * This module knows NOTHING about the ledger document. It writes a text, lists
 * what is there, reads one back, renames a broken file aside, and prunes. The
 * document contract (schema version, record repair, what a restore adopts) lives
 * in `host-ledger.ts`, which owns the single-writer lock — a snapshot is only
 * ever written THROUGH the ledger, never beside a live ledger by hand.
 *
 * Three disciplines are copied from the ledger on purpose, and the reasons are
 * worth keeping:
 *  - **Atomic tmp+rename.** A snapshot half-written when the process dies is
 *    worse than no snapshot: it is a file a later restore would happily adopt.
 *  - **Quarantine, never delete.** An unreadable snapshot is renamed beside
 *    itself so the evidence survives and the same bad file is not offered twice.
 *  - **The Windows EPERM rename flake** falls back to a direct write. See
 *    `host-ledger.ts` for the full reasoning; this is a second copy rather than a
 *    shared helper because each caller's failure handling differs (the settings
 *    store must clean its tmp file and rethrow, this one is best effort).
 */
import type { IdeasSnapshotReason as SnapshotReason } from './protocol.ts';
/** Folder holding the snapshots, relative to the ledger folder. */
export declare const IDEAS_BACKUP_DIR_NAME = "backups";
/** Suffix every plugin-written snapshot (and quarantine) carries. */
export declare const SNAPSHOT_SUFFIX = ".json";
/**
 * Why a snapshot exists. It rides the file name (so the list can be built
 * without parsing a single file) and the in-document stamp (so a copy that
 * travelled to another machine still says what it is).
 *
 * Spelled in `protocol.ts` and imported TYPE-ONLY: this module reaches for
 * `node:fs`, and `protocol.ts` is the one module the browser bundle also loads,
 * so a value import here would pull the filesystem into the panel.
 */
export type { IdeasSnapshotReason as SnapshotReason } from './protocol.ts';
/**
 * How many plugin-written snapshots are kept. The policy is explicit and
 * deliberately small: a snapshot is a safety net for "what did my board look
 * like an hour ago", not an archive. Files the USER dropped in the folder are
 * never pruned (see {@link IdeasBackupStore.prune}).
 */
export declare const IDEAS_SNAPSHOT_RETENTION = 10;
/** One file of the backup folder, as the list reports it. */
export interface SnapshotFile {
    /** File name inside the backup folder (the only accepted selector). */
    name: string;
    /** Absolute path, for diagnostics and the download route. */
    path: string;
    /** Size in bytes on disk. */
    bytes: number;
    /** Last modification time (epoch ms). */
    modifiedAt: number;
    /** Stamp the name carries, or 'manual' for a file the plugin did not write. */
    reason: SnapshotReason;
    /** Creation time carried by the name, or the mtime for a foreign file. */
    createdAt: number;
    /** False for a file this plugin did not write (never pruned, never renamed). */
    managed: boolean;
}
/** Result of reading one snapshot back. */
export type SnapshotRead = {
    ok: true;
    text: string;
} | {
    ok: false;
    reason: 'not-found' | 'unreadable' | 'invalid-name';
};
/**
 * Whether a caller-supplied name is an acceptable selector. Bounded, ASCII,
 * rooted: a name can never escape the folder or name a directory. A leading dot
 * is refused so `..` and dotfiles are out by construction.
 */
export declare function isSnapshotName(name: string): boolean;
/** File name of one snapshot: `<reason>-<epoch ms>-<8 hex>.json`. */
export declare function snapshotFileName(reason: SnapshotReason, at: number): string;
export declare class IdeasBackupStore {
    /** Absolute path of the backup folder. */
    readonly dir: string;
    constructor(dir: string);
    /**
     * Every restorable file in the folder, newest first. Nothing is parsed: the
     * plugin-written name carries the reason and the timestamp, and a file the
     * plugin did not write (an export dropped in by hand — a supported way in)
     * falls back to its mtime.
     */
    list(): SnapshotFile[];
    /** Absolute path of one snapshot, or undefined when the name is not usable. */
    pathOf(name: string): string | undefined;
    /**
     * Write one snapshot atomically and return it. The folder is created on
     * demand: a first snapshot on a fresh install is a normal event, not an
     * error, and the folder must not exist just to prove the plugin booted.
     */
    write(text: string, reason: SnapshotReason, at: number): SnapshotFile;
    /** Read one snapshot back as text; never throws. */
    read(name: string): SnapshotRead;
    /**
     * Move an unusable snapshot beside itself (`<name>.corrupt-<stamp>`), the
     * ledger's quarantine discipline: evidence is kept, the bad file is never
     * offered again. A file this plugin did not write is NOT renamed — a foreign
     * export is the user's file, and moving it would be a surprise.
     *
     * @returns the quarantine path, or undefined when nothing was moved.
     */
    quarantine(file: SnapshotFile): string | undefined;
    /**
     * Keep the newest {@link IDEAS_SNAPSHOT_RETENTION} snapshots this plugin
     * wrote and remove the older ones. Unmanaged files are NEVER touched: a user
     * who dropped an exported ledger in this folder must not watch it disappear
     * because the retention count was reached.
     *
     * @returns how many files were removed.
     */
    prune(retention?: number): number;
    /** Whether the folder exists at all (a fresh install has none until needed). */
    exists(): boolean;
}
/**
 * Atomic tmp+rename commit (the ledger's own discipline, see this module's
 * header). The tmp path never survives a successful write; on the transient
 * Windows EPERM rename flake the same bytes go straight to the destination.
 */
export declare function writeFileAtomic(file: string, text: string): void;
