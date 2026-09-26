/**
 * Run-state badges: the header pills that say where an idea stands with its
 * last execution. Extracted from the Overview card header so the Priorities
 * and Delivered rows can show the same facts - a row without a state tag
 * forces the reader to open the modal, and a missed "Running" row is
 * duplicated work.
 *
 * What the tags read (all host-written system fields, never set by an idea
 * verb - see core/ideas.ts):
 *  - `followUpOfId`: the recipe lineage of a child idea ("follow-up of #N");
 *    the number is resolved by the caller (the row itself carries no parent).
 *  - `status === 'underReview'`: the recipe gate. NOT a run state - it is a
 *    column, and an idea engaged in the recipe has left the open backlog, so
 *    it never shows in Priorities.
 *  - `taskBoardStatus === 'failed'` on an OPEN idea: a failed run delivered
 *    nothing, so the idea deliberately stays in the backlog and the badge only
 *    makes the situation visible.
 *  - `runStatus === 'running'` or `taskBoardStatus === 'running'`: a run is in
 *    flight, whichever backend runs it (a card started from the task board
 *    itself is folded into runStatus by the next poll).
 *  - `runSessionId`: the direct-session run, with the button that opens it.
 *  - `deliveredAt`: the exit stamp.
 *
 * Every tag is a LAST OBSERVATION, never a promise of a live state: the host
 * poll runs every 30 s and keeps the last value it saw. The tooltips keep
 * saying so.
 */

import type { IdeaListRow } from '../protocol.ts'
import type { IdeasClient } from './ideas-client.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'

/** Compact day/month stamp, the canonical one (the Overview card's updated
 *  date and the Delivered stamp both read it). Exported rather than repeated:
 *  board-view imports it back from here. */
export function shortDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export interface RunStateBadgesProps {
  /** The row to describe (a list row is enough: every field used is on it). */
  idea: IdeaListRow
  /**
   * The board client, for the "Open session" link only: the button renders for
   * a direct run (`runStatus === 'running'` + a session id) AND only when the
   * shell serves a sessions service, so a host without one degrades to the tag
   * alone. Taking the client (not a handler) keeps that feature detection in
   * one place instead of three identical lambdas.
   */
  client: IdeasClient
  /**
   * Resolve the parent of a follow-up child into its ledger number. The row
   * carries `followUpOfId` but never the parent's number, so the caller owns
   * the id -> idea map (the Overview already builds one) instead of every
   * call site duplicating it. Absent = the lineage chip is skipped.
   */
  parentNumber?: (ideaId: string) => number | undefined
  /**
   * Render the "Delivered {date}" stamp. On by default (the Overview card
   * header); pass false where the date is already shown elsewhere, or where a
   * stale stamp would lie: the Delivered tab prints it as the row's exit
   * stamp, and an OPEN row (a restored idea, in Priorities) is not an exit at
   * all — restore only clears `archivedAt`, so its delivery date survives.
   */
  showDelivered?: boolean
}

/**
 * The shared state pills of one idea, in header order. Renders nothing (an
 * empty fragment) for an idea that is simply idle: the callers drop it in
 * unconditionally, each in the top-right corner of its card or row.
 */
export function RunStateBadges({ idea, client, parentNumber, showDelivered = true }: RunStateBadgesProps) {
  const sessionId = idea.runSessionId
  // Feature-detected once, here: a host with no sessions service renders the
  // running tag alone and no link.
  const opener = client.sessionOpener
  return (
    <>
      {idea.followUpOfId !== undefined && parentNumber !== undefined && (
        <span className={classes.followUpBadge} title={t('card.followUpOfHint')}>
          {t('card.followUpOf', { number: parentNumber(idea.followUpOfId) ?? '—' })}
        </span>
      )}
      {idea.status === 'underReview' && (
        <span className={classes.reviewBadge} title={t('card.underReviewHint')}>
          {t('board.status.underReview')}
        </span>
      )}
      {/* Failed mirrored task (follow-up work): the poll records the last
          observed status; the idea deliberately STAYS open (a failed run
          delivered nothing) - the badge only makes the situation visible. */}
      {idea.status === 'open' && idea.taskBoardStatus === 'failed' && (
        <span
          className={classes.taskFailedBadge}
          title={t('card.taskFailedHint')}
          data-dsh-ideas-task-failed=""
        >
          {t('card.taskFailed')}
        </span>
      )}
      {/* A launch in flight (idea #66), whichever backend runs it: the badge is
          what keeps the card from looking ordinary the second after the button
          was clicked, and the link is the way back into the execution - a
          direct run lives in a session the human never saw open. The card
          status counts too: someone can start the mirrored card from the
          task-board itself, and the next poll folds that into runStatus. */}
      {(idea.runStatus === 'running' || idea.taskBoardStatus === 'running') && (
        <span
          className={classes.taskRunningBadge}
          title={t('card.taskRunningHint')}
          data-dsh-ideas-task-running=""
        >
          <span className={classes.taskRunningDot} aria-hidden="true" />
          {t('card.taskRunning')}
        </span>
      )}
      {idea.runStatus === 'running' && sessionId !== undefined && sessionId !== '' && opener !== undefined && (
        <button
          type="button"
          className={classes.openSession}
          title={t('card.openSessionHint')}
          data-dsh-ideas-open-session=""
          onClick={event => {
            event.stopPropagation()
            opener.open(sessionId)
          }}
        >
          {t('card.openSession')}
        </button>
      )}
      {showDelivered && idea.deliveredAt !== undefined && (
        <span className={classes.deliveredBadge} title={t('card.deliveredHint')}>
          {t('card.delivered', { date: shortDate(idea.deliveredAt) })}
        </span>
      )}
    </>
  )
}
