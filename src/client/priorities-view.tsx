/**
 * Priorities view: the suggested ranking of the open backlog — the current
 * best ordering of the open ideas. Each open idea is one ranked row (rank,
 * title, workspace chip, value/effort, description preview, rationale) with
 * move-up/move-down actions and drag & drop reordering of the open column.
 * During a drag an accent line shows the insertion point: before the hovered
 * row (upper half) or after it (lower half); dropping on the list surface
 * below the rows appends at the end of the dragged idea's workspace group.
 *
 * Ranking is PER WORKSPACE ("rank by workspace"): every workspace group (the
 * workspace-less ideas are one generic group) carries its own relative ranks.
 * When the board shows "all workspaces" (`grouped`) the rows are laid out in
 * headed sections — workspaces first in title order, the generic group last —
 * and a drag is only accepted inside the dragged idea's own group (a
 * cross-workspace drop has no within-group insertion point). When the board
 * is scoped to one workspace the grouped layout degrades to a single
 * unheaded list, identical to the pre-grouping behaviour. The wire call is
 * the same rank-write path the kanban uses.
 */

import { useState, type DragEvent, type CSSProperties } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import type { IdeaListRow } from '../protocol.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { tagHue } from './tags.ts'
import {
  compareWorkspaceGroups,
  groupOpenByWorkspace,
  moveIdeaInOpenBacklog,
  rebuildOrder,
  type OpenRankGroup,
} from './ordering.ts'
import { ScoreBadge } from './score-badge.tsx'
import { IdeaTitle } from './idea-title.tsx'
import { IdeaPreview } from './idea-preview.tsx'
import { beforeHalf, draggedIdFrom } from './drag.ts'
import { dragAutoscrollBegin, dragAutoscrollTrack, dragAutoscrollEnd } from './autoscroll.ts'

export interface PrioritiesProps {
  client: IdeasClient
  /** Open list rows of the current workspace scope, unsorted (ranked below). */
  openIdeas: readonly IdeaListRow[]
  /** Full ledger row ids/status/ranks, for the group-major rebuild the reorder needs. */
  allIdeas: readonly IdeaListRow[]
  /** Resolve a workspace id to its display label. */
  workspaceTitle: (workspaceId: string) => string
  /** Open the shared edit modal on the given row (fetches the full body first). */
  onEdit: (idea: IdeaListRow) => void
  /** Toggle a tag in the shared conjunctive filter (same state as kanban). */
  onToggleTag: (name: string) => void
  /** Currently selected filter tags (highlighted pills + row meta). */
  activeTags: readonly string[]
  /** Render descriptions as markdown (raw text otherwise), like the kanban. */
  mdMode: boolean
  /** True when the board shows "all workspaces": render per-workspace headed
   *  sections (the generic group last) and restrict drops to one group.
   *  False (single-workspace scope) keeps the plain unheaded list. */
  grouped: boolean
}

/** Drop indicator: which row is hovered and whether the drop inserts before
 *  (upper half) or after (lower half) it. */
interface DropAt {
  id: string
  before: boolean
}

/** Normalized group discriminator of an idea ('' = the generic group), used
 *  to accept drags inside one group only. */
function groupKeyOfIdea(idea: IdeaListRow): string {
  return idea.workspaceId ?? ''
}

/** Display title of a Priorities group (generic group gets the no-workspace
 *  label), with null for a workspace that has no registry title. */
function groupTitle(group: OpenRankGroup<IdeaListRow>, workspaceTitle: (workspaceId: string) => string): string {
  return group.workspaceId === undefined ? t('board.noWorkspace') : workspaceTitle(group.workspaceId)
}

/** Ranked backlog view (see module doc). */
export function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, grouped }: PrioritiesProps) {
  // Workspace groups in display order; inside every group ideas are ranked
  // relatively. Re-grouping is cheap (a handful of open ideas) and keeps the
  // render a pure function of the props.
  const groups = groupOpenByWorkspace(openIdeas)
    .sort((a, b) => compareWorkspaceGroups(a, b, workspaceTitle))
  // Duplicate of the kanban drag discipline: a dedicated grip starts the HTML5
  // drag carrying the idea id; rows mark where the drop would insert.
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  const [dropAt, setDropAt] = useState<DropAt | undefined>(undefined)

  const move = (idea: IdeaListRow, toward: 'up' | 'down'): void => {
    const ordered = moveIdeaInOpenBacklog(allIdeas, idea.id, toward)
    if (ordered !== undefined) void client.reorderIdea(ordered)
  }

  const startDrag = (event: DragEvent<HTMLDivElement>, idea: IdeaListRow): void => {
    // Carry the idea id on the drag payload (task-board family contract) so
    // the drop target can read it; the state is a fallback for browsers that
    // do not share the payload with the drop target.
    event.dataTransfer.setData('text/plain', idea.id)
    event.dataTransfer.effectAllowed = 'move'
    setDragId(idea.id)
    dragAutoscrollBegin()
  }

  const endDrag = (): void => {
    setDragId(undefined)
    setDropAt(undefined)
    dragAutoscrollEnd()
  }

  const commitDrop = (draggedId: string, beforeId: string | undefined): void => {
    if (draggedId === beforeId) return
    // rebuildOrder is group-aware: the dragged idea lands inside its own
    // workspace group of the open column, right before beforeId when the
    // anchor belongs to that group, else at the group end — so a drop with
    // no anchor (list surface) always appends at the dragged group's end.
    const ordered = rebuildOrder(allIdeas, draggedId, 'open', beforeId)
    void client.reorderIdea(ordered)
    endDrag()
  }

  /** The dragged idea's own group key (undefined when the payload is stale). */
  const groupOfDrag = (draggedId: string): string | undefined => {
    const dragged = openIdeas.find(idea => idea.id === draggedId)
    return dragged === undefined ? undefined : groupKeyOfIdea(dragged)
  }

  /** Same-group check for a hover/drop on a row: cross-workspace drags are
   *  rejected (no insertion point exists between two different groups). */
  const sameGroupAsDrag = (draggedId: string, idea: IdeaListRow): boolean => {
    const dragGroup = groupOfDrag(draggedId)
    return dragGroup !== undefined && dragGroup === groupKeyOfIdea(idea)
  }

  const dropOnRow = (event: DragEvent<HTMLLIElement>, idea: IdeaListRow, index: number, groupRanked: readonly IdeaListRow[]): void => {
    event.preventDefault()
    event.stopPropagation()
    const draggedId = draggedIdFrom(event, dragId)
    if (draggedId === undefined || draggedId === idea.id) return
    if (!sameGroupAsDrag(draggedId, idea)) return
    // Upper half inserts before the row, lower half after it (before the next
    // row; past the last row means appending at the group end).
    const before = beforeHalf(event, event.currentTarget)
    const beforeId = before ? idea.id : groupRanked[index + 1]?.id
    commitDrop(draggedId, beforeId)
  }

  // Dropping on a group's list surface (outside any row) appends at the end
  // of the dragged idea's OWN group — rebuildOrder lands a no-anchor move at
  // the group end, so the surface drop is group-correct by construction. The
  // indicator shows the insertion line below the group's last row while
  // hovering that surface.
  const listDragOver = (event: DragEvent<HTMLOListElement>, groupRanked: readonly IdeaListRow[]): void => {
    if (dragId === undefined || groupOfDrag(dragId) === undefined) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    // Auto-scroll the list when the pointer nears its top/bottom edge.
    const scroller = event.currentTarget.closest<HTMLElement>('[data-dsh-list-scroll]')
    if (scroller !== null) dragAutoscrollTrack(event, scroller)
    if ((event.target as HTMLElement).closest('li') !== null) return
    const last = groupRanked[groupRanked.length - 1]
    setDropAt(last === undefined ? undefined : { id: last.id, before: false })
  }

  const dropAtEnd = (event: DragEvent<HTMLOListElement>): void => {
    if ((event.target as HTMLElement).closest('li') !== null) return
    event.preventDefault()
    const draggedId = draggedIdFrom(event, dragId)
    if (draggedId !== undefined) commitDrop(draggedId, undefined)
  }

  const anyRows = openIdeas.length > 0
  return (
    <div
      className={classes.priorities}
      data-dsh-ideas-priorities=""
      data-dsh-ideas-grouped={grouped ? '' : undefined}
    >      <div className={classes.prioritiesHint}>{t('priorities.hint')}</div>
      {!anyRows
        ? <div className={classes.empty}>{t('priorities.empty')}</div>
        : (
          groups.map(group => (
            <section
              key={group.workspaceId ?? ''}
              className={classes.prioritiesGroup}
              data-dsh-priorities-group={group.workspaceId ?? ''}
            >
              {grouped && (
                <h4 className={classes.prioritiesGroupTitle}>{groupTitle(group, workspaceTitle)}</h4>
              )}
              <ol
                className={classes.prioritiesList}
                data-dsh-list-scroll=""
                onDragOver={event => { listDragOver(event, group.ideas) }}
                onDrop={dropAtEnd}
              >
                {group.ideas.map((idea, index) => {
                  const first = index === 0
                  const last = index === group.ideas.length - 1
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
                        if (!sameGroupAsDrag(dragId, idea)) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        const before = beforeHalf(event, event.currentTarget)
                        setDropAt(current => current !== undefined && current.id === idea.id && current.before === before
                          ? current
                          : { id: idea.id, before })
                      }}
                      onDrop={event => { dropOnRow(event, idea, index, group.ideas) }}
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
                          <IdeaTitle ideaNumber={idea.ideaNumber} title={idea.title} />
                        </div>
                        <div className={classes.cardMeta}>
                          {idea.workspaceId !== undefined && (
                            <span className={classes.workspaceChip}>{workspaceTitle(idea.workspaceId)}</span>
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
                        <IdeaPreview excerpt={idea.bodyExcerpt} mdMode={mdMode} onEdit={() => { onEdit(idea) }} />
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
            </section>
          ))
        )}
    </div>
  )
}