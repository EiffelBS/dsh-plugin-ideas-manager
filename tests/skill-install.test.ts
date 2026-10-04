/**
 * Skill-install tests: the Host installs the bundled ideas-analyst skill into
 * the user-dsh skill root (`<home>/skills/ideas-analyst/SKILL.md`) so any
 * analysing session discovers it.
 *
 * The policy is one line — **the bundled prompt always wins, and what it
 * replaces is kept** — because both earlier rules failed the same way: first-wins
 * stranded every installation on a months-old prompt, and "upgrade only what we
 * recognise" needed a digest list and still left the author no way back. So a
 * present, different file is replaced AND copied to `SKILL.md.<stamp>.bak` first,
 * and the log names where. Best-effort: failures return a kept-existing outcome
 * instead of throwing.
 */

import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installedSkillPath,
  installIdeasAnalystSkill,
  SKILL_BACKUPS_KEPT,
  SKILL_BACKUP_SUFFIX,
  skillRoot,
} from '../src/skill-install.ts'
import { IDEAS_ANALYST_SKILL_CONTENT, IDEAS_ANALYST_SKILL_NAME } from '../src/skills/ideas-analyst.ts'

/** A fixed clock, so the backup name is predictable. */
const AT = new Date(2026, 9, 4, 3, 30, 15)

let home: string

beforeEach(() => {
  home = join(tmpdir(), `ideas-skill-test-${process.pid}-${randomUUID()}`)
  mkdirSync(join(home, 'skills', IDEAS_ANALYST_SKILL_NAME), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Write a divergent prompt where the plugin installs its own. */
function installForeign(text: string): string {
  const target = installedSkillPath(home)
  writeFileSync(target, text, 'utf8')
  return target
}

/** The kept copies beside the installed file. */
function backups(): string[] {
  return readdirSync(join(skillRoot(home), IDEAS_ANALYST_SKILL_NAME))
    .filter(name => name.endsWith(SKILL_BACKUP_SUFFIX))
    .sort()
}

describe('installIdeasAnalystSkill', () => {
  it('writes the bundled skill to <home>/skills/ideas-analyst/SKILL.md', () => {
    const outcome = installIdeasAnalystSkill({ home })
    expect(outcome.status).toBe('created')
    expect(outcome.synced).toBe(true)
    expect(outcome.path).toBe(installedSkillPath(home))
    expect(skillRoot(home)).toBe(join(home, 'skills'))
    const target = installedSkillPath(home)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(IDEAS_ANALYST_SKILL_CONTENT)
    // Inside the SKILL.md the skill names itself and matches the directory.
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain(`name: ${IDEAS_ANALYST_SKILL_NAME}`)
  })

  it('frontmatter is discoverable: opens with ---, carries name/description/whenToUse as plain scalars', () => {
    // The skill-filesystem provider parses the file strictly as YAML and
    // silently drops a skill whose frontmatter does not parse (only a warning
    // is logged). Regression guard for the fix that kept `whenToUse` as a
    // plain scalar — opening with a quoted phrase then continuing with
    // unquoted text produced invalid YAML ("Unexpected scalar at node end")
    // and the skill never appeared in the catalog. Assert the structural
    // markers so a future edit does not reintroduce a quote-opened scalar.
    const lines = IDEAS_ANALYST_SKILL_CONTENT.split('\n')
    expect(lines[0]).toBe('---')
    const fm = lines.slice(1, lines.indexOf('---', 1)).join('\n')
    expect(fm).toContain('name: ideas-analyst')
    expect(fm).toContain('description: ')
    // `whenToUse:` value must not OPEN with a double quote (a quoted phrase
    // followed by unquoted text is invalid YAML; a plain scalar like
    // task-board/SKILL.md is what the discoverer accepts).
    const whenLine = fm.split('\n').find(line => line.startsWith('whenToUse:'))
    expect(whenLine).toBeTruthy()
    expect(/^whenToUse:\s*"/.test(whenLine!)).toBe(false)
  })

  it('is idempotent: a matching present file is kept as "matched"', () => {
    installIdeasAnalystSkill({ home })
    const again = installIdeasAnalystSkill({ home })
    expect(again.status).toBe('matched')
    expect(again.synced).toBe(true)
    expect(readFileSync(again.path, 'utf8')).toBe(IDEAS_ANALYST_SKILL_CONTENT)
    expect(backups()).toEqual([])
  })

  it('replaces a HAND-EDITED prompt and keeps it beside, naming where', () => {
    // The author's text is not the prompt that runs any more — that is the
    // point — but it is not destroyed either, and the log says where it went.
    const edits = '# my hand-edited analyst\n'
    installForeign(edits)
    const logged: string[] = []
    const outcome = installIdeasAnalystSkill({ home, log: (line) => { logged.push(line) }, now: AT })

    expect(outcome.status).toBe('upgraded')
    expect(outcome.synced).toBe(true)
    expect(readFileSync(installedSkillPath(home), 'utf8')).toBe(IDEAS_ANALYST_SKILL_CONTENT)
    expect(outcome.backup).toBeDefined()
    expect(readFileSync(outcome.backup!, 'utf8')).toBe(edits)
    expect(logged.some(line => line.includes('replaced by this version'))).toBe(true)
    expect(logged.some(line => line.includes('kept at'))).toBe(true)
  })

  it('replaces an OLD bundled prompt too — that is the case that used to strand an install', () => {
    const stale = '# an older bundled copy\n'
    installForeign(stale)
    const outcome = installIdeasAnalystSkill({ home, now: AT })
    expect(outcome.status).toBe('upgraded')
    expect(readFileSync(installedSkillPath(home), 'utf8')).toBe(IDEAS_ANALYST_SKILL_CONTENT)
    expect(readFileSync(outcome.backup!, 'utf8')).toBe(stale)
  })

  it('keeps the same previous copy once, however many times the install repeats', () => {
    // Every start re-reads the file; a backup per start would bury the folder
    // in identical copies and tell the human nothing.
    const stale = '# an older bundled copy\n'
    installForeign(stale)
    installIdeasAnalystSkill({ home, now: new Date(2026, 0, 1, 0, 0, 0) })
    installForeign(stale)
    const again = installIdeasAnalystSkill({ home, now: new Date(2026, 5, 5, 5, 5, 5) })
    expect(again.status).toBe('upgraded')
    expect(backups()).toHaveLength(1)
    expect(readFileSync(again.backup!, 'utf8')).toBe(stale)
  })

  it('bounds the kept copies', () => {
    for (let index = 0; index < SKILL_BACKUPS_KEPT + 3; index += 1) {
      installForeign(`# a distinct old prompt ${index}\n`)
      installIdeasAnalystSkill({ home, now: new Date(2026, 0, 1, 0, 0, index) })
    }
    expect(backups()).toHaveLength(SKILL_BACKUPS_KEPT)
    // The retained ones are the most recent prompts, not the oldest.
    const kept = backups().map(name => readFileSync(join(skillRoot(home), IDEAS_ANALYST_SKILL_NAME, name), 'utf8'))
    expect(kept.some(text => text.includes(`old prompt ${SKILL_BACKUPS_KEPT + 2}`))).toBe(true)
    expect(kept.some(text => text.includes('old prompt 0'))).toBe(false)
  })

  it('never throws: an unwritable home degrades to kept-existing', () => {
    // The whole home is a file, so the install cannot even create the folder.
    const asFile = join(tmpdir(), `ideas-skill-file-${process.pid}-${randomUUID()}`)
    try {
      writeFileSync(asFile, 'not a dir', 'utf8')
      const logged: string[] = []
      const outcome = installIdeasAnalystSkill({ home: asFile, log: (line) => { logged.push(line) } })
      expect(outcome.synced).toBe(false)
      expect(outcome.status).toBe('kept-existing')
      expect(logged.length).toBeGreaterThan(0)
    } finally {
      rmSync(asFile, { force: true })
    }
  })
})
