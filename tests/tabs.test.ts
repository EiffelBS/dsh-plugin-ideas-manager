/**
 * Board tab model tests: the closed tab set, and the persisted-active-tab
 * helpers with an injectable storage seam (degrade to the default on any
 * storage hiccup; never throw).
 */

import { describe, expect, it } from 'vitest'
import {
  ACTIVE_TAB_STORAGE_KEY,
  DEFAULT_TAB,
  isBoardTab,
  readActiveTab,
  readPersistedActiveTab,
  readSessionWorkspaceScope,
  writeActiveTab,
  writeSessionWorkspaceScope,
  type TabStorage,
} from '../src/client/tabs.ts'

function fakeStorage(): TabStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('isBoardTab', () => {
  it('accepts the tab set and rejects everything else', () => {
    expect(isBoardTab('overview')).toBe(true)
    expect(isBoardTab('priorities')).toBe(true)
    expect(isBoardTab('settings')).toBe(false)
    expect(isBoardTab('')).toBe(false)
    expect(isBoardTab(undefined)).toBe(false)
    expect(isBoardTab(42)).toBe(false)
  })
})

describe('readActiveTab', () => {
  it('defaults to overview without storage or with a stray value', () => {
    expect(readActiveTab(undefined)).toBe(DEFAULT_TAB)
    expect(readActiveTab(fakeStorage())).toBe(DEFAULT_TAB)
    const stray = fakeStorage()
    stray.setItem(ACTIVE_TAB_STORAGE_KEY, 'bogus')
    expect(readActiveTab(stray)).toBe(DEFAULT_TAB)
  })

  it('returns the persisted tab', () => {
    const storage = fakeStorage()
    storage.setItem(ACTIVE_TAB_STORAGE_KEY, 'priorities')
    expect(readActiveTab(storage)).toBe('priorities')
  })

  it('distinguishes no persisted tab from the overview default', () => {
    const storage = fakeStorage()
    expect(readPersistedActiveTab(storage)).toBeUndefined()
    storage.setItem(ACTIVE_TAB_STORAGE_KEY, 'overview')
    expect(readPersistedActiveTab(storage)).toBe('overview')
    storage.setItem(ACTIVE_TAB_STORAGE_KEY, 'bogus')
    expect(readPersistedActiveTab(storage)).toBeUndefined()
  })

  it('degrades to the default when the storage accessor throws', () => {
    const broken: TabStorage = {
      getItem: () => { throw new Error('storage blocked') },
      setItem: () => { throw new Error('storage blocked') },
    }
    expect(readActiveTab(broken)).toBe(DEFAULT_TAB)
    expect(() => writeActiveTab(broken, 'overview')).not.toThrow()
  })
})

describe('writeActiveTab / readActiveTab round trip', () => {
  it('persists then re-reads the chosen tab', () => {
    const storage = fakeStorage()
    writeActiveTab(storage, 'priorities')
    expect(readActiveTab(storage)).toBe('priorities')
    writeActiveTab(storage, 'overview')
    expect(readActiveTab(storage)).toBe('overview')
  })

  it('is a harmless no-op without storage', () => {
    expect(() => writeActiveTab(undefined, 'priorities')).not.toThrow()
  })
})

describe('panel workspace scope memory', () => {
  it('round-trips a concrete scope and the all-workspaces empty scope per owner', () => {
    const owner = {}
    const otherOwner = {}
    expect(readSessionWorkspaceScope(owner)).toBeUndefined()
    writeSessionWorkspaceScope(owner, 'ws1')
    expect(readSessionWorkspaceScope(owner)).toBe('ws1')
    expect(readSessionWorkspaceScope(otherOwner)).toBeUndefined()
    writeSessionWorkspaceScope(owner, '')
    expect(readSessionWorkspaceScope(owner)).toBe('')
  })
})