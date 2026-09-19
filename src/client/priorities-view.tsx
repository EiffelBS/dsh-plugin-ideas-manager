/**
 * Priorities view: the suggested ranking of the open backlog, mirroring the
 * "Suggested priority" table the OpenTimbre IDEAS.md process maintained by
 * hand. Each open idea is one ranked row (rank, title, workspace, value/
 * effort, description preview, rationale) with move-up/move-down actions and
 * drag & drop reordering of the open column. During a drag an accent line
 * shows the insertion point: before the hovered row (upper half) or after it
 * (lower half); dropping on the list surface below the rows appends at the
 * end. The wire call is the same rank-write path the kanban uses.
 */

import { useState, type DragEvent } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import type { IdeaRecord } from '../core/ideas.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { orderIdeas, moveIdeaInOpenBacklog, rebuildOrder } from './ordering.ts'
import { renderMarkdown } from './markdown.ts'
import { ScoreBadge } from './score-badge.tsx'
import { beforeHalf, draggedIdFrom } from './drag.ts'

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

/** Drop indicator: which row is hovered and whether the drop inserts before
 *  (upper half) or after (lower half) it. */
interface DropAt {
  id: string
  before: boolean
}

/** Ranked backlog view (see module doc). */
export function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, mdMode }: PrioritiesProps) {
  const ranked = orderIdeas(openIdeas)
  // Duplicate of the kanban drag discipline: a dedicated grip starts the HTML5
  // drag carrying the idea id; rows mark where the drop would insert.
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  const [dropAt, setDropAt] = useState<DropAt | undefined>(undefined)

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
    setDropAt(undefined)
  }

  const commitDrop = (draggedId: string, beforeId: string | undefined): void => {
    if (draggedId === beforeId) return
    const ordered = rebuildOrder(allIdeas, draggedId, 'open', beforeId)
    void client.reorderIdea(ordered)
    endDrag()
  }

  const dropOnRow = (event: DragEvent<HTMLLIElement>, idea: IdeaRecord, index: number): void => {
    event.preventDefault()
    event.stopPropagation()
    const draggedId = draggedIdFrom(event, dragId)
    if (draggedId === undefined || draggedId === idea.id) return
    // Upper half inserts before the row, lower half after it (before the next
    // row; past the last row means appending at the end).
    const before = beforeHalf(event, event.currentTarget)
    const beforeId = before ? idea.id : ranked[index + 1]?.id
    commitDrop(draggedId, beforeId)
  }

  // Dropping on the list surface (outside any row) appends at the end of the
  // open backlog, mirroring the kanban column-end drop. The indicator shows
  // the insertion line below the last row while hovering that surface.
  const listDragOver = (event: DragEvent<HTMLOListElement>): void => {
    if (dragId === undefined) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if ((event.target as HTMLElement).closest('li') !== null) return
    const last = ranked[ranked.length - 1]
    setDropAt(last === undefined ? undefined : { id: last.id, before: false })
  }

  const dropAtEnd = (event: DragEvent<HTMLOListElement>): void => {
    if ((event.target as HTMLElement).closest('li') !== null) return
    event.preventDefault()
    const draggedId = draggedIdFrom(event, dragId)
    if (draggedId !== undefined) commitDrop(draggedId, undefined)
  }

  return (
    <div className={classes.priorities} data-dsh-ideas-priorities="">
      <div className={classes.prioritiesHint}>{t('priorities.hint')}</div>
      {ranked.length === 0
        ? <div className={classes.empty}>{t('priorities.empty')}</div>
        : (
          <ol
            className={classes.prioritiesList}
            onDragOver={listDragOver}
            onDrop={dropAtEnd}
          >
            {ranked.map((idea, index) => {
              const first = index === 0
              const last = index === ranked.length - 1
              const hovering = dragId !== undefined && dragId !== idea.id && dropAt?.id === idea.id
              return (
                <li
                  key={idea.id}
                  className={classes.prioritiesRow}
                  data-dsh-idea-id={idea.id}
                  data-drop-before={hovering && dropAt!.before ? '' : undefined}
                  data-drop-after={hovering && !dropAt!.before ? '' : undefined}
                  onDragOver={event => {
                    if (dragId === undefined || idea.id === dragId) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const before = beforeHalf(event, event.currentTarget)
                    setDropAt(current => current !== undefined && current.id === idea.id && current.before === before
                      ? current
                      : { id: idea.id, before })
                  }}
                  onDrop={event => { dropOnRow(event, idea, index) }}
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
                      {idea.value !== undefined && <ScoreBadge axis="value" value={idea.value} />}
                      {idea.effort !== undefined && <ScoreBadge axis="effort" value={idea.effort} />}
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