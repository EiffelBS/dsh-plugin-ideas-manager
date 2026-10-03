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

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { IdeasSnapshotReason as SnapshotReason } from './protocol.ts'

/** Folder holding the snapshots, relative to the ledger folder. */
export const IDEAS_BACKUP_DIR_NAME = 'backups'

/** Suffix every plugin-written snapshot (and quarantine) carries. */
export const SNAPSHOT_SUFFIX = '.json'

/**
 * Why a snapshot exists. It rides the file name (so the list can be built
 * without parsing a single file) and the in-document stamp (so a copy that
 * travelled to another machine still says what it is).
 *
 * Spelled in `protocol.ts` and imported TYPE-ONLY: this module reaches for
 * `node:fs`, and `protocol.ts` is the one module the browser bundle also loads,
 * so a value import here would pull the filesystem into the panel.
 */
export type { IdeasSnapshotReason as SnapshotReason } from './protocol.ts'

const REASON_STEMS: Record<SnapshotReason, string> = {
  manual: 'snapshot',
  export: 'export',
  'pre-restore': 'displaced',
}

/**
 * How many plugin-written snapshots are kept. The policy is explicit and
 * deliberately small: a snapshot is a safety net for "what did my board look
 * like an hour ago", not an archive. Files the USER dropped in the folder are
 * never pruned (see {@link IdeasBackupStore.prune}).
 */
export const IDEAS_SNAPSHOT_RETENTION = 10

/** One file of the backup folder, as the list reports it. */
export interface SnapshotFile {
  /** File name inside the backup folder (the only accepted selector). */
  name: string
  /** Absolute path, for diagnostics and the download route. */
  path: string
  /** Size in bytes on disk. */
  bytes: number
  /** Last modification time (epoch ms). */
  modifiedAt: number
  /** Stamp the name carries, or 'manual' for a file the plugin did not write. */
  reason: SnapshotReason
  /** Creation time carried by the name, or the mtime for a foreign file. */
  createdAt: number
  /** False for a file this plugin did not write (never pruned, never renamed). */
  managed: boolean
}

/** Result of reading one snapshot back. */
export type SnapshotRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'not-found' | 'unreadable' | 'invalid-name' }

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/

/**
 * Whether a caller-supplied name is an acceptable selector. Bounded, ASCII,
 * rooted: a name can never escape the folder or name a directory. A leading dot
 * is refused so `..` and dotfiles are out by construction.
 */
export function isSnapshotName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes('..')
}

/** File name of one snapshot: `<reason>-<epoch ms>-<8 hex>.json`. */
export function snapshotFileName(reason: SnapshotReason, at: number): string {
  const stamp = String(Math.trunc(at))
  const unique = randomUUID().replace(/-/g, '').slice(0, 8)
  return `${REASON_STEMS[reason]}-${stamp}-${unique}${SNAPSHOT_SUFFIX}`
}

/** Decode a plugin-written name back into its reason and timestamp. */
function readSnapshotName(name: string): { reason: SnapshotReason; createdAt: number } | undefined {
  const stem = name.slice(0, -SNAPSHOT_SUFFIX.length)
  const parts = stem.split('-')
  if (parts.length !== 3) return undefined
  const [reasonStem, stamp, unique] = parts as [string, string, string]
  const reason = (Object.keys(REASON_STEMS) as SnapshotReason[]).find(candidate => REASON_STEMS[candidate] === reasonStem)
  if (reason === undefined) return undefined
  if (!/^[0-9]{10,17}$/.test(stamp) || !/^[0-9a-f]{1,8}$/.test(unique)) return undefined
  return { reason, createdAt: Number(stamp) }
}

export class IdeasBackupStore {
  /** Absolute path of the backup folder. */
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * Every restorable file in the folder, newest first. Nothing is parsed: the
   * plugin-written name carries the reason and the timestamp, and a file the
   * plugin did not write (an export dropped in by hand — a supported way in)
   * falls back to its mtime.
   */
  list(): SnapshotFile[] {
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }
    const files: SnapshotFile[] = []
    for (const name of entries) {
      if (!isSnapshotName(name)) continue
      const path = join(this.dir, name)
      try {
        const stats = statSync(path)
        if (!stats.isFile()) continue
        const stamp = readSnapshotName(name)
        files.push({
          name,
          path,
          bytes: stats.size,
          modifiedAt: stats.mtimeMs,
          reason: stamp?.reason ?? 'manual',
          createdAt: stamp?.createdAt ?? stats.mtimeMs,
          managed: stamp !== undefined,
        })
      } catch {
        // Vanished between readdir and stat (a restore prune): not a listing.
      }
    }
    return files.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name))
  }

  /** Absolute path of one snapshot, or undefined when the name is not usable. */
  pathOf(name: string): string | undefined {
    return isSnapshotName(name) ? join(this.dir, name) : undefined
  }

  /**
   * Write one snapshot atomically and return it. The folder is created on
   * demand: a first snapshot on a fresh install is a normal event, not an
   * error, and the folder must not exist just to prove the plugin booted.
   */
  write(text: string, reason: SnapshotReason, at: number): SnapshotFile {
    mkdirSync(this.dir, { recursive: true })
    const name = snapshotFileName(reason, at)
    writeFileAtomic(join(this.dir, name), text)
    const stats = statSync(join(this.dir, name))
    return {
      name,
      path: join(this.dir, name),
      bytes: stats.size,
      modifiedAt: stats.mtimeMs,
      reason,
      createdAt: at,
      managed: true,
    }
  }

  /** Read one snapshot back as text; never throws. */
  read(name: string): SnapshotRead {
    const path = this.pathOf(name)
    if (path === undefined) return { ok: false, reason: 'invalid-name' }
    try {
      return { ok: true, text: readFileSync(path, 'utf8') }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR') return { ok: false, reason: 'not-found' }
      return { ok: false, reason: 'unreadable' }
    }
  }

  /**
   * Move an unusable snapshot beside itself (`<name>.corrupt-<stamp>`), the
   * ledger's quarantine discipline: evidence is kept, the bad file is never
   * offered again. A file this plugin did not write is NOT renamed — a foreign
   * export is the user's file, and moving it would be a surprise.
   *
   * @returns the quarantine path, or undefined when nothing was moved.
   */
  quarantine(file: SnapshotFile): string | undefined {
    if (!file.managed) return undefined
    const target = `${file.path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`
    try {
      renameSync(file.path, target)
      return target
    } catch {
      return undefined
    }
  }

  /**
   * Keep the newest {@link IDEAS_SNAPSHOT_RETENTION} snapshots this plugin
   * wrote and remove the older ones. Unmanaged files are NEVER touched: a user
   * who dropped an exported ledger in this folder must not watch it disappear
   * because the retention count was reached.
   *
   * @returns how many files were removed.
   */
  prune(retention: number = IDEAS_SNAPSHOT_RETENTION): number {
    const managed = this.list().filter(file => file.managed)
    if (managed.length <= retention) return 0
    let removed = 0
    for (const file of managed.slice(retention)) {
      try {
        unlinkSync(file.path)
        removed += 1
      } catch {
        // A file we cannot remove (locked by an indexer) is not worth failing a
        // snapshot the user just took over.
      }
    }
    return removed
  }

  /** Whether the folder exists at all (a fresh install has none until needed). */
  exists(): boolean {
    return existsSync(this.dir)
  }
}

/**
 * Atomic tmp+rename commit (the ledger's own discipline, see this module's
 * header). The tmp path never survives a successful write; on the transient
 * Windows EPERM rename flake the same bytes go straight to the destination.
 */
export function writeFileAtomic(file: string, text: string): void {
  const tmpFile = `${file}.tmp-${process.pid}`
  writeFileSync(tmpFile, text)
  try {
    renameSync(tmpFile, file)
  } catch {
    try {
      writeFileSync(file, text)
    } finally {
      try { unlinkSync(tmpFile) } catch { /* best effort */ }
    }
  }
}