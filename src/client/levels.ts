/**
 * Named value/effort levels for the board UI.
 *
 * Ideas store value and effort as bare numbers, which is meaningless to a
 * user. The board instead presents three named levels (low / medium / high),
 * each mapped to a stored numeric value. Picking a level persists its number;
 * a stored number that does not exactly match a level snaps to the nearest
 * one when the idea is displayed or edited.
 */

import type { IdeasKey } from './locales.ts'

/** A named level and the numeric value it maps to in the ledger. */
export interface IdeaLevel {
  value: number
  labelKey: IdeasKey
}

/** Shared value/effort denominations (same scale for both axes). */
export const IDEA_LEVELS: readonly IdeaLevel[] = [
  { value: 1, labelKey: 'level.low' },
  { value: 2, labelKey: 'level.medium' },
  { value: 3, labelKey: 'level.high' },
]

/** Snap a stored number to the nearest defined level; undefined stays undefined. */
export function levelForValue(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  let best = IDEA_LEVELS[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of IDEA_LEVELS) {
    const distance = Math.abs(level.value - value)
    if (distance < bestDistance) {
      bestDistance = distance
      best = level
    }
  }
  return best.value
}

/** Translation key of the level a number belongs to (display on cards). */
export function levelLabelKey(value: number | undefined): IdeasKey | undefined {
  const snapped = levelForValue(value)
  return IDEA_LEVELS.find(level => level.value === snapped)?.labelKey
}