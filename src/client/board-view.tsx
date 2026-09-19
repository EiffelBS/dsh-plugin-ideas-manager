/**
 * Board view: the 3-column kanban (open / archived / declined) that replaces
 * the center column while active. P1 scope: full CRUD — capture and edit
 * modals, per-card archive/restore/decline/delete, manual drag between Open
 * and Archived (+ intra-column reorder), search and a conjunctive tag filter.
 *
 * UI polish: markdown-rendered descriptions with a raw/MD toggle, value/effort
 * as named-level comboboxes, and a single click on a card title or body
 * opening the edit modal.
 */

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import type { IdeasClient, IdeaClientPatch } from './ideas-client.ts'
import { IDEA_COLUMNS, type IdeaRecord, type IdeaStatus } from '../core/ideas.ts'
import { t, type IdeasKey } from './locales.ts'
import { classes } from './style.ts'
import { renderMarkdown } from './markdown.ts'
import { IDEA_LEVELS, levelForValue, levelLabelKey } from './levels.ts'
import { buildWorkspaceCatalog } from './workspaces.ts'
import { orderIdeas, rebuildOrder } from './ordering.ts'
import { PrioritiesView } from './priorities-view.tsx'
import { ACTIVE_TAB_STORAGE_KEY, readActiveTab, writeActiveTab, type BoardTab, type TabStorage } from './tabs.ts'

const STATUS_LABEL: Record<IdeaStatus, IdeasKey> = {
  open: 'board.status.open',
  archived: 'board.status.archived',
  declined: 'board.status.declined',
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
 * Deterministic per-name hue (0–359) so every tag keeps a stable,
 * distinct color on the cards. FNV-1a then maps onto 15 well-spaced hues.
 */
function tagHue(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 15) * 24
}

function shortDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/* --- tiny action icons (feather-style strokes, currentColor) --- */

const actionIcon = {
  'aria-hidden': true,
  width: 12,
  height: 12,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

function IconEdit() {
  return <svg {...actionIcon}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
}

function IconArchive() {
  return (
    <svg {...actionIcon}>
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  )
}

function IconDecline() {
  return (
    <svg {...actionIcon}>
      <path d="M10 15v4a3 3 0 0 1-3 3l-4-9V2h11.28a2 2 0 0 1 2 1.7l1.38 9a2 2 0 0 1-2 2.3z" />
      <path d="M7 22v-11" />
    </svg>
  )
}

function IconRestore() {
  return (
    <svg {...actionIcon}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  )
}

function IconDelete() {
  return (
    <svg {...actionIcon}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

function tagsText(idea: IdeaRecord | undefined): string {
  return idea?.tags === undefined ? '' : idea.tags.map(tag => tag.name).join(', ')
}

/**
 * localStorage seam for the persisted active tab. Returns undefined when the
 * browser has no usable storage (probes the accessor once); the tab helpers
 * then keep the in-memory default and never throw.
 */
function activeTabStorage(): TabStorage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    void localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)
    return localStorage
  } catch {
    return undefined
  }
}

/** Named-level combobox options for value/effort plus the unset choice. */
function LevelSelect({ id, label, value, onChange, disabled }: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  return (
    <div className={classes.field}>
      <label className={classes.fieldLabel} htmlFor={id}>{label}</label>
      <select
        id={id}
        className={classes.select}
        value={value}
        disabled={disabled}
        onChange={event => { onChange(event.target.value) }}
      >
        <option value="">{t('new.levelNone')}</option>
        {IDEA_LEVELS.map(level => (
          <option key={level.value} value={String(level.value)}>{t(level.labelKey)}</option>
        ))}
      </select>
    </div>
  )
}

/** Shared capture/edit modal. */
function IdeaModal({ client, initial, initialWorkspace, onClose }: {
  client: IdeasClient
  initial?: IdeaRecord
  /** Board scope preselected for a new capture ('' when the board shows all). */
  initialWorkspace?: string
  onClose: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [valueLevel, setValueLevel] = useState(initial?.value === undefined ? '' : String(levelForValue(initial.value)))
  const [effortLevel, setEffortLevel] = useState(initial?.effort === undefined ? '' : String(levelForValue(initial.effort)))
  const [tags, setTags] = useState(tagsText(initial))
  const [workspace, setWorkspace] = useState(initial?.workspaceId ?? initialWorkspace ?? '')
  const [error, setError] = useState<string | undefined>(undefined)
  // The edit modal opens straight on the rendered markdown view (the raw
  // textarea is one click away); a new capture keeps the raw textarea first
  // so the idea is written before it is reviewed.
  const [preview, setPreview] = useState(initial !== undefined)

  // Shape the workspace picker options once per open: the DSH registry rows
  // plus every workspace id present in the ledger (a scoped board and an edit
  // of an idea whose workspace the registry does not know both keep working).
  const catalog = buildWorkspaceCatalog(client.snapshot?.ideas ?? [], client.workspaceOptions)
  const editingUnknownWorkspace =
    initial?.workspaceId !== undefined
    && initial.workspaceId !== ''
    && !catalog.some(entry => entry.workspaceId === initial.workspaceId)

  // Escape closes the modal (Echo the overlay-click behaviour), without
  // closing anything behind it: the listener runs in the capture phase and
  // stops the event from reaching the shell's own handlers.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [onClose])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (title.trim() === '') {
      setError(t('new.required'))
      return
    }
    const value = valueLevel === '' ? undefined : Number(valueLevel)
    const effort = effortLevel === '' ? undefined : Number(effortLevel)
    try {
      if (initial === undefined) {
        await client.createIdea({
          title: title.trim(),
          body: body.trim(),
          tags: tags.split(','),
          ...(value === undefined ? {} : { value }),
          ...(effort === undefined ? {} : { effort }),
          // The create path omits an empty workspace (stays generic); the
          // edit path below always sends the field, '' moving the idea back
          // to generic through the Host's blank-to-undefined mapping.
          workspaceId: workspace,
        })
      } else {
        const patch: IdeaClientPatch = {
          title: title.trim(),
          body: body.trim(),
          ...(value === undefined ? {} : { value }),
          ...(effort === undefined ? {} : { effort }),
          tags: tags.split(','),
          workspaceId: workspace,
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
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-workspace">{t('new.workspace')}</label>
          <select
            id="dsh-ideas-workspace"
            className={classes.select}
            value={workspace}
            disabled={client.pending}
            onChange={event => { setWorkspace(event.target.value) }}
          >
            <option value="">{t('new.workspaceNone')}</option>
            {editingUnknownWorkspace && initial !== undefined && (
              <option value={initial.workspaceId!}>
                {initial.workspaceId} {t('edit.workspaceUnknown')}
              </option>
            )}
            {catalog.map(entry => (
              <option key={entry.workspaceId} value={entry.workspaceId}>
                {entry.title}{entry.knownToApp ? '' : ` (${entry.workspaceId})`}
              </option>
            ))}
          </select>
        </div>
        <div className={classes.field}>
          <span className={classes.fieldRowBetween}>
            <label className={classes.fieldLabel} htmlFor="dsh-ideas-body">{t('new.body')}</label>
            <button
              type="button"
              className={classes.ghostButton}
              aria-pressed={preview}
              onClick={() => { setPreview(current => !current) }}
            >
              {preview ? t('edit.previewOff') : t('edit.preview')}
            </button>
          </span>
          {preview
            ? (
              <div
                className={classes.preview}
                data-dsh-ideas-preview=""
                dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
              />
            )
            : (
              <textarea
                id="dsh-ideas-body"
                className={classes.textarea}
                value={body}
                placeholder={t('new.bodyPlaceholder')}
                onChange={event => { setBody(event.target.value) }}
              />
            )}
        </div>
        <div className={classes.fieldRow}>
          <LevelSelect
            id="dsh-ideas-value"
            label={t('new.value')}
            value={valueLevel}
            onChange={setValueLevel}
            disabled={client.pending}
          />
          <LevelSelect
            id="dsh-ideas-effort"
            label={t('new.effort')}
            value={effortLevel}
            onChange={setEffortLevel}
            disabled={client.pending}
          />
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
  // '': all workspaces; a concrete id scopes the columns + search to it.
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<IdeaRecord | undefined>(undefined)
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined)
  const [drag, setDrag] = useState<DragState>(undefined)
  const [dragTarget, setDragTarget] = useState<DragTarget>(undefined)
  // Rendered-markdown view of descriptions (raw text is one click away).
  const [mdMode, setMdMode] = useState(true)
  // Active panel tab (Overview kanban / Priorities ranking), persisted.
  const [activeTab, setActiveTab] = useState<BoardTab>(() => readActiveTab(activeTabStorage()))
  const switchTab = (tab: BoardTab): void => {
    setActiveTab(tab)
    writeActiveTab(activeTabStorage(), tab)
  }

  useEffect(
    () => client.subscribe(() => setSnapshot(client.snapshot)),
    [client],
  )

  const ideas = snapshot?.ideas ?? []
  const revision = snapshot?.revision
  const knownTags = collectKnownTags(ideas)
  const catalog = buildWorkspaceCatalog(ideas, client.workspaceOptions)
  const workspaceTitle = (workspaceId: string): string =>
    catalog.find(entry => entry.workspaceId === workspaceId)?.title ?? workspaceId
  // The scope alone does not count as "filtered": an empty workspace shows the
  // plain empty message, while an active search/tag filter explains itself.
  const filtering = filter.trim() !== '' || tagFilter.length > 0
  const visible = ideas.filter(idea =>
    (workspaceFilter === '' || idea.workspaceId === workspaceFilter)
    && matchesFilter(idea, filter)
    && matchesTags(idea, tagFilter))
  // The Priorities ranking ignores the kanban search/tag filters: it is the
  // workspace-scoped backlog, ranked (see priorities-view.tsx).
  const scopedOpen = ideas.filter(idea => workspaceFilter === '' || idea.workspaceId === workspaceFilter)
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
      <nav className={classes.tabs} role="tablist" aria-label={t('tab.label')}>
        <button
          type="button"
          role="tab"
          className={activeTab === 'overview' ? classes.tabActive : classes.tab}
          aria-selected={activeTab === 'overview'}
          onClick={() => { switchTab('overview') }}
        >
          {t('tab.overview')}
        </button>
        <button
          type="button"
          role="tab"
          className={activeTab === 'priorities' ? classes.tabActive : classes.tab}
          aria-selected={activeTab === 'priorities'}
          onClick={() => { switchTab('priorities') }}
        >
          {t('tab.priorities')}
        </button>
      </nav>
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
        <select
          className={classes.workspaceSelect}
          value={workspaceFilter}
          aria-label={t('board.workspace')}
          title={t('board.workspaceHint')}
          onChange={event => { setWorkspaceFilter(event.target.value) }}
        >
          <option value="">{t('board.allWorkspaces')}</option>
          {catalog.map(entry => (
            <option key={entry.workspaceId} value={entry.workspaceId}>
              {entry.title}{entry.knownToApp ? '' : ` (${entry.workspaceId})`}
            </option>
          ))}
        </select>
        {activeTab === 'overview' && (
          <>
            <input
              className={classes.search}
              type="search"
              placeholder={t('board.search')}
              value={filter}
              aria-label={t('board.search')}
              onChange={event => { setFilter(event.target.value) }}
            />
            <div className={classes.mdToggle} role="group" aria-label={t('board.mdToggleLabel')}>
              <button
                type="button"
                className={mdMode ? classes.mdToggleActive : classes.mdToggleButton}
                aria-pressed={mdMode}
                onClick={() => { setMdMode(true) }}
              >
                {t('board.mdView')}
              </button>
              <button
                type="button"
                className={mdMode ? classes.mdToggleButton : classes.mdToggleActive}
                aria-pressed={!mdMode}
                onClick={() => { setMdMode(false) }}
              >
                {t('board.textView')}
              </button>
            </div>
          </>
        )}
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

      {activeTab === 'overview'
        ? (
          <>
      {knownTags.length > 0 && (
        <div className={classes.tagFilterRow}>
          <span className={classes.tagFilterLabel}>{t('board.tagFilter')}</span>
          {knownTags.map(name => (
            <button
              key={name}
              type="button"
              className={tagFilter.includes(name) ? classes.filterChipActive : classes.filterChip}
              style={{ '--dsh-ideas-tag-hue': tagHue(name) } as CSSProperties}
              aria-pressed={tagFilter.includes(name)}
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
                  {status === 'open' && (
                    <button type="button" className={classes.quickAdd} onClick={() => { setShowNew(true) }}>
                      <span aria-hidden="true">＋</span>
                      {t('board.new')}
                    </button>
                  )}
                  {columnIdeas.length === 0
                    ? <div className={classes.empty}>{t(filtering ? 'board.emptyFiltered' : 'board.empty')}</div>
                    : columnIdeas.map(idea => {
                      const confirm = confirmId === idea.id
                      const workspaceId = idea.workspaceId
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
                              <div
                                className={classes.cardTitle}
                                role="button"
                                tabIndex={0}
                                title={t('card.clickToEdit')}
                                onClick={() => { openEdit(idea) }}
                                onKeyDown={event => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    openEdit(idea)
                                  }
                                }}
                              >
                                {idea.title}
                              </div>
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
                            {workspaceId !== undefined && (
                              <div className={classes.cardMeta}>
                                <button
                                  type="button"
                                  className={classes.workspaceChip}
                                  title={t('card.workspaceHint', { workspace: workspaceTitle(workspaceId) })}
                                  onClick={() => { setWorkspaceFilter(workspaceId) }}
                                >
                                  {workspaceTitle(workspaceId)}
                                </button>
                              </div>
                            )}
                            {idea.tags !== undefined && idea.tags.length > 0 && (
                              <div className={classes.cardMeta}>
                                {idea.tags.map(tag => (
                                  <span
                                    key={tag.name}
                                    className={classes.tag}
                                    style={{ '--dsh-ideas-tag-hue': tagHue(tag.name) } as CSSProperties}
                                    onClick={() => { toggleTag(tag.name) }}
                                  >
                                    {tag.name}
                                  </span>
                                ))}
                              </div>
                            )}
                            {idea.body.trim() !== '' && (
                              mdMode
                                ? (
                                  <div
                                    className={`${classes.markdownBody} ${classes.bodyClickable}`}
                                    tabIndex={0}
                                    title={t('card.clickToEdit')}
                                    data-dsh-ideas-md=""
                                    dangerouslySetInnerHTML={{ __html: renderMarkdown(idea.body) }}
                                    onClick={event => {
                                      // A link inside the rendered body opens
                                      // the target; anything else edits.
                                      if ((event.target as HTMLElement).closest('a') !== null) return
                                      openEdit(idea)
                                    }}
                                    onKeyDown={event => {
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        openEdit(idea)
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
                                    onClick={() => { openEdit(idea) }}
                                    onKeyDown={event => {
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        openEdit(idea)
                                      }
                                    }}
                                  >
                                    {idea.body}
                                  </div>
                                )
                            )}
                            {(idea.value !== undefined || idea.effort !== undefined) && (
                              <div className={classes.cardMeta}>
                                {idea.value !== undefined && (
                                  <span className={classes.score}>{t('card.value', { level: t(levelLabelKey(idea.value)!) })}</span>
                                )}
                                {idea.effort !== undefined && (
                                  <span className={classes.score}>{t('card.effort', { level: t(levelLabelKey(idea.effort)!) })}</span>
                                )}
                              </div>
                            )}
                            <div className={classes.cardMeta}>
                              <span className={classes.updated}>{t('card.updated', { date: shortDate(idea.updatedAt) })}</span>
                            </div>
                            <div className={classes.cardActions}>
                              <button type="button" className={classes.actionButton} disabled={client.pending} onClick={() => { openEdit(idea) }}>
                                <IconEdit />
                                {t('card.edit')}
                              </button>
                              {idea.status === 'open' && (
                                <button
                                  type="button"
                                  className={classes.actionButton}
                                  disabled={client.pending}
                                  onClick={() => { void client.moveIdea(idea.id, 'archived') }}
                                >
                                  <IconArchive />
                                  {t('card.archive')}
                                </button>
                              )}
                              {idea.status === 'open' && (
                                <button
                                  type="button"
                                  className={classes.actionButton}
                                  disabled={client.pending}
                                  onClick={() => { void client.declineIdea(idea.id) }}
                                >
                                  <IconDecline />
                                  {t('card.decline')}
                                </button>
                              )}
                              {idea.status !== 'open' && (
                                <button
                                  type="button"
                                  className={classes.actionButton}
                                  disabled={client.pending}
                                  onClick={() => { void client.restoreIdea(idea.id) }}
                                >
                                  <IconRestore />
                                  {t('card.restore')}
                                </button>
                              )}
                              {!confirm
                                ? (
                                  <button
                                    type="button"
                                    className={classes.dangerButton}
                                    disabled={client.pending}
                                    onClick={() => { setConfirmId(idea.id) }}
                                  >
                                    <IconDelete />
                                    {t('card.delete')}
                                  </button>
                                )
                                : (
                                  <>
                                    <span className={classes.confirmLabel}>{t('card.confirmDelete')}</span>
                                    <button
                                      type="button"
                                      className={classes.dangerButton}
                                      disabled={client.pending}
                                      onClick={() => {
                                        setConfirmId(undefined)
                                        void client.deleteIdea(idea.id)
                                      }}
                                    >
                                      <IconDelete />
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
          </>
        )
        : (
          <PrioritiesView
            client={client}
            openIdeas={scopedOpen}
            allIdeas={ideas}
            workspaceTitle={workspaceTitle}
            onEdit={openEdit}
          />
        )}

      {showNew && <IdeaModal client={client} initialWorkspace={workspaceFilter} onClose={() => { setShowNew(false) }} />}
      {editing !== undefined && (
        <IdeaModal client={client} initial={editing} onClose={() => { setEditing(undefined) }} />
      )}
    </div>
  )
}