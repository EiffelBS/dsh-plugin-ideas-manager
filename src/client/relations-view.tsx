/**
 * Relations on the board (idea #106): the React half.
 *
 * The pure rules live in `./relations.ts`; this file only paints. Two surfaces,
 * one module:
 *  - {@link RelationChips} is the compact, READ-ONLY line a card prints, under
 *    its description. It renders nothing at all for an idea that carries no
 *    relation — an absence is not a box — and it caps itself so a heavily
 *    linked card cannot push the board's DOM budget around.
 *  - {@link RelationsEditor} is the editor's Relations section: the two kinds a
 *    human states (`relates to`, `blocks`) are editable, and the third line
 *    (`blocked by`) is READ-ONLY on purpose.
 *
 * Why `blocked by` is not editable here: it is the derived inverse of an edge
 * stored on the OTHER idea, so "removing" it would mean editing a different
 * card. The editor says so instead of silently writing to a row the human never
 * opened — the same honesty the launch gate and the permission refusal use.
 */

import { IDEA_RELATION_LIMIT } from '../core/ideas.ts'
import { classes } from './style.ts'
import { t } from './locales.ts'
import {
  CARD_RELATION_CHIP_LIMIT,
  relationCandidates,
  relationViews,
  withRelation,
  withoutRelation,
  type IdeaRelationViewKind,
  type RelationRow,
  type RelationView,
} from './relations.ts'

/**
 * The arrow each kind prints. `blocks` points AT the idea it waits for and
 * `blockedBy` points back at the idea doing the waiting, so the two chips for
 * one edge are mirror images and the board's direction rule is legible on the
 * card itself rather than only in a tooltip.
 */
function relationGlyph(kind: IdeaRelationViewKind): string {
  if (kind === 'blocks') return '→'
  if (kind === 'blockedBy') return '←'
  return '↔'
}

/** Tooltip naming what the chip means, so a glyph never reads as a verdict. */
function relationHint(kind: IdeaRelationViewKind, label: string): string {
  if (kind === 'blocks') return t('relations.blocksHint', { target: label })
  if (kind === 'blockedBy') return t('relations.blockedByHint', { target: label })
  return t('relations.relatesToHint', { target: label })
}

/**
 * The read-only relation line of a card: up to {@link CARD_RELATION_CHIP_LIMIT}
 * chips, then a counter. Returns null when there is nothing to say, so a card
 * without relations pays zero DOM nodes.
 *
 * The views are DERIVED ONCE per paint by the board (`relationIndexOf`) and
 * handed down: computing them per card would rebuild the row map and rescan the
 * whole board for every one of them.
 */
export function RelationChips({ views }: { views: readonly RelationView[] | undefined }) {
  if (views === undefined || views.length === 0) return null
  const shown = views.slice(0, CARD_RELATION_CHIP_LIMIT)
  const rest = views.length - shown.length
  return (
    <span className={classes.cardMeta} data-dsh-ideas-relations="">
      {shown.map(view => (
        <span
          key={`${view.kind}:${view.id}`}
          className={classes.relationChip}
          data-dsh-ideas-relation={view.kind}
          title={relationHint(view.kind, view.label)}
        >
          <span className={classes.relationGlyph} aria-hidden="true">{relationGlyph(view.kind)}</span>
          {view.short}
        </span>
      ))}
      {rest > 0 && <span className={classes.relationMore}>{t('relations.more', { count: rest })}</span>}
    </span>
  )
}

/** One editable line: its label, its chips, and the picker that adds one. */
function RelationLine({ label, list, ideas, ideaId, exclude, placeholder, disabled, onChange, removeTitle }: {
  label: string
  list: readonly string[]
  ideas: readonly RelationRow[]
  ideaId: string
  /** Ids this line must not offer (the other kind's list, plus the row itself). */
  exclude: readonly string[]
  placeholder: string
  disabled: boolean
  onChange: (next: string[]) => void
  removeTitle: (label: string) => string
}) {
  const byId = new Map(ideas.map(item => [item.id, item]))
  // An idea may be named by BOTH kinds, so a candidate already used by the
  // other line is excluded here: the picker offers only what this line can add.
  const candidates = relationCandidates(ideas, ideaId, [...list, ...exclude])
  const labelFor = (id: string): string => {
    const row = byId.get(id)
    return row === undefined ? id : row.ideaNumber === undefined ? row.title : `#${row.ideaNumber} ${row.title}`
  }
  return (
    <div className={classes.relationRow}>
      <span className={classes.fieldLabel}>{label}</span>
      <span className={classes.relationChips}>
        {list.map(id => (
          <span key={id} className={classes.relationChip} data-dsh-ideas-relation-edit={id}>
            {labelFor(id)}
            <button
              type="button"
              className={classes.relationRemove}
              disabled={disabled}
              title={removeTitle(labelFor(id))}
              onClick={() => { onChange(withoutRelation(list, id)) }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        ))}
        {list.length === 0 && <span className={classes.relationEmpty}>{t('relations.none')}</span>}
      </span>
      <select
        className={classes.select}
        value=""
        disabled={disabled || candidates.length === 0 || list.length >= IDEA_RELATION_LIMIT}
        aria-label={placeholder}
        data-dsh-ideas-relation-add=""
        onChange={event => {
          const id = event.target.value
          if (id === '') return
          onChange(withRelation(list, id))
        }}
      >
        <option value="">{candidates.length === 0 ? t('relations.nothingToAdd') : placeholder}</option>
        {candidates.map(candidate => (
          <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
        ))}
      </select>
    </div>
  )
}

/**
 * The editor's Relations section. State is owned by the caller (the idea modal)
 * and only the CHANGED lists are posted, so opening an editor and saving an
 * unrelated field never rewrites an edge.
 */
export function RelationsEditor({ ideas, ideaId, relatesTo, blocks, disabled, onRelatesTo, onBlocks }: {
  ideas: readonly RelationRow[]
  ideaId: string
  relatesTo: readonly string[]
  blocks: readonly string[]
  disabled: boolean
  onRelatesTo: (next: string[]) => void
  onBlocks: (next: string[]) => void
}) {
  // `blockedBy` is derived from every OTHER row's `blocks`, so the editor reads
  // it from the board it already has rather than asking the Host again.
  const blockers = relationViews(ideas, ideaId).filter(view => view.kind === 'blockedBy')
  return (
    <div className={classes.relations} data-dsh-ideas-relations-editor="">
      <span className={classes.fieldLabel}>{t('relations.title')}</span>
      <div className={classes.fieldHint}>{t('relations.hint')}</div>
      <RelationLine
        label={t('relations.relatesTo')}
        list={relatesTo}
        ideas={ideas}
        ideaId={ideaId}
        exclude={blocks}
        placeholder={t('relations.addRelated')}
        disabled={disabled}
        onChange={onRelatesTo}
        removeTitle={target => t('relations.removeRelated', { target })}
      />
      <RelationLine
        label={t('relations.blocks')}
        list={blocks}
        ideas={ideas}
        ideaId={ideaId}
        exclude={relatesTo}
        placeholder={t('relations.addBlocked')}
        disabled={disabled}
        onChange={onBlocks}
        removeTitle={target => t('relations.removeBlocked', { target })}
      />
      <div className={classes.relationRow}>
        <span className={classes.fieldLabel}>{t('relations.blockedBy')}</span>
        <span className={classes.relationChips} data-dsh-ideas-blocked-by="">
          {blockers.length === 0
            ? <span className={classes.relationEmpty}>{t('relations.blockedByNone')}</span>
            : blockers.map(view => (
              <span
                key={view.id}
                className={`${classes.relationChip} ${classes.relationChipLocked}`}
                data-dsh-ideas-relation-locked={view.id}
                title={relationHint('blockedBy', view.label)}
              >
                <span className={classes.relationGlyph} aria-hidden="true">{relationGlyph('blockedBy')}</span>
                {view.label}
              </span>
            ))}
        </span>
      </div>
      <div className={classes.fieldHint}>{t('relations.blockedByExplained')}</div>
    </div>
  )
}
