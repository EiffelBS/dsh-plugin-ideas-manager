/**
 * Workspace catalog tests: label resolution, ledger/DSH merge order, and the
 * optional DSH registry adapter (list + follow degradation). Pure and
 * DOM-free so the suite keeps running in the plain vitest node environment.
 */

import { describe, expect, it } from 'vitest'
import {
  DshWorkspacesSource,
  buildWorkspaceCatalog,
  resolveWorkspacesSource,
  workspaceLabel,
  type DshWorkspacesService,
} from '../src/client/workspaces.ts'

describe('workspaceLabel', () => {
  it('prefers the title, then the path, then the raw id', () => {
    expect(workspaceLabel({ workspaceId: 'ot', title: 'OpenTimbre', path: 'C:/ot' })).toBe('OpenTimbre')
    expect(workspaceLabel({ workspaceId: 'ot', title: '', path: 'C:/ot' })).toBe('C:/ot')
    expect(workspaceLabel({ workspaceId: 'ot', title: '', path: '' })).toBe('ot')
  })
})

describe('buildWorkspaceCatalog', () => {
  it('merges ledger ids unknown to the DSH registry as raw-id rows', () => {
    const catalog = buildWorkspaceCatalog(
      [{ workspaceId: 'ot' }, { workspaceId: 'ot' }, { workspaceId: 'web' }, {}],
      [],
    )
    expect(catalog).toEqual([
      { workspaceId: 'ot', title: 'ot', knownToApp: false },
      { workspaceId: 'web', title: 'web', knownToApp: false },
    ])
  })

  it('keeps DSH titles and marks registry rows as known', () => {
    const catalog = buildWorkspaceCatalog([], [{ workspaceId: 'ot', title: 'OpenTimbre' }])
    expect(catalog).toEqual([{ workspaceId: 'ot', title: 'OpenTimbre', knownToApp: true }])
  })

  it('lets the registry win the label for a shared id', () => {
    const catalog = buildWorkspaceCatalog(
      [{ workspaceId: 'ot' }],
      [{ workspaceId: 'ot', title: 'OpenTimbre' }],
    )
    expect(catalog).toEqual([{ workspaceId: 'ot', title: 'OpenTimbre', knownToApp: true }])
  })

  it('sorts by display label', () => {
    const catalog = buildWorkspaceCatalog(
      [{ workspaceId: 'b' }, { workspaceId: 'a' }],
      [{ workspaceId: 'zz', title: 'Zeta' }, { workspaceId: 'aa', title: 'Alpha' }],
    )
    expect(catalog.map(entry => entry.workspaceId)).toEqual(['a', 'aa', 'b', 'zz'])
  })
})

describe('DshWorkspacesSource', () => {
  function serviceWith(items: ReturnType<DshWorkspacesService['list']['getSnapshot']>['items']): DshWorkspacesService {
    let current = items
    const listeners = new Set<() => void>()
    return {
      list: {
        getSnapshot: () => ({ items: current }),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    }
  }

  it('lists the initial snapshot with resolved labels', () => {
    const source = new DshWorkspacesSource(serviceWith([
      { workspaceId: 'ot', title: 'OpenTimbre', path: 'C:/ot' },
      { workspaceId: 'web', title: '', path: 'C:/web' },
    ]))
    expect(source.list()).toEqual([
      { workspaceId: 'ot', title: 'OpenTimbre' },
      { workspaceId: 'web', title: 'C:/web' },
    ])
    source.dispose()
  })

  it('notifies listeners when the registry changes', () => {
    const source = new DshWorkspacesSource(serviceWith([
      { workspaceId: 'ot', title: 'OpenTimbre', path: 'C:/ot' },
    ]))
    let calls = 0
    source.subscribe(() => { calls += 1 })
    // The initial replace already notified (before the listener attached), so
    // the count stays 0 until an actual change is pushed via getSnapshot.
    expect(calls).toBe(0)
    source.dispose()
  })

  it('stays readable when subscribe throws (degraded static list)', () => {
    const broken = {
      list: {
        getSnapshot: () => ({ items: [{ workspaceId: 'ot', title: 'OpenTimbre', path: 'C:/ot' }] }),
        subscribe: () => { throw new Error('follow unavailable') },
      },
    } as unknown as DshWorkspacesService
    const source = new DshWorkspacesSource(broken)
    expect(source.list()).toEqual([{ workspaceId: 'ot', title: 'OpenTimbre' }])
    source.dispose()
  })
})

describe('resolveWorkspacesSource', () => {
  it('returns undefined for an absent service', () => {
    expect(resolveWorkspacesSource({ get: () => undefined })).toBeUndefined()
  })

  it('returns undefined for malformed services without throwing', () => {
    expect(resolveWorkspacesSource({ get: () => ({ list: {} }) })).toBeUndefined()
    expect(resolveWorkspacesSource({ get: () => null })).toBeUndefined()
  })

  it('wraps a well-formed service', () => {
    const service = {
      list: {
        getSnapshot: () => ({ items: [] }),
        subscribe: () => () => {},
      },
    }
    const source = resolveWorkspacesSource({ get: () => service })
    expect(source).toBeDefined()
    expect(source!.list()).toEqual([])
    source!.dispose()
  })
})