/**
 * Delivered view: the derived "exit log" of the T2 lifecycle — archived ideas
 * of the current workspace scope, most recent exit first. This is the
 * generated equivalent of the exit log for archived ideas; nothing here is
 * hand-edited. One row per archived idea: on the left an
 * exit stamp — green "delivered YYYY-MM-DD" for ideas that went through the
 * deliver verb, a neutral "archived YYYY-MM-DD" for manually archived
 * (abandoned) ones — then the title, workspace, value/effort, description
 * preview (MD/raw like the kanban and Priorities), and the edit/restore
 * actions. Restoring an idea brings it back to the open backlog (the deliver
 * verb is the only way in, restore the only way out).
 *
 * The run-state tags (idea #71) are the shared RunStateBadges of the Overview
 * card header: a run started while the idea was already under review or
 * archived stays followed by the host poll until the stamp clears, so the
 * journal must not hide a row whose execution is still in flight.
 */

import { type CSSProperties } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import type { IdeaListRow } from '../protocol.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { ScoreBadge } from './score-badge.tsx'
import { RunStateBadges } from './run-state-badges.tsx'
import { IdeaTitle } from './idea-title.tsx'
import { IdeaPreview } from './idea-preview.tsx'
import { tagHue } from './tags.ts'

export interface DeliveredViewProps {
  client: IdeasClient
  /** Archived list rows of the current scope, unsorted. */
  archivedIdeas: readonly IdeaListRow[]
  /** Resolve a workspace id to its display label. */
  workspaceTitle: (workspaceId: string) => string
  /** Open the shared edit modal on the given row (fetches the full body first). */
  onEdit: (idea: IdeaListRow) => void
  /** Toggle a tag in the shared conjunctive filter (same state as kanban). */
  onToggleTag: (name: string) => void
  /** Currently selected filter tags (highlighted row pills). */
  activeTags: readonly string[]
  /** Render descriptions as markdown (raw text otherwise), like the kanban. */
  mdMode: boolean
  /**
   * Resolve the parent of a follow-up child into its ledger number (idea #71).
   * The board owns the id -> idea map and passes the resolver down.
   */
  parentNumber?: (ideaId: string) => number | undefined
}

/** Most recent exit first (deliveredAt for delivered, archivedAt otherwise). */
function mostRecentFirst(ideas: readonly IdeaListRow[]): IdeaListRow[] {
  return [...ideas].sort((a, b) => exitAt(b) - exitAt(a))
}

/** The stamp date: the delivery date when delivered, the archive date else. */
function exitAt(idea: IdeaListRow): number {
  return idea.deliveredAt ?? idea.archivedAt ?? idea.updatedAt ?? idea.createdAt
}

/** Compact ISO "YYYY-MM-DD" for the exit stamp (the delivered/archived date). */
function isoDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function DeliveredView({ client, archivedIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, parentNumber }: DeliveredViewProps) {
  const rows = mostRecentFirst(archivedIdeas)
  return (
    <div className={classes.priorities} data-dsh-ideas-delivered="">
      <div className={classes.prioritiesHint}>{t('delivered.hint')}</div>
      {rows.length === 0
        ? <div className={classes.empty}>{t('delivered.empty')}</div>
        : (
          <ol className={classes.prioritiesList}>
            {rows.map(idea => {
              const workspaceId = idea.workspaceId
              const delivered = idea.deliveredAt !== undefined
              const stamp = delivered
                ? t('delivered.deliverAt', { date: isoDate(idea.deliveredAt!) })
                : t('delivered.archivedAt', { date: isoDate(exitAt(idea)) })
              return (
                <li key={idea.id} className={classes.prioritiesRow}>
                  <span
                    className={delivered ? classes.deliveredStamp : classes.archivedStamp}
                    title={delivered ? t('card.deliveredHint') : t('delivered.archivedHint')}
                  >
                    {stamp}
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
                      <IdeaTitle ideaNumber={idea.ideaNumber} title={idea.title} />
                    </div>
                    {(workspaceId !== undefined || idea.tags !== undefined || idea.value !== undefined || idea.effort !== undefined) && (
                      <div className={classes.cardMeta}>
                        {workspaceId !== undefined && (
                          <span className={classes.workspaceChip}>{workspaceTitle(workspaceId)}</span>
                        )}
                        {idea.tags !== undefined && idea.tags.map(tag => (
                          <span
                            key={tag.name}
                            className={classes.tag}
                            style={{ '--dsh-ideas-tag-hue': tagHue(tag.name) } as CSSProperties}
                            onClick={() => { onToggleTag(tag.name) }}
                          >
                            {tag.name}
                          </span>
                        ))}
                        {idea.value !== undefined && <ScoreBadge axis="value" value={idea.value} />}
                        {idea.effort !== undefined && <ScoreBadge axis="effort" value={idea.effort} />}
                      </div>
                    )}
                    <IdeaPreview excerpt={idea.bodyExcerpt} mdMode={mdMode} onEdit={() => { onEdit(idea) }} />
                  </div>
                  {/* Run-state tags (idea #71), same component and same
                      top-right placement as the Overview card header: an idea
                      archived while a run was still in flight keeps that run
                      followed by the host poll, so the journal must say so. The
                      row is rendered unconditionally here — the tags no longer
                      share the meta line, so a bare archived row needs no meta
                      to exist at all. The exit stamp on the left already carries
                      the delivery date, hence showDelivered=false. */}
                  <div className={classes.rowState}>
                    <RunStateBadges
                      idea={idea}
                      client={client}
                      parentNumber={parentNumber}
                      showDelivered={false}
                    />
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
