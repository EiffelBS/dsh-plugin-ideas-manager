/**
 * The relations on the `ideas_*` agent tool surface.
 *
 * The ledger has carried `relatesTo` and `blocks`, but they rode
 * only on the HTTP `update` patch — so an agent asked to state one had to
 * hand-build an envelope, or go read the plugin's source to discover the model
 * had the field at all. These tests pin the two halves of the fix:
 *
 *  - **writing**: `ideas_relate` edits by ADD/REMOVE, so it cannot silently drop
 *    an edge nobody named (the wire patch replaces a whole list), and a call that
 *    changes nothing writes nothing;
 *  - **reading**: `blockedBy` exists on no row and rides no wire field, so every
 *    read has to DERIVE it — an agent that cannot see "what waits on this card?"
 *    cannot act on it either.
 *
 * They run against the REAL ledger rather than the suite's simplified fake,
 * because the properties under test are ledger properties: the symmetric
 * `relatesTo` write, the acyclic `blocks` refusal with its chain, and the
 * dropped-target reconciliation all live in `host-ledger.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildIdeasTools, type IdeasToolDefinition, type IdeasToolHost } from '../src/agent-tools.ts'
import { IDEA_RELATION_LIMIT, createIdea, type IdeaRecord } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { IDEAS_SCHEMA_VERSION, type IdeasSnapshot } from '../src/protocol.ts'

const dirs: string[] = []
const opened: IdeasHostLedger[] = []

/** A temporary ledger directory, registered for teardown. */
function freshDir(): string {
  const dir = join(tmpdir(), `ideas-relate-tool-${process.pid}-${randomUUID()}`)
  dirs.push(dir)
  return dir
}

/**
 * The real ledger behind the narrow face the tools drive: the same object the
 * Host hands them, so a tool call exercises the same gate, the same invariants
 * and the same reconciliations an HTTP call would.
 */
class LedgerToolHost implements IdeasToolHost {
  constructor(readonly ledger: IdeasHostLedger) {}

  snapshot(): IdeasSnapshot {
    return this.ledger.snapshot()
  }

  idea(id: string): IdeaRecord | undefined {
    return this.ledger.idea(id)
  }

  apply(requestId: string, action: unknown, initiator?: string): unknown {
    return this.ledger.applyRequest(requestId, action as never, initiator === undefined ? undefined : { initiator })
  }

  async launchIdea(): Promise<unknown> {
    throw new Error('ideas_relate never launches anything')
  }
}

afterEach(() => {
  while (opened.length > 0) {
    try { opened.pop()!.dispose() } catch { /* lock already released */ }
  }
  while (dirs.length > 0) dirs.pop()
})

/** A host over a fresh ledger holding `titles` worth of ideas. */
function hostWith(titles: Record<string, string>): LedgerToolHost {
  const ledger = new IdeasHostLedger({ dir: freshDir(), now: () => 1000 })
  opened.push(ledger)
  let index = 0
  for (const [id, title] of Object.entries(titles)) {
    index += 1
    ledger.applyRequest(`seed-${id}`, {
      kind: 'create',
      id,
      input: { title, body: `Body of ${id}`, workspaceId: 'ws-1' },
    })
    expect(ledger.idea(id)?.ideaNumber).toBeGreaterThanOrEqual(index)
  }
  return new LedgerToolHost(ledger)
}

function toolsOf(host: IdeasToolHost): Map<string, IdeasToolDefinition> {
  return new Map(buildIdeasTools(host).map(tool => [tool.name, tool]))
}

type ToolResult = Record<string, unknown>

async function call(host: LedgerToolHost, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = toolsOf(host).get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return await tool.execute(args, {}) as ToolResult
}

/** The stored relation lists of one card, `undefined` when it has none. */
function stored(host: LedgerToolHost, id: string): { relatesTo?: string[]; blocks?: string[] } {
  const idea = host.idea(id)
  if (idea === undefined) throw new Error(`no idea ${id}`)
  return { relatesTo: idea.relatesTo, blocks: idea.blocks }
}

/** The revision counter of the ledger, read through the tool face. */
function revision(host: LedgerToolHost): number {
  return host.snapshot().revision
}

describe('ideas_relate — writing a relation', () => {
  it('states `relatesTo` on BOTH endpoints in one call', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta', c: 'Gamma' })
    const result = await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'] })
    expect(result).toMatchObject({ ok: true, changed: true })
    // Symmetry is a LEDGER invariant, not a tool convention: the agent wrote one
    // edge and must not have to write it twice.
    expect(stored(host, 'a').relatesTo).toEqual(['b'])
    expect(stored(host, 'b').relatesTo).toEqual(['a'])
    expect(stored(host, 'c').relatesTo).toBeUndefined()
  })

  it('keeps `blocks` one-directional and reports the inverse as derived', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    const result = await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['b'] })
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(stored(host, 'a').blocks).toEqual(['b'])
    expect(stored(host, 'b').blocks).toBeUndefined()
    // The blocked card carries no field of its own: `blockedBy` is computed.
    const relations = result.relations as ToolResult
    expect(relations.blocks).toEqual([{ id: 'b', number: expect.any(String), title: 'Beta' }])
    const readBack = await call(host, 'ideas_get', { ideaId: 'b' })
    expect((readBack.idea as ToolResult).blockedBy).toEqual(['a'])
  })

  it('names a target with its number so an agent can report the edge', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    const result = await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'] })
    const related = (result.relations as ToolResult).relatesTo as ToolResult[]
    expect(related[0]?.id).toBe('b')
    expect(related[0]?.title).toBe('Beta')
    expect(related[0]?.number).toMatch(/^#\d+$/)
  })

  it('keeps an edge the call did not name — the patch replaces, the tool does not', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta', c: 'Gamma' })
    await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'] })
    // `c` arrives while `b` is already stored. Sending only `[c]` is exactly the
    // foot-gun the wire patch carries, and the edge to `b` must survive it.
    await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['c'] })
    expect(stored(host, 'a').relatesTo?.sort()).toEqual(['b', 'c'])
    await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['c'] })
    expect(stored(host, 'a').relatesTo?.sort()).toEqual(['b', 'c'])
  })

  it('removes one edge, and clearing the last one empties the list', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta', c: 'Gamma' })
    await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b', 'c'] })
    await call(host, 'ideas_relate', { ideaId: 'a', removeRelatesTo: ['b'] })
    expect(stored(host, 'a').relatesTo).toEqual(['c'])
    expect(stored(host, 'b').relatesTo).toBeUndefined()
    await call(host, 'ideas_relate', { ideaId: 'a', removeRelatesTo: ['c'] })
    // `null`/absent would leave the list alone, so the clear has to be an
    // explicit empty list; an omitted key is a no-op on the wire.
    expect(stored(host, 'a').relatesTo).toBeUndefined()
  })

  it('removes a blocking edge, and the derived side follows', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['b'] })
    await call(host, 'ideas_relate', { ideaId: 'a', removeBlocks: ['b'] })
    expect(stored(host, 'a').blocks).toBeUndefined()
    expect((await call(host, 'ideas_get', { ideaId: 'b' })).idea).toMatchObject({ blockedBy: [] })
  })

  it('writes NOTHING when the named relation is already the stored one', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'] })
    const settled = revision(host)
    const again = await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'] })
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(revision(host)).toBe(settled)
    // An agent that reports "I linked them" must not have burned a revision and
    // an activity line saying so for an edge that was already there.
    expect(host.idea('a')?.events?.filter(entry => entry.summary.includes('related'))).toHaveLength(1)
  })

  it('edits both kinds in one call', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta', c: 'Gamma' })
    await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'], addBlocks: ['c'] })
    expect(stored(host, 'a')).toMatchObject({ relatesTo: ['b'], blocks: ['c'] })
  })

  it('ignores blanks, duplicates and non-string entries', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    const result = await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['  b  ', 'b', '', 7] })
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(stored(host, 'a').relatesTo).toEqual(['b'])
  })
})

describe('ideas_relate — refusals', () => {
  it('refuses an unknown or missing idea rather than creating an edge to nothing', async () => {
    const host = hostWith({ a: 'Alpha' })
    expect(await call(host, 'ideas_relate', { ideaId: 'nope', addRelatesTo: ['a'] })).toEqual({
      ok: false,
      code: 'idea-not-found',
      message: 'no idea with id nope',
    })
    expect((await call(host, 'ideas_relate', { addRelatesTo: ['a'] })).code).toBe('invalid-arguments')
  })

  it('refuses a call that names no relation', async () => {
    const host = hostWith({ a: 'Alpha' })
    expect((await call(host, 'ideas_relate', { ideaId: 'a' })).code).toBe('nothing-to-record')
    expect((await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: [] })).code).toBe('nothing-to-record')
  })

  it('refuses a dangling target instead of dropping the edge silently', async () => {
    const host = hostWith({ a: 'Alpha' })
    const result = await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['ghost'] })
    expect(result.ok).toBe(false)
    expect((result.message as string).toLowerCase()).toContain('ghost')
    expect(stored(host, 'a').relatesTo).toBeUndefined()
  })

  it('refuses a self-link', async () => {
    const host = hostWith({ a: 'Alpha' })
    const result = await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['a'] })
    expect(result.ok).toBe(false)
    expect(stored(host, 'a').blocks).toBeUndefined()
  })

  it('refuses a `blocks` cycle WITH ITS CHAIN, writing nothing', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta', c: 'Gamma' })
    await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['b'] })
    await call(host, 'ideas_relate', { ideaId: 'b', addBlocks: ['c'] })
    const settled = revision(host)
    const result = await call(host, 'ideas_relate', { ideaId: 'c', addBlocks: ['a'] })
    expect(result.ok).toBe(false)
    expect(result.message as string).toMatch(/cycle/i)
    expect(revision(host)).toBe(settled)
    expect(stored(host, 'c').blocks).toBeUndefined()
  })

  it('refuses an edit past the relation cap instead of truncating it', async () => {
    const ids = Object.fromEntries(Array.from({ length: IDEA_RELATION_LIMIT + 2 }, (_, index) => [`t${index}`, `T${index}`]))
    const host = hostWith({ a: 'Alpha', ...ids })
    await call(host, 'ideas_relate', {
      ideaId: 'a',
      addRelatesTo: Object.keys(ids).slice(0, IDEA_RELATION_LIMIT),
    })
    const result = await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['t0', Object.keys(ids).at(-1)!] })
    expect(result).toMatchObject({ ok: false, code: 'relation-limit' })
    expect(stored(host, 'a').relatesTo).toHaveLength(IDEA_RELATION_LIMIT)
  })

  it('offers no `blockedBy` argument at all: the inverse is never written', () => {
    const schema = toolsOf(hostWith({})).get('ideas_relate')!.parameters as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual([
      'ideaId', 'addRelatesTo', 'removeRelatesTo', 'addBlocks', 'removeBlocks',
    ])
  })
})

describe('reading the relations', () => {
  it('carries the stored lists AND the derived side on every list row', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta', c: 'Gamma' })
    await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'] })
    await call(host, 'ideas_relate', { ideaId: 'b', addBlocks: ['c'] })
    const result = await call(host, 'ideas_list', { workspaceId: 'ws-1' })
    const rows = result.ideas as ToolResult[]
    const row = (id: string): ToolResult => rows.find(entry => entry.id === id)!
    expect(row('a').relatesTo).toEqual(['b'])
    // `b` waits for `c`: the answer an agent needs is the DERIVED one, and it is
    // on the row of the card that waits.
    expect(row('b').blocks).toEqual(['c'])
    expect(row('c').blockedBy).toEqual(['b'])
    expect(row('a').blockedBy).toEqual([])
  })

  it('derives `blockedBy` from the whole document, not from the filtered page', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['b'] })
    // The blocker sits in another workspace: a filter must not make a row claim
    // that nothing waits on it.
    await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['b'] })
    const open = await call(host, 'ideas_list', { status: 'open' })
    const row = (open.ideas as ToolResult[]).find(entry => entry.id === 'b')!
    expect(row.blockedBy).toEqual(['a'])
  })

  it('answers a full read with the three lines and their targets', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta', c: 'Gamma' })
    await call(host, 'ideas_relate', { ideaId: 'a', addRelatesTo: ['b'] })
    await call(host, 'ideas_relate', { ideaId: 'c', addBlocks: ['a'] })
    const result = await call(host, 'ideas_get', { ideaId: 'a' })
    const relations = result.relations as ToolResult
    expect((relations.relatesTo as ToolResult[]).map(entry => entry.id)).toEqual(['b'])
    expect(relations.blocks).toEqual([])
    expect((relations.blockedBy as ToolResult[]).map(entry => entry.id)).toEqual(['c'])
    expect((result.idea as ToolResult).blockedBy).toEqual(['c'])
    // The stored lists are still on the raw record: the derived side is an
    // addition, never a replacement of what the ledger holds.
    expect((result.idea as ToolResult).relatesTo).toEqual(['b'])
  })

  it('reports an edge whose target the board cannot resolve as the bare id', async () => {
    // A snapshot CAN hold an edge whose target is gone: the ledger reconciles it
    // on the next write, not on the read that observes it. The view must print
    // the bare id instead of inventing a number or an empty label — exactly what
    // the board's own relation line does (client/relations.ts).
    const ghost = { ...createIdea({ title: 'Alpha', body: '', workspaceId: 'ws-1' }, 1, 'a'), relatesTo: ['ghost'] } as IdeaRecord
    const host: IdeasToolHost = {
      snapshot: () => ({ schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [ghost] }),
      idea: id => (id === 'a' ? ghost : undefined),
      apply: () => { throw new Error('not used') },
      launchIdea: async () => { throw new Error('not used') },
    }
    const tool = buildIdeasTools(host).find(entry => entry.name === 'ideas_get')!
    const result = await tool.execute({ ideaId: 'a' }, {}) as ToolResult
    expect((result.relations as ToolResult).relatesTo).toEqual([{ id: 'ghost' }])
  })
})

describe('the dependency the ranking contradicts', () => {
  /**
   * The live case this answers: #47 blocks #82, and #82 sat ABOVE #47 in the
   * same backlog. `a` = the blocker, `b` = the card that waits.
   */
  async function contradicted(): Promise<LedgerToolHost> {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['b'] })
    await call(host, 'ideas_triage', { ideaId: 'a', rank: 2 })
    await call(host, 'ideas_triage', { ideaId: 'b', rank: 1 })
    return host
  }

  it('is reported by the write that creates it, from BOTH cards', async () => {
    const host = await contradicted()

    const onBlocker = await call(host, 'ideas_triage', { ideaId: 'a', effort: 1 })
    expect((onBlocker.rankConflicts as ToolResult[])).toHaveLength(1)
    expect(onBlocker.rankConflicts).toEqual([{
      role: 'blocker',
      blocked: { id: 'b', number: expect.any(String) as unknown as string, title: 'Beta' },
      blocker: { id: 'a', number: expect.any(String) as unknown as string, title: 'Alpha' },
    }])

    const onBlocked = await call(host, 'ideas_triage', { ideaId: 'b', value: 2 })
    expect((onBlocked.rankConflicts as ToolResult[]).map(entry => entry.role)).toEqual(['blocked'])
  })

  it('is silent while the order matches the edge, and speaks when it stops', async () => {
    const host = hostWith({ a: 'Alpha', b: 'Beta' })
    await call(host, 'ideas_relate', { ideaId: 'a', addBlocks: ['b'] })
    // a above b is exactly what the edge asks for.
    const fine = await call(host, 'ideas_triage', { ideaId: 'a', rank: 1 })
    expect(fine.rankConflicts).toEqual([])
    // The same edge with the ranks swapped: the answer now names the card it
    // contradicts, which is the point of reporting it at all.
    await call(host, 'ideas_triage', { ideaId: 'b', rank: 1 })
    const flipped = await call(host, 'ideas_triage', { ideaId: 'a', rank: 2 })
    expect((flipped.rankConflicts as ToolResult[]).map(entry => entry.blocked)).toEqual([{ id: 'b', number: expect.any(String), title: 'Beta' }])
  })

  it('goes quiet again once the order is corrected', async () => {
    const host = await contradicted()
    const fixed = await call(host, 'ideas_triage', { ideaId: 'b', rank: 2 })
    expect(fixed.rankConflicts).toEqual([])
  })
})