/**
 * Priorities view: the suggested ranking of the open backlog, mirroring the
 * "Suggested priority" table the OpenTimbre IDEAS.md process maintained by
 * hand. Each open idea is one ranked row (rank, title, workspace, value/
 * effort, description preview, rationale) with move-up/move-down actions and
 * drag & drop reordering of the open column (drop before a row or at the end
 * of the list; the wire call is the same rank-write path the kanban uses).
 * The rationale text is displayed when the idea carries one; writing it
 * arrives with the T1 triage flow.
 */

import { useState, type DragEvent } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import type { IdeaRecord } from '../core/ideas.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { orderIdeas, moveIdeaInOpenBacklog, rebuildOrder } from './ordering.ts'
import { renderMarkdown } from './markdown.ts'
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
  /** Render descriptions as markdown (raw text otherwise), like the kanban. */
  mdMode: boolean
}

/** Ranked backlog view (see module doc). */
export function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, mdMode }: PrioritiesProps) {
  const ranked = orderIdeas(openIdeas)
  // Duplicate of the kanban drag discipline: a dedicated grip starts the HTML5
  // drag carrying the idea id; rows mark where the drop would insert.
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  const [dropBefore, setDropBefore] = useState<string | undefined>(undefined)

  const move = (idea: IdeaRecord, toward: 'up' | 'down'): void => {
    const ordered = moveIdeaInOpenBacklog(allIdeas, idea.id, toward)
    if (ordered !== undefined) void client.reorderIdea(ordered)
  }

  const startDrag = (event: DragEvent<HTMLDivElement>, idea: IdeaRecord): void => {
    // Carry the idea id on the drag payload (task-board family contract) so
    // the drop target can read it; the state is a fallback for browsers that
    // do not share the payload with the drop target.
    event.dataTransfer.setData('text/plain', idea.id)
    event.dataTransfer.effectAllowed = 'move'
    setDragId(idea.id)
  }

  const endDrag = (): void => {
    setDragId(undefined)
    setDropBefore(undefined)
  }

  const commitDrop = (event: DragEvent<HTMLElement>, beforeId: string | undefined): void => {
    const transferId = event.dataTransfer.getData('text/plain')
    const draggedId = transferId !== undefined && transferId !== '' ? transferId : dragId
    if (draggedId === undefined || draggedId === beforeId) return
    const ordered = rebuildOrder(allIdeas, draggedId, 'open', beforeId)
    void client.reorderIdea(ordered)
    endDrag()
  }

  const dropOnRow = (event: DragEvent<HTMLLIElement>, beforeId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    commitDrop(event, beforeId)
  }

  // Dropping on the list surface (outside any row) appends at the end of the
  // open backlog, mirroring the kanban column-end drop.
  const dropAtEnd = (event: DragEvent<HTMLOListElement>): void => {
    if ((event.target as HTMLElement).closest('li') !== null) return
    event.preventDefault()
    commitDrop(event, undefined)
  }

  return (
    <div className={classes.priorities} data-dsh-ideas-priorities="">
      <div className={classes.prioritiesHint}>{t('priorities.hint')}</div>
      {ranked.length === 0
        ? <div className={classes.empty}>{t('priorities.empty')}</div>
        : (
          <ol
            className={classes.prioritiesList}
            onDragOver={event => {
              if (dragId !== undefined) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }
            }}
            onDrop={dropAtEnd}
          >
            {ranked.map((idea, index) => {
              const first = index === 0
              const last = index === ranked.length - 1
              const isTarget = dragId !== undefined && dropBefore === idea.id
              return (
                <li
                  key={idea.id}
                  className={classes.prioritiesRow}
                  data-dsh-idea-id={idea.id}
                  data-drop-target={isTarget ? '' : undefined}
                  onDragEnter={() => { if (dragId !== undefined) setDropBefore(idea.id) }}
                  onDragOver={event => {
                    if (dragId !== undefined) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }
                  }}
                  onDrop={event => { dropOnRow(event, idea.id) }}
                >
                  <span className={classes.prioritiesRank}>{index + 1}</span>
                  <div
                    className={classes.cardGrip}
                    draggable={!client.pending}
                    title={t('card.drag')}
                    aria-label={t('card.drag')}
                    onDragStart={(event) => { startDrag(event, idea) }}
                    onDragEnd={endDrag}
                  >
                    <span aria-hidden="true">⠿</span>
                  </div>
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
                    {idea.body.trim() !== '' && (
                      mdMode
                        ? (
                          <div
                            className={`${classes.markdownBody} ${classes.bodyClickable}`}
                            tabIndex={0}
                            data-dsh-ideas-md=""
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(idea.body) }}
                            onClick={event => {
                              // A link inside the rendered body opens the
                              // target; anything else edits (kanban parity).
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