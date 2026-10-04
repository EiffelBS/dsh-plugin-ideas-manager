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
export declare const KNOWN_BUNDLED_DIGESTS: readonly string[];
/** Directory under the DSH home holding user-installed skills (user-dsh root). */
export declare const DSH_SKILLS_DIR = "skills";
/** Outcome of one installation attempt. */
export interface SkillInstallOutcome {
    /** Absolute path of the installed (or kept) SKILL.md. */
    path: string;
    /** Whether the bundled content is now the file's content. */
    synced: boolean;
    /** created | upgraded | matched | kept-existing */
    status: 'created' | 'upgraded' | 'matched' | 'kept-existing';
}
/** Logging seam (defaults to the host console pattern used by the service). */
export type SkillInstallLog = (line: string) => void;
/**
 * Default target directory for the installed skill: `<dshHome>/skills`.
 * @param home - DSH home override (test seam; default = the live home).
 */
export declare function skillRoot(home?: string): string;
/** Absolute SKILL.md path for the plugin-installed skill under `home`. */
export declare function installedSkillPath(home?: string): string;
/**
 * Install the bundled ideas-analyst skill (best-effort, upgrade-or-keep).
 * @param options - `home` DSH home override; `log` journaling seam;
 *   `knownDigests` test seam for the recognised-older-copies list.
 * @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
 */
export declare function installIdeasAnalystSkill(options?: {
    home?: string;
    log?: SkillInstallLog;
    knownDigests?: readonly string[];
}): SkillInstallOutcome;
