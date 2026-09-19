/**
 * Priorities view: the suggested ranking of the open backlog, mirroring the
 * "Suggested priority" table the OpenTimbre IDEAS.md process maintained by
 * hand. Each open idea is one ranked row (rank, title, workspace, value/
 * effort, rationale) with move-up/move-down actions that reorder the open
 * column through the rank-write path used by the kanban. The rationale text
 * is displayed when the idea carries one; writing it arrives with the T1
 * triage flow.
 */

import type { IdeasClient } from './ideas-client.ts'
import type { IdeaRecord } from '../core/ideas.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { orderIdeas, moveIdeaInOpenBacklog } from './ordering.ts'
import { levelLabelKey } from './levels.ts'

export interface PrioritiesProps {
  client: IdeasClient
  /** Open ideas of the current workspace scope, unsorted (ranked below). */
  openIdeas: readonly IdeaRecord[]
  /** Full ledger rows, for the column-major rebuild the reorder needs. */
  allIdeas: readonly IdeaRecord[]
  /** Resolve a workspace id to its display label. */
  workspaceTitle: (workspaceId: string) => string
  /** Open the shared edit modal on the given idea. */
  onEdit: (idea: IdeaRecord) => void
}

/** Ranked backlog view (see module doc). */
export function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit }: PrioritiesProps) {
  const ranked = orderIdeas(openIdeas)

  const move = (idea: IdeaRecord, toward: 'up' | 'down'): void => {
    const ordered = moveIdeaInOpenBacklog(allIdeas, idea.id, toward)
    if (ordered !== undefined) void client.reorderIdea(ordered)
  }

  return (
    <div className={classes.priorities} data-dsh-ideas-priorities="">
      <div className={classes.prioritiesHint}>{t('priorities.hint')}</div>
      {ranked.length === 0
        ? <div className={classes.empty}>{t('priorities.empty')}</div>
        : (
          <ol className={classes.prioritiesList}>
            {ranked.map((idea, index) => {
              const first = index === 0
              const last = index === ranked.length - 1
              return (
                <li key={idea.id} className={classes.prioritiesRow} data-dsh-idea-id={idea.id}>
                  <span className={classes.prioritiesRank}>{index + 1}</span>
                  <div className={classes.prioritiesGrow}>
                    <div
                      className={classes.prioritiesTitle}
                      role="button"
                      tabIndex={0}
                      title={t('card.clickToEdit')}
                      onClick={() => { onEdit(idea) }}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onEdit(idea)
                        }
                      }}
                    >
                      {idea.title}
                    </div>
                    <div className={classes.cardMeta}>
                      {idea.workspaceId !== undefined && (
                        <span className={classes.workspaceChip}>{workspaceTitle(idea.workspaceId)}</span>
                      )}
                      {idea.value !== undefined && (
                        <span className={classes.score}>{t('card.value', { level: t(levelLabelKey(idea.value)!) })}</span>
                      )}
                      {idea.effort !== undefined && (
                        <span className={classes.score}>{t('card.effort', { level: t(levelLabelKey(idea.effort)!) })}</span>
                      )}
                    </div>
                    {idea.rationale !== undefined && (
                      <div className={classes.prioritiesRationale}>
                        <span className={classes.prioritiesRationaleLabel}>{t('priorities.rationale')}</span>
                        <span className={classes.prioritiesRationaleText}>{idea.rationale}</span>
                      </div>
                    )}
                  </div>
                  <div className={classes.prioritiesActions}>
                    <button
                      type="button"
                      className={classes.prioritiesMove}
                      disabled={client.pending || first}
                      aria-label={t('priorities.moveUp')}
                      title={t('priorities.moveUp')}
                      onClick={() => { move(idea, 'up') }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={classes.prioritiesMove}
                      disabled={client.pending || last}
                      aria-label={t('priorities.moveDown')}
                      title={t('priorities.moveDown')}
                      onClick={() => { move(idea, 'down') }}
                    >
                      ↓
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
    </div>
  )
}