/**
 * Board view: the 3-column kanban (open / archived / declined) that replaces
 * the center column while active. P0 scope: render the Host state, a
 * "Nouvelle idée" capture modal, and the empty state — triage (drag, edit,
 * decline, restore, search, tags filter) lands in P1.
 */

import { useEffect, useState, type FormEvent } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import type { IdeaRecord, IdeaStatus } from '../core/ideas.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'

const COLUMNS: readonly { status: IdeaStatus; labelKey: 'board.status.open' | 'board.status.archived' | 'board.status.declined' }[] = [
  { status: 'open', labelKey: 'board.status.open' },
  { status: 'archived', labelKey: 'board.status.archived' },
  { status: 'declined', labelKey: 'board.status.declined' },
]

function IdeaCard({ idea }: { idea: IdeaRecord }) {
  return (
    <div className={classes.card} data-dsh-idea-id={idea.id}>
      <div className={classes.cardTitle}>{idea.title}</div>
      {idea.body.trim() !== '' && <div className={classes.cardBody}>{idea.body}</div>}
      {(idea.tags !== undefined && idea.tags.length > 0) || idea.value !== undefined || idea.effort !== undefined
        ? (
          <div className={classes.cardMeta}>
            {idea.tags?.map(tag => (
              <span key={tag.name} className={classes.tag}>{tag.name}</span>
            ))}
            {idea.value !== undefined && <span className={classes.score}>{t('card.value', { value: idea.value })}</span>}
            {idea.effort !== undefined && <span className={classes.score}>{t('card.effort', { effort: idea.effort })}</span>}
          </div>
        )
        : null}
    </div>
  )
}

function NewIdeaModal({ client, onClose }: { client: IdeasClient; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (title.trim() === '') {
      setError(t('new.required'))
      return
    }
    try {
      await client.createIdea({
        title: title.trim(),
        body: body.trim(),
        tags: tags.split(','),
      })
      onClose()
    } catch {
      // The client carries the Host error; the modal stays open for a retry.
    }
  }

  return (
    <div className={classes.overlay} onClick={onClose}>
      <form className={classes.modal} onClick={event => { event.stopPropagation() }} onSubmit={submit}>
        <h3 className={classes.modalTitle}>{t('board.new')}</h3>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-new-title">{t('new.title')}</label>
          <input
            id="dsh-ideas-new-title"
            className={classes.input}
            type="text"
            value={title}
            placeholder={t('new.titlePlaceholder')}
            autoFocus
            onChange={event => { setTitle(event.target.value) }}
          />
        </div>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-new-body">{t('new.body')}</label>
          <textarea
            id="dsh-ideas-new-body"
            className={classes.textarea}
            value={body}
            placeholder={t('new.bodyPlaceholder')}
            onChange={event => { setBody(event.target.value) }}
          />
        </div>
        <div className={classes.field}>
          <label className={classes.fieldLabel} htmlFor="dsh-ideas-new-tags">{t('new.tags')}</label>
          <input
            id="dsh-ideas-new-tags"
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
          <button type="submit" className={classes.primaryButton} disabled={client.pending}>{t('new.submit')}</button>
        </div>
      </form>
    </div>
  )
}

/** Board component; subscribes to the client snapshot. */
export function IdeasBoard({ client }: { client: IdeasClient }) {
  const [snapshot, setSnapshot] = useState(client.snapshot)
  const [showNew, setShowNew] = useState(false)

  useEffect(
    () => client.subscribe(() => setSnapshot(client.snapshot)),
    [client],
  )

  const ideas = snapshot?.ideas ?? []
  const revision = snapshot?.revision

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

      <div className={classes.columns}>
        {COLUMNS.map(column => {
          const columnIdeas = ideas
            .filter(idea => idea.status === column.status)
            .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
          return (
            <section className={classes.column} key={column.status}>
              <div className={classes.columnHeader}>
                <span className={classes.columnTitle}>{t(column.labelKey)}</span>
                <span className={classes.columnCount}>{columnIdeas.length}</span>
              </div>
              <div className={classes.columnBody}>
                {columnIdeas.length === 0
                  ? <div className={classes.empty}>{t('board.empty')}</div>
                  : columnIdeas.map(idea => <IdeaCard key={idea.id} idea={idea} />)}
              </div>
            </section>
          )
        })}
      </div>

      {showNew && <NewIdeaModal client={client} onClose={() => { setShowNew(false) }} />}
    </div>
  )
}
