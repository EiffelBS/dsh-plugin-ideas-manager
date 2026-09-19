/**
 * Delivered view: the derived "delivered log" of the T2 lifecycle — archived
 * ideas of the current workspace scope that carry a delivery stamp, most
 * recent first. This is the generated equivalent of the OT delivered-log
 * entries (hand-maintained in IDEAS.md); nothing here is hand-edited. One
 * row per delivered idea: the delivery date, title, workspace, value/effort,
 * description preview (MD/raw like the kanban and Priorities), and the
 * edit/restore actions. Restoring an idea brings it back to the open backlog
 * (the deliver verb is the only way in, restore the only way out).
 */

import type { IdeasClient } from './ideas-client.ts'
import type { IdeaRecord } from '../core/ideas.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { renderMarkdown } from './markdown.ts'
import { levelLabelKey } from './levels.ts'

export interface DeliveredViewProps {
  client: IdeasClient
  /** Archived + deliveredAt ideas of the current scope, unsorted. */
  deliveredIdeas: readonly IdeaRecord[]
  /** Resolve a workspace id to its display label. */
  workspaceTitle: (workspaceId: string) => string
  /** Open the shared edit modal on the given idea. */
  onEdit: (idea: IdeaRecord) => void
  /** Render descriptions as markdown (raw text otherwise), like the kanban. */
  mdMode: boolean
}

/** Most recent delivery first; ideas without a stamp never get here. */
function deliveredFirst(ideas: readonly IdeaRecord[]): IdeaRecord[] {
  return [...ideas].sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0))
}

export function DeliveredView({ client, deliveredIdeas, workspaceTitle, onEdit, mdMode }: DeliveredViewProps) {
  const rows = deliveredFirst(deliveredIdeas)
  return (
    <div className={classes.priorities} data-dsh-ideas-delivered="">
      <div className={classes.prioritiesHint}>{t('delivered.hint')}</div>
      {rows.length === 0
        ? <div className={classes.empty}>{t('delivered.empty')}</div>
        : (
          <ol className={classes.prioritiesList}>
            {rows.map(idea => {
              const workspaceId = idea.workspaceId
              return (
                <li key={idea.id} className={classes.prioritiesRow}>
                  <span className={classes.deliveredStamp}>
                    {idea.deliveredAt === undefined ? '' : t('delivered.deliverAt', { date: isoDate(idea.deliveredAt) })}
                  </span>
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
                    {(workspaceId !== undefined || idea.value !== undefined || idea.effort !== undefined) && (
                      <div className={classes.cardMeta}>
                        {workspaceId !== undefined && (
                          <span className={classes.workspaceChip}>{workspaceTitle(workspaceId)}</span>
                        )}
                        {idea.value !== undefined && (
                          <span className={classes.score}>{t('card.value', { level: t(levelLabelKey(idea.value)!) })}</span>
                        )}
                        {idea.effort !== undefined && (
                          <span className={classes.score}>{t('card.effort', { level: t(levelLabelKey(idea.effort)!) })}</span>
                        )}
                      </div>
                    )}
                    {idea.body.trim() !== '' && (
                      mdMode
                        ? (
                          <div
                            className={`${classes.markdownBody} ${classes.bodyClickable}`}
                            tabIndex={0}
                            data-dsh-ideas-md=""
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(idea.body) }}
                            title={t('card.clickToEdit')}
                            onClick={event => {
                              if ((event.target as HTMLElement).closest('a') !== null) return
                              onEdit(idea)
                            }}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                onEdit(idea)
                              }
                            }}
                          />
                        )
                        : (
                          <div
                            className={`${classes.cardBody} ${classes.bodyClickable}`}
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
                            {idea.body}
                          </div>
                        )
                    )}
                  </div>
                  <div className={classes.prioritiesActions}>
                    <button
                      type="button"
                      className={classes.actionButton}
                      disabled={client.pending}
                      onClick={() => { onEdit(idea) }}
                    >
                      {t('card.edit')}
                    </button>
                    <button
                      type="button"
                      className={classes.actionButton}
                      disabled={client.pending}
                      title={t('card.restore')}
                      onClick={() => { void client.restoreIdea(idea.id) }}
                    >
                      {t('card.restore')}
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

/** Compact ISO "YYYY-MM-DD" for the delivering stamp (the OT log convention). */
function isoDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}