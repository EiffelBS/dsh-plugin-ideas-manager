/**
 * List-projection units (idea #34): the body excerpt builder and the
 * full->list snapshot projection the host (?view=list) and the client
 * (action responses) share. The projection MUST drop the voluminous fields
 * (body, analysisAudit) while every list field survives byte-identically.
 */

import { describe, expect, it } from 'vitest'
import {
  BODY_EXCERPT_MAX_LENGTH,
  IDEAS_SCHEMA_VERSION,
  bodyExcerptOf,
  toListRow,
  toListSnapshot,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

function record(partial: Partial<IdeaRecord> = {}): IdeaRecord {
  return {
    id: 'idea-1',
    title: 'A title',
    body: 'Short body.',
    status: 'open',
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  }
}

describe('bodyExcerptOf', () => {
  it('returns a short body trimmed and unchanged', () => {
    expect(bodyExcerptOf('  Hello board.  ')).toBe('Hello board.')
  })

  it('collapses whitespace runs (a teaser, not markdown structure)', () => {
    expect(bodyExcerptOf('# Head\n\nline one\n\n\nline two')).toBe('# Head line one line two')
  })

  it('caps a long body at the excerpt budget with an ellipsis', () => {
    const body = 'word '.repeat(400)
    const excerpt = bodyExcerptOf(body)
    expect(excerpt.length).toBeLessThanOrEqual(BODY_EXCERPT_MAX_LENGTH + 1)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('prefers a word boundary in the second half of the window', () => {
    const words = Array.from({ length: 80 }, (_, i) => `w${i}padding`).join(' ')
    const excerpt = bodyExcerptOf(words)
    // Cut inside the window, on whitespace: never a mid-word chop when a
    // boundary exists past the 60% mark.
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.slice(0, -1).endsWith(' ')).toBe(false)
  })

  it('handles multibyte text without throwing (cut may land inside a pair)', () => {
    const excerpt = bodyExcerptOf('東京タワー '.repeat(100))
    expect(excerpt.length).toBeGreaterThan(0)
    expect(excerpt.length).toBeLessThanOrEqual(BODY_EXCERPT_MAX_LENGTH + 1)
  })

  it('keeps an empty body empty', () => {
    expect(bodyExcerptOf('')).toBe('')
    expect(bodyExcerptOf('   \n  ')).toBe('')
  })
})

describe('toListRow / toListSnapshot (deferred body)', () => {
  it('drops body + analysisAudit, keeps every list field, adds the excerpt', () => {
    const full = record({
      summary: 'The abstract',
      rank: 3,
      value: 4,
      effort: 2,
      rationale: 'because',
      tags: [{ name: 'perf' }],
      workspaceId: 'ws-1',
      taskBoardId: 'tb-1',
      ideaNumber: 42,
      deliveredAt: 10,
      decision: 'no',
      archivedAt: 11,
      reanalyzeAt: 12,
      followUpOfId: 'parent-1',
      analysisAudit: { at: 9, title: 'prior', body: 'prior body text' },
      body: 'The whole voluminous analysis, tens of KB.',
    })
    const row = toListRow(full)

    expect('body' in row).toBe(false)
    expect('analysisAudit' in row).toBe(false)
    expect(row.bodyExcerpt).toBe('The whole voluminous analysis, tens of KB.')
    // Every other field survives verbatim.
    expect(row.title).toBe(full.title)
    expect(row.summary).toBe(full.summary)
    expect(row.rank).toBe(3)
    expect(row.value).toBe(4)
    expect(row.effort).toBe(2)
    expect(row.rationale).toBe(full.rationale)
    expect(row.tags).toEqual(full.tags)
    expect(row.workspaceId).toBe('ws-1')
    expect(row.taskBoardId).toBe('tb-1')
    expect(row.ideaNumber).toBe(42)
    expect(row.deliveredAt).toBe(10)
    expect(row.decision).toBe('no')
    expect(row.archivedAt).toBe(11)
    expect(row.reanalyzeAt).toBe(12)
    expect(row.followUpOfId).toBe('parent-1')
    expect(row.createdAt).toBe(full.createdAt)
    expect(row.updatedAt).toBe(full.updatedAt)
  })

  it('projects a snapshot envelope (revision/schemaVersion untouched)', () => {
    const snapshot: IdeasSnapshot = {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 17,
      ideas: [record(), record({ id: 'idea-2', body: 'x'.repeat(5000) })],
    }
    const list = toListSnapshot(snapshot)
    expect(list.revision).toBe(17)
    expect(list.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    expect(list.ideas).toHaveLength(2)
    expect(list.ideas.every(idea => !('body' in idea))).toBe(true)
    // Payload sanity: the second body (5000 chars) is cut to the budget.
    expect(list.ideas[1]!.bodyExcerpt.length).toBeLessThanOrEqual(BODY_EXCERPT_MAX_LENGTH + 1)
    const fullBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    const listBytes = Buffer.byteLength(JSON.stringify(list), 'utf8')
    expect(listBytes).toBeLessThan(fullBytes)
  })
})
