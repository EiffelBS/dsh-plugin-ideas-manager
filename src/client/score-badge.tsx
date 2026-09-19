/**
 * Score badge: the value/effort level read as a colored pill with a tiny
 * axis icon — a dollar sign for value, a dumbbell for effort — so the two
 * axes are distinguishable at a glance on cards and list rows. The color
 * always means "best": green = High value / Low effort, amber = Medium,
 * red = Low value / High effort, through a per-badge hue variable.
 */

import type { CSSProperties } from 'react'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { levelForValue, levelLabelKey } from './levels.ts'

/**
 * Hue per level (1..3), green = the BEST level of the axis: for value that
 * is High (3, most valuable), for effort it is Low (1, least costly).
 */
function levelHue(axis: 'value' | 'effort', level: number): number {
  const hues = axis === 'value' ? [5, 45, 140] : [140, 45, 5]
  return hues[level - 1] ?? 210
}

const badgeIcon = {
  'aria-hidden': true,
  width: 10,
  height: 10,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

function IconDollar() {
  return (
    <svg {...badgeIcon}>
      <path d="M12 1v22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  )
}

function IconDumbbell() {
  return (
    <svg {...badgeIcon}>
      <path d="M6.5 6.5v11" />
      <path d="M17.5 6.5v11" />
      <path d="M3 9.5v5" />
      <path d="M21 9.5v5" />
      <path d="M6.5 12h11" />
    </svg>
  )
}

export function ScoreBadge({ axis, value }: {
  /** Which axis the score belongs to (drives the icon). */
  axis: 'value' | 'effort'
  /** Stored score number; snapped to the nearest level for display. */
  value: number
}) {
  const level = levelForValue(value)
  const labelKey = levelLabelKey(value)
  if (level === undefined || labelKey === undefined) return null
  return (
    <span
      className={classes.score}
      style={{ '--dsh-ideas-level-hue': levelHue(axis, level) } as CSSProperties}
      title={t(axis === 'value' ? 'card.value' : 'card.effort', { level: t(labelKey) })}
    >
      <span className={classes.scoreIcon}>
        {axis === 'value' ? <IconDollar /> : <IconDumbbell />}
      </span>
      {t(labelKey)}
    </span>
  )
}
