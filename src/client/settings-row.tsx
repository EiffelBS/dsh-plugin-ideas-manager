/**
 * One option row of the settings section: a title and its description on the
 * left, the control on the right (or on the title line, for the boolean rows
 * whose switch belongs to the heading).
 *
 * Extracted rather than duplicated because the Display tab and the Backup tab
 * render the same row shape with the same copy discipline — an
 * option always states what it changes, its range and its default — and a second
 * copy of that markup would drift exactly where the discipline lives.
 */

import type { ReactNode } from 'react'
import { classes } from './style.ts'

export function SettingsRow({ title, desc, control, controlOnTitle = false }: {
  title: string
  desc: string
  control: ReactNode
  controlOnTitle?: boolean
}) {
  return (
    <div className={classes.settingsRow}>
      <div className={`${classes.settingsRowText}${controlOnTitle ? ` ${classes.settingsRowTextWithTitleControl}` : ''}`}>
        <div className={classes.settingsRowHeading}>
          <span className={classes.settingsRowTitle}>{title}</span>
          {controlOnTitle && control}
        </div>
        <span className={classes.settingsRowDesc}>{desc}</span>
      </div>
      {!controlOnTitle && control}
    </div>
  )
}