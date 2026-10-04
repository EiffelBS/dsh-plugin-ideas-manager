/**
 * The delivery note on the review gate (part A).
 *
 * Before this, a finished run landed in the review gate as a column change and
 * nothing else: the reviewer could only press *Open session* to learn what had
 * actually happened, which made deciding the one question the gate exists for
 * (approve / follow-up / decline) a two-step errand.
 *
 * The rule that shapes this component is honesty about absence. A run that
 * left nothing to harvest — a card backend that exposes no output, a session
 * with no assistant turn, a host that refused the read — must read as "no
 * note", not as an empty box the reader has to interpret. So the component
 * says so in one quiet line and stops; it never renders a placeholder summary.
 */

import type { IdeaRunStatus } from '../core/ideas.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'

export interface DeliveryNoteProps {
  /**
   * The row to describe. Deliberately the two fields this reads and nothing
   * else: the Overview card and the Delivered log hand it a list row, the
   * editor hands it the full record it fetched on demand, and a component that
   * only needs the run state and the note should not be forced to pick one of
   * the two projections.
   */
  idea: { runStatus?: IdeaRunStatus; deliveryNote?: string }
}

/**
 * The delivery note of a finished run, or nothing at all.
 *
 * Renders only for a run that actually finished (`runStatus === 'done'`): a
 * running idea has no conclusion yet, and a failed one has no delivery to
 * describe — the *Task failed* badge already owns that story.
 */
export function DeliveryNote({ idea }: DeliveryNoteProps) {
  if (idea.runStatus !== 'done') return null
  const note = idea.deliveryNote?.trim()
  return (
    <div className={classes.deliveryNote} data-dsh-ideas-delivery-note="">
      <span className={classes.deliveryNoteLabel}>{t('card.deliveryNote')}</span>
      {note !== undefined && note !== ''
        ? <span className={classes.deliveryNoteText}>{note}</span>
        : <span className={classes.deliveryNoteEmpty}>{t('card.deliveryNoteEmpty')}</span>}
    </div>
  )
}