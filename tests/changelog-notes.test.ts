/**
 * The changelog extractor that fills the GitHub Release body. It has to be
 * forgiving: a release must never fail because the notes could not be read,
 * and a section that exists must be found whatever heading style wrote it.
 */

import { describe, expect, it } from 'vitest'
import { extractSection, readChangelog } from '../scripts/changelog-notes.mjs'

const SAMPLE = `# Changelog

Preamble that is not a section.

## 0.7.0 - 2026-09-26

### Added

- Something new.

### Fixed

- Something repaired.

## [0.6.0] - 2026-09-25

### Changed

- Something else.

## Unreleased

- Not released yet.
`

describe('changelog notes', () => {
  it('extracts one section, heading excluded, subsections included', () => {
    const section = extractSection(SAMPLE, 'v0.7.0')
    expect(section).toBeDefined()
    expect(section).toContain('### Added')
    expect(section).toContain('- Something new.')
    expect(section).toContain('- Something repaired.')
    // The next version's content must not leak in.
    expect(section).not.toContain('Something else.')
    // Nor the heading itself: the release already carries the title.
    expect(section?.startsWith('###')).toBe(true)
  })

  it('accepts a tag with or without its v, and a bracketed heading', () => {
    expect(extractSection(SAMPLE, '0.6.0')).toContain('Something else.')
    expect(extractSection(SAMPLE, 'v0.6.0')).toContain('Something else.')
  })

  it('stops at the next version, not at a subsection', () => {
    const section = extractSection(SAMPLE, 'v0.6.0')
    expect(section).toContain('### Changed')
    expect(section).not.toContain('Not released yet.')
  })

  it('returns nothing for an unknown tag, so the caller can fall back', () => {
    expect(extractSection(SAMPLE, 'v9.9.9')).toBeUndefined()
    expect(extractSection('', 'v0.7.0')).toBeUndefined()
  })

  it('reads the real changelog, and every released tag is documented', () => {
    const changelog = readChangelog()
    expect(changelog.length).toBeGreaterThan(0)
    for (const tag of ['v0.3.0', 'v0.4.0', 'v0.5.0', 'v0.6.0', 'v0.7.0']) {
      const section = extractSection(changelog, tag)
      expect(section, `no changelog section for ${tag}`).toBeDefined()
      expect(section?.length ?? 0).toBeGreaterThan(40)
    }
  })
})
