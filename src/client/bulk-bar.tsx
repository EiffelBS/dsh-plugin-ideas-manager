/**
 * Multi-select and bulk actions on the board (idea #94): the per-row select
 * box, the selection bar, and the bulk dialog that runs a batch and reports it
 * idea by idea.
 *
 * The three components here are deliberately thin. Every rule — what may be
 * selected, which verbs a batch posts, what a skip or a failure means — lives in
 * the pure modules `selection.ts` and `bulk.ts`, so this file only renders them
 * and posts the ordinary per-idea verbs through `IdeasClient`. There is no
 * bulk-only verb and no ledger write anywhere on this path.
 *
 * The bar always states what "all" means: how many are selected, how many the
 * current filter shows, and which workspace / tags / search produced that set.
 * That sentence is the difference between "everything" (what the user sees) and
 * "everything" (what the batch would touch).
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { classes } from './style.ts'
import { t, type IdeasKey } from './locales.ts'
import type { IdeasClient } from './ideas-client.ts'
import type { IdeaListRow } from '../protocol.ts'
import type { WorkspaceCatalogEntry } from './workspaces.ts'
import {
  markBulkUndone,
  parseBulkTagNames,
  planBulkArchive,
  planBulkRestore,
  planBulkTag,
  planBulkWorkspace,
  runBulkPlan,
  summarizeBulk,
  undoableIds,
  type BulkItemResult,
  type BulkOperation,
  type BulkReason,
  type BulkReport,
  type BulkStep,
} from './bulk.ts'
import type { UndoKind } from './undo.ts'
import { NO_WORKSPACE_FILTER } from './ordering.ts'

/**
 * Per-row select box. A real button with `role="checkbox"` (keyboard reachable
 * and announced), stopping propagation so picking a row never opens the editor
 * underneath it, and honouring shift-click for a range.
 *
 * The tick is drawn by a CSS pseudo-element, NOT by a child span: this control
 * renders on EVERY card of every view, and at 140 cards a second node per card
 * is ~140 extra DOM nodes on every re-render of the board (the search
 * keystroke and the workspace scoping both re-render all of them). One node per
 * row is the whole budget this affordance spends.
 */
export function SelectBox({ checked, onToggle, label }: {
  checked: boolean
  onToggle: (shiftKey: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={checked ? classes.selectBoxChecked : classes.selectBox}
      data-dsh-ideas-select=""
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        onToggle(event.shiftKey)
      }}
    />
  )
}

/** The selection bar: the count, the scope sentence and the three bulk actions. */
export function SelectionBar({
  selectedCount,
  scopeTotal,
  scopeLabel,
  wholeScope,
  busy,
  onSelectAll,
  onClear,
  onTag,
  onWorkspace,
  onArchive,
}: {
  selectedCount: number
  /** How many ideas the active filter shows (the denominator of "all"). */
  scopeTotal: number
  /** One sentence naming the scope: workspace, tags and search in force. */
  scopeLabel: string
  wholeScope: boolean
  busy: boolean
  onSelectAll: () => void
  onClear: () => void
  onTag: () => void
  onWorkspace: () => void
  onArchive: () => void
}) {
  return (
    <div className={classes.selectionBar} data-dsh-ideas-selection-bar="">
      <button
        type="button"
        className={wholeScope ? classes.ghostButton : classes.actionButton}
        aria-pressed={wholeScope}
        data-dsh-ideas-select-all=""
        disabled={scopeTotal === 0 || busy}
        onClick={onSelectAll}
      >
        {wholeScope ? t('bulk.bar.clearSelection') : t('bulk.bar.selectAll')}
      </button>
      <span className={classes.selectionCount} data-dsh-ideas-selection-count="">
        {t('bulk.bar.count', { selected: selectedCount, total: scopeTotal })}
      </span>
      <span className={classes.selectionScope}>{scopeLabel}</span>
      <div className={classes.selectionActions}>
        <button
          type="button"
          className={classes.actionButton}
          disabled={selectedCount === 0 || busy}
          title={t('bulk.bar.tagHint')}
          data-dsh-ideas-bulk-tag=""
          onClick={onTag}
        >
          {t('bulk.bar.tag')}
        </button>
        <button
          type="button"
          className={classes.actionButton}
          disabled={selectedCount === 0 || busy}
          title={t('bulk.bar.workspaceHint')}
          data-dsh-ideas-bulk-workspace=""
          onClick={onWorkspace}
        >
          {t('bulk.bar.workspace')}
        </button>
        <button
          type="button"
          className={classes.actionButton}
          disabled={selectedCount === 0 || busy}
          title={t('bulk.bar.archiveHint')}
          data-dsh-ideas-bulk-archive=""
          onClick={onArchive}
        >
          {t('bulk.bar.archive')}
        </button>
        <button
          type="button"
          className={classes.ghostButton}
          disabled={selectedCount === 0 || busy}
          data-dsh-ideas-selection-clear=""
          onClick={onClear}
        >
          {t('bulk.bar.clear')}
        </button>
      </div>
    </div>
  )
}

/** Localized sentence for a skip code; a Host refusal prints its own message. */
const REASON_KEYS: Record<BulkReason, IdeasKey> = {
  declined: 'bulk.reason.declined',
  'already-tagged': 'bulk.reason.alreadyTagged',
  'tag-limit': 'bulk.reason.tagLimit',
  'already-there': 'bulk.reason.alreadyThere',
  'already-archived': 'bulk.reason.alreadyArchived',
  // Idea #111: the undo drift guard, reported in the very same per-idea line as
  // every other skip — an undo that quietly dropped an idea is the one failure
  // mode a bulk report must not have.
  drifted: 'bulk.reason.drifted',
}

/** Per-state class of a report line (applied / skipped / failed). */
function stateClass(state: BulkItemResult['state']): string {
  if (state === 'applied') return classes.bulkItemApplied
  if (state === 'skipped') return classes.bulkItemSkipped
  return classes.bulkItemFailed
}

/** The report line of one idea: its ledger number, its title and why. */
function ResultLine({ result }: { result: BulkItemResult }) {
  const known = typeof result.reason === 'string' && result.reason in REASON_KEYS
    ? REASON_KEYS[result.reason as BulkReason]
    : undefined
  return (
    <div className={`${classes.bulkItem} ${stateClass(result.state)}`} data-dsh-ideas-bulk-item={result.state}>
      <span className={classes.bulkItemTitle}>
        {result.ideaNumber !== undefined ? `#${result.ideaNumber} — ` : ''}{result.title}
      </span>
      {result.reason !== undefined && (
        <span className={classes.bulkItemReason}>{known === undefined ? result.reason : t(known)}</span>
      )}
      {result.note !== undefined && (
        <span className={classes.bulkItemNote}>
          {result.note === 'rearchived' ? t('bulk.note.rearchived') : t('bulk.note.leftOpen')}
        </span>
      )}
    </div>
  )
}

/** One bucket of the report ("Failed (3)"), with its per-idea lines. */
function ResultGroup({ title, bucket, results }: {
  title: IdeasKey
  /** Stable data attribute for the bucket (tests read it; the copy is localized). */
  bucket: string
  results: readonly BulkItemResult[]
}) {
  if (results.length === 0) return null
  return (
    <div className={classes.field} data-dsh-ideas-bulk-group={bucket}>
      <span className={classes.fieldLabel}>
        {t(title, { count: results.length })}
      </span>
      <div className={classes.bulkItems}>
        {results.map(result => <ResultLine key={result.id} result={result} />)}
      </div>
    </div>
  )
}

/** Post one planned verb through the ordinary per-idea client methods. */
function stepRunner(client: IdeasClient) {
  return async (ideaId: string, step: BulkStep): Promise<void> => {
    if (step.verb === 'restore') await client.restoreIdea(ideaId)
    else if (step.verb === 'move') await client.moveIdea(ideaId, step.status)
    else if (step.verb === 'triage') await client.triageIdea(ideaId, step.patch)
    else await client.updateIdea(ideaId, step.patch)
  }
}

/**
 * The undo kind a bulk operation maps to (idea #111). The batch binds every verb
 * the run posts under ONE entry, so a tag of sixty ideas is one Ctrl+Z and not
 * sixty.
 */
const BULK_UNDO_KIND: Record<BulkOperation, UndoKind> = {
  tag: 'tag',
  workspace: 'workspace',
  archive: 'archive',
}

/**
 * The bulk dialog: confirm -> run -> report, in one modal so the batch keeps the
 * author's attention until it is settled. Every verb goes through `IdeasClient`;
 * a refusal is recorded against the idea that hit it and the batch continues,
 * because the report owes a per-idea answer rather than a single error line.
 */
export function BulkDialog({ client, operation, rows, catalog, scopeLabel, onClose }: {
  client: IdeasClient
  operation: BulkOperation
  /** The selected rows, in scope order (what the batch operates on). */
  rows: readonly IdeaListRow[]
  catalog: readonly WorkspaceCatalogEntry[]
  /** The scope sentence the selection bar already states; repeated here so a
   *  batch is never posted from a dialog that lost the "of what" half. */
  scopeLabel: string
  onClose: () => void
}) {
  const [tagInput, setTagInput] = useState('')
  const [targetWorkspace, setTargetWorkspace] = useState(NO_WORKSPACE_FILTER)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [report, setReport] = useState<BulkReport | undefined>(undefined)
  /**
   * The undo entry this run pushed (idea #111). Kept beside the report so the
   * dialog's OWN restore button can consume it: the same action must not stay
   * reversible after the report already undid it.
   */
  const [undoKey, setUndoKey] = useState<string | undefined>(undefined)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !running) {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [onClose, running])

  // A tag batch needs at least one usable name and no over-long one: the ledger
  // silently DROPS an over-long label, so a "tagged" batch that never got the
  // tag is refused here instead.
  const parsed = parseBulkTagNames(tagInput)
  const valid = operation !== 'tag' || (parsed.names.length > 0 && parsed.invalid.length === 0)

  const apply = useCallback(async (): Promise<void> => {
    const plan = operation === 'tag'
      ? planBulkTag(rows, parsed.names)
      : operation === 'workspace'
        ? planBulkWorkspace(rows, targetWorkspace === NO_WORKSPACE_FILTER ? '' : targetWorkspace)
        : planBulkArchive(rows)
    setRunning(true)
    setDone(0)
    // One undo batch for the whole run: the batch IS the action the human
    // performed, so the stack binds every verb under one entry (idea #111).
    client.beginUndoBatch(BULK_UNDO_KIND[operation])
    let key: string | undefined
    try {
      const results = await runBulkPlan(plan, stepRunner(client), (settled) => { setDone(settled) })
      setReport(summarizeBulk(operation, results))
    } finally {
      // Read the handle from the close itself: a run that changed nothing pushes
      // no entry, and then there is nothing for the report to consume.
      key = client.endUndoBatch()
      setUndoKey(key)
      setRunning(false)
    }
  }, [client, operation, parsed.names, rows, targetWorkspace])

  /** Undo the bulk archive: restore exactly the ideas the run archived. */
  const undo = useCallback(async (current: BulkReport): Promise<void> => {
    const ids = new Set(undoableIds(current))
    const plan = planBulkRestore(rows.filter(row => ids.has(row.id)))
    setRunning(true)
    setDone(0)
    try {
      const results = await runBulkPlan(plan, stepRunner(client), (settled) => { setDone(settled) })
      setReport(markBulkUndone(summarizeBulk('archive', results)))
    } finally {
      // This button already restored exactly those ideas, in its own report.
      // Leaving the generic entry behind would offer the same restoration a
      // second time — and that second press would undo the first.
      if (undoKey !== undefined) client.discardUndoBatch(undoKey)
      setRunning(false)
    }
  }, [client, rows, undoKey])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!valid || running) return
    void apply()
  }

  const title: IdeasKey = report === undefined
    ? `bulk.${operation}.title`
    : report.undone ? 'bulk.undoReport' : 'bulk.report.title'

  return (
    <div className={classes.overlay} onClick={() => { if (!running) onClose() }}>
      <div className={classes.modal} onClick={event => { event.stopPropagation() }} data-dsh-ideas-bulk-dialog={operation}>
        <h3 className={classes.modalTitle}>
          {t(title, { count: report?.total ?? rows.length })}
        </h3>

        {report === undefined && (
          <>
            <div className={classes.field}>
              <span className={classes.detailMeta} data-dsh-ideas-bulk-batch="">
                {t('bulk.batch.count', { count: rows.length })}
              </span>
              <span className={classes.fieldHint} data-dsh-ideas-bulk-scope="">{scopeLabel}</span>
            </div>
            {operation === 'tag' && (
              <div className={classes.field}>
                <label className={classes.fieldLabel} htmlFor="dsh-ideas-bulk-tags">{t('bulk.tag.label')}</label>
                <input
                  id="dsh-ideas-bulk-tags"
                  className={classes.input}
                  type="text"
                  value={tagInput}
                  placeholder={t('bulk.tag.placeholder')}
                  disabled={running}
                  onChange={event => { setTagInput(event.target.value) }}
                />
                <div className={classes.fieldHint}>{t('bulk.tag.hint')}</div>
                {parsed.invalid.length > 0 && (
                  <div className={classes.bulkWarning} data-dsh-ideas-bulk-invalid="">
                    {t('bulk.tag.invalid', { tags: parsed.invalid.join(', ') })}
                  </div>
                )}
              </div>
            )}
            {operation === 'workspace' && (
              <div className={classes.field}>
                <label className={classes.fieldLabel} htmlFor="dsh-ideas-bulk-workspace">{t('bulk.workspace.label')}</label>
                <select
                  id="dsh-ideas-bulk-workspace"
                  className={classes.select}
                  value={targetWorkspace}
                  disabled={running}
                  onChange={event => { setTargetWorkspace(event.target.value) }}
                >
                  <option value={NO_WORKSPACE_FILTER}>{t('bulk.workspace.none')}</option>
                  {catalog.map(entry => (
                    <option key={entry.workspaceId} value={entry.workspaceId}>
                      {entry.title}{entry.knownToApp ? '' : ` (${entry.workspaceId})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {operation === 'archive' && (
              <div className={classes.field}>
                <div className={classes.fieldHint}>{t('bulk.archive.hint')}</div>
              </div>
            )}
            {(operation === 'tag' || operation === 'workspace') && (
              <div className={classes.field}>
                <div className={classes.fieldHint}>{t('bulk.roundTrip')}</div>
              </div>
            )}
            <div className={classes.modalActions}>
              <button type="button" className={classes.ghostButton} disabled={running} onClick={onClose}>{t('bulk.cancel')}</button>
              <button
                type="button"
                className={classes.primaryButton}
                disabled={running || !valid}
                data-dsh-ideas-bulk-submit=""
                onClick={submit}
              >
                {t('bulk.submit')}
              </button>
            </div>
          </>
        )}

        {report !== undefined && (
          <>
            <div className={classes.field}>
              <div className={classes.bulkSummary} data-dsh-ideas-bulk-summary="">
                {t('bulk.report.summary', {
                  applied: report.applied.length,
                  skipped: report.skipped.length,
                  failed: report.failed.length,
                })}
              </div>
            </div>
            <ResultGroup title="bulk.report.applied" bucket="applied" results={report.applied} />
            <ResultGroup title="bulk.report.skipped" bucket="skipped" results={report.skipped} />
            <ResultGroup title="bulk.report.failed" bucket="failed" results={report.failed} />
            <div className={classes.field}>
              <div className={classes.fieldHint} data-dsh-ideas-bulk-undo-note="">
                {report.reversible && !report.undone
                  ? t('bulk.undoHint')
                  : report.undone
                    ? t('bulk.undoDone', { count: report.applied.length })
                    : t('bulk.undoNote')}
              </div>
              {/* Idea #111: the line that keeps the promise honest. Undo reverses
                  THIS batch and the board's own edits; it is not a transaction
                  journal, and saying so here is cheaper than a user believing
                  it is. */}
              <div className={classes.fieldHint} data-dsh-ideas-bulk-undo-scope="">
                {t('undo.scope')}
              </div>
            </div>
            <div className={classes.modalActions}>
              <button type="button" className={classes.ghostButton} disabled={running} onClick={onClose}>{t('bulk.close')}</button>
              {report.reversible && !report.undone && report.applied.length > 0 && (
                <button
                  type="button"
                  className={classes.primaryButton}
                  disabled={running}
                  data-dsh-ideas-bulk-undo=""
                  onClick={() => { void undo(report) }}
                >
                  {t('bulk.undo', { count: report.applied.length })}
                </button>
              )}
            </div>
          </>
        )}

        {/* One progress line for the whole run (confirm phase or undo phase):
            the batch is sequential on purpose, so the author watches it settle
            idea by idea instead of waiting on one opaque request. */}
        {running && (
          <div className={classes.bulkProgress} data-dsh-ideas-bulk-progress="">
            {t('bulk.running', { done: done, total: report?.total ?? rows.length })}
          </div>
        )}
      </div>
    </div>
  )
}