/**
 * Idea #106 — generic relations between ideas (`relatesTo`, `blocks`, and the
 * DERIVED `blockedBy`).
 *
 * The brief for this idea is mostly about what must NOT change, so the suite is
 * ordered that way: the frozen wire first (the envelope, the full snapshot, the
 * stored key set), then the stored model, then the three places relations are
 * easy to forget — the merge, the delete and the import/export round trip.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  buildIdeasReadSnapshot,
  IDEAS_READ_SELECTABLE_FIELDS,
  IDEAS_SCHEMA_VERSION,
  parseActionEnvelope,
  parseIdeasReadQuery,
  toListSnapshot,
  type IdeaUpdatePatch,
} from '../src/protocol.ts'
import {
  IDEA_RELATION_LIMIT,
  blockCyclePath,
  blocksGraphOf,
  ideaBlockedBy,
  ideaRelatedTo,
  isIdeaRelationList,
  normalizeRelationIds,
  repointedRelationIds,
  type IdeaRecord,
} from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { IdeasHostService } from '../src/host-service.ts'
import { TaskBoardMirror, type TaskBoardActionEnvelope, type TaskBoardTransport } from '../src/taskboard-bridge.ts'
import { ideaToMarkdown } from '../src/export-markdown.ts'

const dirs: string[] = []
const opened: IdeasHostLedger[] = []

function freshDir(): string {
  const dir = join(tmpdir(), `ideas-relations-test-${process.pid}-${randomUUID()}`)
  dirs.push(dir)
  return dir
}

function freshLedger(now = 1000): IdeasHostLedger {
  const ledger = new IdeasHostLedger({ dir: freshDir(), now: () => now })
  opened.push(ledger)
  return ledger
}

afterEach(() => {
  while (opened.length > 0) {
    try { opened.pop()!.dispose() } catch { /* lock already released */ }
  }
  while (dirs.length > 0) dirs.pop()
})

const create = (id: string, title: string, workspaceId = 'ws-1') => ({
  kind: 'create' as const,
  id,
  input: { title, body: '', workspaceId },
})

const update = (ideaId: string, patch: IdeaUpdatePatch) => ({ kind: 'update' as const, ideaId, patch })

function row(ledger: IdeasHostLedger, id: string): IdeaRecord {
  const idea = ledger.snapshot().ideas.find(item => item.id === id)
  if (idea === undefined) throw new Error(`no idea ${id}`)
  return idea
}

/** Three linked ideas, so a cycle and a diamond are both expressible. */
function threeIdeas(ledger: IdeasHostLedger): void {
  ledger.applyRequest('c1', create('a', 'Alpha'))
  ledger.applyRequest('c2', create('b', 'Beta'))
  ledger.applyRequest('c3', create('c', 'Gamma'))
}

/** Every `blocks` edge of a document, as `from -> to` strings. */
function blockEdges(ledger: IdeasHostLedger): string[] {
  return ledger.snapshot().ideas.flatMap(idea =>
    (idea.blocks ?? []).map(target => `${idea.id}->${target}`))
}

/**
 * Fail on any cycle in the document's `blocks` graph. Written as a plain DFS
 * rather than reusing `blockCyclePath`: the helper answers "would this edge
 * close a loop", this one answers "is the graph as stored a DAG".
 */
function expectAcyclicBlocks(ledger: IdeasHostLedger): void {
  const graph = blocksGraphOf(ledger.snapshot().ideas)
  const walk = (node: string, path: readonly string[]): void => {
    expect(path).not.toContain(node)
    for (const next of graph.get(node) ?? []) walk(next, [...path, node])
  }
  for (const idea of ledger.snapshot().ideas) walk(idea.id, [])
}

/* --- the wire stays frozen ---------------------------------------------- */

describe('the frozen wire', () => {
  it('still accepts exactly {requestId, action, initiator} and nothing else', () => {
    const parsed = parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'update', ideaId: 'a', patch: { relatesTo: ['b'] } },
      initiator: 'agent:test',
    })
    expect(parsed?.action).toEqual({ kind: 'update', ideaId: 'a', patch: { relatesTo: ['b'] } })
    // The relations rode an existing verb's PATCH: no new verb, no new envelope
    // key, and the initiator still travels through verbatim (idea #92's rule).
    expect(parsed?.initiator).toBe('agent:test')
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'export' }, weight: 1 })).toBeUndefined()
    expect(parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'relations', ideaId: 'a' },
    })).toBeUndefined()
  })

  it('refuses `blockedBy` on the wire — it is derived, never stored', () => {
    // The whole point of the direction rule: accepting the inverse spelling
    // would create a second fact that nothing could reconcile.
    expect(parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'update', ideaId: 'a', patch: { blockedBy: ['b'] } },
    })).toBeUndefined()
  })

  it('accepts a well-formed relation list and refuses a malformed one', () => {
    const parse = (patch: unknown) => parseActionEnvelope({ requestId: 'r1', action: { kind: 'update', ideaId: 'a', patch } })
    expect(parse({ relatesTo: [] })).toBeDefined()
    expect(parse({ relatesTo: ['b'], blocks: null })).toBeDefined()
    expect(parse({ relatesTo: ['b', 42] })).toBeUndefined()
    expect(parse({ relatesTo: ['  '] })).toBeUndefined()
    expect(parse({ relatesTo: 'b' })).toBeUndefined()
    expect(parse({ blocks: Array.from({ length: IDEA_RELATION_LIMIT + 1 }, (_, i) => `idea-${i}`) })).toBeUndefined()
    expect(parse({ blocks: ['x'.repeat(257)] })).toBeUndefined()
    // The patch key set stays closed, exactly like every other verb.
    expect(parse({ relations: { relatesTo: ['b'] } })).toBeUndefined()
    expect(parse({ relatedTo: ['b'] })).toBeUndefined()
  })

  it('leaves the default full snapshot byte-identical on a board with no relation', () => {
    const ledger = freshLedger()
    ledger.applyRequest('r1', create('a', 'Alpha'))
    const snapshot = ledger.snapshot()
    // The frozen envelope is these three keys — not a new one.
    expect(Object.keys(snapshot).sort()).toEqual(['ideas', 'revision', 'schemaVersion'])
    expect(snapshot.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    expect(IDEAS_SCHEMA_VERSION).toBe(1)
    // And the record carries no relation key at all: a document written before
    // this feature simply has none, so nothing is back-filled. The list poll
    // (what the board actually fetches) is byte-identical too.
    expect(Object.keys(snapshot.ideas[0])).not.toContain('relatesTo')
    expect(Object.keys(snapshot.ideas[0])).not.toContain('blocks')
    expect(JSON.stringify(toListSnapshot(snapshot))).not.toMatch(/relatesTo|blocks|blockedBy/)
  })

  it('keeps `IDEAS_SCHEMA_VERSION` at 1 and back-fills nothing', () => {
    const ledger = freshLedger(2000)
    threeIdeas(ledger)
    expect(ledger.snapshot().schemaVersion).toBe(1)
    // An idea that has never been related to anything carries no key.
    expect('relatesTo' in row(ledger, 'b')).toBe(false)
    expect('blocks' in row(ledger, 'b')).toBe(false)
  })
})

/* --- the stored model ---------------------------------------------------- */

describe('stored relations', () => {
  it('writes `relatesTo` on BOTH endpoints in one commit', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    const revision = ledger.snapshot().revision
    ledger.applyRequest('r1', update('a', { relatesTo: ['b'] }))
    // One statement, one revision, both rows — a symmetric edge cannot be two
    // facts that drift apart.
    expect(ledger.snapshot().revision).toBe(revision + 1)
    expect(row(ledger, 'a').relatesTo).toEqual(['b'])
    expect(row(ledger, 'b').relatesTo).toEqual(['a'])
    expect(row(ledger, 'c').relatesTo).toBeUndefined()
    // ...and the derived read agrees with the stored one from either side.
    expect(ideaRelatedTo(ledger.snapshot().ideas, 'a')).toEqual(['b'])
    expect(ideaRelatedTo(ledger.snapshot().ideas, 'b')).toEqual(['a'])
  })

  it('drops the mirrored edge from the other row when the relation is removed', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { relatesTo: ['b'] }))
    ledger.applyRequest('r2', update('b', { relatesTo: [] }))
    expect(row(ledger, 'a').relatesTo).toBeUndefined()
    expect(row(ledger, 'b').relatesTo).toBeUndefined()
  })

  it('stores `blocks` in ONE direction and derives `blockedBy`', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { blocks: ['b'] }))
    expect(row(ledger, 'a').blocks).toEqual(['b'])
    // Only the edited row moved — there is no second row to keep in step.
    expect(row(ledger, 'b').blocks).toBeUndefined()
    expect('blockedBy' in row(ledger, 'b')).toBe(false)
    expect(ideaBlockedBy(ledger.snapshot().ideas, 'b')).toEqual(['a'])
    expect(ideaBlockedBy(ledger.snapshot().ideas, 'a')).toEqual([])
  })

  it('never stores an empty list — an absence is not a box', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { blocks: ['b'] }))
    ledger.applyRequest('r2', update('a', { blocks: null }))
    expect('blocks' in row(ledger, 'a')).toBe(false)
    expect(JSON.stringify(ledger.snapshot())).not.toContain('"blocks":[]')
  })

  it('refuses a self edge and an unknown target, with a reason, writing nothing', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    const revision = ledger.snapshot().revision
    expect(() => ledger.applyRequest('r1', update('a', { relatesTo: ['a'] })))
      .toThrow(/cannot point at the idea itself/)
    expect(() => ledger.applyRequest('r2', update('a', { blocks: ['a'] })))
      .toThrow(/cannot point at the idea itself/)
    expect(() => ledger.applyRequest('r3', update('a', { relatesTo: ['ghost'] })))
      .toThrow(/relation target not found/)
    expect(ledger.snapshot().revision).toBe(revision)
  })

  it('refuses a `blocks` cycle and NAMES the chain, writing nothing', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { blocks: ['b'] }))
    ledger.applyRequest('r2', update('b', { blocks: ['c'] }))
    const revision = ledger.snapshot().revision
    expect(() => ledger.applyRequest('r3', update('c', { blocks: ['a'] }))).toThrow(/cycle/)
    // A refusal a human can act on: the chain, by number and title.
    let message = ''
    try {
      ledger.applyRequest('r3b', update('c', { blocks: ['a'] }))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('#1')
    expect(message).toContain('#2')
    expect(message).toContain('#3')
    expect(ledger.snapshot().revision).toBe(revision)
    expect(row(ledger, 'c').blocks).toBeUndefined()
  })

  it('lets a diamond through: two blockers of the same idea is not a cycle', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { blocks: ['c'] }))
    ledger.applyRequest('r2', update('b', { blocks: ['c'] }))
    expect(row(ledger, 'a').blocks).toEqual(['c'])
    expect(row(ledger, 'b').blocks).toEqual(['c'])
    expect(ideaBlockedBy(ledger.snapshot().ideas, 'c')).toEqual(['a', 'b'])
  })
})

/* --- the three places relations are easy to forget ----------------------- */

describe('delete', () => {
  it('drops the edges that named the removed idea', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { relatesTo: ['b'] }))
    ledger.applyRequest('r2', update('c', { blocks: ['a'] }))
    ledger.applyRequest('r3', { kind: 'delete', ideaId: 'a' })

    // DROP, not tombstone: a deleted idea leaves no dangling id behind, so a
    // chip can never point at something nobody can open.
    expect(ledger.snapshot().ideas.map(idea => idea.id)).toEqual(['b', 'c'])
    expect('relatesTo' in row(ledger, 'b')).toBe(false)
    expect(row(ledger, 'c').blocks).toBeUndefined()
    expect(JSON.stringify(ledger.snapshot())).not.toContain('"a"')
  })
})

describe('merge', () => {
  it('re-points the loser edges at the survivor, inherits them, and never self-links', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { relatesTo: ['c'] }))
    ledger.applyRequest('r2', update('c', { blocks: ['a'] }))
    ledger.applyRequest('r3', { kind: 'merge', sourceId: 'a', targetId: 'b', mode: 'keepTargetRank' })

    // The edge that NAMED the loser now names the survivor — exactly as the
    // loser's follow-up children were re-pointed in the same commit.
    expect(row(ledger, 'c').blocks).toEqual(['b'])
    // The survivor INHERITS the edge the loser stated (the labels bargain): a
    // duplicate contributes what it has that the survivor lacks.
    expect(row(ledger, 'b').relatesTo).toEqual(['c'])
    expect(row(ledger, 'c').relatesTo).toContain('b')
    // The archived loser keeps its own lists, so restoring a merged card is
    // lossless — and its edges still name the survivor, which is why the
    // survivor sees the duplicate as related.
    expect(row(ledger, 'a').status).toBe('archived')
    expect(row(ledger, 'a').relatesTo).toEqual(['c'])
    expect(row(ledger, 'a').decision).toMatch(/#2/)
    // Nothing points at itself, anywhere.
    for (const idea of ledger.snapshot().ideas) {
      expect(idea.relatesTo ?? []).not.toContain(idea.id)
      expect(idea.blocks ?? []).not.toContain(idea.id)
    }
  })

  it('repairs — never renders — a cycle the re-point would close, and reports the drop', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { blocks: ['b'] }))
    ledger.applyRequest('r2', update('b', { blocks: ['c'] }))
    // Folding C into A re-points "B blocks C" to "B blocks A", which would close
    // A -> B -> A. A merge is a reconciliation, not a new statement: it drops
    // the offending edge rather than refusing the merge, and says so.
    ledger.applyRequest('r3', { kind: 'merge', sourceId: 'c', targetId: 'a', mode: 'keepTargetRank' })

    expect(blockEdges(ledger)).toEqual(['b->a'])
    expectAcyclicBlocks(ledger)
    expect(row(ledger, 'a').blocks).toBeUndefined()
    expect(row(ledger, 'c').decision).toMatch(/1 relation edge could not follow the merge/)
  })
})

describe('a hand-edited or imported document', () => {
  it('is repaired at boot: no self edge, no dangling target, symmetric, acyclic', () => {
    const dir = freshDir()
    // Open once so the directory and the lock exist exactly as a first boot
    // leaves them, then close and replace the document by hand.
    const first = new IdeasHostLedger({ dir, now: () => 1 })
    first.dispose()
    writeFileSync(join(dir, 'ledger-v2.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      ideaSequence: 3,
      importedSources: [],
      recentRequests: [],
      ideas: [
        { id: 'a', title: 'Alpha', body: '', status: 'open', createdAt: 1, updatedAt: 1, relatesTo: ['a', 'ghost'], blocks: ['b'] },
        { id: 'b', title: 'Beta', body: '', status: 'open', createdAt: 2, updatedAt: 2, blocks: ['a'] },
        { id: 'c', title: 'Gamma', body: '', status: 'open', createdAt: 3, updatedAt: 3, relatesTo: ['c'] },
      ],
    }))
    const ledger = new IdeasHostLedger({ dir, now: () => 5000 })
    opened.push(ledger)

    const byId = new Map(ledger.snapshot().ideas.map(idea => [idea.id, idea]))
    // The self edge, the unknown id and the self edge on C are all gone.
    expect(byId.get('a')!.relatesTo).toBeUndefined()
    expect(byId.get('c')!.relatesTo).toBeUndefined()
    // `blocks` is acyclic. A->B and B->A cannot both survive, and which one
    // goes is decided by document order — deterministic, which is all a repair
    // can honestly promise: this reader keeps B->A and drops A->B.
    expect(byId.get('b')!.blocks).toEqual(['a'])
    expect(byId.get('a')!.blocks).toBeUndefined()
    expectAcyclicBlocks(ledger)
  })

  it('carries relations through an `import` verb', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { relatesTo: ['b'] }))
    ledger.applyRequest('r2', update('c', { blocks: ['a'] }))
    const exported = ledger.snapshot().ideas

    const other = freshLedger()
    other.applyRequest('r1', { kind: 'import', sourceId: 'migration-1', ideas: exported })
    expect(row(other, 'a').relatesTo).toEqual(['b'])
    expect(row(other, 'b').relatesTo).toEqual(['a'])
    expect(row(other, 'c').blocks).toEqual(['a'])
  })
})

/* --- round trip ---------------------------------------------------------- */

describe('export / import round trip', () => {
  it('survives the portable JSON document, byte for byte', () => {
    const source = freshLedger(2000)
    threeIdeas(source)
    source.applyRequest('r1', update('a', { relatesTo: ['b', 'c'] }))
    source.applyRequest('r2', update('c', { blocks: ['a'] }))
    const exported = readFileSync(source.takeSnapshot('export').snapshot.path, 'utf8')
    const before = source.snapshot().ideas
    source.dispose()

    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    const target = new IdeasHostLedger({ dir, now: () => 2000 })
    opened.push(target)
    const outcome = target.restore({ document: exported })
    expect(outcome.ok).toBe(true)
    expect(target.snapshot().ideas).toEqual(before)
  })

  it('prints the stored direction in the markdown view', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { relatesTo: ['b'], blocks: ['c'] }))
    const markdown = ideaToMarkdown(row(ledger, 'a'))
    expect(markdown).toContain('- relates to: `b`')
    expect(markdown).toContain('- blocks: `c`')
    // The inverse is never printed as if it were stored.
    expect(markdown).not.toContain('blocked by')
  })
})

/* --- read projections ---------------------------------------------------- */

describe('bounded read projections', () => {
  it('`view=summary` carries relations by default — they are reference-shaped', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { relatesTo: ['b'], blocks: ['c'] }))
    const read = buildIdeasReadSnapshot(ledger.snapshot(), { view: 'summary' })
    const a = read.ideas.find(entry => entry.id === 'a')!
    expect(a.relatesTo).toEqual(['b'])
    expect(a.blocks).toEqual(['c'])
    expect(read.meta.omittedFields).not.toContain('relatesTo')
    expect(read.meta.omittedFields).not.toContain('blocks')
  })

  it('`fields=` still selects them away, and `omittedFields` says so', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { relatesTo: ['b'] }))
    const read = buildIdeasReadSnapshot(ledger.snapshot(), { view: 'summary', fields: ['relatesTo'] })
    const a = read.ideas.find(entry => entry.id === 'a')!
    expect(a.relatesTo).toEqual(['b'])
    expect('blocks' in a).toBe(false)
    expect(read.meta.omittedFields).toContain('blocks')
    expect(IDEAS_READ_SELECTABLE_FIELDS).toContain('relatesTo')
    expect(IDEAS_READ_SELECTABLE_FIELDS).toContain('blocks')
  })

  it('the derived `blockedBy` needs no wire field: it reads the stored direction', () => {
    const ledger = freshLedger()
    threeIdeas(ledger)
    ledger.applyRequest('r1', update('a', { blocks: ['b'] }))
    // Both rows come back — the blocked one carries no `blocks` of its own, and
    // the blocked-by answer comes from the blocker that was read alongside it.
    const read = buildIdeasReadSnapshot(ledger.snapshot(), { view: 'summary', ids: ['a', 'b'] })
    const b = read.ideas.find(entry => entry.id === 'b')!
    expect('blockedBy' in b).toBe(false)
    expect(ideaBlockedBy(read.ideas, 'b')).toEqual(['a'])
  })

  it('accepts the two new selectable field names on the query string', () => {
    const query = parseIdeasReadQuery(new URLSearchParams('view=summary&fields=relatesTo,blocks'))
    expect(query?.fields).toEqual(['relatesTo', 'blocks'])
  })
})

/* --- the TaskBoard mirror ------------------------------------------------ */

describe('the mirror decision', () => {
  /** In-memory task-board double (always 200; serves a mutable snapshot). */
  class FakeTaskBoard implements TaskBoardTransport {
    stateTasks: Array<{ id: string; status: string }> | undefined
    posts: TaskBoardActionEnvelope[] = []
    async getState() {
      return {
        status: 200,
        ...(this.stateTasks === undefined ? {} : { body: { schemaVersion: 3, revision: 1, tasks: this.stateTasks } }),
      }
    }
    async postAction(envelope: TaskBoardActionEnvelope) {
      this.posts.push(envelope)
      return { status: 200 }
    }
  }

  it('mirrors nothing for a relations-only patch, and still mirrors a mixed one', async () => {
    const board = new FakeTaskBoard()
    const service = new IdeasHostService({
      dir: freshDir(),
      mirror: new TaskBoardMirror({ transport: board }),
      autoMirror: true,
    })
    try {
      service.apply('r1', create('a', 'Alpha'))
      service.apply('r2', create('b', 'Beta'))
      await service.flushMirror()
      board.stateTasks = [{ id: 'idea-a', status: 'backlog' }, { id: 'idea-b', status: 'backlog' }]
      board.posts = []

      // A card shows neither a relation nor its direction, so a relations-only
      // edit must not spend a round trip — and must not attempt a content patch
      // on a card that has already run.
      service.apply('r3', update('a', { relatesTo: ['b'] }))
      await service.flushMirror()
      expect(board.posts).toEqual([])

      // A patch that also changes content is an ordinary update again.
      service.apply('r4', update('a', { title: 'Alpha renamed', blocks: ['b'] }))
      await service.flushMirror()
      expect(board.posts.map(post => post.action.kind)).toEqual(['update'])
    } finally {
      service.dispose()
    }
  })
})

/* --- pure helpers -------------------------------------------------------- */

describe('relation helpers', () => {
  it('normalizes a persisted list: trim, dedupe, cap, and nothing means undefined', () => {
    expect(normalizeRelationIds([' b ', 'a', 'b', ''])).toEqual(['b', 'a'])
    expect(normalizeRelationIds([])).toBeUndefined()
    expect(normalizeRelationIds('nope')).toBeUndefined()
    expect(normalizeRelationIds(Array.from({ length: 40 }, (_, i) => `i${i}`))).toHaveLength(IDEA_RELATION_LIMIT)
    expect(isIdeaRelationList([])).toBe(true)
    expect(isIdeaRelationList(['a', 'a'])).toBe(true)
    expect(isIdeaRelationList(['a', 1])).toBe(false)
  })

  it('re-points a list and drops the self edge the re-point would create', () => {
    expect(repointedRelationIds(['loser', 'x'], 'survivor', 'loser', 'survivor')).toEqual(['x'])
    expect(repointedRelationIds(['survivor'], 'survivor', 'loser', 'survivor')).toBeUndefined()
    expect(repointedRelationIds(undefined, 'survivor', 'loser', 'survivor')).toBeUndefined()
  })

  it('finds the chain a new edge would close', () => {
    const graph = blocksGraphOf([
      { id: 'a', title: 'A', body: '', status: 'open', createdAt: 0, updatedAt: 0, blocks: ['b'] },
      { id: 'b', title: 'B', body: '', status: 'open', createdAt: 0, updatedAt: 0, blocks: ['c'] },
      { id: 'c', title: 'C', body: '', status: 'open', createdAt: 0, updatedAt: 0 },
    ])
    expect(blockCyclePath(graph, 'c', 'a')).toEqual(['a', 'b', 'c'])
    expect(blockCyclePath(graph, 'a', 'c')).toBeUndefined()
    expect(blockCyclePath(graph, 'a', 'a')).toEqual(['a'])
  })
})
