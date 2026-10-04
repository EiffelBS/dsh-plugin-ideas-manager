/**
 * Skill installation for the ideas Host half (Phase 3 refinement): on
 * activation the plugin installs the `ideas-analyst` skill as a real file at
 * `<dshHome>/skills/ideas-analyst/SKILL.md` — the user-dsh skill root (rank
 * 400) that the dsh-skill-filesystem discoverer reads for EVERY session,
 * whatever the workspace/cwd. The launched Phase 3 session therefore finds
 * the skill in its catalog and loads it instead of receiving the full
 * methodology inline.
 *
 * **The bundled prompt always wins, and the previous file is never lost.** The
 * rules before it were both wrong in the same way — first-wins kept an
 * installation stranded on a months-old PROMPT after every upgrade, so the
 * features this plugin advertises went unused by the analyst with no symptom;
 * "upgrade only what we recognise" fixed that but needed a digest list to
 * maintain and still left the author with no way to get their text back.
 *
 * So: the file on disk is replaced, whatever it is, and a copy of what was
 * there is kept beside it (`SKILL.md.<stamp>.bak`, newest
 * {@link SKILL_BACKUPS_KEPT} kept) BEFORE the write. Nothing is destroyed, the
 * prompt in use is always the one this plugin ships, and restoring the author's
 * version is a file copy away — which the start-up log names, because silently
 * replacing a hand-written file would be its own kind of dishonesty.
 *
 * Best-effort by design — a filesystem failure (e.g. a read-only home) must
 * never break plugin boot.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import {
  IDEAS_ANALYST_SKILL_CONTENT,
  IDEAS_ANALYST_SKILL_FILE,
  IDEAS_ANALYST_SKILL_NAME,
} from './skills/ideas-analyst.ts'

/** Directory under the DSH home holding user-installed skills (user-dsh root). */
export const DSH_SKILLS_DIR = 'skills'

/** Suffix of the kept copies of a replaced prompt. */
export const SKILL_BACKUP_SUFFIX = '.bak'

/** How many replaced prompts are kept beside the current one. */
export const SKILL_BACKUPS_KEPT = 5

/** Outcome of one installation attempt. */
export interface SkillInstallOutcome {
  /** Absolute path of the installed (or kept) SKILL.md. */
  path: string
  /** Whether the bundled content is now the file's content. */
  synced: boolean
  /** created | upgraded | matched | kept-existing */
  status: 'created' | 'upgraded' | 'matched' | 'kept-existing'
  /** Where the replaced prompt was kept, when one was (an upgrade). */
  backup?: string
}

/** Logging seam (defaults to the host console pattern used by the service). */
export type SkillInstallLog = (line: string) => void

/**
 * Default target directory for the installed skill: `<dshHome>/skills`.
 * @param home - DSH home override (test seam; default = the live home).
 */
export function skillRoot(home: string = dshHome()): string {
  return join(home, DSH_SKILLS_DIR)
}

/** Absolute SKILL.md path for the plugin-installed skill under `home`. */
export function installedSkillPath(home: string = dshHome()): string {
  return join(skillRoot(home), IDEAS_ANALYST_SKILL_NAME, IDEAS_ANALYST_SKILL_FILE)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `YYYYMMDD-HHMMSS` in local time: when a replaced prompt was seen. */
function stamp(at: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
}

/** The kept copies beside `target`, newest first. */
function existingBackups(target: string): string[] {
  const dir = dirname(target)
  const prefix = `${basename(target)}.`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter(name => name.startsWith(prefix) && name.endsWith(SKILL_BACKUP_SUFFIX))
    .map(name => join(dir, name))
    .sort((left, right) => {
      // The stamp is lexicographically ordered, so the file name is the order.
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs
      } catch {
        return right.localeCompare(left)
      }
    })
}

/**
 * Keep what is about to be replaced, and return where it now lives.
 *
 * Idempotent on content: a second install of the same previous version reuses
 * the copy already taken instead of littering the folder, and the retention
 * drops the oldest beyond {@link SKILL_BACKUPS_KEPT}.
 *
 * @returns the backup path, or undefined when the copy could not be kept (the
 *   caller still installs: a missing courtesy copy must not strand the prompt).
 */
function keepPrevious(target: string, previous: string, at: Date): string | undefined {
  const digest = sha256(previous)
  try {
    for (const path of existingBackups(target)) {
      if (sha256(readFileSync(path, 'utf8')) === digest) return path
    }
    const path = `${target}.${stamp(at)}${SKILL_BACKUP_SUFFIX}`
    writeFileSync(path, previous, 'utf8')
    // Retention: the few most recent kept copies survive; older ones go.
    for (const old of existingBackups(target).slice(SKILL_BACKUPS_KEPT)) {
      try {
        unlinkSync(old)
      } catch {
        // Nothing to do: an undeletable extra copy is not worth a failed boot.
      }
    }
    return path
  } catch {
    return undefined
  }
}

/**
 * Install the bundled ideas-analyst skill (always the bundled prompt; the
 * replaced file is kept beside it).
 * @param options - `home` DSH home override; `log` journaling seam;
 *   `now` clock seam for the backup stamp.
 * @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
 */
export function installIdeasAnalystSkill(options: {
  home?: string
  log?: SkillInstallLog
  now?: Date
} = {}): SkillInstallOutcome {
  const log = options.log ?? ((line: string): void => { console.log(`[dsh-plugin-ideas-manager] ${line}`) })
  const target = installedSkillPath(options.home)
  try {
    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8')
      if (existing === IDEAS_ANALYST_SKILL_CONTENT) return { path: target, synced: true, status: 'matched' }
      // Replace unconditionally: the prompt in use must be the one this plugin
      // ships. The author's text is kept first, and the log says where — a
      // silent overwrite of hand-written work would be its own dishonesty.
      const backup = keepPrevious(target, existing, options.now ?? new Date())
      writeFileSync(target, IDEAS_ANALYST_SKILL_CONTENT, 'utf8')
      log(
        `skill "${IDEAS_ANALYST_SKILL_NAME}" at ${target} was replaced by this version's prompt` +
        (backup === undefined
          ? ' (the previous copy could NOT be kept beside it)'
          : `; the previous copy is kept at ${backup} if you want it back`) + '.',
      )
      return { path: target, synced: true, status: 'upgraded', ...(backup === undefined ? {} : { backup }) }
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, IDEAS_ANALYST_SKILL_CONTENT, 'utf8')
    return { path: target, synced: true, status: 'created' }
  } catch (error) {
    log(
      `failed to install skill "${IDEAS_ANALYST_SKILL_NAME}" at ${target}: ` +
      `${error instanceof Error ? error.message : String(error)} (best-effort, launch prompt keeps an inline fallback)`,
    )
    return { path: target, synced: false, status: 'kept-existing' }
  }
}
