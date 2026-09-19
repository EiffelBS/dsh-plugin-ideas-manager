/**
 * Export golden tests: the ledger -> markdown shape is pinned here. Change
 * the format in src/export-markdown.ts only together with this file.
 */

import { describe, expect, it } from 'vitest'
import { buildIdeasExport } from '../src/export-markdown.ts'
import { createIdea } from '../src/core/ideas.ts'

const T0 = Date.parse('2026-09-16T08:00:00.000Z')
const T1 = Date.parse('2026-09-16T09:30:00.000Z')

describe('buildIdeasExport', () => {
  it('renders an empty ledger with the two headers', () => {
    const result = buildIdeasExport([], undefined)
    expect(result.ideasMd).toContain('# IDEAS\n')
    expect(result.ideasMd).toContain('_No open ideas yet._')
    expect(result.archiveMd).toContain('# IDEAS-ARCHIVE\n')
    expect(result.archiveMd).toContain('_No archived ideas yet._')
  })

  it('separates open ideas from archived/declined and pins the section shape', () => {
    const open = createIdea(
      {
        title: 'Port YuE2 score',
        body: 'Render the ABC score on the board.',
        value: 5,
        effort: 2,
        tags: [{ name: 'work' }],
        workspaceId: 'ot',
      },
      T0,
      'idea-1',
    )
    const archived = { ...createIdea({ title: 'Old idea', body: '' }, T0, 'idea-2'), status: 'archived' as const, archivedAt: T1 }
    const result = buildIdeasExport([open, archived], undefined)

    expect(result.ideasMd).toContain('## Port YuE2 score')
    expect(result.ideasMd).toContain('- id: `idea-1`')
    expect(result.ideasMd).toContain('- status: open')
    expect(result.ideasMd).toContain('- tags: `work`')
    expect(result.ideasMd).toContain('- scores: value: 5 · effort: 2')
    expect(result.ideasMd).toContain('- workspace: `ot`')
    expect(result.ideasMd).toContain('- created: 2026-09-16T08:00:00.000Z')
    expect(result.archiveMd).toContain('## Old idea')
    expect(result.archiveMd).toContain('- status: archived')
    expect(result.archiveMd).toContain('- archived: 2026-09-16T09:30:00.000Z')
    // The open idea must not leak into the archive, and vice versa.
    expect(result.ideasMd).not.toContain('## Old idea')
    expect(result.archiveMd).not.toContain('## Port YuE2 score')
    expect(result.ideasMd).not.toContain('- archived:')
  })

  it('filters by workspace when requested', () => {
    const ot = createIdea({ title: 'OT idea', body: '', workspaceId: 'ot' }, T0, 'ot-1')
    const generic = createIdea({ title: 'Generic idea', body: '' }, T0, 'gen-1')
    const result = buildIdeasExport([ot, generic], 'ot')
    expect(result.ideasMd).toContain('## OT idea')
    expect(result.ideasMd).not.toContain('## Generic idea')
    // An absent workspaceId means generic: it must not leak into a scoped export.
    expect(result.ideasMd).not.toContain('Generic idea')
  })

  it('renders the T1 bullets: number, rationale, decision and delivered', () => {
    const open = {
      ...createIdea({ title: 'Port YuE2 score', body: '', value: 3, effort: 1, rationale: 'Top value' }, T0, 'idea-1'),
      ideaNumber: 12,
    }
    const delivered = {
      ...createIdea({ title: 'Shipped idea', body: '' }, T0, 'idea-2'),
      status: 'archived' as const,
      archivedAt: T1,
      deliveredAt: T1,
      ideaNumber: 7,
    }
    const declined = {
      ...createIdea({ title: 'Nope', body: '' }, T0, 'idea-3'),
      status: 'declined' as const,
      archivedAt: T1,
      decision: 'Covered elsewhere',
      ideaNumber: 2,
    }
    const result = buildIdeasExport([open, delivered, declined], undefined)
    expect(result.ideasMd).toContain('- number: #12')
    expect(result.ideasMd).toContain('- rationale: Top value')
    expect(result.archiveMd).toContain('## Shipped idea')
    expect(result.archiveMd).toContain('- number: #7')
    expect(result.archiveMd).toContain('- delivered: 2026-09-16T09:30:00.000Z')
    expect(result.archiveMd).toContain('- decision: Covered elsewhere')
    // A delivered idea carries no decision bullet, and an open idea carries no
    // delivery stamp.
    expect(result.ideasMd).not.toContain('- delivered:')
    expect(result.ideasMd).not.toContain('- decision:')
  })

  it('keeps under-review ideas in the active document (recette gate pending)', () => {
    const underReview = {
      ...createIdea({ title: 'Awaiting recette', body: '' }, T0, 'idea-1'),
      status: 'underReview' as const,
      ideaNumber: 3,
    }
    const result = buildIdeasExport([underReview], undefined)
    // Under review is still an active idea: it lives in IDEAS.md, never in the
    // archive document.
    expect(result.ideasMd).toContain('## Awaiting recette')
    expect(result.ideasMd).toContain('- status: underReview')
    expect(result.ideasMd).toContain('- number: #3')
    expect(result.ideasMd).not.toContain('- archived:')
    expect(result.archiveMd).not.toContain('## Awaiting recette')
  })

  it('renders the follow-up lineage bullet on a child idea', () => {
    const child = {
      ...createIdea({ title: 'Rework the fade-out', body: '' }, T0, 'idea-2'),
      ideaNumber: 4,
      followUpOfId: 'idea-1',
    }
    const result = buildIdeasExport([child], undefined)
    expect(result.ideasMd).toContain('- follow-up of: `idea-1`')
  })
})