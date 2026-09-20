/**
 * Skill-install tests: the Host installs the bundled ideas-analyst skill into
 * the user-dsh skill root (`<home>/skills/ideas-analyst/SKILL.md`) so any
 * analysing session discovers it. Install is first-wins: a missing file is
 * written, a present file (even a hand-edited one) is kept, and a divergent
 * present file is logged without overwrite. Best-effort: failures return a
 * kept-existing outcome instead of throwing.
 */

import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installedSkillPath,
  installIdeasAnalystSkill,
  skillRoot,
} from '../src/skill-install.ts'
import { IDEAS_ANALYST_SKILL_CONTENT, IDEAS_ANALYST_SKILL_NAME } from '../src/skills/ideas-analyst.ts'

let home: string

beforeEach(() => {
  home = join(tmpdir(), `ideas-skill-test-${process.pid}-${randomUUID()}`)
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

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
  })

  it('first-wins: a divergent present file is kept and logged, never overwritten', () => {
    const target = installedSkillPath(home)
    const edits = '# my hand-edited skill\n'
    mkdirSync(join(skillRoot(home), IDEAS_ANALYST_SKILL_NAME), { recursive: true })
    writeFileSync(target, edits, 'utf8')
    const logged: string[] = []
    const outcome = installIdeasAnalystSkill({ home, log: (line) => { logged.push(line) } })
    expect(outcome.status).toBe('kept-existing')
    expect(outcome.synced).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(edits) // untouched
    expect(logged.some(line => line.includes('differs from the bundled copy'))).toBe(true)
  })

  it('never throws: an unreadable/undeletable target degrades to kept-existing', () => {
    // The whole home is a file, so mkdirSync inside it fails.
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