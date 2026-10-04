/**
 * The board's undo affordance (idea #111): one quiet row that names the action
 * an Undo would reverse, offers the button, states the shortcut, and — after the
 * click — says exactly which ideas went back and which ones were left alone.
 *
 * It is deliberately NOT a toast that disappears on a timer. An undo the reader
 * did not see the result of is an undo they will press twice, and the failure
 * mode of a destructive action needs a receipt that stays until it is dismissed.
 *
 * Kept out of `board-view.tsx` on purpose: the board file is already the largest
 * one in the plugin, and this is one self-contained row with no board state of
 * its own. It reads the client and nothing else.
 */

import { t, type IdeasKey } from './locales.ts'
import { classes } from './style.ts'
import type { IdeasClient, UndoOutcome } from './ideas-client.ts'
import type { BulkPlanItem } from './bulk.ts'
import { undoIdeaCount, type UndoEntry, type UndoKind } from './undo.ts'

/** Per-kind label key. `{count}` reads "how many ideas", `{target}` the title. */
const LABEL_KEYS: Record<UndoKind, IdeasKey> = {
  tag: 'undo.label.tag',
  workspace: 'undo.label.workspace',
  archive: 'undo.label.archive',
  edit: 'undo.label.edit',
  triage: 'undo.label.triage',
  restore: 'undo.label.restore',
}

/** What the entry's own first idea is called, for the single-idea labels. */
function targetOf(entry: UndoEntry): string {
  return nameOf(entry.items[0]?.plan)
}

/** `#N` when the ledger gave the idea a number, its title otherwise. */
function nameOf(plan: BulkPlanItem | undefined): string {
  if (plan === undefined) return ''
  return plan.ideaNumber === undefined ? plan.title : `#${plan.ideaNumber}`
}

/**
 * Label of an entry: the action, counted in IDEAS.
 *
 * `undoIdeaCount`, not `items.length`: a mirrored idea round-trips through three
 * verbs and is captured three times, so a batch of four such ideas holds twelve
 * items and a receipt reading "fourteen idea(s)" would be wrong in a way the
 * reader can verify at a glance.
 */
function labelOf(entry: UndoEntry): string {
  return t(LABEL_KEYS[entry.kind], { count: undoIdeaCount(entry), target: targetOf(entry) })
}

/** The field names a refusal names, as the reader would recognise them. */
function fieldList(fields: readonly string[]): string {
  return fields.join(', ')
}

/**
 * The undo row. Rendered whenever there is something to undo, or a receipt from
 * the last attempt — and nothing at all otherwise, so an empty stack costs no
 * vertical space on a board that never used it.
 */
export function UndoBar({ client }: { client: IdeasClient }) {
  const entry = client.undoEntry
  const outcome = client.lastUndo
  if (entry === undefined && outcome === undefined) return null

  const progress = client.undoProgress
  const running = client.pending || progress !== undefined

  return (
    <div className={classes.undoBar} data-dsh-ideas-undo-bar="">
      {entry !== undefined && (
        <>
          <span className={classes.undoLabel} data-dsh-ideas-undo-label="">
            {labelOf(entry)}
          </span>
          <button
            type="button"
            className={classes.actionButton}
            disabled={running}
            data-dsh-ideas-undo=""
            onClick={() => { void client.undoLast() }}
          >
            {t('undo.button')}
          </button>
          <span className={classes.undoHint} data-dsh-ideas-undo-hint="">{t('undo.hint')}</span>
        </>
      )}

      {progress !== undefined && (
        <span className={classes.undoHint} data-dsh-ideas-undo-progress="">
          {t('undo.progress', { done: progress.done, total: progress.total })}
        </span>
      )}

      {outcome !== undefined && (
        <span className={classes.undoResult} data-dsh-ideas-undo-result={outcomeSummary(outcome)} role="status">
          {outcomeSentence(outcome)}
          {/* The drift refusals are named one by one: "the idea changed since"
              without saying WHICH one leaves the reader thinking undo is broken. */}
          {outcome.refused.map(refusal => (
            <span
              key={refusal.id}
              className={classes.undoRefused}
              data-dsh-ideas-undo-refused=""
            >
              {t('undo.refusedFields', { title: refusal.title, fields: fieldList(refusal.fields) })}
            </span>
          ))}
          <button
            type="button"
            className={classes.undoHint}
            data-dsh-ideas-undo-dismiss=""
            onClick={() => { client.clearLastUndo() }}
          >
            {t('undo.dismiss')}
          </button>
        </span>
      )}
    </div>
  )
}

/** Short machine tag for the receipt (what actually happened, for tests/CSS). */
function outcomeSummary(outcome: UndoOutcome): string {
  if (ideaIds(outcome.applied).length === 0) return 'none'
  return outcome.refused.length === 0 ? 'all' : 'partial'
}

/**
 * The receipt sentence. Three honest answers, never one: it worked, it worked on
 * most of them, or it worked on none of them because everything had moved.
 *
 * Every count here is an idea count (see `undoIdeaCount`): a mirrored idea was
 * captured three times, so counting items would tell the reader it had three
 * undone cards.
 */
function outcomeSentence(outcome: UndoOutcome): string {
  const applied = ideaIds(outcome.applied).length
  const total = undoIdeaCount(outcome.entry)
  const refused = ideaIds(outcome.refused).length
  if (refused > 0) {
    return t(applied === 0 ? 'undo.refusedAll' : 'undo.refused', { applied, refused })
  }
  if (applied < total) return t('undo.donePartial', { applied, total })
  return t('undo.done', { label: labelOf(outcome.entry) })
}

/** The distinct idea ids of a result set or a refusal list. */
function ideaIds(rows: readonly { id: string }[]): string[] {
  return [...new Set(rows.map(row => row.id))]
}