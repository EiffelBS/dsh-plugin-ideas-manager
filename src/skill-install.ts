/**
 * Skill installation for the ideas Host half (Phase 3 refinement): on
 * activation the plugin installs the `ideas-analyst` skill as a real file at
 * `<dshHome>/skills/ideas-analyst/SKILL.md` — the user-dsh skill root (rank
 * 400) that the dsh-skill-filesystem discoverer reads for EVERY session,
 * whatever the workspace/cwd. The launched Phase 3 session therefore finds
 * the skill in its catalog and loads it instead of receiving the full
 * methodology inline.
 *
 * **An installed copy is UPGRADED, and only a hand-edited one is kept.** The
 * earlier rule was first-wins: never overwrite. That protected a hand-edited
 * skill and cost something much more expensive — an instance that installed an
 * older version kept running the older PROMPT after every upgrade, with no
 * symptom at all except the features this plugin advertises going unused by the
 * analyst (it did not know relations, it silently dropped tag promptPrefixes).
 * A feature the AI cannot use is not a feature.
 *
 * So the file on disk is classified by digest:
 *  - **absent** → install the bundled copy;
 *  - **identical to the bundled copy** → already current;
 *  - **matching a digest this plugin has shipped** → it is OUR old copy, so the
 *    upgrade replaces it (and says so);
 *  - **anything else** → the author edited it; it is kept, untouched, and a
 *    warning names the one command that adopts the plugin default.
 *
 * Best-effort by design — a filesystem failure (e.g. a read-only home) must
 * never break plugin boot.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import {
  IDEAS_ANALYST_SKILL_CONTENT,
  IDEAS_ANALYST_SKILL_FILE,
  IDEAS_ANALYST_SKILL_NAME,
} from './skills/ideas-analyst.ts'

/**
 * SHA-256 of every OLDER bundled copy this plugin has shipped, so an upgrade can
 * recognise its own past and replace it. Exported for the test that pins the
 * seeded entry.
 *
 * This list is the only manual bookkeeping in the install path, and it exists
 * because the alternative — overwriting unconditionally — destroys hand-written
 * skills. When a release changes `IDEAS_ANALYST_SKILL_CONTENT`, append that
 * release's digest here in the same commit (the CURRENT copy is hashed at
 * runtime and needs no entry). A machine that installed that release then
 * upgrades itself on the next start instead of staying on a months-old prompt.
 */
export const KNOWN_BUNDLED_DIGESTS: readonly string[] = [
  // 2026-09-23, the copy installed on every instance created before the
  // relations/promptPrefix work. Recognising it is the whole point.
  'a52ebd3ac0de29e5b029070762ff4f05761373e77ab8a9473168950990cf4880',
]

/** Directory under the DSH home holding user-installed skills (user-dsh root). */
export const DSH_SKILLS_DIR = 'skills'

/** Outcome of one installation attempt. */
export interface SkillInstallOutcome {
  /** Absolute path of the installed (or kept) SKILL.md. */
  path: string
  /** Whether the bundled content is now the file's content. */
  synced: boolean
  /** created | upgraded | matched | kept-existing */
  status: 'created' | 'upgraded' | 'matched' | 'kept-existing'
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

/** SHA-256 of the bundled copy, computed rather than listed (it must never drift). */
function bundledDigest(): string {
  return createHash('sha256').update(IDEAS_ANALYST_SKILL_CONTENT, 'utf8').digest('hex')
}

/**
 * Install the bundled ideas-analyst skill (best-effort, upgrade-or-keep).
 * @param options - `home` DSH home override; `log` journaling seam;
 *   `knownDigests` test seam for the recognised-older-copies list.
 * @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
 */
export function installIdeasAnalystSkill(options: {
  home?: string
  log?: SkillInstallLog
  knownDigests?: readonly string[]
} = {}): SkillInstallOutcome {
  const log = options.log ?? ((line: string): void => { console.log(`[dsh-plugin-ideas-manager] ${line}`) })
  const known = options.knownDigests ?? KNOWN_BUNDLED_DIGESTS
  const target = installedSkillPath(options.home)
  try {
    if (existsSync(target)) {
      // The file exists: is it OURS (an older bundled copy) or the author's?
      const existing = readFileSync(target, 'utf8')
      if (existing === IDEAS_ANALYST_SKILL_CONTENT) return { path: target, synced: true, status: 'matched' }
      const digest = createHash('sha256').update(existing, 'utf8').digest('hex')
      if (known.includes(digest) || digest === bundledDigest()) {
        // Our own past: an upgrade, not an author's work. Replacing it is the
        // whole point — otherwise the analyst runs a months-old prompt.
        writeFileSync(target, IDEAS_ANALYST_SKILL_CONTENT, 'utf8')
        log(`skill "${IDEAS_ANALYST_SKILL_NAME}" at ${target} was an older bundled copy; upgraded it to this version.`)
        return { path: target, synced: true, status: 'upgraded' }
      }
      // Anything else was edited by a human: it wins, and the warning says which
      // prompt is in use and how to give it up on purpose.
      const line =
        `skill "${IDEAS_ANALYST_SKILL_NAME}" exists at ${target} and was edited by hand ` +
        `(it matches no bundled version), so it is kept untouched — which means the analysis prompt in use ` +
        `is yours, NOT this plugin version. Delete the file and restart to adopt the bundled copy.`
      log(line)
      console.warn(`[dsh-plugin-ideas-manager] ${line}`)
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
