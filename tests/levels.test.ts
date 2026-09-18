/**
 * Named-level mapping tests: stored numbers snap to the nearest level, and
 * every level round-trips to its canonical label key.
 */

import { describe, expect, it } from 'vitest'
import { IDEA_LEVELS, levelForValue, levelLabelKey } from '../src/client/levels.ts'

describe('levels', () => {
  it('exposes the three canonical levels', () => {
    expect(IDEA_LEVELS.map(level => level.value)).toEqual([1, 2, 3])
  })

  it('maps stored numbers to the nearest level', () => {
    expect(levelForValue(1)).toBe(1)
    expect(levelForValue(2)).toBe(2)
    expect(levelForValue(3)).toBe(3)
    // Below low, above high snap to the edges.
    expect(levelForValue(0)).toBe(1)
    expect(levelForValue(7)).toBe(3)
    // Strictly closer to the upper level wins; an exact tie keeps the lower.
    expect(levelForValue(2.6)).toBe(3)
    expect(levelForValue(2.5)).toBe(2)
  })

  it('keeps an absent level absent', () => {
    expect(levelForValue(undefined)).toBeUndefined()
    expect(levelLabelKey(undefined)).toBeUndefined()
  })

  it('labels every canonical level', () => {
    for (const level of IDEA_LEVELS) {
      expect(levelLabelKey(level.value)).toBe(level.labelKey)
    }
  })
})