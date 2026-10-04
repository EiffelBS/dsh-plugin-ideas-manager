/**
 * Skill-install tests: the Host installs the bundled ideas-analyst skill into
 * the user-dsh skill root (`<home>/skills/ideas-analyst/SKILL.md`) so any
 * analysing session discovers it.
 *
 * The classification is by DIGEST, and it is the whole policy: a missing file is
 * written, an older copy THIS PLUGIN shipped is upgraded, a matching copy is
 * left alone, and a hand-edited one is kept untouched with a warning. The old
 * rule was first-wins for all of them, which silently stranded every instance on
 * a months-old analysis prompt. Best-effort: failures return a kept-existing
 * outcome instead of throwing.
 */

import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installedSkillPath,
  installIdeasAnalystSkill,
  KNOWN_BUNDLED_DIGESTS,
  skillRoot,
} from '../src/skill-install.ts'
import { IDEAS_ANALYST_SKILL_CONTENT, IDEAS_ANALYST_SKILL_NAME } from '../src/skills/ideas-analyst.ts'

const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

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

  it('UPGRADES a copy this plugin shipped before, instead of stranding it', () => {
    // The bug this replaces: an instance installed months ago kept running the
    // old prompt after every upgrade, so the features the plugin advertised went
    // unused by the analyst with no symptom anywhere.
    const target = installedSkillPath(home)
    mkdirSync(join(skillRoot(home), IDEAS_ANALYST_SKILL_NAME), { recursive: true })
    // An older copy this plugin shipped — recognised by digest through the seam,
    // the same way the seeded 2026-09 entry works on a real home.
    const stale = '# an older bundled copy of the skill\n'
    writeFileSync(target, stale, 'utf8')
    const logged: string[] = []
    const outcome = installIdeasAnalystSkill({ home, log: (line) => { logged.push(line) }, knownDigests: [digestOf(stale)] })
    expect(outcome.status).toBe('upgraded')
    expect(outcome.synced).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(IDEAS_ANALYST_SKILL_CONTENT)
    expect(logged.some(line => line.includes('upgraded it to this version'))).toBe(true)
    // And it is idempotent afterwards: the next start sees the current copy.
    expect(installIdeasAnalystSkill({ home }).status).toBe('matched')
  })

  it('keeps a HAND-EDITED copy untouched, and says which prompt is in use', () => {
    const target = installedSkillPath(home)
    const edits = '# my hand-edited skill\n'
    mkdirSync(join(skillRoot(home), IDEAS_ANALYST_SKILL_NAME), { recursive: true })
    writeFileSync(target, edits, 'utf8')
    const logged: string[] = []
    const outcome = installIdeasAnalystSkill({ home, log: (line) => { logged.push(line) } })
    expect(outcome.status).toBe('kept-existing')
    expect(outcome.synced).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(edits) // untouched
    expect(logged.some(line => line.includes('edited by hand'))).toBe(true)
    // The sentence must name the consequence AND the way out: a kept copy means
    // the analyst is running the author's prompt, not the plugin's.
    expect(logged.some(line => line.includes('NOT this plugin version'))).toBe(true)
    expect(logged.some(line => line.includes('Delete the file and restart'))).toBe(true)
  })

  it('knows the digest of the copy sitting on a real home, so that one upgrades too', () => {
    // Guards the seeded list itself: the digest registered for the 2026-09-23
    // release is the one an untouched installation of it produces. If the skill
    // text is reflowed, this entry must be re-seeded rather than silently
    // stranding every machine on the old prompt.
    expect(KNOWN_BUNDLED_DIGESTS).toContain('a52ebd3ac0de29e5b029070762ff4f05761373e77ab8a9473168950990cf4880')
    // Every entry is a lowercase sha-256, and none is the current copy's (that
    // one is compared at runtime).
    for (const digest of KNOWN_BUNDLED_DIGESTS) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      expect(digest).not.toBe(digestOf(IDEAS_ANALYST_SKILL_CONTENT))
    }
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