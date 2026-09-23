/**
 * Deferred-body client tests (idea #34):
 *  - transport URLs: state() asks the LEAN ?view=list projection, stateFull()
 *    the untouched full snapshot (deep search), idea(id) one full record -
 *    while POST /api/ideas/action keeps its exact frozen wire (same URL,
 *    method, envelope) and is projected only CLIENT-side;
 *  - IdeasClient: the idle-poll revision bailout (same revision = same
 *    snapshot reference, emit still fired), the fetchIdea cache with its
 *    updatedAt self-invalidation, and the once-per-revision search index.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpIdeasHostTransport, type IdeasHostTransport } from '../src/client/host-api.ts'
import { IdeasClient } from '../src/client/ideas-client.ts'
import {
  IDEAS_API_PREFIX,
  IDEAS_SCHEMA_VERSION,
  toListSnapshot,
  type IdeaListRow,
  type IdeasActionEnvelope,
  type IdeasListSnapshot,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function fullSnapshot(revision: number, ideas: IdeaRecord[]): IdeasSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision, ideas }
}

function row(id: string, updatedAt: number, extra: Partial<IdeaListRow> = {}): IdeaListRow {
  return {
    id,
    title: `Title ${id}`,
    status: 'open',
    createdAt: 1,
    updatedAt,
    bodyExcerpt: `excerpt of ${id}`,
    ...extra,
  }
}

function list(revision: number, ideas: IdeaListRow[]): IdeasListSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision, ideas }
}

/** Stub global fetch with a JSON handler; returns the call recorder. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const payload = handler(String(input), init)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('HttpIdeasHostTransport read projections', () => {
  it('state() asks ?view=list, stateFull() asks the untouched default', async () => {
    const seen: string[] = []
    stubFetch(url => {
      seen.push(url)
      return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }
    })
    const transport = new HttpIdeasHostTransport()
    await transport.state()
    await transport.stateFull()
    expect(seen).toEqual([
      `${IDEAS_API_PREFIX}/state?view=list`,
      `${IDEAS_API_PREFIX}/state`,
    ])
  })

  it('idea(id) fetches ONE full record, encoding the id', async () => {
    const seen: string[] = []
    stubFetch(url => {
      seen.push(url)
      return { id: 'a b', title: 'T', body: 'the whole body', status: 'open', createdAt: 1, updatedAt: 2 }
    })
    const transport = new HttpIdeasHostTransport()
    const record = await transport.idea!('a b')
    expect(seen).toEqual([`${IDEAS_API_PREFIX}/idea?id=${encodeURIComponent('a b')}`])
    expect(record.body).toBe('the whole body')
  })

  it('action() keeps the frozen POST wire and projects only the response', async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined
    const full = fullSnapshot(9, [{
      id: 'idea-1',
      title: 'T',
      body: 'voluminous',
      status: 'open',
      createdAt: 1,
      updatedAt: 2,
      analysisAudit: { at: 1, title: 'p', body: 'b' },
    }])
    stubFetch((url, init) => {
      captured = { url, init }
      return full
    })
    const transport = new HttpIdeasHostTransport()
    const result = await transport.action({ kind: 'triage', ideaId: 'idea-1', patch: { rank: 1 } }, 'test-initiator')

    // The WIRE is untouched: same path, method, envelope shape (requestId +
    // action + initiator) any pre-idea#34 client would send.
    expect(captured!.url).toBe(`${IDEAS_API_PREFIX}/action`)
    expect((captured!.init!.method ?? 'GET').toUpperCase()).toBe('POST')
    const body = JSON.parse(String(captured!.init!.body)) as IdeasActionEnvelope
    expect(typeof body.requestId).toBe('string')
    expect(body.requestId.length).toBeGreaterThan(0)
    expect(body.action).toEqual({ kind: 'triage', ideaId: 'idea-1', patch: { rank: 1 } })
    expect(body.initiator).toBe('test-initiator')

    // The RESPONSE is projected at the transport edge: the client never
    // holds bodies from the action channel either.
    expect(result.revision).toBe(9)
    expect(result.ideas[0]!.bodyExcerpt).toBe('voluminous')
    expect('body' in result.ideas[0]!).toBe(false)
    expect('analysisAudit' in result.ideas[0]!).toBe(false)
  })
})

/** Client-side fake with the full optional capability set. */
class RichTransport implements IdeasHostTransport {
  stateResponse: IdeasListSnapshot = list(1, [])
  actionResponse: IdeasListSnapshot | undefined
  fullSnapshot: IdeasSnapshot | undefined
  stateCalls = 0
  actionCalls = 0
  fullCalls = 0
  ideaCalls = 0
  records = new Map<string, IdeaRecord>()

  async state(): Promise<IdeasListSnapshot> {
    this.stateCalls += 1
    return this.stateResponse
  }

  async action(): Promise<IdeasListSnapshot> {
    this.actionCalls += 1
    return this.actionResponse ?? this.stateResponse
  }

  async stateFull(): Promise<IdeasSnapshot> {
    this.fullCalls += 1
    if (this.fullSnapshot === undefined) throw new Error('no full snapshot')
    return this.fullSnapshot
  }

  async idea(id: string): Promise<IdeaRecord> {
    this.ideaCalls += 1
    const record = this.records.get(id)
    if (record === undefined) throw new Error('not-found')
    return record
  }

  subscribe(): () => void {
    return () => {}
  }
}

/** Client-side fake WITHOUT the optional read capabilities. */
class BareTransport implements IdeasHostTransport {
  async state(): Promise<IdeasListSnapshot> { return list(1, []) }
  async action(): Promise<IdeasListSnapshot> { return list(1, []) }
  subscribe(): () => void { return () => {} }
}

describe('IdeasClient idle-poll bailout (revision fence)', () => {
  it('keeps the SAME snapshot reference - and stays silent - on an idle poll', async () => {
    const transport = new RichTransport()
    transport.stateResponse = list(4, [row('a', 100)])
    const client = new IdeasClient(transport, undefined)
    const listener = vi.fn()
    client.subscribe(listener)

    await client.refresh()
    const first = client.snapshot
    expect(first).toBeDefined()
    expect(transport.stateCalls).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)

    // Same revision, fresh object (like a real re-parse of an idle poll):
    // the reference is kept AND no subscriber is woken (zero re-render).
    transport.stateResponse = list(4, [row('a', 100)])
    await client.refresh()
    expect(transport.stateCalls).toBe(2)
    expect(client.snapshot).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)

    // A revision bump notifies again.
    transport.stateResponse = list(5, [row('a', 100)])
    await client.refresh()
    expect(client.snapshot).not.toBe(first)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('emits on an error transition even without a snapshot change', async () => {
    const transport = new RichTransport()
    transport.stateResponse = list(1, [])
    const client = new IdeasClient(transport, undefined)
    const listener = vi.fn()
    client.subscribe(listener)
    await client.refresh()
    expect(listener).toHaveBeenCalledTimes(1)

    // A failing idle poll surfaces the error bar...
    const boom = new Error('boom')
    transport.state = async () => { throw boom }
    await client.refresh()
    expect(client.error).toBe('boom')
    expect(listener).toHaveBeenCalledTimes(2)

    // ...and the recovery clears it (another observable transition).
    transport.state = async () => list(1, [])
    await client.refresh()
    expect(client.error).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('adopts a new reference on a revision bump', async () => {
    const transport = new RichTransport()
    transport.stateResponse = list(4, [row('a', 100)])
    const client = new IdeasClient(transport, undefined)
    await client.refresh()
    const first = client.snapshot

    transport.stateResponse = list(5, [row('a', 101), row('b', 101)])
    await client.refresh()
    expect(client.snapshot).not.toBe(first)
    expect(client.snapshot!.revision).toBe(5)
    expect(client.snapshot!.ideas).toHaveLength(2)
  })

  it('keeps the reference when an action replays the current revision', async () => {
    const transport = new RichTransport()
    transport.stateResponse = list(7, [row('a', 100)])
    const client = new IdeasClient(transport, undefined)
    await client.refresh()
    const first = client.snapshot

    // A replayed/duplicate request id returns the CURRENT state untouched.
    transport.actionResponse = list(7, [row('a', 100)])
    await client.triageIdea('a', { rank: 1 })
    expect(client.snapshot).toBe(first)

    // A real commit lands as a new reference.
    transport.actionResponse = list(8, [row('a', 100)])
    await client.triageIdea('a', { rank: 2 })
    expect(client.snapshot).not.toBe(first)
    expect(client.snapshot!.revision).toBe(8)
  })
})

describe('IdeasClient deferred body (fetchIdea)', () => {
  it('serves the cached record until the row updatedAt moves', async () => {
    const transport = new RichTransport()
    transport.records.set('a', { id: 'a', title: 'T', body: 'v1', status: 'open', createdAt: 1, updatedAt: 100 })
    const client = new IdeasClient(transport, undefined)

    const first = await client.fetchIdea({ id: 'a', updatedAt: 100 })
    expect(first.body).toBe('v1')
    expect(await client.fetchIdea({ id: 'a', updatedAt: 100 })).toBe(first)
    expect(transport.ideaCalls).toBe(1)

    // A newer row (post-commit stamp) invalidates the entry.
    transport.records.set('a', { id: 'a', title: 'T', body: 'v2', status: 'open', createdAt: 1, updatedAt: 200 })
    const fresh = await client.fetchIdea({ id: 'a', updatedAt: 200 })
    expect(fresh.body).toBe('v2')
    expect(transport.ideaCalls).toBe(2)
    expect(client.cachedBodyOf('a')).toBe('v2')
  })

  it('rejects with body-unavailable when the transport has no idea()', async () => {
    const client = new IdeasClient(new BareTransport(), undefined)
    await expect(client.fetchIdea({ id: 'a', updatedAt: 1 })).rejects.toThrow('body-unavailable')
    expect(client.cachedBodyOf('a')).toBeUndefined()
  })
})

describe('IdeasClient deep-search index', () => {
  it('fills the body cache once per revision', async () => {
    const transport = new RichTransport()
    transport.stateResponse = list(3, [row('a', 100), row('b', 100)])
    transport.fullSnapshot = fullSnapshot(3, [
      { id: 'a', title: 'TA', body: 'deep body a', status: 'open', createdAt: 1, updatedAt: 100 },
      { id: 'b', title: 'TB', body: 'deep body b', status: 'open', createdAt: 1, updatedAt: 100 },
    ])
    const client = new IdeasClient(transport, undefined)
    await client.refresh()

    await client.ensureSearchIndex()
    expect(transport.fullCalls).toBe(1)
    expect(client.cachedBodyOf('a')).toBe('deep body a')
    expect(client.cachedBodyOf('b')).toBe('deep body b')

    // Same revision: no reload (the index is complete for this state).
    await client.ensureSearchIndex()
    expect(transport.fullCalls).toBe(1)

    // A new revision invalidates the index.
    transport.stateResponse = list(4, [row('a', 200)])
    await client.refresh()
    await client.ensureSearchIndex()
    expect(transport.fullCalls).toBe(2)
  })

  it('degrades silently without the capability and never rejects on failure', async () => {
    const bareClient = new IdeasClient(new BareTransport(), undefined)
    bareClient.snapshot = list(1, [])
    await expect(bareClient.ensureSearchIndex()).resolves.toBeUndefined()
    expect(bareClient.cachedBodyOf('a')).toBeUndefined()

    const failing = new RichTransport()
    failing.fullSnapshot = undefined // stateFull() throws
    const client = new IdeasClient(failing, undefined)
    client.snapshot = list(1, [])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(client.ensureSearchIndex()).resolves.toBeUndefined()
      expect(failing.fullCalls).toBe(1)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('projects the full snapshot before caching (rows lose bodies too)', async () => {
    const transport = new RichTransport()
    transport.stateResponse = list(2, [row('x', 5)])
    transport.fullSnapshot = fullSnapshot(2, [
      { id: 'x', title: 'TX', body: 'whole', status: 'open', createdAt: 1, updatedAt: 5 },
    ])
    const client = new IdeasClient(transport, undefined)
    await client.refresh()
    await client.ensureSearchIndex()
    // The SNAPSHOT stays a projection; only the body cache carries bodies.
    expect('body' in client.snapshot!.ideas[0]!).toBe(false)
    expect(toListSnapshot(transport.fullSnapshot).ideas[0]!.bodyExcerpt).toBe('whole')
    expect(client.cachedBodyOf('x')).toBe('whole')
  })
})
