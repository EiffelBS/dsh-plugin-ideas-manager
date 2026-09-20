/**
 * Skill installation for the ideas Host half (Phase 3 refinement): on
 * activation the plugin installs the `ideas-analyst` skill as a real file at
 * `<dshHome>/skills/ideas-analyst/SKILL.md` — the user-dsh skill root (rank
 * 400) that the dsh-skill-filesystem discoverer reads for EVERY session,
 * whatever the workspace/cwd. The launched Phase 3 session therefore finds
 * the skill in its catalog and loads it instead of receiving the full
 * methodology inline.
 *
 * Installation is first-wins, mirroring the runtime registries' duplicate
 * rule: an existing SKILL.md is never overwritten (a hand-edited copy stays
 * the author's), only a missing file is written; a divergent present file is
 * logged so the author knows the plugin ships a newer default. Delete the
 * installed file to restore the bundled version. Best-effort by design — a
 * filesystem failure (e.g. a read-only home) must never break plugin boot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import {
  IDEAS_ANALYST_SKILL_CONTENT,
  IDEAS_ANALYST_SKILL_FILE,
  IDEAS_ANALYST_SKILL_NAME,
} from './skills/ideas-analyst.ts'

/** Directory under the DSH home holding user-installed skills (user-dsh root). */
export const DSH_SKILLS_DIR = 'skills'

/** Outcome of one installation attempt. */
export interface SkillInstallOutcome {
  /** Absolute path of the installed (or kept) SKILL.md. */
  path: string
  /** Whether the bundled content is now the file's content. */
  synced: boolean
  /** created | kept-existing | matched */
  status: 'created' | 'kept-existing' | 'matched'
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

/**
 * Install the bundled ideas-analyst skill (best-effort, first-wins).
 * @param options - `home` DSH home override; `log` journaling seam.
 * @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
 */
export function installIdeasAnalystSkill(options: {
  home?: string
  log?: SkillInstallLog
} = {}): SkillInstallOutcome {
  const log = options.log ?? ((line: string): void => { console.log(`[dsh-plugin-ideas-manager] ${line}`) })
  const target = installedSkillPath(options.home)
  try {
    if (existsSync(target)) {
      // The file already exists: first-wins — respect a hand-edited skill.
      const existing = readFileSync(target, 'utf8')
      if (existing === IDEAS_ANALYST_SKILL_CONTENT) return { path: target, synced: true, status: 'matched' }
      log(
        `skill "${IDEAS_ANALYST_SKILL_NAME}" exists at ${target} and differs from the bundled copy; ` +
        `keeping the present file (first-wins). Delete it to restore the plugin default.`,
      )
      return { path: target, synced: false, status: 'kept-existing' }
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