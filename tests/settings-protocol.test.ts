/**
 * Config wire contract tests: the tagRows clamp (the ONLY guard against an
 * illegal row count — the settings schema is deliberately permissive so a
 * hand-edited document cannot brick the namespace at registration) and the
 * strict config body parser (exact keys, clamped numbers, revision fence).
 */

import { describe, expect, it } from 'vitest'
import {
  clampTagRows,
  parseSettingsBody,
  IDEAS_SETTINGS_DEFAULTS,
  TAG_ROWS_MAX,
  TAG_ROWS_MIN,
} from '../src/protocol.ts'

describe('clampTagRows', () => {
  it('keeps in-range integers untouched', () => {
    expect(clampTagRows(1)).toBe(1)
    expect(clampTagRows(3)).toBe(3)
    expect(clampTagRows(5)).toBe(5)
  })

  it('rounds then clamps out-of-range numbers into the 1..5 bounds', () => {
    expect(clampTagRows(0)).toBe(TAG_ROWS_MIN)
    expect(clampTagRows(-9)).toBe(TAG_ROWS_MIN)
    expect(clampTagRows(99)).toBe(TAG_ROWS_MAX)
    expect(clampTagRows(2.6)).toBe(3)
    expect(clampTagRows(0.4)).toBe(1)
  })

  it('falls back to the default for anything that is not a finite number', () => {
    // A STRING number must NOT coerce: '4' means a corrupt wire, not 4.
    expect(clampTagRows('4')).toBe(IDEAS_SETTINGS_DEFAULTS.tagRows)
    expect(clampTagRows(undefined)).toBe(IDEAS_SETTINGS_DEFAULTS.tagRows)
    expect(clampTagRows(null)).toBe(IDEAS_SETTINGS_DEFAULTS.tagRows)
    expect(clampTagRows(Number.NaN)).toBe(IDEAS_SETTINGS_DEFAULTS.tagRows)
    expect(clampTagRows(true)).toBe(IDEAS_SETTINGS_DEFAULTS.tagRows)
    expect(clampTagRows({ tagRows: 4 })).toBe(IDEAS_SETTINGS_DEFAULTS.tagRows)
  })

  it('exposes the documented inclusive bounds', () => {
    expect(TAG_ROWS_MIN).toBe(1)
    expect(TAG_ROWS_MAX).toBe(5)
    expect(IDEAS_SETTINGS_DEFAULTS.tagRows).toBe(3)
  })
})

describe('parseSettingsBody', () => {
  it('accepts a plain patch and clamps the number before the wire', () => {
    expect(parseSettingsBody({ patch: { tagRows: 99 } }))
      .toEqual({ patch: { tagRows: 5 }, expectedRevision: undefined })
    expect(parseSettingsBody({ patch: { tagRows: 0 } }))
      .toEqual({ patch: { tagRows: 1 }, expectedRevision: undefined })
    expect(parseSettingsBody({ patch: { tagRows: 2.6 } }))
      .toEqual({ patch: { tagRows: 3 }, expectedRevision: undefined })
  })

  it('carries the revision fence when it is a finite number', () => {
    expect(parseSettingsBody({ patch: { tagRows: 4 }, expectedRevision: 7 }))
      .toEqual({ patch: { tagRows: 4 }, expectedRevision: 7 })
    expect(parseSettingsBody({ patch: {}, expectedRevision: 0 }))
      .toEqual({ patch: {}, expectedRevision: 0 })
  })

  it('allows an empty patch (a no-op merge that still carries the fence)', () => {
    expect(parseSettingsBody({ patch: {} })).toEqual({ patch: {}, expectedRevision: undefined })
  })

  it('rejects unknown keys, non-numbers and malformed envelopes', () => {
    expect(parseSettingsBody({ patch: { tagRows: '4' } })).toBeUndefined()
    expect(parseSettingsBody({ patch: { nope: 1 } })).toBeUndefined()
    expect(parseSettingsBody({ patch: 'x' })).toBeUndefined()
    expect(parseSettingsBody({ patch: {}, extra: 1 })).toBeUndefined()
    expect(parseSettingsBody({ patch: {}, expectedRevision: 'x' })).toBeUndefined()
    expect(parseSettingsBody('x')).toBeUndefined()
    expect(parseSettingsBody(undefined)).toBeUndefined()
    expect(parseSettingsBody([{ patch: {} }])).toBeUndefined()
  })
})
