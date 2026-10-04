/**
 * The two read-only signals:
 *  - the sidebar row's "N to review" badge (part B), derived from the snapshot
 *    already in memory;
 *  - the quiet *stale* badge on open ideas (part C), plus its
 *    `staleAfterDays` setting.
 *
 * Both are pure view helpers, which is the whole point of the design: no host
 * request, no stored state, and a host that changes its wire shape cannot break
 * a badge. The suite pins the decisions that are easy to get wrong — which
 * statuses count, which scope, and the fact that 0 means OFF and not
 * "everything is stale".
 */

import { describe, expect, it } from 'vitest'
import { createIdea } from '../src/core/ideas.ts'
import {
  clampStaleAfterDays,
  IDEAS_SETTINGS_DEFAULTS,
  parseSettingsBody,
  sanitizeSettings,
  STALE_AFTER_DAYS_RANGE,
  type IdeaListRow,
} from '../src/protocol.ts'
import { panelReviewScope, underReviewCountOf } from '../src/client/review-count.ts'
import { isStaleIdea, staleDays } from '../src/client/staleness.ts'
import { NO_WORKSPACE_FILTER } from '../src/client/ordering.ts'

const T0 = Date.parse('2026-10-01T08:00:00.000Z')
const DAY = 86_400_000

/** A list row carrying only what these helpers read. */
function row(overrides: Partial<IdeaListRow> = {}): IdeaListRow {
  const record = createIdea({ title: 'T', body: 'B', workspaceId: 'ws-1' }, T0, 'idea-1')
  return { ...record, bodyExcerpt: 'B', ...overrides }
}

describe('underReviewCountOf', () => {
  it('counts only the review gate, in every workspace by default', () => {
    const rows = [
      row({ id: 'a', status: 'open' }),
      row({ id: 'b', status: 'underReview' }),
      row({ id: 'c', status: 'underReview', workspaceId: 'ws-2' }),
      row({ id: 'd', status: 'archived' }),
      row({ id: 'e', status: 'declined' }),
    ]
    expect(underReviewCountOf(rows, '')).toBe(2)
  })

  it('honours one workspace scope, and the workspace-less scope', () => {
    const rows = [
      row({ id: 'a', status: 'underReview', workspaceId: 'ws-1' }),
      row({ id: 'b', status: 'underReview', workspaceId: 'ws-2' }),
      row({ id: 'c', status: 'underReview', workspaceId: undefined }),
    ]
    expect(underReviewCountOf(rows, 'ws-2')).toBe(1)
    expect(underReviewCountOf(rows, NO_WORKSPACE_FILTER)).toBe(1)
    expect(underReviewCountOf(rows, 'ws-9')).toBe(0)
  })

  it('is zero before the first snapshot rather than a crash', () => {
    expect(underReviewCountOf(undefined, '')).toBe(0)
    expect(underReviewCountOf([], '')).toBe(0)
  })
})

describe('panelReviewScope', () => {
  it('counts everything unless the workspace scope is remembered', () => {
    const remembered = sanitizeSettings({ rememberWorkspaceScope: true, workspaceScope: 'ws-7' })
    expect(panelReviewScope(remembered)).toBe('ws-7')
    // Scope on, remember off: the stored id is not in force.
    expect(panelReviewScope(sanitizeSettings({ rememberWorkspaceScope: false, workspaceScope: 'ws-7' }))).toBe('')
    // Blank / sentinel / whitespace all mean "no scope", never a matchless id
    // that would silently hide every badge.
    expect(panelReviewScope(sanitizeSettings({ rememberWorkspaceScope: true, workspaceScope: '' }))).toBe('')
    expect(panelReviewScope(sanitizeSettings({ rememberWorkspaceScope: true, workspaceScope: '   ' }))).toBe('')
    expect(panelReviewScope(sanitizeSettings({ rememberWorkspaceScope: true, workspaceScope: NO_WORKSPACE_FILTER }))).toBe('')
  })
})

describe('isStaleIdea', () => {
  it('flags an open idea past the threshold', () => {
    const now = T0 + 40 * DAY
    expect(isStaleIdea(row({ status: 'open', updatedAt: now - 31 * DAY }), 30, now)).toBe(true)
    expect(isStaleIdea(row({ status: 'open', updatedAt: now - 29 * DAY }), 30, now)).toBe(false)
    // Strict: exactly at the threshold is not yet stale.
    expect(isStaleIdea(row({ status: 'open', updatedAt: now - 30 * DAY }), 30, now)).toBe(false)
  })

  it('never flags a closed idea, whatever its age', () => {
    const now = T0 + 400 * DAY
    for (const status of ['underReview', 'archived', 'declined'] as const) {
      expect(isStaleIdea(row({ status, updatedAt: T0 }), 30, now)).toBe(false)
    }
  })

  it('treats 0 as OFF, not as "flag everything"', () => {
    const now = T0 + 400 * DAY
    const ancient = row({ status: 'open', updatedAt: T0 })
    expect(isStaleIdea(ancient, 0, now)).toBe(false)
    expect(isStaleIdea(ancient, -5, now)).toBe(false)
    expect(isStaleIdea(ancient, Number.NaN, now)).toBe(false)
    expect(isStaleIdea(ancient, 30, now)).toBe(true)
  })
})

describe('staleDays', () => {
  it('counts whole days and never goes negative', () => {
    const now = T0 + 10 * DAY
    expect(staleDays(row({ updatedAt: now }), now)).toBe(0)
    expect(staleDays(row({ updatedAt: now - (3 * DAY + 12_345) }), now)).toBe(3)
    expect(staleDays(row({ updatedAt: now + DAY }), now)).toBe(0)
  })
})

describe('staleAfterDays setting', () => {
  it('defaults to 30 and sanitizes every illegal shape to a legal value', () => {
    expect(IDEAS_SETTINGS_DEFAULTS.staleAfterDays).toBe(30)
    expect(sanitizeSettings({}).staleAfterDays).toBe(30)
    expect(sanitizeSettings({ staleAfterDays: 7 }).staleAfterDays).toBe(7)
    expect(sanitizeSettings({ staleAfterDays: 0 }).staleAfterDays).toBe(0)
    // Clamped, rounded, and defaulted rather than trusted.
    expect(clampStaleAfterDays(1e9)).toBe(STALE_AFTER_DAYS_RANGE.max)
    expect(clampStaleAfterDays(-1)).toBe(STALE_AFTER_DAYS_RANGE.min)
    expect(clampStaleAfterDays(12.6)).toBe(13)
    expect(clampStaleAfterDays('30')).toBe(30)
    expect(clampStaleAfterDays(Number.NaN)).toBe(30)
    expect(clampStaleAfterDays(null)).toBe(30)
    expect(clampStaleAfterDays(true)).toBe(30)
  })

  it('round-trips a patch through the wire gate', () => {
    expect(parseSettingsBody({ patch: { staleAfterDays: 45 } })?.patch.staleAfterDays).toBe(45)
    // 0 is a real value (the badge off), and a non-number is refused outright.
    expect(parseSettingsBody({ patch: { staleAfterDays: 0 } })?.patch.staleAfterDays).toBe(0)
    expect(parseSettingsBody({ patch: { staleAfterDays: '45' } })).toBeUndefined()
    // An unknown option is still refused: the patch key set stays closed.
    expect(parseSettingsBody({ patch: { staleAfterDay: 45 } })).toBeUndefined()
  })
})