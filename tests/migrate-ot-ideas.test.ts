/**
 * P3 migration parser tests: the OT `## Idea #N` section shape is parsed into
 * import rows — headings with `—`/`-` separators, `*(…)*` meta suffixes,
 * DELIVERED/DECLINED statuses, priority-table ranks, and date extraction.
 */

import { describe, expect, it } from 'vitest'
import {
  deliveredDateInSection,
  filterIncremental,
  parseOtIdeasDocument,
  parseOtMigration,
  parseOtPriorityRanks,
  statusInSection,
  titleFromHeading,
} from '../scripts/migrate-ot-ideas.mjs'

const T0 = Date.parse('2026-09-16T00:00:00.000Z')

describe('titleFromHeading', () => {
  it('strips the Idea label and the meta suffix', () => {
    expect(titleFromHeading('## Idea #6 — Arrangement timeline *(priority 2 — link mode C)*')).toBe('Arrangement timeline')
    expect(titleFromHeading('## Idea #18 - Compile the multi-arch shared ggml-cuda DLL *(captured 2026-09-13)*'))
      .toBe('Compile the multi-arch shared ggml-cuda DLL')
  })

  it('handles a parenthesized label after the id and keeps inner dashes', () => {
    expect(titleFromHeading('## Idea #15 (remaining) - Music generation via the in-process audiocpp_engine DLL *(captured 2026-08-31)*'))
      .toBe('Music generation via the in-process audiocpp_engine DLL')
    expect(titleFromHeading('## Idea #23 — OT-serve full implementation (new backends + all tasks — only if PoC #22 GO) *(captured 2026-09-16)*'))
      .toBe('OT-serve full implementation (new backends + all tasks — only if PoC #22 GO)')
  })
})

describe('parseOtIdeasDocument', () => {
  it('parses open sections with id, title, verbatim body, workspace and captured date', () => {
    const doc = [
      '# OpenTimbre — Improvement Ideas',
      '',
      '## Idea #6 — Arrangement timeline *(priority 2 — link mode C)*',
      '',
      '> Status: future idea.',
      '',
      '**Idea.** Drag & drop lanes in the DAW.',
      '',
      '**Recipe.** Verified steps.',
      '',
    ].join('\n')
    const { ideas, sections } = parseOtIdeasDocument(doc, { status: 'open', now: T0 })
    expect(sections).toBe(1)
    expect(ideas[0]?.id).toBe('ot-6')
    expect(ideas[0]?.title).toBe('Arrangement timeline')
    expect(ideas[0]?.status).toBe('open')
    expect(ideas[0]?.workspaceId).toBe('ot')
    expect(ideas[0]?.body).toContain('**Idea.** Drag & drop lanes')
    expect(ideas[0]?.createdAt).toBe(T0)
  })

  it('maps DELIVERED archive sections to archived with an archivedAt date', () => {
    const doc = [
      '## Idea #19 — Restore "Audio/MIDI Settings" in the standalone *(DELIVERED 2026-09-16/17 — record, user-validated)*',
      '',
      '**Idea.** Wrapper dialog restore.',
      '',
    ].join('\n')
    const { ideas } = parseOtIdeasDocument(doc, { status: 'archived', now: T0 })
    expect(ideas[0]?.status).toBe('archived')
    expect(ideas[0]?.archivedAt).toBe(Date.parse('2026-09-16T00:00:00.000Z'))
    expect(ideas[0]?.createdAt).toBe(Date.parse('2026-09-16T00:00:00.000Z'))
  })

  it('maps DECLINED sections to declined', () => {
    const doc = [
      '## Idea #14 - Port Qwen3-TTS 12Hz 0.6B Base to the internal ONNX engine (family C) *(DECLINED 2026-09-13 — …)*',
      '',
      '**Idea.** Port the tokenizer.',
      '',
    ].join('\n')
    const { ideas } = parseOtIdeasDocument(doc, { status: 'archived', now: T0 })
    expect(ideas[0]?.status).toBe('declined')
    expect(ideas[0]?.archivedAt).toBe(Date.parse('2026-09-13T00:00:00.000Z'))
  })

  it('falls back to the provided now instant when no date is parseable', () => {
    const { ideas } = parseOtIdeasDocument('## Idea #4 — Resizable main panels\n\nBody.', { status: 'open', now: T0 })
    expect(ideas[0]?.createdAt).toBe(T0)
  })
})

describe('parseOtPriorityRanks', () => {
  it('reads the Suggested priority table rows', () => {
    const table = [
      '| Rank | ID | Idea | Value | Effort / Risk |',
      '|------|----|------|-------|---------------|',
      '| 1 | #6 | Arrangement timeline | Very high | High |',
      '| 2 | #17 | Release packaging | Very high | Medium |',
    ].join('\n')
    const ranks = parseOtPriorityRanks(table)
    expect(ranks.get(6)).toBe(1)
    expect(ranks.get(17)).toBe(2)
  })
})

describe('parseOtMigration', () => {
  it('merges open and archive documents, dedupes by id and sorts numerically', () => {
    const ideasMd = [
      '## Idea #6 — Arrangement timeline *(priority 2)*',
      '',
      'Open body A',
      '',
    ].join('\n')
    const archiveMd = [
      '## Idea #1 — Drag & drop external files *(DELIVERED 2026-08-28/29 — record)*',
      '',
      'Archived body B',
      '',
    ].join('\n')
    const merged = parseOtMigration(ideasMd, archiveMd, { now: T0 })
    expect(merged.ideas.map(row => row.id)).toEqual(['ot-1', 'ot-6'])
    expect(merged.open.map(row => row.id)).toEqual(['ot-6'])
    expect(merged.archived.map(row => row.id)).toEqual(['ot-1'])
    expect(merged.declined).toHaveLength(0)
  })

  it('applies the priority ranks onto the open ideas', () => {
    const ideasMd = [
      '| Rank | ID | Idea |',
      '| 1 | #6 | Arrangement timeline |',
      '',
      '## Idea #6 — Arrangement timeline *(priority 2)*',
      '',
      'Body',
      '',
    ].join('\n')
    const merged = parseOtMigration(ideasMd, '# Archive\n', { now: T0 })
    expect(merged.open[0]?.rank).toBe(1)
  })

  it('keeps the open backlog slice when an idea id exists in both docs', () => {
    const ideasMd = [
      '| Rank | ID | Idea |',
      '| 5 | #15 (remaining) | Music generation via the in-process audiocpp_engine DLL |',
      '',
      '## Idea #15 (remaining) - Music generation via the in-process audiocpp_engine DLL *(captured 2026-08-31)*',
      '',
      'Open music slice body',
      '',
    ].join('\n')
    const archiveMd = [
      '## Idea #15 (slice) — In-process audiocpp_engine DLL for TTS and MIDI *(DELIVERED — verified in the code tree)*',
      '',
      'Archived TTS slice body',
      '',
    ].join('\n')
    const merged = parseOtMigration(ideasMd, archiveMd, { now: T0 })
    expect(merged.collisions).toBe(1)
    const fifteen = merged.ideas.find(row => row.id === 'ot-15')
    expect(fifteen?.status).toBe('open')
    expect(fifteen?.rank).toBe(5)
    expect(fifteen?.title).toBe('Music generation via the in-process audiocpp_engine DLL')
  })
})

describe('statusInSection', () => {
  it('classifies by status markers, DECLINED winning over DELIVERED', () => {
    expect(statusInSection('## Idea #1\n\n> Status: future idea.', 'open')).toBe('open')
    expect(statusInSection('## Idea #22 — OT-serve PoC *(DELIVERED 2026-09-18)*', 'open')).toBe('archived')
    expect(statusInSection('## Idea #14 — Qwen3 *(DECLINED 2026-09-13)*', 'open')).toBe('declined')
    expect(statusInSection('## Idea #14 — Qwen3 *(DELIVERED then DECLINED 2026-09-13)*', 'open')).toBe('declined')
  })

  it('only scans the status region, not deep body quotes', () => {
    const longBody = `${'x'.repeat(500)}\n> The sidecar was delivered anyway.`
    expect(statusInSection(`## Idea #6 — Timeline\n\n${longBody}`, 'open')).toBe('open')
  })

  it('does not treat the lowercase verb "delivered" in a status line as a marker', () => {
    // The OT future-idea template says "…analysis and plan delivered in
    // `docs/internal/`" — the idea stays open, only the all-caps markers count.
    expect(statusInSection(
      '## Idea #24 — ggml-Vulkan support *(captured 2026-09-17)*\n\n> Status: feasibility and impact analysis and phased plan delivered in `docs/internal/`. Verdict: GO CONDITIONNEL. Not scheduled; idea backlog only.',
      'open',
    )).toBe('open')
    expect(statusInSection(
      '## Idea #15 (remaining) — Music generation *(captured 2026-08-31)*\n\n> **2026-09-01 update:** phased plan delivered in RESEARCH.\n\n> **2026-09-07 update:** the TTS and MIDI slices of this idea are **DELIVERED** — the remaining music slice stays open.',
      'open',
    )).toBe('open')
  })

  it('ignores all-caps DELIVERED in prose inside a merged update blockquote', () => {
    // The real #15 section merges its update notes into ONE blockquote using
    // `>` separator lines; "… are DELIVERED - `source/…`" stays prose and
    // must not close the idea (only meta/status-line/date markers count).
    const section = [
      '## Idea #15 (remaining) - Music generation via the in-process audiocpp_engine DLL *(captured 2026-08-31)*',
      '',
      '> **2026-09-01 update:** full feasibility analysis + phased plan delivered in RESEARCH.',
      '>',
      '> **2026-09-07 update (code-tree verification):** the TTS and MIDI slices',
      '> of this idea are DELIVERED - `source/engine/AudiocppNative.h` wraps the DLL.',
      '',
    ].join('\n')
    expect(statusInSection(section, 'open')).toBe('open')
  })
})

describe('deliveredDateInSection', () => {
  it('reads the delivery date from the DELIVERED marker', () => {
    expect(deliveredDateInSection('## Idea #22 *(DELIVERED 2026-09-18)*')).toBe(Date.parse('2026-09-18T00:00:00.000Z'))
    expect(deliveredDateInSection('## Idea #6 — Timeline\n\nBody.')).toBeUndefined()
  })
})

describe('parseOtIdeasDocument classify', () => {
  it('maps DELIVERED sections to archived with a deliveredAt stamp', () => {
    const doc = [
      '## Idea #22 — OT-serve PoC *(captured 2026-09-16, DELIVERED 2026-09-18)*',
      '',
      '> Status: DELIVERED — all PoC gates pass.',
      '',
      '**Idea.** Generic sidecar layer probe.',
      '',
    ].join('\n')
    const { ideas } = parseOtIdeasDocument(doc, { status: 'open', classify: true, now: T0 })
    expect(ideas[0]?.status).toBe('archived')
    expect(ideas[0]?.archivedAt).toBe(Date.parse('2026-09-16T00:00:00.000Z'))
    expect(ideas[0]?.deliveredAt).toBe(Date.parse('2026-09-18T00:00:00.000Z'))
    expect(ideas[0]?.createdAt).toBe(Date.parse('2026-09-16T00:00:00.000Z'))
  })

  it('falls the deliveredAt back to the heading date when no marker date exists', () => {
    const doc = [
      '## Idea #23 — OT-serve full implementation *(DELIVERED — record)*',
      '',
      'Body',
      '',
    ].join('\n')
    const { ideas } = parseOtIdeasDocument(doc, { status: 'open', classify: true, now: T0 })
    expect(ideas[0]?.status).toBe('archived')
    expect(ideas[0]?.deliveredAt).toBe(T0)
  })

  it('leaves closed documents untouched when classify is off (P3 parity)', () => {
    const doc = [
      '## Idea #19 — Restore "Audio/MIDI Settings" *(DELIVERED 2026-09-16/17 — record)*',
      '',
      'Body',
      '',
    ].join('\n')
    const { ideas } = parseOtIdeasDocument(doc, { status: 'archived', now: T0 })
    expect(ideas[0]?.status).toBe('archived')
    expect(ideas[0]?.deliveredAt).toBeUndefined()
  })
})

describe('filterIncremental', () => {
  it('keeps only ids missing from the target ledger', () => {
    const rows = [
      { id: 'ot-6', title: 'Timeline' },
      { id: 'ot-24', title: 'Vulkan' },
      { id: 'ot-28', title: 'mlx-serve' },
    ]
    const delta = filterIncremental(rows, ['ot-6', 'ot-23'])
    expect(delta.skipped).toBe(1)
    expect(delta.missing.map(row => row.id)).toEqual(['ot-24', 'ot-28'])
  })

  it('returns everything when the ledger is empty and nothing when it is complete', () => {
    const rows = [{ id: 'ot-24', title: 'Vulkan' }]
    expect(filterIncremental(rows, []).missing).toHaveLength(1)
    expect(filterIncremental(rows, ['ot-24']).missing).toHaveLength(0)
  })
})