/**
 * Per-column kanban width persistence tests (idea #53): the read/write helpers
 * with an injectable storage seam — a corrupt or partial entry degrades to a
 * clean map without throwing, only legal status keys survive, and the clamp
 * normalizes unordered bounds so the render is always sane.
 */

import { describe, expect, it } from 'vitest'
import {
  COLUMN_WIDTHS_STORAGE_KEY,
  COLUMN_WIDTH_STORE_MAX,
  COLUMN_WIDTH_STORE_MIN,
  clampColumnWidth,
  readColumnWidths,
  writeColumnWidths,
  type ColumnWidthStorage,
} from '../src/client/column-widths.ts'

function fakeStorage(): ColumnWidthStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('readColumnWidths', () => {
  it('returns an empty map without storage or with no entry yet', () => {
    expect(readColumnWidths(undefined)).toEqual({})
    expect(readColumnWidths(fakeStorage())).toEqual({})
  })

  it('round-trips a legal per-status width map', () => {
    const storage = fakeStorage()
    writeColumnWidths(storage, { open: 320, archived: 480 })
    expect(readColumnWidths(storage)).toEqual({ open: 320, archived: 480 })
  })

  it('drops unknown keys, non-numbers and out-of-range values', () => {
    const storage = fakeStorage()
    storage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify({
      open: 319.6, // rounds to 320
      underReview: 'wide', // non-number -> dropped
      archived: 500, // legal -> kept
      declined: 99999, // above the store max -> dropped
      bogus: 500, // unknown status key -> dropped
    }))
    expect(readColumnWidths(storage)).toEqual({ open: 320, archived: 500 })
  })

  it('keeps values only within the inclusive store bounds', () => {
    const storage = fakeStorage()
    storage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify({
      open: COLUMN_WIDTH_STORE_MIN - 1,
      underReview: COLUMN_WIDTH_STORE_MIN,
      archived: COLUMN_WIDTH_STORE_MAX,
      declined: COLUMN_WIDTH_STORE_MAX + 1,
    }))
    expect(readColumnWidths(storage)).toEqual({ underReview: COLUMN_WIDTH_STORE_MIN, archived: COLUMN_WIDTH_STORE_MAX })
  })

  it('degrades to an empty map on unreadable or non-object JSON', () => {
    const storage = fakeStorage()
    storage.setItem(COLUMN_WIDTHS_STORAGE_KEY, 'not-json{')
    expect(readColumnWidths(storage)).toEqual({})
    storage.setItem(COLUMN_WIDTHS_STORAGE_KEY, '[1,2,3]')
    expect(readColumnWidths(storage)).toEqual({})
  })

  it('degrades to an empty map when the storage accessor throws', () => {
    const broken: ColumnWidthStorage = {
      getItem: () => { throw new Error('storage blocked') },
      setItem: () => { throw new Error('storage blocked') },
    }
    expect(readColumnWidths(broken)).toEqual({})
  })
})

describe('writeColumnWidths', () => {
  it('is a harmless no-op without storage and never throws on a broken seam', () => {
    expect(() => writeColumnWidths(undefined, { open: 320 })).not.toThrow()
    const broken: ColumnWidthStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('storage blocked') },
    }
    expect(() => writeColumnWidths(broken, { open: 320 })).not.toThrow()
  })

  it('stores only the legal status keys as rounded numbers', () => {
    const storage = fakeStorage()
    writeColumnWidths(storage, { open: 319.6, underReview: NaN, bogus: 500 } as never)
    expect(storage.map.get(COLUMN_WIDTHS_STORAGE_KEY)).toBe(JSON.stringify({ open: 320 }))
  })

  it('clears a column by omitting its key on the next write', () => {
    const storage = fakeStorage()
    writeColumnWidths(storage, { open: 320, archived: 480 })
    writeColumnWidths(storage, { open: 320 })
    expect(readColumnWidths(storage)).toEqual({ open: 320 })
  })
})

describe('clampColumnWidth', () => {
  it('clamps into [lo, hi] and rounds to whole pixels', () => {
    expect(clampColumnWidth(150, 200, 640)).toBe(200)
    expect(clampColumnWidth(900, 200, 640)).toBe(640)
    expect(clampColumnWidth(319.6, 200, 640)).toBe(320)
    expect(clampColumnWidth(400, 200, 640)).toBe(400)
  })

  it('normalizes unordered bounds and falls back to the floor on NaN', () => {
    // Inverted pair (a stored max below min): still a sane [min, max] range.
    expect(clampColumnWidth(500, 640, 200)).toBe(500)
    expect(clampColumnWidth(100, 640, 200)).toBe(200)
    expect(clampColumnWidth(Number.NaN, 200, 640)).toBe(200)
  })
})
