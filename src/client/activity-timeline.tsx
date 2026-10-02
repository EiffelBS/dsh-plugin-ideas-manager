/**
 * The per-idea activity timeline (idea #92, part B).
 *
 * `IdeaRecord` keeps only the last state, so an idea that was declined a month
 * ago answers "why?" with whatever survived in its body — usually nothing. This
 * is the other half of the ledger's `events[]`: a compact, read-only list of
 * what happened to this idea, in the editor.
 *
 * Two habits shape it:
 *  - an absence renders as NOTHING, not as an empty frame. An idea captured
 *    before the log existed has no history, and a box saying "no history" would
 *    imply something is missing rather than that nothing was recorded yet;
 *  - the actor is shown as the board knows it (`you`, an agent label, or the
 *    run), because "who did this" is half of the question the timeline exists
 *    to answer.
 *
 * The list is already bounded host-side (the last 50 entries), so the view adds
 * a scroll cap rather than another bound: a fifty-line log stays readable in a
 * modal instead of pushing the verdict buttons off the screen.
 */

import type { IdeaEvent } from '../core/ideas.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'

export interface ActivityTimelineProps {
  /**
   * The idea to describe. Takes the event log and nothing else: the editor
   * hands it the full record it fetched on demand, and a component that needed
   * more would force the deferred-body read to carry more than it does.
   */
  idea: { events?: IdeaEvent[] }
}

/** How one actor label reads in the UI. */
function actorLabel(actor: string): string {
  if (actor === 'human') return t('activity.human')
  if (actor === 'run') return t('activity.run')
  // `agent:<initiator>`: the label is the plugin's own naming, which already
  // reads as a program (`plugin:ideas-manager:ai-capture`).
  return actor.startsWith('agent:') ? actor.slice('agent:'.length) : actor
}

/** One entry: when, who, what. Rendered chronologically, oldest first. */
function ActivityRow({ entry }: { entry: IdeaEvent }) {
  return (
    <li className={classes.activityRow} data-dsh-ideas-activity-row="">
      <span className={classes.activityWhen}>
        <time dateTime={new Date(entry.at).toISOString()}>{shortDate(entry.at)}</time>
        {' · '}
        <span className={classes.activityActor}>{actorLabel(entry.actor)}</span>
      </span>
      <span className={classes.activitySummary}>{entry.summary}</span>
    </li>
  )
}

/**
 * The recorded life of an idea, or nothing at all.
 *
 * Renders only when the ledger actually holds entries: an idea that has never
 * been touched since the log landed simply has none, and silence is the honest
 * reading.
 */
export function ActivityTimeline({ idea }: ActivityTimelineProps) {
  const events = idea.events
  if (events === undefined || events.length === 0) return null
  return (
    <div className={classes.activity} data-dsh-ideas-activity="" title={t('activity.hint')}>
      <span className={classes.activityLabel}>
        {t('activity.label', { count: events.length })}
      </span>
      <ol className={classes.activityList} style={{ maxHeight: '9.5em' }}>
        {events.map((entry, index) => (
          <ActivityRow key={`${entry.at}-${index}`} entry={entry} />
        ))}
      </ol>
    </div>
  )
}

/** Compact day/month stamp, the same one every other date on the board uses. */
function shortDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}