/**
 * T3 session-aware capture tests: the pure workspace-of-session resolution
 * (current session id -> its workspace, with the recent-workspace fallback)
 * and the defensive service adapter (degrades to undefined when a service is
 * absent or malformed).
 */

import { describe, expect, it } from 'vitest'
import {
  DshActiveWorkspaceSource,
  resolveActiveWorkspace,
  resolveActiveWorkspaceSource,
  type DshSessionsService,
  type DshWorkspacesSnapshotService,
} from '../src/client/session-context.ts'

const WS_OT = { workspaceId: 'ws-ot', title: 'OpenTimbre', path: 'C:/ot', sessionIds: ['s-1', 's-2'] }
const WS_WEB = { workspaceId: 'ws-web', title: 'Web', path: 'C:/web', sessionIds: ['s-3'] }

describe('resolveActiveWorkspace', () => {
  it('returns the workspace whose sessionIds contains the current session', () => {
    expect(resolveActiveWorkspace('s-2', [WS_OT, WS_WEB], undefined)).toEqual({
      workspaceId: 'ws-ot',
      title: 'OpenTimbre',
    })
  })

  it('falls back to the recent workspace when the session binds nothing', () => {
    expect(resolveActiveWorkspace('s-99', [WS_OT, WS_WEB], 'ws-web')).toEqual({
      workspaceId: 'ws-web',
      title: 'Web',
    })
  })

  it('returns undefined without a session and without a recent workspace', () => {
    expect(resolveActiveWorkspace(undefined, [WS_OT, WS_WEB], undefined)).toBeUndefined()
    expect(resolveActiveWorkspace('', [WS_OT, WS_WEB], 'nope')).toBeUndefined()
  })

  it('tolerates a registry without sessionIds (ledger-only degradation)', () => {
    expect(resolveActiveWorkspace('s-1', [{ workspaceId: 'ws-ot', title: 'OpenTimbre' }], undefined)).toBeUndefined()
  })

  it('prefers the session-bound workspace over the recent fallback', () => {
    expect(resolveActiveWorkspace('s-3', [WS_OT, WS_WEB], 'ws-ot')).toEqual({
      workspaceId: 'ws-web',
      title: 'Web',
    })
  })
})

describe('DshActiveWorkspaceSource', () => {
  it('resolves synchronously from the two snapshots and reacts to changes', () => {
    let sessionsSnapshot = { current: 's-2' }
    const listeners: Array<() => void> = []
    const sessions: DshSessionsService = {
      list: {
        getSnapshot: () => sessionsSnapshot,
        subscribe: listener => { listeners.push(listener); return () => {} },
      },
    }
    let workspacesItems: unknown[] = [WS_OT, WS_WEB]
    const workspaces: DshWorkspacesSnapshotService = {
      list: {
        getSnapshot: () => ({ items: workspacesItems as never }),
        subscribe: listener => { listeners.push(listener); return () => {} },
      },
    }
    const source = new DshActiveWorkspaceSource(sessions, workspaces)
    expect(source.current()).toEqual({ workspaceId: 'ws-ot', title: 'OpenTimbre' })
    // Session switch: the same snapshot now binds the web workspace.
    sessionsSnapshot = { current: 's-3' }
    for (const listener of listeners) listener()
    expect(source.current()).toEqual({ workspaceId: 'ws-web', title: 'Web' })
    source.dispose()
  })

  it('degrades to undefined when a snapshot read throws', () => {
    const sessions: DshSessionsService = {
      list: {
        getSnapshot: () => { throw new Error('boom') },
        subscribe: () => () => {},
      },
    }
    const workspaces: DshWorkspacesSnapshotService = {
      list: {
        getSnapshot: () => ({ items: [WS_OT] }),
        subscribe: () => () => {},
      },
    }
    const source = new DshActiveWorkspaceSource(sessions, workspaces)
    expect(source.current()).toBeUndefined()
    source.dispose()
  })
})

describe('resolveActiveWorkspaceSource', () => {
  it('builds the adapter when both services are shaped correctly', () => {
    const ctx = {
      get: (name: string) => name === 'sessions'
        ? { list: { getSnapshot: () => ({ current: 's-2' }), subscribe: () => () => {} } }
        : { list: { getSnapshot: () => ({ items: [WS_OT, WS_WEB] }), subscribe: () => () => {} } },
    }
    const source = resolveActiveWorkspaceSource(ctx as never)
    expect(source).toBeDefined()
    expect(source?.current()).toEqual({ workspaceId: 'ws-ot', title: 'OpenTimbre' })
    source?.dispose()
  })

  it('returns undefined when a service is absent or malformed', () => {
    expect(resolveActiveWorkspaceSource({ get: () => undefined } as never)).toBeUndefined()
    expect(resolveActiveWorkspaceSource({ get: () => ({}) } as never)).toBeUndefined()
    const broken = {
      get: (name: string) => name === 'sessions'
        ? { list: { getSnapshot: () => ({ current: 's-1' }), subscribe: () => () => {} } }
        : { list: { getSnapshot: undefined } },
    }
    expect(resolveActiveWorkspaceSource(broken as never)).toBeUndefined()
  })
})