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
/** Directory under the DSH home holding user-installed skills (user-dsh root). */
export declare const DSH_SKILLS_DIR = "skills";
/** Outcome of one installation attempt. */
export interface SkillInstallOutcome {
    /** Absolute path of the installed (or kept) SKILL.md. */
    path: string;
    /** Whether the bundled content is now the file's content. */
    synced: boolean;
    /** created | kept-existing | matched */
    status: 'created' | 'kept-existing' | 'matched';
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
 * Install the bundled ideas-analyst skill (best-effort, first-wins).
 * @param options - `home` DSH home override; `log` journaling seam.
 * @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
 */
export declare function installIdeasAnalystSkill(options?: {
    home?: string;
    log?: SkillInstallLog;
}): SkillInstallOutcome;
