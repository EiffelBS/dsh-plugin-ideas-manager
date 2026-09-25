/**
 * Bounded read-view contract (idea #65): filters, projections, pagination,
 * revision metadata, explicit omission/truncation flags, and hard response
 * bounds against the deterministic 140-card large-board fixture.
 */

import { describe, expect, it } from 'vitest'
import {
  IDEAS_READ_MAX_BODY_BYTES,
  IDEAS_READ_MAX_RESPONSE_BYTES,
  IDEAS_SCHEMA_VERSION,
  buildIdeasReadSnapshot,
  ideasReadSearchParams,
  parseIdeasReadQuery,
  type IdeasReadField,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord, IdeaStatus } from '../src/core/ideas.ts'
import { makePerfDataset, PERF_IDEA_COUNT } from './perf-fixture.ts'

function idea(partial: Partial<IdeaRecord> & Pick<IdeaRecord, 'id' | 'status'>): IdeaRecord {
  return {
    title: `Title ${partial.id}`,
    body: `Body ${partial.id}`,
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  }
}

function snapshot(ideas: IdeaRecord[], revision = 7): IdeasSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision, ideas }
}

describe('bounded summary reads', () => {
  const ledger = snapshot([
    idea({ id: 'a', status: 'open', ideaNumber: 1, workspaceId: 'ws-a', summary: 'Alpha', tags: [{ name: 'api' }], taskBoardId: 'task-a' }),
    idea({ id: 'b', status: 'archived', ideaNumber: 2, workspaceId: 'ws-a', summary: 'Beta', followUpOfId: 'a' }),
    idea({ id: 'c', status: 'open', ideaNumber: 3, workspaceId: 'ws-b', summary: 'Gamma' }),
  ], 19)

  it('filters by workspace and repeated lifecycle status without exposing full fields', () => {
    const result = buildIdeasReadSnapshot(ledger, {
      view: 'summary',
      workspaceId: 'ws-a',
      status: ['open', 'archived'],
    })

    expect(result.revision).toBe(19)
    expect(result.meta).toMatchObject({
      view: 'summary',
      matched: 2,
      returned: 2,
      rowTruncated: false,
      nextOffset: null,
      bodyTruncated: false,
    })
    expect(result.ideas.map(row => row.id)).toEqual(['a', 'b'])
    expect(result.ideas[0]).toMatchObject({
      id: 'a',
      ideaNumber: 1,
      title: 'Title a',
      status: 'open',
      workspaceId: 'ws-a',
      summary: 'Alpha',
      tags: [{ name: 'api' }],
      taskBoardId: 'task-a',
    })
    expect(result.ideas.every(row => !('body' in row))).toBe(true)
    expect(result.meta.omittedFields).toContain('body')
    expect(result.meta.omittedFields).toContain('analysisAudit')
  })

  it('treats ids and numbers as one explicit selector group, then applies other filters', () => {
    const result = buildIdeasReadSnapshot(ledger, {
      ids: ['missing', 'c'],
      numbers: [2],
      status: ['archived'],
    })
    expect(result.ideas.map(row => row.id)).toEqual(['b'])
    expect(result.meta.matched).toBe(1)
  })

  it('supports exact field selection, bounded UTF-8 body loading, and row flags', () => {
    const long = idea({ id: 'detail', status: 'underReview', body: 'East wind', rationale: 'kept', rank: 3 })
    const result = buildIdeasReadSnapshot(snapshot([long], 23), {
      view: 'detail',
      ids: ['detail'],
      fields: ['body', 'rationale'],
      bodyLimit: 5,
    })

    expect(result.ideas[0]).toEqual({
      id: 'detail',
      title: 'Title detail',
      status: 'underReview',
      createdAt: 1,
      updatedAt: 2,
      rationale: 'kept',
      body: 'East ',
      bodyTruncated: true,
    })
    expect(result.meta.bodyLimitBytes).toBe(5)
    expect(result.meta.bodyTruncated).toBe(true)
    expect(result.meta.omittedFields).toContain('workspaceId')
    expect(result.meta.omittedFields).not.toContain('body')
    expect(result.meta.omittedFields).toContain('analysisAudit')
  })
})

describe('bounded read pagination, revision, and size', () => {
  it('reports empty results, matched counts, and continuation offsets', () => {
    const empty = buildIdeasReadSnapshot(snapshot([]), { workspaceId: 'missing' })
    expect(empty.ideas).toEqual([])
    expect(empty.meta).toMatchObject({ matched: 0, returned: 0, rowTruncated: false, nextOffset: null })

    const ledger = snapshot(Array.from({ length: 5 }, (_, index) => idea({ id: `id-${index}`, status: 'open' })), 31)
    const first = buildIdeasReadSnapshot(ledger, { limit: 2, offset: 1 })
    const second = buildIdeasReadSnapshot(ledger, { limit: 2, offset: first.meta.nextOffset! })
    expect(first.ideas.map(row => row.id)).toEqual(['id-1', 'id-2'])
    expect(first.meta).toMatchObject({ matched: 5, returned: 2, nextOffset: 3, rowTruncated: true })
    expect(second.ideas.map(row => row.id)).toEqual(['id-3', 'id-4'])
    expect(second.revision).toBe(31)
  })

  it('keeps a field-rich 140-card response under the hard wire cap', () => {
    const result = buildIdeasReadSnapshot(snapshot(makePerfDataset(), 101), {
      view: 'detail',
      fields: ['body', 'rationale', 'summary', 'tags', 'workspaceId', 'taskBoardId'],
      bodyLimit: IDEAS_READ_MAX_BODY_BYTES,
      limit: 200,
    })
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    expect(result.meta.matched).toBe(PERF_IDEA_COUNT)
    expect(result.meta.returned).toBeGreaterThan(0)
    expect(result.meta.returned).toBeLessThan(PERF_IDEA_COUNT)
    expect(result.meta.rowTruncated).toBe(true)
    expect(result.meta.nextOffset).toBe(result.meta.returned)
    expect(result.meta.bodyTruncated).toBe(true)
    expect(result.ideas.every(row => !('analysisAudit' in row))).toBe(true)
    expect(Buffer.byteLength(result.ideas[0]!.body!, 'utf8')).toBeLessThanOrEqual(IDEAS_READ_MAX_BODY_BYTES)
    expect(bytes).toBeLessThanOrEqual(IDEAS_READ_MAX_RESPONSE_BYTES)
  })
})

describe('read query parser and serializer', () => {
  it('accepts repeated and comma-separated selectors, and round-trips through the client URL', () => {
    const query = {
      view: 'summary' as const,
      workspaceId: 'ws one',
      status: ['open', 'archived'] as IdeaStatus[],
      ids: ['id-a', 'id-b'],
      numbers: [4, 5],
      fields: ['summary', 'body'] as IdeasReadField[],
      bodyLimit: 128,
      limit: 20,
      offset: 40,
    }
    const params = ideasReadSearchParams(query)
    expect(params.get('workspaceId')).toBe('ws one')
    expect(params.getAll('status')).toEqual(['open', 'archived'])
    expect(params.getAll('id')).toEqual(['id-a', 'id-b'])
    expect(params.getAll('fields')).toEqual(['summary', 'body'])
    const parsed = parseIdeasReadQuery(new URLSearchParams('view=detail&status=open,archived&id=a&id=b&number=4&fields=summary,body&bodyLimit=128&limit=20&offset=40'))
    expect(parsed).toEqual({
      view: 'detail',
      status: ['open', 'archived'],
      ids: ['a', 'b'],
      numbers: [4],
      fields: ['summary', 'body'],
      bodyLimit: 128,
      limit: 20,
      offset: 40,
    })
  })

  it('rejects unknown keys, invalid statuses, oversized body limits, and unsafe pagination', () => {
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&unknown=1'))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&status=deleted'))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&id='))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&number='))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&bodyLimit=4097'))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&limit=201'))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&offset=-1'))).toBeUndefined()
    expect(() => buildIdeasReadSnapshot(snapshot([]), { bodyLimit: IDEAS_READ_MAX_BODY_BYTES + 1 })).toThrow('invalid-query')
  })
})
