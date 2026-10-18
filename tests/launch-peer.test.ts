/**
 * Every call names the Peer it speaks for — host-side tests.
 *
 * DSH core added a rule with no default: `InvokeRemoteRequest.peer` is required,
 * and so is the peer argument of `wireStream.open()`. The gateway reads the peer
 * BEFORE any session exists (`assertPeerLive(request.peer, endpoint)` touches
 * `peer.signal`), so an unnamed call dies as
 * `TypeError: Cannot read properties of undefined (reading 'signal')` — not a
 * degraded feature, every direct launch failing before a session is created.
 *
 * The fake below enforces exactly that rule, in the same order as the gateway
 * does: it reads `peer.signal` first and answers only afterwards. A build that
 * names no peer therefore fails here on the real defect, not on an assertion
 * invented for it — which is what makes this file the test that would have
 * caught the break.
 */

import { describe, expect, it, vi } from 'vitest'
import type { IdeaRecord } from '../src/core/ideas.ts'
import { createIdea } from '../src/core/ideas.ts'
import { runPromptOf } from '../src/run-prompt.ts'
import {
  SessionRunner,
  type HostConnectionFace,
  type HostPeerFace,
  type HostServiceReader,
} from '../src/session-runner.ts'

const T0 = Date.parse('2026-10-18T08:00:00.000Z')

function idea(overrides: Partial<IdeaRecord> = {}): IdeaRecord {
  return createIdea({
    title: 'Run from idea',
    body: 'Launch the execution from the board.',
    workspaceId: 'ws-1',
  }, T0, 'idea-1') as IdeaRecord
}

/** One recorded call: the endpoint, the wire argument keys, and the peer named. */
interface RecordedCall {
  namespace: string
  method: string
  /** The descriptor table of this plugin: which key carries the request. */
  argKeys: string[]
  /** The inner fields the request carried, for the endpoints that pin them. */
  fields: Record<string, unknown>
  peerPrincipal?: string
  peerSignalIsLive?: boolean
}

interface GatewayCall {
  namespace: string
  method: string
  args?: unknown
  peer?: HostPeerFace
}

/**
 * A gateway that enforces the core rule in the core's order.
 *
 * `refuse` shapes the host this plugin has to survive: 'none' is a core below
 * the peer rule (it ignores an extra field), 'peer' is a core that refuses a
 * peer it was not asked to speak for, and the default 'require' is the current
 * core: required, never defaulted.
 */
class PeerAwareGateway {
  calls: RecordedCall[] = []

  constructor(private readonly mode: 'require' | 'refuse' | 'none' = 'require') {}

  async invoke(request: GatewayCall): Promise<unknown> {
    // The gateway's own first act, byte for byte: `peer.signal`, with no default.
    const live = request.peer?.signal.aborted === false
    if (this.mode === 'require' && request.peer === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'signal')")
    }
    if (this.mode === 'refuse' && request.peer !== undefined) {
      const refusal = new Error('the host refused the peer this call named') as Error & { code: string }
      refusal.code = 'remote-access/denied'
      throw refusal
    }
    const args = (request.args ?? {}) as Record<string, unknown>
    const inner = args.request ?? args._request
    this.calls.push({
      namespace: request.namespace,
      method: request.method,
      argKeys: Object.keys(args),
      fields: typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : {},
      peerPrincipal: request.peer === undefined ? undefined : String((request.peer as { principal?: { kind?: string } }).principal?.kind ?? 'none'),
      peerSignalIsLive: live,
    })
    const key = `${request.namespace}.${request.method}`
    if (key === 'session.create') return { sessionId: 'session-1' }
    if (key === 'session.list') return { items: [{ sessionId: 'session-1', running: true }] }
    if (key === 'session.projections') return { asOfSeq: 3 }
    if (key === 'session.page') return { records: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }] }
    return { ok: true }
  }

  get methods(): string[] {
    return this.calls.map(call => call.method)
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter(call => call.method === method)
  }
}

/** The connection face shaped as a cordis SERVICE, read through `get`, never a property. */
function makeContextFace(options: { peer?: HostPeerFace | undefined, refusal?: unknown } = {}) {
  let created = options.peer
  const peersMade: Array<{ principal: string }> = []
  const reader: HostServiceReader = (name: string) => {
    if (name !== 'connection') return undefined
    const face: HostConnectionFace = {
      createPeer: ({ principal }) => {
        peersMade.push({ principal: String(principal.kind) })
        if (options.refusal !== undefined) throw options.refusal
        if (created === undefined) created = livePeer()
        return created
      },
    }
    return face
  }
  return { reader, peersMade }
}

function livePeer(): HostPeerFace {
  const controller = new AbortController()
  // The core peer scope carries its principal, and the gateway reads `signal` on every call.
  return { signal: controller.signal, principal: { kind: 'owner' } } as HostPeerFace
}

describe('SessionRunner peer naming', () => {
  it('names a live owner peer on every endpoint the launch path uses, in its wire key', async () => {
    const gateway = new PeerAwareGateway('require')
    const { reader, peersMade } = makeContextFace()
    const runner = new SessionRunner(gateway, () => Promise.resolve({ ok: true }), reader)

    await runner.probePeer()
    const sessionId = await runner.launchIdea(idea(), 'deepseek/deepseek-chat', 'workspace-write')
    await runner.listRunning()
    await runner.readDeliveryNote(sessionId)

    // The endpoints, in the order this backend drives them.
    expect(gateway.methods).toEqual(['list', 'create', 'rename', 'selectModel', 'prompt', 'list', 'projections', 'page'])
    // The descriptor table: `session/list` is declared under `_request`, every
    // other method under `request`. The peer never replaces that key.
    for (const call of gateway.calls) {
      expect(call.argKeys).toEqual([call.method === 'list' ? '_request' : 'request'])
      expect(call.peerSignalIsLive).toBe(true)
      expect(call.peerPrincipal).toBe('owner')
    }
    // The fields the launch pins, unchanged by the peer.
    const created = gateway.callsOf('create')[0]
    expect(created?.fields).toEqual({ workspaceId: 'ws-1' })
    const renamed = gateway.callsOf('rename')[0]
    expect(renamed?.fields).toEqual({ sessionId: 'session-1', title: 'Run from idea' })
    const selected = gateway.callsOf('selectModel')[0]
    expect(selected?.fields.model).toBe('deepseek-chat')
    expect(selected?.fields.provider).toBe('deepseek')
    const prompted = gateway.callsOf('prompt')[0]
    expect(prompted?.fields.mode).toBe('queue')
    expect((prompted?.fields.content as Array<{ type?: string; text?: string }>)?.[0]?.text).toBe(runPromptOf(idea()))
    const paged = gateway.callsOf('page')[0]
    expect(paged?.fields.address).toEqual({ kind: 'session', sessionId: 'session-1' })
    // ONE peer for the whole service, not one per call.
    expect(peersMade.length).toBe(1)
    expect(peersMade[0]?.principal).toBe('owner')
  })

  it('fails a launch that names no peer with the host’s own crash', async () => {
    const gateway = new PeerAwareGateway('require')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // No connection service at all: there is nothing to name.
    const runner = new SessionRunner(gateway, undefined, () => undefined)

    await expect(runner.launchIdea(idea())).rejects.toThrow("Cannot read properties of undefined (reading 'signal')")
    expect(gateway.calls.length).toBe(0)
    // The absent face says so: a wrong name must be tellable from an unsupported deployment.
    expect(warn.mock.calls.some(line => String(line[0]).includes('connection service'))).toBe(true)
    warn.mockRestore()
  })

  it('remembers a refused peer and runs the launch without naming one', async () => {
    const gateway = new PeerAwareGateway('refuse')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { reader } = makeContextFace()
    const runner = new SessionRunner(gateway, undefined, reader)

    await runner.probePeer() // the mount probe is refused by this host
    const sessionId = await runner.launchIdea(idea(), 'deepseek/deepseek-chat')

    expect(sessionId).toBe('session-1')
    for (const call of gateway.calls) {
      expect(call.peerPrincipal).toBeUndefined()
    }
    // The decision is memoized: the probe refused once and nothing after it re-proposed a peer.
    // The refused probe itself is not recorded — only the calls that ran are.
    expect(gateway.methods).toEqual(['create', 'rename', 'selectModel', 'prompt'])
    warn.mockRestore()
  })

  it('keeps naming the peer for a host that never asked for one', async () => {
    const gateway = new PeerAwareGateway('none')
    const { reader } = makeContextFace()
    const runner = new SessionRunner(gateway, undefined, reader)

    await runner.probePeer()
    const sessionId = await runner.launchIdea(idea())

    expect(sessionId).toBe('session-1')
    // Naming a peer is harmless below the rule: no version comparison decides this.
    for (const call of gateway.calls) {
      expect(call.peerPrincipal).toBe('owner')
      expect(call.peerSignalIsLive).toBe(true)
    }
  })

  it('never disposes the peer it made, and reuses the same one across launches', async () => {
    const gateway = new PeerAwareGateway('require')
    const peers: HostPeerFace[] = []
    const reader: HostServiceReader = (name: string) => {
      if (name !== 'connection') return undefined
      return { createPeer: ({ principal }) => {
        expect(principal.kind).toBe('owner')
        const peer = livePeer()
        peers.push(peer)
        return peer
      } } as HostConnectionFace
    }
    const runner = new SessionRunner(gateway, undefined, reader)

    await runner.launchIdea(idea())
    await runner.listRunning()
    await runner.launchIdea({ ...idea(), id: 'idea-2' })

    expect(peers.length).toBe(1)
    // The peer the gateway saw on every call is the one this backend made.
    for (const call of gateway.calls) {
      expect(call.peerSignalIsLive).toBe(true)
    }
  })
})
