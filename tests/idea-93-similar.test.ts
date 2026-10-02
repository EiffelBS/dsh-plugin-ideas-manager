/**
 * Idea #93, parts 2 and 3 — the near-duplicate FLAG and the Find similar
 * action.
 *
 * Two contracts are under test.
 *
 * The FLAG is a cheap, OPT-IN signal: it never appears on the default snapshot
 * (that is what keeps the board's 2.5 s poll exactly as cheap as it was), it is
 * computed over the open backlog of ONE workspace only, and it is reported as
 * evidence ("which signals fired") rather than as a verdict.
 *
 * The ACTION delegates the judgement: the affordance obeys the same gate as
 * Re-analyze, and the prompt it builds names the bounded candidates, tells the
 * analyst to distrust the scores, and forbids the merge verb outright.
 */

import { describe, expect, it } from 'vitest'
import {
  buildIdeasReadSnapshot,
  ideasReadSearchParams,
  parseIdeasReadQuery,
  toListSnapshot,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import {
  findIdeaSimilar,
  ideaSimilarity,
  ideaTitleTokens,
  IDEAS_SIMILAR_MAX_CANDIDATES,
  IDEAS_SIMILAR_MIN_SCORE,
  type IdeaRecord,
} from '../src/core/ideas.ts'
import { buildFindSimilarInput, canFindSimilar, FIND_SIMILAR_CANDIDATE_LIMIT, similarCandidateViews } from '../src/client/find-similar.ts'
import { buildFindSimilarPrompt } from '../src/client/session-queue.ts'
import { IDEAS_ANALYST_SKILL_CONTENT } from '../src/skills/ideas-analyst.ts'

/** A minimal record with the fields the scan reads. */
function idea(id: string, overrides: Partial<IdeaRecord> = {}): IdeaRecord {
  return {
    id,
    title: id,
    body: '',
    status: 'open',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    updatedAt: 1,
    ...overrides,
  }
}

function snapshotOf(ideas: IdeaRecord[]): IdeasSnapshot {
  return { schemaVersion: 1, revision: 1, ideas }
}

describe('title normalization', () => {
  it('lowercases, splits on punctuation and collapses duplicates', () => {
    // The article is a token like any other: nothing is stemmed away, because
    // the score is a cheap signal and not a linguistic model.
    expect([...ideaTitleTokens('Add a  tag-filter, add TAG filter!')]).toEqual(['add', 'a', 'tag', 'filter'])
    expect([...ideaTitleTokens('---')]).toEqual([])
  })

  it('splits an ideographic run per CHARACTER, so CJK titles can overlap at all', () => {
    // Whole-title tokens would never overlap here; per-character tokens do.
    const shared = ideaTitleTokens('想法看板的合并')
    expect(shared.size).toBe(7)
    expect([...ideaTitleTokens('想法合并')]).toEqual(['想', '法', '合', '并'])
    const a = ideaTitleTokens('想法看板的合并')
    const b = ideaTitleTokens('想法合并')
    let sharedCount = 0
    for (const token of b) if (a.has(token)) sharedCount += 1
    expect(sharedCount).toBe(4)
  })
})

describe('ideaSimilarity (the cheap signal)', () => {
  it('is symmetric, bounded to 0..1 and rounded to 3 decimals', () => {
    const a = idea('1', { title: 'Add tag filter to the board', tags: [{ name: 'ui' }] })
    const b = idea('2', { title: 'Add a tag filter to the board', tags: [{ name: 'ui' }] })
    const forward = ideaSimilarity(a, b)
    const backward = ideaSimilarity(b, a)
    expect(forward.score).toBe(backward.score)
    expect(forward.score).toBeGreaterThanOrEqual(0)
    expect(forward.score).toBeLessThanOrEqual(1)
    expect(String(forward.score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3)
  })

  it('an identical title alone clears the floor, with no shared tag at all', () => {
    const a = idea('1', { title: 'Cache the ledger snapshot', tags: [{ name: 'perf' }] })
    const b = idea('2', { title: 'Cache the ledger snapshot', tags: [{ name: 'docs' }] })
    const { score, signals } = ideaSimilarity(a, b)
    expect(signals).toEqual(['title'])
    expect(score).toBeGreaterThanOrEqual(IDEAS_SIMILAR_MIN_SCORE)
  })

  it('one shared tag out of many, with no title overlap, stays below the floor', () => {
    const a = idea('1', { title: 'Compress the wire payload', tags: [{ name: 'perf' }, { name: 'wire' }, { name: 'ui' }, { name: 'docs' }] })
    const b = idea('2', { title: 'Rewrite the markdown exporter', tags: [{ name: 'perf' }, { name: 'export' }, { name: 'docs' }, { name: 'i18n' }] })
    const { score, signals } = ideaSimilarity(a, b)
    // Title overlap only on the word "the"; the shared labels must not carry it.
    expect(signals).toContain('tags')
    expect(score).toBeLessThan(IDEAS_SIMILAR_MIN_SCORE)
  })
})

describe('findIdeaSimilar (the flag)', () => {
  it('scans only the OPEN backlog of the SAME workspace', () => {
    const ideas = [
      idea('1', { title: 'Add tag filter to the board', workspaceId: 'ws-1', tags: [{ name: 'ui' }] }),
      // Same workspace, open: a genuine candidate.
      idea('2', { title: 'Add tag filter to the board', workspaceId: 'ws-1', tags: [{ name: 'ui' }] }),
      // Other workspace: never compared, however similar it looks.
      idea('3', { title: 'Add tag filter to the board', workspaceId: 'ws-2' }),
      // Closed columns are not a "backlog": excluded.
      idea('4', { title: 'Add tag filter to the board', workspaceId: 'ws-1', status: 'archived' }),
      idea('5', { title: 'Add tag filter to the board', workspaceId: 'ws-1', status: 'underReview' }),
      idea('6', { title: 'Add tag filter to the board', workspaceId: 'ws-1', status: 'declined' }),
    ]
    const report = findIdeaSimilar(ideas, '1')
    expect(report.found).toBe(true)
    // Only idea-2 is a peer; the five excluded rows never entered the scan.
    expect(report.scanned).toBe(1)
    expect(report.candidates.map(candidate => candidate.id)).toEqual(['2'])
    expect(report.flagged).toBe(true)
  })

  it('treats the workspace-less ideas as ONE generic group, like rankGroupKey', () => {
    const ideas = [
      idea('1', { title: 'Add tag filter to the board' }),
      idea('2', { title: 'Add tag filter to the board' }),
      idea('3', { title: 'Add tag filter to the board', workspaceId: 'ws-1' }),
    ]
    const report = findIdeaSimilar(ideas, '1')
    expect(report.candidates.map(candidate => candidate.id)).toEqual(['2'])
  })

  it('reports not-found distinctly from no candidates', () => {
    const report = findIdeaSimilar([idea('1')], 'missing')
    expect(report.found).toBe(false)
    expect(report.scanned).toBe(0)
    expect(report.flagged).toBe(false)
  })

  it('is not flagged when nothing clears the floor', () => {
    const ideas = [
      idea('1', { title: 'Compress the wire payload' }),
      idea('2', { title: 'Rewrite the markdown exporter' }),
      idea('3', { title: 'Add a tag filter' }),
    ]
    const report = findIdeaSimilar(ideas, '1')
    expect(report.scanned).toBe(2)
    expect(report.candidates).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('never returns the anchor itself', () => {
    const ideas = [idea('1', { title: 'Add tag filter to the board' })]
    const report = findIdeaSimilar(ideas, '1')
    expect(report.candidates.map(candidate => candidate.id)).not.toContain('1')
  })

  it('orders strongest first, ties by age, and truncates to the limit', () => {
    const ideas = [
      idea('1', { title: 'Add tag filter to the board' }),
      idea('2', { title: 'Add tag filter to the board' }),
      idea('3', { title: 'Add a tag filter to the board', tags: [{ name: 'ui' }] }),
      idea('4', { title: 'Add a tag filter to the board', tags: [{ name: 'ui' }] }),
    ]
    const report = findIdeaSimilar(ideas, '1', 2)
    expect(report.scanned).toBe(3)
    // The exact-title pair is strongest; the truncated older one wins the tie.
    expect(report.candidates.map(candidate => candidate.id)).toEqual(['2', '3'])
    expect(report.candidates[0]!.score).toBeGreaterThan(report.candidates[1]!.score)
  })

  it('clamps the limit into 1..IDEAS_SIMILAR_MAX_CANDIDATES', () => {
    const many = Array.from({ length: 40 }, (_, index) => idea(String(index), { title: 'Add tag filter to the board' }))
    expect(findIdeaSimilar(many, '0', 0).candidates).toHaveLength(1)
    expect(findIdeaSimilar(many, '0', 9999).candidates).toHaveLength(IDEAS_SIMILAR_MAX_CANDIDATES)
    expect(findIdeaSimilar(many, '0', IDEAS_SIMILAR_MAX_CANDIDATES).candidates).toHaveLength(IDEAS_SIMILAR_MAX_CANDIDATES)
  })

  it('is deterministic for one revision', () => {
    const ideas = [idea('1'), idea('2'), idea('3'), idea('4')]
    expect(JSON.stringify(findIdeaSimilar(ideas, '1'))).toBe(JSON.stringify(findIdeaSimilar(ideas, '1')))
  })
})

describe('the similar flag is OPT-IN on the read path', () => {
  const snapshot = snapshotOf([
    idea('1', { title: 'Add tag filter to the board', workspaceId: 'ws-1' }),
    idea('2', { title: 'Add tag filter to the board', workspaceId: 'ws-1' }),
  ])

  it('the default full snapshot carries no similar block at all', () => {
    expect(JSON.stringify(snapshot)).not.toContain('similar')
    // The board's poll projection too: not one byte of this feature.
    expect(JSON.stringify(toListSnapshot(snapshot))).not.toContain('similar')
  })

  it('a bounded read without the key answers exactly as before', () => {
    const response = buildIdeasReadSnapshot(snapshot, { view: 'summary' })
    expect(response.similar).toBeUndefined()
    expect(JSON.stringify(response)).not.toContain('similar')
  })

  it('a bounded read WITH the key carries the report', () => {
    const response = buildIdeasReadSnapshot(snapshot, { view: 'summary', similar: '1', limit: 5 })
    expect(response.similar?.flagged).toBe(true)
    expect(response.similar?.candidates.map(candidate => candidate.id)).toEqual(['2'])
    expect(response.similar?.scanned).toBe(1)
    // The rows themselves are untouched: the report is additive.
    expect(response.ideas).toHaveLength(2)
  })

  it('an unknown anchor reports found:false rather than failing the read', () => {
    const response = buildIdeasReadSnapshot(snapshot, { view: 'summary', similar: 'nope' })
    expect(response.similar?.found).toBe(false)
  })

  it('parses and bounds the query key, and rejects a blank one', () => {
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&similar=idea-1'))?.similar).toBe('idea-1')
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&similar='))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&similar=%20'))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams(`view=summary&similar=${'x'.repeat(257)}`))).toBeUndefined()
    // An unknown key still rejects the whole query.
    expect(parseIdeasReadQuery(new URLSearchParams('view=summary&similarity=idea-1'))).toBeUndefined()
    expect(parseIdeasReadQuery(new URLSearchParams('view=full&similar=idea-1'))).toBeUndefined()
  })

  it('round-trips through the browser serializer', () => {
    const params = ideasReadSearchParams({ view: 'summary', similar: 'idea-1', limit: 8 })
    expect(params.get('similar')).toBe('idea-1')
    expect(parseIdeasReadQuery(params)?.similar).toBe('idea-1')
  })

  it('bounds the report through the requested limit', () => {
    const many = snapshotOf(Array.from({ length: 30 }, (_, index) => idea(String(index), { title: 'Add tag filter to the board', workspaceId: 'ws-1' })))
    expect(buildIdeasReadSnapshot(many, { view: 'summary', similar: '0', limit: 3 }).similar?.candidates).toHaveLength(3)
  })

  it('rejects an out-of-range similar in a programmatic read', () => {
    expect(() => buildIdeasReadSnapshot(snapshot, { view: 'summary', similar: '' })).toThrow('invalid-query')
  })
})

describe('the Find similar affordance gate', () => {
  const open = idea('1', { status: 'open', workspaceId: 'ws-1' })
  const gate = { hasLauncher: true, knownWorkspaceIds: new Set(['ws-1']) }

  it('offers the action only when a session could actually read the idea back', () => {
    expect(canFindSimilar(open, gate)).toBe(true)
  })

  it('refuses when the workspace is unknown to the app (the Re-analyze gate)', () => {
    expect(canFindSimilar(open, { hasLauncher: true, knownWorkspaceIds: new Set(['ws-2']) })).toBe(false)
  })

  it('refuses without a session launcher, and on a closed idea', () => {
    expect(canFindSimilar(open, { hasLauncher: false, knownWorkspaceIds: new Set(['ws-1']) })).toBe(false)
    expect(canFindSimilar(idea('2', { status: 'archived', workspaceId: 'ws-1' }), gate)).toBe(false)
    expect(canFindSimilar(idea('3', { status: 'underReview', workspaceId: 'ws-1' }), gate)).toBe(false)
  })

  it('refuses a workspace-less idea (no session can run there)', () => {
    expect(canFindSimilar(idea('4', { status: 'open' }), gate)).toBe(false)
    expect(canFindSimilar(idea('5', { status: 'open', workspaceId: '' }), gate)).toBe(false)
  })
})

describe('the Find similar launch input', () => {
  const anchor = idea('1', {
    status: 'open',
    workspaceId: 'ws-1',
    ideaNumber: 7,
    title: 'Add tag filter to the board',
    summary: 'A conjunctive tag filter',
    tags: [{ name: 'ui' }],
  })
  const report = findIdeaSimilar([
    anchor,
    idea('2', { title: 'Add tag filter to the board', workspaceId: 'ws-1' }),
    // Shares the anchor's label too, so this row reports BOTH signals.
    idea('3', { title: 'Add a tag filter to the board', workspaceId: 'ws-1', tags: [{ name: 'ui' }] }),
  ], '1')

  it('carries the bounded candidate set, the scan size and the picked model', () => {
    const input = buildFindSimilarInput(anchor, report, {
      workspaceTitle: 'Alpha',
      model: { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek' },
    })
    expect(input).toBeDefined()
    expect(input!.workspaceId).toBe('ws-1')
    expect(input!.workspaceTitle).toBe('Alpha')
    expect(input!.ideaId).toBe('1')
    expect(input!.ideaNumber).toBe(7)
    expect(input!.tags).toEqual(['ui'])
    expect(input!.candidates.map(candidate => candidate.id)).toEqual(['3', '2'])
    expect(input!.scanned).toBe(2)
    expect(input!.model?.model).toBe('deepseek-chat')
  })

  it('omits the model when the picker was left untouched', () => {
    expect(buildFindSimilarInput(anchor, report, { workspaceTitle: 'Alpha' })?.model).toBeUndefined()
  })

  it('refuses to build an input for a workspace-less idea', () => {
    expect(buildFindSimilarInput(idea('9', { status: 'open' }), report, { workspaceTitle: 'Alpha' })).toBeUndefined()
  })

  it('renders the fired signals as display words', () => {
    const views = similarCandidateViews(report, { title: 'Title', tags: 'Tags' })
    // Strongest first: the row sharing BOTH axes leads the list.
    expect(views.map(view => view.id)).toEqual(['3', '2'])
    // Each row reports the evidence it actually has, so a reader can weigh it.
    expect(views[0]!.signals).toEqual(['Title', 'Tags'])
    expect(views[1]!.signals).toEqual(['Title'])
  })
})

describe('the Find similar launch prompt', () => {
  const input = buildFindSimilarInput(
    idea('1', { status: 'open', workspaceId: 'ws-1', ideaNumber: 7, title: 'Add tag filter to the board', tags: [{ name: 'ui' }] }),
    findIdeaSimilar([
      idea('1', { status: 'open', workspaceId: 'ws-1', title: 'Add tag filter to the board' }),
      idea('2', { status: 'open', workspaceId: 'ws-1', ideaNumber: 9, title: 'Add a tag filter to the board' }),
    ], '1'),
    { workspaceTitle: 'Alpha' },
  )!
  const prompt = buildFindSimilarPrompt(input, 'http://127.0.0.1:3101')

  it('names the anchor, the workspace and the server origin', () => {
    expect(prompt).toContain('FIND SIMILAR')
    expect(prompt).toContain('"Alpha" (workspaceId ws-1)')
    expect(prompt).toContain('ideaId: 1')
    expect(prompt).toContain('#7')
    expect(prompt).toContain('http://127.0.0.1:3101')
    expect(prompt).toContain('Load the skill named "ideas-analyst"')
  })

  it('lists the bounded candidates with their ids, so the analyst can read each body', () => {
    expect(prompt).toContain('ideaId: 2')
    expect(prompt).toContain('Add a tag filter to the board')
    // The bodies are NOT inlined; the prompt names the exact deferred read.
    expect(prompt).toContain(`/api/ideas/idea?id=<candidate-id>`)
  })

  it('forbids every write, the merge verb above all', () => {
    expect(prompt).toContain('Write NOTHING')
    expect(prompt).toContain('NEVER use the merge verb')
    expect(prompt).toContain('never a merge you perform')
  })

  it('tells the analyst to distrust the score in BOTH directions', () => {
    expect(prompt).toContain('CHEAP SIGNAL')
    expect(prompt).toContain('Distrust it in both directions')
  })

  it('reports the scan size and demands a line per weighed candidate', () => {
    expect(prompt).toContain('1 open idea(s)')
    expect(prompt).toContain('For EVERY candidate you weighed')
    expect(prompt).toContain('Report and stop.')
  })

  it('stays inside the launch-prompt bound: no candidate body is inlined', () => {
    expect(input.candidates.length).toBeLessThanOrEqual(FIND_SIMILAR_CANDIDATE_LIMIT)
    expect(prompt).not.toContain('Do not load the full /state snapshot.\n\n=== Full')
  })

  it('the installed skill documents the merge verb and the find-similar rules', () => {
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('## Duplicates: the merge verb')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('"kind": "merge"')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('takeSourceRank')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('## Find similar runs (find-similar action)')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('NEVER the merge')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('DUPLICATE, RELATED BUT DISTINCT')
  })
})