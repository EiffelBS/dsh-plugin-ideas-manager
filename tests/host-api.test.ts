/**
 * Host transport subscription tests. The subscription must NOT hold a
 * long-lived SSE connection: the browser caps HTTP/1.1 connections per origin
 * (~6, shared across tabs), so a stream per tab exhausts the pool and page
 * reloads starve (the "Host request timed out after 15s" refresh loop). The
 * transport instead polls `state` on a short interval, gated by `isActive`
 * and the page visibility when a document exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpIdeasHostTransport, IdeasApiError, type IdeasHostTransport } from '../src/client/host-api.ts'
import { IdeasClient } from '../src/client/ideas-client.ts'
import { IDEAS_SCHEMA_VERSION, type IdeasEventPayload, type IdeasListSnapshot } from '../src/protocol.ts'
import type { IdeasSyncPackage } from '../src/sync.ts'

function snapshot(revision: number): IdeasListSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision, ideas: [] }
}

/** Record the subscribe arguments and drive the poll timer manually. */
class FakeTransport implements IdeasHostTransport {
  stateCalls = 0
  subscribed: { listener: () => void; isActive: (() => boolean) | undefined; dispose: () => void } | undefined
  readonly gate: (() => boolean | undefined) | undefined

  async state(): Promise<IdeasListSnapshot> {
    this.stateCalls += 1
    return snapshot(this.stateCalls)
  }

  async action(): Promise<IdeasListSnapshot> {
    return snapshot(0)
  }

  subscribe(listener: (event?: IdeasEventPayload) => void, isActive?: () => boolean): () => void {
    let active = true
    this.subscribed = { listener, isActive, dispose: () => { active = false } }
    return () => { active = false }
  }
}

describe('HttpIdeasHostTransport synchronization routes', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts the preview revision fence and returns the Host plan', async () => {
    const pkg: IdeasSyncPackage = {
      format: 'dsh-ideas-sync', version: 1, deviceId: 'device-a', snapshotId: 'snapshot-a',
      baseSnapshotId: null, createdAt: 1, workspace: { syncKey: 'sync_12345678', sourceWorkspaceId: 'workspace-a' }, ideas: [],
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: 7, plan: { ready: true } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = await new HttpIdeasHostTransport().syncPlan({ package: pkg, expectedRevision: 7 })
    expect(outcome).toEqual({ ok: true, revision: 7, plan: { ready: true } })
    expect(fetchMock).toHaveBeenCalledWith('/api/ideas/sync/plan', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ package: pkg, expectedRevision: 7 }),
    }))
  })

  it('keeps a normal refusal code and complete answer for the client state machine', async () => {
    const body = { ok: false, error: 'sync-preview-stale', message: 'refresh the preview' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 409, headers: { 'content-type': 'application/json' },
    })))
    const error = await new HttpIdeasHostTransport().syncImport({
      package: {
        format: 'dsh-ideas-sync', version: 1, deviceId: 'device-a', snapshotId: 'snapshot-a',
        baseSnapshotId: null, createdAt: 1, workspace: { syncKey: 'sync_12345678', sourceWorkspaceId: 'workspace-a' }, ideas: [],
      },
      expectedRevision: 7,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(IdeasApiError)
    expect(error).toMatchObject({ code: 'sync-preview-stale', message: 'refresh the preview', body })
  })
})

describe('HttpIdeasHostTransport.subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls the listener on the short interval while active', () => {
    const transport = new HttpIdeasHostTransport()
    const listener = vi.fn()
    const dispose = transport.subscribe(listener)
    try {
      vi.advanceTimersByTime(2_500)
      expect(listener).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2_500)
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
    }
  })

  it('does not poll while the board is closed (isActive gate)', () => {
    const transport = new HttpIdeasHostTransport()
    const listener = vi.fn()
    const dispose = transport.subscribe(listener, () => false)
    try {
      vi.advanceTimersByTime(10_000)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('stops polling once disposed', () => {
    const transport = new HttpIdeasHostTransport()
    const listener = vi.fn()
    const dispose = transport.subscribe(listener)
    dispose()
    vi.advanceTimersByTime(10_000)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('IdeasClient subscription wiring', () => {
  it('passes boardOpen as the isActive gate and refreshes on toggle', async () => {
    const transport = new FakeTransport()
    const client = new IdeasClient(transport, undefined)
    client.start()
    expect(transport.subscribed).toBeDefined()
    // start() loads one snapshot immediately, board still closed.
    await vi.waitFor(() => {
      expect(transport.stateCalls).toBe(1)
    })
    // The gate starts closed: board closed → no polling traffic.
    expect(transport.subscribed!.isActive!()).toBe(false)

    // Opening the board flips the gate and triggers an immediate refresh.
    client.toggleBoard()
    expect(transport.subscribed!.isActive!()).toBe(true)
    await vi.waitFor(() => {
      expect(transport.stateCalls).toBe(2)
    })

    // Closing it again stops the polling for the next window.
    client.closeBoard()
    expect(transport.subscribed!.isActive!()).toBe(false)
    client.dispose()
  })
})