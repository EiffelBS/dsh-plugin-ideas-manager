/** Client surface for bounded reads (idea #65): delegation, URL encoding,
 * compatibility fallback, and the frozen board snapshot remaining untouched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpIdeasHostTransport, type IdeasHostTransport } from '../src/client/host-api.ts'
import { IdeasClient } from '../src/client/ideas-client.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasReadQuery,
  type IdeasReadSnapshot,
} from '../src/protocol.ts'

class ReadTransport implements IdeasHostTransport {
  query: IdeasReadQuery | undefined
  readCalls = 0

  async state(): Promise<IdeasListSnapshot> {
    return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }
  }

  async action(_action: IdeasAction): Promise<IdeasListSnapshot> {
    return await this.state()
  }

  async read(query: IdeasReadQuery = {}): Promise<IdeasReadSnapshot> {
    this.readCalls += 1
    this.query = query
    return {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 9,
      ideas: [{ id: 'idea-1', title: 'Target', status: 'open', createdAt: 1, updatedAt: 2 }],
      meta: {
        view: query.view ?? 'summary', fields: [], bodyLimitBytes: 0,
        limit: 100, offset: 0, matched: 1, returned: 1,
        rowTruncated: false, nextOffset: null, bodyTruncated: false, omittedFields: [],
      },
    }
  }

  subscribe(listener: (event?: IdeasEventPayload) => void): () => void {
    return () => { void listener }
  }
}

class BareTransport implements IdeasHostTransport {
  async state(): Promise<IdeasListSnapshot> {
    return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }
  }
  async action(_action: IdeasAction): Promise<IdeasListSnapshot> {
    return await this.state()
  }
  subscribe(): () => void {
    return () => { /* no polling */ }
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('IdeasClient bounded reads', () => {
  it('delegates a read without mutating the board snapshot', async () => {
    const transport = new ReadTransport()
    const client = new IdeasClient(transport, undefined)
    const result = await client.readIdeas({ workspaceId: 'ws one', status: ['open'], limit: 25 })
    expect(transport.readCalls).toBe(1)
    expect(transport.query).toEqual({ workspaceId: 'ws one', status: ['open'], limit: 25 })
    expect(result.revision).toBe(9)
    expect(client.snapshot).toBeUndefined()
  })

  it('degrades explicitly when a transport has no bounded-read capability', async () => {
    const client = new IdeasClient(new BareTransport(), undefined)
    await expect(client.readIdeas()).rejects.toThrow('read-view-unavailable')
  })
})

describe('HttpIdeasHostTransport bounded reads', () => {
  it('encodes summary filters and fields into the additive state query', async () => {
    let requested = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      requested = String(url)
      return new Response(JSON.stringify({
        schemaVersion: IDEAS_SCHEMA_VERSION,
        revision: 12,
        ideas: [],
        meta: {
          view: 'summary', fields: ['summary'], bodyLimitBytes: 0, limit: 20,
          offset: 0, matched: 0, returned: 0, rowTruncated: false,
          nextOffset: null, bodyTruncated: false, omittedFields: [],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const result = await new HttpIdeasHostTransport().read({
      view: 'summary',
      workspaceId: 'ws one',
      status: ['open', 'archived'],
      ids: ['idea a'],
      fields: ['summary'],
      limit: 20,
      offset: 5,
    })
    expect(requested).toBe('/api/ideas/state?view=summary&workspaceId=ws+one&status=open&status=archived&id=idea+a&fields=summary&limit=20&offset=5')
    expect(result.revision).toBe(12)
  })
})
