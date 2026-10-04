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
/** Directory under the DSH home holding user-installed skills (user-dsh root). */
export declare const DSH_SKILLS_DIR = "skills";
/** Suffix of the kept copies of a replaced prompt. */
export declare const SKILL_BACKUP_SUFFIX = ".bak";
/** How many replaced prompts are kept beside the current one. */
export declare const SKILL_BACKUPS_KEPT = 5;
/** Outcome of one installation attempt. */
export interface SkillInstallOutcome {
    /** Absolute path of the installed (or kept) SKILL.md. */
    path: string;
    /** Whether the bundled content is now the file's content. */
    synced: boolean;
    /** created | upgraded | matched | kept-existing */
    status: 'created' | 'upgraded' | 'matched' | 'kept-existing';
    /** Where the replaced prompt was kept, when one was (an upgrade). */
    backup?: string;
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
 * Install the bundled ideas-analyst skill (always the bundled prompt; the
 * replaced file is kept beside it).
 * @param options - `home` DSH home override; `log` journaling seam;
 *   `now` clock seam for the backup stamp.
 * @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
 */
export declare function installIdeasAnalystSkill(options?: {
    home?: string;
    log?: SkillInstallLog;
    now?: Date;
}): SkillInstallOutcome;
