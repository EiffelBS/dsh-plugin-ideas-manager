/**
 * Board view: the 4-column kanban (open / under review / archived / declined)
 * that replaces the center column while active. P1 scope: full CRUD — capture
 * and edit modals, per-card archive/restore/decline/delete, manual drag
 * between the move-verb columns (+ intra-column reorder), search and a
 * conjunctive tag filter. The under-review column is the recette gate: Recette
 * OK delivers, Follow-up raises a linked child idea and archives the parent,
 * Decline rejects.
 *
 * UI polish: markdown-rendered descriptions with a raw/MD toggle, value/effort
 * as named-level comboboxes, and a single click on a card title or body
 * opening the edit modal.
 */

import { useEffect, useState, type CSSProperties, type DragEvent, type FormEvent } from 'react'
import type { IdeasClient, IdeaClientPatch } from './ideas-client.ts'
import { IDEA_COLUMNS, rankGroupKey, type IdeaRecord, type IdeaStatus } from '../core/ideas.ts'
import { t, type IdeasKey } from './locales.ts'
import { classes } from './style.ts'
import { renderMarkdown } from './markdown.ts'
import { IDEA_LEVELS, levelForValue } from './levels.ts'
import { buildWorkspaceCatalog } from './workspaces.ts'
import { matchesWorkspaceScope, NO_WORKSPACE_FILTER, orderIdeas, orderByWorkspaceGroups, rebuildOrder, archivedIdeasOf } from './ordering.ts'
import { beforeHalf, draggedIdFrom } from './drag.ts'
import type { AiCaptureInput } from './session-queue.ts'
import { PrioritiesView } from './priorities-view.tsx'
import { DeliveredView } from './delivered-view.tsx'
import { ScoreBadge } from './score-badge.tsx'
import { ACTIVE_TAB_STORAGE_KEY, readActiveTab, writeActiveTab, type BoardTab, type TabStorage } from './tabs.ts'

const STATUS_LABEL: Record<IdeaStatus, IdeasKey> = {
  open: 'board.status.open',
  underReview: 'board.status.underReview',
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

function IconCheck() {
  return <svg {...actionIcon}><polyline points="20 6 9 17 4 12" /></svg>
}

function IconFollowUp() {
  return (
    <svg {...actionIcon}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
      <line x1="14" y1="12" x2="20" y2="12" />
      <line x1="17" y1="9" x2="17" y2="15" />
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

/** Current 1-based position of an edited idea inside ITS workspace group of
 *  the open backlog ('' when the idea is not open or absent — the rank field
 *  then starts empty; the triage verb is the only path that re-ranks with a
 *  shift). Ranking is per workspace, so the peer set is the (open,
 *  workspace) group the idea belongs to, never the whole open column. */
function currentOpenRank(idea: IdeaRecord | undefined, ideas: readonly IdeaRecord[]): string {
  if (idea === undefined || idea.status !== 'open') return ''
  const key = rankGroupKey('open', idea.workspaceId)
  const open = orderIdeas(ideas.filter(item =>
    item.status === 'open' && rankGroupKey('open', item.workspaceId) === key))
  const at = open.findIndex(item => item.id === idea.id)
  return at < 0 ? '' : String(at + 1)
}

/** Shared capture/edit modal. The lifecycle actions of the card are mirrored
 *  here per status (deliver / archive / decline / recette OK / follow-up /
 *  restore), so the author can move an idea without leaving the editor. */
function IdeaModal({ client, initial, initialWorkspace, onClose, onFollowUp }: {
  client: IdeasClient
  initial?: IdeaRecord
  /** Board scope preselected for a new capture ('' when the board shows all;
   *  NO_WORKSPACE_FILTER maps to the generic "no workspace" value ''). */
  initialWorkspace?: string
  onClose: () => void
  /** Open the follow-up (recette NOK) modal for an under-review idea. */
  onFollowUp?: (idea: IdeaRecord) => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [valueLevel, setValueLevel] = useState(initial?.value === undefined ? '' : String(levelForValue(initial.value)))
  const [effortLevel, setEffortLevel] = useState(initial?.effort === undefined ? '' : String(levelForValue(initial.effort)))
  const [rationale, setRationale] = useState(initial?.rationale ?? '')
  const [tags, setTags] = useState(tagsText(initial))
  // Capture default (T3): a new idea targets the current session's workspace
  // when the board is not scoped to one — the project being discussed is the
  // natural home of a capture. An edit keeps the idea's own workspace, and a
  // scoped board still preselects its scope (explicit beats session).
  const sessionWorkspace = client.activeWorkspace?.workspaceId ?? ''
  const [workspace, setWorkspace] = useState((() =>
    initial?.workspaceId
    ?? (initialWorkspace === undefined || initialWorkspace === ''
      ? sessionWorkspace
      // A board scoped to "no workspace" keeps the capture generic too: '' is
      // the modal's "no workspace" value (the sentinel never leaks as an id).
      : initialWorkspace === NO_WORKSPACE_FILTER ? '' : initialWorkspace)
    ?? '')())
  // True while the picker shows the session-inferred default (capture only):
  // a quiet hint marks it, so the author knows the selection was made for them.
  // ('' — the sentinel-mapped "no workspace" state — never counts as a default.)
  const sessionDefaulted = initial === undefined && workspace !== '' && workspace === sessionWorkspace && workspace !== initialWorkspace
  const [rank, setRank] = useState(() => currentOpenRank(initial, client.snapshot?.ideas ?? []))
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
  // Phase 3: a NEW capture targeting a real workspace KNOWN TO THE DSH APP is
  // handed to the AI analyst (a fresh DSH session) instead of being created
  // manually; the workspace-less capture keeps the plain Create. A ledger-only
  // workspace id (present on ideas but absent from the DSH registry) cannot
  // host a session, so it keeps the manual Create too. No session service ->
  // no AI mode.
  const aiMode = initial === undefined && workspace !== '' && client.sessionLauncher !== undefined
    && catalog.some(entry => entry.workspaceId === workspace && entry.knownToApp)

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
    // The suggested rank is a 1-based position inside the open backlog of the
    // idea's OWN workspace group (relative ranks per workspace; blank means
    // "no rank opinion" = append). Only a positive integer is accepted (the
    // triage re-rank treats it as a position).
    const parsedRank = rank.trim() === '' ? undefined : Number(rank)
    if (parsedRank !== undefined && (!Number.isInteger(parsedRank) || parsedRank < 1)) {
      setError(t('new.rankInvalid'))
      return
    }
    try {
      if (aiMode && client.sessionLauncher !== undefined) {
        // Phase 3: NON-BLOCKING AI capture — the modal closes immediately,
        // like the manual Create; nothing stays pending. The fresh session
        // analyses the idea, creates or merges it in the target workspace
        // through the loopback write channel, applies a per-workspace rank
        // and reports the ranking decision to the human in the session.
        const captured: AiCaptureInput = {
          workspaceId: workspace,
          workspaceTitle: catalog.find(entry => entry.workspaceId === workspace)?.title ?? workspace,
          title: title.trim(),
          body: body.trim(),
          tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
          ...(value === undefined ? {} : { value }),
          ...(effort === undefined ? {} : { effort }),
          rationale,
          ...(parsedRank === undefined ? {} : { rank: parsedRank }),
        }
        onClose()
        void client.sessionLauncher.launch(captured).catch((launchError: unknown) => {
          // The session could not be queued (service torn down, create or
          // prompt rejected): the board stays usable, the failure is logged.
          console.error('[dsh-plugin-ideas-manager] AI capture failed:', launchError)
        })
        return
      }
      if (initial === undefined) {
        await client.createIdea({
          title: title.trim(),
          body: body.trim(),
          tags: tags.split(','),
          ...(value === undefined ? {} : { value }),
          ...(effort === undefined ? {} : { effort }),
          rationale,
          workspaceId: workspace,
          ...(parsedRank === undefined ? {} : { rank: parsedRank }),
        })
      } else if (initial.status === 'open') {
        // Open backlog edit: the text/tag/workspace fields go through the
        // plain update; the priority opinion and the suggested rank go
        // through the transactional triage — the only verb that re-ranks the
        // open backlog with a shift (a rank change here must not orphan the
        // old rank, and the workflow wants the backlog re-ranked on change).
        await client.updateIdea(initial.id, {
          title: title.trim(),
          body: body.trim(),
          tags: tags.split(','),
          workspaceId: workspace,
        })
        await client.triageIdea(initial.id, {
          ...(value === undefined ? {} : { value }),
          ...(effort === undefined ? {} : { effort }),
          rationale,
          ...(parsedRank === undefined ? {} : { rank: parsedRank }),
        })
      } else {
        // Non-open edit (under review / archived / declined): no open-backlog
        // re-rank (the rank field is hidden), the opinion fields go through
        // the plain update.
        const patch: IdeaClientPatch = {
          title: title.trim(),
          body: body.trim(),
          ...(value === undefined ? {} : { value }),
          ...(effort === undefined ? {} : { effort }),
          rationale,
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

  /** One lifecycle action from the editor: run it, then close — the card
   *  leaves its column, so the edit form no longer applies. Follow-up opens
   *  its own modal instead (the parent stays put until the child is created). */
  const lifecycle = (action: () => Promise<void>, followUp = false): void => {
    if (followUp) {
      if (initial === undefined || onFollowUp === undefined) return
      onFollowUp(initial)
      onClose()
      return
    }
    void action().then(onClose, () => {
      // The client carries the Host error; the modal stays open for a retry.
    })
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
          {sessionDefaulted && <div className={classes.fieldHint}>{t('new.sessionWorkspaceHint')}</div>}
        </div>
        <div className={`${classes.fieldRow} ${classes.bodyLevelRow}`}>
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
                  className={`${classes.textarea} ${classes.bodyTextarea}`}
                  value={body}
                  placeholder={t('new.bodyPlaceholder')}
                  onChange={event => { setBody(event.target.value) }}
                />
              )}
            {aiMode && <div className={classes.fieldHint}>{t('new.aiCaptureHint')}</div>}
          </div>
          <div className={classes.bodyLevelSide}>
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
        </div>
        {(initial === undefined || initial.status === 'open') && (
          <div className={classes.field}>
            <label className={classes.fieldLabel} htmlFor="dsh-ideas-rank">{t('new.rank')}</label>
            <input
              id="dsh-ideas-rank"
              className={classes.input}
              type="number"
              min={1}
              step={1}
              value={rank}
              disabled={client.pending}
              onChange={event => { setRank(event.target.value) }}
            />
            <div className={classes.fieldHint}>{t('new.rankHint')}</div>
          </div>
        )}
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
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-rationale">{t('new.rationale')}</label>
          <textarea
            id="dsh-ideas-rationale"
            className={classes.textarea}
            rows={2}
            value={rationale}
            placeholder={t('new.rationalePlaceholder')}
            onChange={event => { setRationale(event.target.value) }}
          />
        </div>
        {initial !== undefined && (
          // Lifecycle actions, mirroring the card's own action row by
          // status — the author can move the idea without closing the editor.
          <div className={classes.editActions}>
            {initial.status === 'open' && (
              <>
                <button
                  type="button"
                  className={classes.actionButton}
                  disabled={client.pending}
                  title={t('card.deliverHint')}
                  onClick={() => { lifecycle(() => client.deliverIdea(initial.id)) }}
                >
                  <IconCheck />
                  {t('card.deliver')}
                </button>
                <button
                  type="button"
                  className={classes.actionButton}
                  disabled={client.pending}
                  onClick={() => { lifecycle(() => client.moveIdea(initial.id, 'archived')) }}
                >
                  <IconArchive />
                  {t('card.archive')}
                </button>
                <button
                  type="button"
                  className={classes.actionButton}
                  disabled={client.pending}
                  onClick={() => { lifecycle(() => client.declineIdea(initial.id)) }}
                >
                  <IconDecline />
                  {t('card.decline')}
                </button>
              </>
            )}
            {initial.status === 'underReview' && (
              <>
                <button
                  type="button"
                  className={classes.actionButton}
                  disabled={client.pending}
                  title={t('card.reviewOkHint')}
                  onClick={() => { lifecycle(() => client.deliverIdea(initial.id)) }}
                >
                  <IconCheck />
                  {t('card.reviewOk')}
                </button>
                <button
                  type="button"
                  className={classes.actionButton}
                  disabled={client.pending}
                  title={t('card.followUpHint')}
                  onClick={() => { lifecycle(() => Promise.resolve(), true) }}
                >
                  <IconFollowUp />
                  {t('card.followUp')}
                </button>
                <button
                  type="button"
                  className={classes.actionButton}
                  disabled={client.pending}
                  onClick={() => { lifecycle(() => client.declineIdea(initial.id)) }}
                >
                  <IconDecline />
                  {t('card.decline')}
                </button>
              </>
            )}
            {(initial.status === 'archived' || initial.status === 'declined') && (
              <button
                type="button"
                className={classes.actionButton}
                disabled={client.pending}
                onClick={() => { lifecycle(() => client.restoreIdea(initial.id)) }}
              >
                <IconRestore />
                {t('card.restore')}
              </button>
            )}
          </div>
        )}
        {error !== undefined && <div className={classes.error}>{error}</div>}
        <div className={classes.modalActions}>
          <button type="button" className={classes.ghostButton} onClick={onClose}>{t('new.cancel')}</button>
          <button type="submit" className={classes.primaryButton} disabled={client.pending}>
            {aiMode ? t('new.submitAi') : (initial === undefined ? t('new.submit') : t('edit.save'))}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Recette-NOK modal: raise a child follow-up idea that carries the parent
 * summary + the user's justification, and archive the parent — the atomic
 * `followUp` verb. The child title is prefilled from the parent (number +
 * title) so the lineage reads at a glance.
 */
function FollowUpModal({ client, parent, onClose }: {
  client: IdeasClient
  parent: IdeaRecord
  onClose: () => void
}) {
  const [title, setTitle] = useState(() =>
    t('followUp.childTitlePlaceholder', { number: parent.ideaNumber ?? '?', title: parent.title }))
  const [justification, setJustification] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  // Escape closes the modal (capture phase, like the idea modal).
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
      setError(t('followUp.required'))
      return
    }
    // The child body = the user's justification + the parent summary. The
    // Host composes nothing: the client sends the final text verbatim.
    const summary = parent.body.trim()
    const parts = [
      ...(justification.trim() === '' ? [] : [justification.trim()]),
      ...(summary === '' ? [] : [`**${t('followUp.summaryLabel')}**\n\n${summary}`]),
    ]
    try {
      await client.followUpIdea(parent.id, { title: title.trim(), body: parts.join('\n\n---\n\n') })
      onClose()
    } catch {
      // The client carries the Host error; the modal stays open for a retry.
    }
  }

  return (
    <div className={classes.overlay} onClick={onClose}>
      <form className={classes.modal} onClick={event => { event.stopPropagation() }} onSubmit={submit}>
        <h3 className={classes.modalTitle}>{t('followUp.title')}</h3>
        <div className={classes.field}>
          <span className={classes.detailMeta}>{t('followUp.parent', { title: parent.title })}</span>
        </div>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-followup-title">{t('followUp.childTitle')}</label>
          <input
            id="dsh-ideas-followup-title"
            className={classes.input}
            type="text"
            value={title}
            autoFocus
            onChange={event => { setTitle(event.target.value) }}
          />
        </div>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-followup-justification">{t('followUp.justification')}</label>
          <textarea
            id="dsh-ideas-followup-justification"
            className={classes.textarea}
            rows={4}
            value={justification}
            placeholder={t('followUp.justification')}
            onChange={event => { setJustification(event.target.value) }}
          />
        </div>
        {parent.body.trim() !== '' && (
          <div className={classes.field}>
            <label className={classes.fieldLabel} htmlFor="dsh-ideas-followup-summary">{t('followUp.summaryLabel')}</label>
            <div id="dsh-ideas-followup-summary" className={classes.preview} data-dsh-ideas-preview="">
              {parent.body}
            </div>
          </div>
        )}
        {error !== undefined && <div className={classes.error}>{error}</div>}
        <div className={classes.modalActions}>
          <button type="button" className={classes.ghostButton} onClick={onClose}>{t('followUp.cancel')}</button>
          <button type="submit" className={classes.primaryButton} disabled={client.pending}>
            {t('followUp.submit')}
          </button>
        </div>
      </form>
    </div>
  )
}

type DragState = { id: string; source: IdeaStatus } | undefined
/** Drop target of the kanban drag: the column plus the insertion point
 *  (beforeId undefined = append at the column end), and the hovered card +
 *  half that drives the accent insertion line while dragging. */
type DragTarget = { status: IdeaStatus; beforeId?: string; hoverId?: string; half?: 'before' | 'after' } | undefined

/** Board component; subscribes to the client snapshot. */
export function IdeasBoard({ client }: { client: IdeasClient }) {
  const [snapshot, setSnapshot] = useState(client.snapshot)
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  // '': all workspaces; a concrete id scopes the columns + search to it.
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<IdeaRecord | undefined>(undefined)
  // The under-review parent a recette-NOK follow-up is being raised for.
  const [followUp, setFollowUp] = useState<IdeaRecord | undefined>(undefined)
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
  // id -> idea, to resolve a child's followUpOfId into the parent number.
  const ideaById = new Map(ideas.map(idea => [idea.id, idea]))
  const knownTags = collectKnownTags(ideas)
  const catalog = buildWorkspaceCatalog(ideas, client.workspaceOptions)
  const workspaceTitle = (workspaceId: string): string =>
    catalog.find(entry => entry.workspaceId === workspaceId)?.title ?? workspaceId
  // The scope alone does not count as "filtered": an empty workspace shows the
  // plain empty message, while an active search/tag filter explains itself.
  const filtering = filter.trim() !== '' || tagFilter.length > 0
  const visible = ideas.filter(idea =>
    matchesWorkspaceScope(idea, workspaceFilter)
    && matchesFilter(idea, filter)
    && matchesTags(idea, tagFilter))
  // The Priorities ranking ignores the kanban search/tag filters: it ranks the
  // OPEN backlog of the current workspace scope — archived/declined ideas are
  // simply not part of the ranking (see priorities-view.tsx).
  const scopedOpen = ideas.filter(idea =>
    idea.status === 'open'
    && matchesWorkspaceScope(idea, workspaceFilter))
  // The Delivered log mirrors the Priorities scope: archived ideas of the
  // current workspace ('' = all), no kanban filters; the green delivery
  // stamp renders only for rows carrying deliveredAt.
  const archivedIdeas = archivedIdeasOf(ideas, workspaceFilter)
  const byStatus = (status: IdeaStatus): IdeaRecord[] => {
    const rows = visible.filter(idea => idea.status === status)
    // "All workspaces": lay the column out per workspace group (named by
    // title, the generic group last), each group rank-sorted — the board side
    // of the "rank by workspace" presentation. A single-workspace scope has
    // one group, so the plain rank sort is identical.
    return workspaceFilter === ''
      ? orderByWorkspaceGroups(rows, workspaceTitle)
      : orderIdeas(rows)
  }

  const toggleTag = (name: string): void => {
    setTagFilter(current => current.includes(name)
      ? current.filter(entry => entry !== name)
      : [...current, name])
  }

  const performDrop = async (event: DragEvent<HTMLElement>, status: IdeaStatus, beforeId: string | undefined): Promise<void> => {
    // The dropped task id is carried on the dataTransfer (like the
    // task-board family); the drag state is a fallback for browsers that
    // do not share the payload with the drop target.
    const draggedId = draggedIdFrom(event, drag?.id)
    if (draggedId === undefined || drag === undefined) return
    const source = drag.source
    try {
      if (source !== status) {
        if (status === 'declined') {
          // Declining is its own action (sets archivedAt, mirrors decline on
          // the task board); the move verb covers open/underReview/archived.
          await client.declineIdea(draggedId)
        } else {
          await client.moveIdea(draggedId, status as Extract<IdeaStatus, 'open' | 'underReview' | 'archived'>)
        }
      }
      const all = client.snapshot?.ideas ?? []
      const ordered = rebuildOrder(all, draggedId, status, beforeId)
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
        <select
          className={classes.workspaceSelect}
          value={workspaceFilter}
          aria-label={t('board.workspace')}
          title={t('board.workspaceHint')}
          onChange={event => { setWorkspaceFilter(event.target.value) }}
        >
          <option value="">{t('board.allWorkspaces')}</option>
          <option value={NO_WORKSPACE_FILTER}>{t('board.noWorkspace')}</option>
          {catalog.map(entry => (
            <option key={entry.workspaceId} value={entry.workspaceId}>
              {entry.title}{entry.knownToApp ? '' : ` (${entry.workspaceId})`}
            </option>
          ))}
        </select>
        {activeTab === 'overview' && (
          <input
            className={classes.search}
            type="search"
            placeholder={t('board.search')}
            value={filter}
            aria-label={t('board.search')}
            onChange={event => { setFilter(event.target.value) }}
          />
        )}
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
        <button
          type="button"
          className={classes.primaryButton}
          onClick={() => { setShowNew(true) }}
        >
          {t('board.new')}
        </button>
      </header>
      <nav className={classes.tabs} role="tablist" aria-label={t('tab.label')}>
        <button
          type="button"
          role="tab"
          className={activeTab === 'overview' ? classes.tabActive : classes.tab}
          data-active={activeTab === 'overview' ? '' : undefined}
          aria-selected={activeTab === 'overview'}
          onClick={() => { switchTab('overview') }}
        >
          {t('tab.overview')}
          <span className={classes.tabCount}>{visible.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          className={activeTab === 'priorities' ? classes.tabActive : classes.tab}
          data-active={activeTab === 'priorities' ? '' : undefined}
          aria-selected={activeTab === 'priorities'}
          onClick={() => { switchTab('priorities') }}
        >
          {t('tab.priorities')}
          <span className={classes.tabCount}>{scopedOpen.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          className={activeTab === 'delivered' ? classes.tabActive : classes.tab}
          data-active={activeTab === 'delivered' ? '' : undefined}
          aria-selected={activeTab === 'delivered'}
          onClick={() => { switchTab('delivered') }}
        >
          {t('tab.delivered')}
          <span className={classes.tabCount}>{archivedIdeas.length}</span>
        </button>
      </nav>

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
                  // Over the column surface (outside any card) the insertion
                  // line sits under the last card and the drop appends at the
                  // column end, mirroring the Priorities list surface.
                  if ((event.target as HTMLElement).closest('[data-dsh-idea-id]') !== null) return
                  const last = columnIdeas[columnIdeas.length - 1]
                  if (last === undefined) return
                  setDragTarget(current => current !== undefined
                    && current.status === status
                    && current.beforeId === undefined
                    && current.hoverId === last.id
                    && current.half === 'after'
                    ? current
                    : { status, beforeId: undefined, hoverId: last.id, half: 'after' })
                }
              }}
              onDrop={event => {
                event.preventDefault()
                void performDrop(event, status, undefined)
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
                    : columnIdeas.map((idea, index) => {
                      const confirm = confirmId === idea.id
                      const workspaceId = idea.workspaceId
                      // Half-split insertion line, like the Priorities rows:
                      // hovering the upper half drops before the card, the
                      // lower half after it (before the next card).
                      const dropBefore = dragTarget?.status === status
                        && dragTarget?.hoverId === idea.id
                        && dragTarget?.half === 'before'
                      const dropAfter = dragTarget?.status === status
                        && dragTarget?.hoverId === idea.id
                        && dragTarget?.half === 'after'
                      const dropNextId = columnIdeas[index + 1]?.id
                      return (
                        <div
                          key={idea.id}
                          className={classes.cardWrapper}
                          data-dsh-idea-id={idea.id}
                          data-drop-before={dropBefore ? '' : undefined}
                          data-drop-after={dropAfter ? '' : undefined}
                          onDragEnter={event => {
                            if (drag === undefined || idea.id === drag.id) return
                            const before = beforeHalf(event, event.currentTarget)
                            setDragTarget({ status, beforeId: before ? idea.id : dropNextId, hoverId: idea.id, half: before ? 'before' : 'after' })
                          }}
                          onDragOver={event => {
                            if (drag === undefined || idea.id === drag.id) return
                            event.preventDefault()
                            event.dataTransfer.dropEffect = 'move'
                            const before = beforeHalf(event, event.currentTarget)
                            const beforeId = before ? idea.id : dropNextId
                            const half: 'before' | 'after' = before ? 'before' : 'after'
                            setDragTarget(current => current !== undefined
                              && current.status === status
                              && current.beforeId === beforeId
                              && current.hoverId === idea.id
                              && current.half === half
                              ? current
                              : { status, beforeId, hoverId: idea.id, half })
                          }}
                          onDrop={event => {
                            event.preventDefault()
                            event.stopPropagation()
                            const before = beforeHalf(event, event.currentTarget)
                            void performDrop(event, status, before ? idea.id : dropNextId)
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
                                {idea.ideaNumber !== undefined && (
                                  <span className={classes.cardNumber}>#{idea.ideaNumber}</span>
                                )}
                                {idea.title}
                              </div>
                              {idea.followUpOfId !== undefined && (
                                <span
                                  className={classes.followUpBadge}
                                  title={t('card.followUpOfHint')}
                                >
                                  {t('card.followUpOf', { number: ideaById.get(idea.followUpOfId)?.ideaNumber ?? '—' })}
                                </span>
                              )}
                              {idea.status === 'underReview' && (
                                <span className={classes.reviewBadge} title={t('card.underReviewHint')}>
                                  {t('board.status.underReview')}
                                </span>
                              )}
                              {idea.deliveredAt !== undefined && (
                                <span className={classes.deliveredBadge} title={t('card.deliveredHint')}>
                                  {t('card.delivered', { date: shortDate(idea.deliveredAt) })}
                                </span>
                              )}
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
                            {(workspaceId !== undefined || (idea.tags !== undefined && idea.tags.length > 0)) && (
                              <div className={classes.cardMeta}>
                                {workspaceId !== undefined && (
                                  <button
                                    type="button"
                                    className={classes.workspaceChip}
                                    title={t('card.workspaceHint', { workspace: workspaceTitle(workspaceId) })}
                                    onClick={() => { setWorkspaceFilter(workspaceId) }}
                                  >
                                    {workspaceTitle(workspaceId)}
                                  </button>
                                )}
                                {idea.tags !== undefined && idea.tags.map(tag => (
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
                                {idea.value !== undefined && <ScoreBadge axis="value" value={idea.value} />}
                                {idea.effort !== undefined && <ScoreBadge axis="effort" value={idea.effort} />}
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
                                  title={t('card.deliverHint')}
                                  onClick={() => { void client.deliverIdea(idea.id) }}
                                >
                                  <IconCheck />
                                  {t('card.deliver')}
                                </button>
                              )}
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
                              {idea.status === 'underReview' && (
                                <button
                                  type="button"
                                  className={classes.actionButton}
                                  disabled={client.pending}
                                  title={t('card.reviewOkHint')}
                                  onClick={() => { void client.deliverIdea(idea.id) }}
                                >
                                  <IconCheck />
                                  {t('card.reviewOk')}
                                </button>
                              )}
                              {idea.status === 'underReview' && (
                                <button
                                  type="button"
                                  className={classes.actionButton}
                                  disabled={client.pending}
                                  title={t('card.followUpHint')}
                                  onClick={() => { setConfirmId(undefined); setFollowUp(idea) }}
                                >
                                  <IconFollowUp />
                                  {t('card.followUp')}
                                </button>
                              )}
                              {idea.status === 'underReview' && (
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
                              {(idea.status === 'archived' || idea.status === 'declined') && (
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
        : activeTab === 'priorities'
          ? (
            <PrioritiesView
              client={client}
              openIdeas={scopedOpen}
              allIdeas={ideas}
              workspaceTitle={workspaceTitle}
              onEdit={openEdit}
              mdMode={mdMode}
              grouped={workspaceFilter === ''}
            />
          )
          : (
            <DeliveredView
              client={client}
              archivedIdeas={archivedIdeas}
              workspaceTitle={workspaceTitle}
              onEdit={openEdit}
              mdMode={mdMode}
            />
          )}

      {showNew && <IdeaModal client={client} initialWorkspace={workspaceFilter} onClose={() => { setShowNew(false) }} />}
      {editing !== undefined && (
        <IdeaModal
          client={client}
          initial={editing}
          onClose={() => { setEditing(undefined) }}
          onFollowUp={(idea) => { setFollowUp(idea) }}
        />
      )}
      {followUp !== undefined && (
        <FollowUpModal client={client} parent={followUp} onClose={() => { setFollowUp(undefined) }} />
      )}
    </div>
  )
}