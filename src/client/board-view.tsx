/**
 * Board view: the 3-column kanban (open / archived / declined) that replaces
 * the center column while active. P1 scope: full CRUD — capture and edit
 * modals, per-card archive/restore/decline/delete, manual drag between Open
 * and Archived (+ intra-column reorder), search and a conjunctive tag filter.
 */

import { useEffect, useState, type FormEvent } from 'react'
import type { IdeasClient, IdeaClientPatch } from './ideas-client.ts'
import { IDEA_COLUMNS, type IdeaRecord, type IdeaStatus } from '../core/ideas.ts'
import { t, type IdeasKey } from './locales.ts'
import { classes } from './style.ts'

const STATUS_LABEL: Record<IdeaStatus, IdeasKey> = {
  open: 'board.status.open',
  archived: 'board.status.archived',
  declined: 'board.status.declined',
}

function orderKey(idea: IdeaRecord): number {
  return idea.rank ?? Number.MAX_SAFE_INTEGER
}

function orderIdeas(ideas: readonly IdeaRecord[]): IdeaRecord[] {
  return [...ideas].sort((a, b) => orderKey(a) - orderKey(b))
}

function matchesFilter(idea: IdeaRecord, filter: string): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  const haystacks = [idea.title, idea.body, ...(idea.tags ?? []).map(tag => tag.name)]
  return haystacks.some(text => text.toLowerCase().includes(needle))
}

/** Conjunctive tag filter: adding a label narrows the board. */
function matchesTags(idea: IdeaRecord, selected: readonly string[]): boolean {
  if (selected.length === 0) return true
  const names = new Set((idea.tags ?? []).map(tag => tag.name))
  return selected.every(name => names.has(name))
}

/** Every label in use across the ledger, sorted (for the filter chips). */
function collectKnownTags(ideas: readonly IdeaRecord[]): string[] {
  const names = new Set<string>()
  for (const idea of ideas) for (const tag of idea.tags ?? []) names.add(tag.name)
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Rebuild the global rank order with `movedId` placed at the drop position of
 * its target column: after `beforeId` when given, else at the column end.
 * Columns are always laid out open, archived, declined, each rank-sorted.
 */
function rebuildOrder(all: readonly IdeaRecord[], movedId: string, targetStatus: IdeaStatus, beforeId: string | undefined): string[] {
  const columns: string[] = []
  for (const status of IDEA_COLUMNS) {
    const ids = orderIdeas(all.filter(idea => idea.status === status && idea.id !== movedId)).map(idea => idea.id)
    if (status === targetStatus) {
      let index = ids.length
      if (beforeId !== undefined) {
        const at = ids.indexOf(beforeId)
        if (at >= 0) index = at
      }
      ids.splice(index, 0, movedId)
    }
    columns.push(...ids)
  }
  return columns
}

function tagsText(idea: IdeaRecord | undefined): string {
  return idea?.tags === undefined ? '' : idea.tags.map(tag => tag.name).join(', ')
}

/** Shared capture/edit modal. */
function IdeaModal({ client, initial, onClose }: { client: IdeasClient; initial?: IdeaRecord; onClose: () => void }) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [value, setValue] = useState(initial?.value === undefined ? '' : String(initial.value))
  const [effort, setEffort] = useState(initial?.effort === undefined ? '' : String(initial.effort))
  const [tags, setTags] = useState(tagsText(initial))
  const [error, setError] = useState<string | undefined>(undefined)

  const toNumber = (raw: string): number | undefined => {
    const parsed = Number(raw)
    return raw.trim() === '' ? undefined : Number.isFinite(parsed) ? parsed : undefined
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (title.trim() === '') {
      setError(t('new.required'))
      return
    }
    try {
      if (initial === undefined) {
        await client.createIdea({ title: title.trim(), body: body.trim(), tags: tags.split(',') })
      } else {
        const patch: IdeaClientPatch = {
          title: title.trim(),
          body: body.trim(),
          ...(toNumber(value) === undefined ? {} : { value: toNumber(value)! }),
          ...(toNumber(effort) === undefined ? {} : { effort: toNumber(effort)! }),
          tags: tags.split(','),
        }
        await client.updateIdea(initial.id, patch)
      }
      onClose()
    } catch {
      // The client carries the Host error; the modal stays open for a retry.
    }
  }

  return (
    <div className={classes.overlay} onClick={onClose}>
      <form className={classes.modal} onClick={event => { event.stopPropagation() }} onSubmit={submit}>
        <h3 className={classes.modalTitle}>{initial === undefined ? t('board.new') : t('edit.title')}</h3>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-title">{t('new.title')}</label>
          <input
            id="dsh-ideas-title"
            className={classes.input}
            type="text"
            value={title}
            placeholder={t('new.titlePlaceholder')}
            autoFocus
            onChange={event => { setTitle(event.target.value) }}
          />
        </div>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-body">{t('new.body')}</label>
          <textarea
            id="dsh-ideas-body"
            className={classes.textarea}
            value={body}
            placeholder={t('new.bodyPlaceholder')}
            onChange={event => { setBody(event.target.value) }}
          />
        </div>
        <div className={classes.fieldRow}>
          <div className={classes.field}>
            <label className={classes.fieldLabel} htmlFor="dsh-ideas-value">{t('new.value')}</label>
            <input
              id="dsh-ideas-value"
              className={classes.input}
              type="number"
              min={0}
              value={value}
              onChange={event => { setValue(event.target.value) }}
            />
          </div>
          <div className={classes.field}>
            <label className={classes.fieldLabel} htmlFor="dsh-ideas-effort">{t('new.effort')}</label>
            <input
              id="dsh-ideas-effort"
              className={classes.input}
              type="number"
              min={0}
              value={effort}
              onChange={event => { setEffort(event.target.value) }}
            />
          </div>
        </div>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-tags">{t('new.tags')}</label>
          <input
            id="dsh-ideas-tags"
            className={classes.input}
            type="text"
            value={tags}
            placeholder={t('new.tagsPlaceholder')}
            onChange={event => { setTags(event.target.value) }}
          />
        </div>
        {error !== undefined && <div className={classes.error}>{error}</div>}
        <div className={classes.modalActions}>
          <button type="button" className={classes.ghostButton} onClick={onClose}>{t('new.cancel')}</button>
          <button type="submit" className={classes.primaryButton} disabled={client.pending}>
            {initial === undefined ? t('new.submit') : t('edit.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

type DragState = { id: string; source: IdeaStatus } | undefined
type DragTarget = { status: IdeaStatus; beforeId?: string } | undefined

/** Board component; subscribes to the client snapshot. */
export function IdeasBoard({ client }: { client: IdeasClient }) {
  const [snapshot, setSnapshot] = useState(client.snapshot)
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<IdeaRecord | undefined>(undefined)
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined)
  const [drag, setDrag] = useState<DragState>(undefined)
  const [dragTarget, setDragTarget] = useState<DragTarget>(undefined)

  useEffect(
    () => client.subscribe(() => setSnapshot(client.snapshot)),
    [client],
  )

  const ideas = snapshot?.ideas ?? []
  const revision = snapshot?.revision
  const knownTags = collectKnownTags(ideas)
  const visible = ideas.filter(idea => matchesFilter(idea, filter) && matchesTags(idea, tagFilter))
  const byStatus = (status: IdeaStatus): IdeaRecord[] => orderIdeas(visible.filter(idea => idea.status === status))

  const toggleTag = (name: string): void => {
    setTagFilter(current => current.includes(name)
      ? current.filter(entry => entry !== name)
      : [...current, name])
  }

  const performDrop = async (event?: { dataTransfer: { getData(format: string): string } }): Promise<void> => {
    // The dropped task id is carried on the dataTransfer (like the
    // task-board family); the drag state is a fallback for browsers that
    // do not share the payload with the drop target.
    const transferId = event?.dataTransfer?.getData('text/plain')
    const draggedId = transferId !== undefined && transferId !== '' ? transferId : drag?.id
    const target = dragTarget
    if (draggedId === undefined || target === undefined || drag === undefined) return
    const source = drag.source
    try {
      if (source !== target.status) {
        if (target.status === 'declined') {
          // The wire protocol only moves open <-> archived; declining is its
          // own action (sets archivedAt, mirrors decline on the task board).
          await client.declineIdea(draggedId)
        } else {
          await client.moveIdea(draggedId, target.status as Extract<IdeaStatus, 'open' | 'archived'>)
        }
      }
      const all = client.snapshot?.ideas ?? []
      const ordered = rebuildOrder(all, draggedId, target.status, target.beforeId)
      await client.reorderIdea(ordered)
    } catch {
      // The board reflects the Host verdict; a failed drop needs no retry UI.
    }
    setDrag(undefined)
    setDragTarget(undefined)
  }

  /** Start an HTML5 drag carrying the idea id, exactly like the task-board family. */
  const startDrag = (idea: IdeaRecord): void => {
    setDrag({ id: idea.id, source: idea.status })
  }

  const openEdit = (idea: IdeaRecord): void => {
    setConfirmId(undefined)
    setEditing(idea)
  }

  return (
    <div className={classes.board} data-dsh-ideas-board="" data-dsh-plugin="ideas">
      <header className={classes.boardHeader}>
        <button
          type="button"
          className={`${classes.ghostButton} ${classes.backButton}`}
          data-dsh-center-view-back=""
          aria-label={t('board.close')}
          onClick={() => { client.closeBoard() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{t('board.close')}</span>
        </button>
        <h2 className={classes.boardTitle}>{t('board.title')}</h2>
        {revision !== undefined && <span className={classes.detailMeta}>{t('board.revision', { revision })}</span>}
        <input
          className={classes.search}
          type="search"
          placeholder={t('board.search')}
          value={filter}
          aria-label={t('board.search')}
          onChange={event => { setFilter(event.target.value) }}
        />
        <button
          type="button"
          className={classes.primaryButton}
          onClick={() => { setShowNew(true) }}
        >
          {t('board.new')}
        </button>
      </header>

      {client.error !== undefined && (
        <div className={classes.error}>
          {t('board.hostError', { error: client.error })}
          {' '}
          <button type="button" className={classes.ghostButton} onClick={() => { void client.refresh() }}>
            {t('board.retryHost')}
          </button>
        </div>
      )}

      {knownTags.length > 0 && (
        <div className={classes.tagFilterRow}>
          <span className={classes.tagFilterLabel}>{t('board.tagFilter')}</span>
          {knownTags.map(name => (
            <button
              key={name}
              type="button"
              className={tagFilter.includes(name) ? classes.filterChipActive : classes.filterChip}
              onClick={() => { toggleTag(name) }}
            >
              {name}
            </button>
          ))}
          {tagFilter.length > 0 && (
            <button type="button" className={classes.ghostButton} onClick={() => { setTagFilter([]) }}>
              {t('board.tagFilterClear')}
            </button>
          )}
        </div>
      )}

      <div className={classes.dragHint}>{t('board.dragHint')}</div>

      <div className={classes.columns}>
        {IDEA_COLUMNS.map(status => {
          const columnIdeas = byStatus(status)
          return (
            <section
              key={status}
              className={classes.column}
              onDragEnter={() => { if (drag !== undefined) setDragTarget({ status }) }}
              onDragOver={event => {
                if (drag !== undefined) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }
              }}
              onDrop={event => {
                event.preventDefault()
                void performDrop(event)
              }}
            >
              <div className={classes.columnHeader}>
                <span className={classes.columnTitle}>{t(STATUS_LABEL[status])}</span>
                <span className={classes.columnCount}>{columnIdeas.length}</span>
              </div>
              <div className={classes.columnBody}>
                {columnIdeas.length === 0
                  ? <div className={classes.empty}>{t('board.empty')}</div>
                  : columnIdeas.map(idea => {
                    const confirm = confirmId === idea.id
                    return (
                      <div
                        key={idea.id}
                        className={classes.cardWrapper}
                        onDragEnter={() => { setDragTarget({ status, beforeId: idea.id }) }}
                        onDragOver={event => {
                          if (drag !== undefined) {
                            event.preventDefault()
                            event.dataTransfer.dropEffect = 'move'
                          }
                        }}
                      >
                        <div className={classes.card} data-dsh-idea-id={idea.id}>
                          <div className={classes.cardHeader}>
                            <div className={classes.cardTitle}>{idea.title}</div>
                            <div
                              className={classes.cardGrip}
                              draggable={!client.pending}
                              title={t('card.drag')}
                              aria-label={t('card.drag')}
                              onDragStart={(event) => {
                                // Carry the idea id on the drag payload
                                // (task-board family contract) so the drop
                                // target can read it. Only the grip starts a
                                // drag: the card body stays selectable.
                                event.dataTransfer.setData('text/plain', idea.id)
                                event.dataTransfer.effectAllowed = 'move'
                                // Default drag image would be the small grip;
                                // ghost the whole card instead, anchored so
                                // the pointer keeps its position on the card.
                                const card = event.currentTarget.closest<HTMLElement>('.dsh-ideas-card')
                                if (card !== null) {
                                  const rect = card.getBoundingClientRect()
                                  event.dataTransfer.setDragImage(
                                    card,
                                    event.clientX - rect.left,
                                    event.clientY - rect.top,
                                  )
                                }
                                startDrag(idea)
                              }}
                              onDragEnd={() => { setDrag(undefined); setDragTarget(undefined) }}
                            >
                              <span aria-hidden="true">⠿</span>
                            </div>
                          </div>
                          {idea.body.trim() !== '' && <div className={classes.cardBody}>{idea.body}</div>}
                          {(idea.tags !== undefined && idea.tags.length > 0) || idea.value !== undefined || idea.effort !== undefined
                            ? (
                              <div className={classes.cardMeta}>
                                {idea.tags?.map(tag => (
                                  <span key={tag.name} className={classes.tag} onClick={() => { toggleTag(tag.name) }}>{tag.name}</span>
                                ))}
                                {idea.value !== undefined && <span className={classes.score}>{t('card.value', { value: idea.value })}</span>}
                                {idea.effort !== undefined && <span className={classes.score}>{t('card.effort', { effort: idea.effort })}</span>}
                              </div>
                            )
                            : null}
                          <div className={classes.cardActions}>
                            <button type="button" className={classes.actionButton} onClick={() => { openEdit(idea) }}>
                              {t('card.edit')}
                            </button>
                            {idea.status === 'open' && (
                              <button
                                type="button"
                                className={classes.actionButton}
                                onClick={() => { void client.moveIdea(idea.id, 'archived') }}
                              >
                                {t('card.archive')}
                              </button>
                            )}
                            {idea.status === 'open' && (
                              <button
                                type="button"
                                className={classes.actionButton}
                                onClick={() => { void client.declineIdea(idea.id) }}
                              >
                                {t('card.decline')}
                              </button>
                            )}
                            {idea.status !== 'open' && (
                              <button
                                type="button"
                                className={classes.actionButton}
                                onClick={() => { void client.restoreIdea(idea.id) }}
                              >
                                {t('card.restore')}
                              </button>
                            )}
                            {!confirm
                              ? (
                                <button
                                  type="button"
                                  className={classes.dangerButton}
                                  onClick={() => { setConfirmId(idea.id) }}
                                >
                                  {t('card.delete')}
                                </button>
                              )
                              : (
                                <>
                                  <span className={classes.confirmLabel}>{t('card.confirmDelete')}</span>
                                  <button
                                    type="button"
                                    className={classes.dangerButton}
                                    onClick={() => {
                                      setConfirmId(undefined)
                                      void client.deleteIdea(idea.id)
                                    }}
                                  >
                                    {t('card.deleteYes')}
                                  </button>
                                  <button
                                    type="button"
                                    className={classes.ghostButton}
                                    onClick={() => { setConfirmId(undefined) }}
                                  >
                                    {t('card.deleteNo')}
                                  </button>
                                </>
                              )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </section>
          )
        })}
      </div>

      {showNew && <IdeaModal client={client} onClose={() => { setShowNew(false) }} />}
      {editing !== undefined && (
        <IdeaModal client={client} initial={editing} onClose={() => { setEditing(undefined) }} />
      )}
    </div>
  )
}