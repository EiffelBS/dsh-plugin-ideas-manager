/** Read-only synchronization preview, explicit mapping and conflict decisions. */

import { useEffect, useReducer, useRef, useState, type ChangeEvent, type Dispatch } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import type { WorkspaceViewLite } from './workspaces.ts'
import type {
  IdeasSyncConflictResolution,
  IdeasSyncErrorCode,
  IdeasSyncExportResponse,
  IdeasSyncImportResponse,
  IdeasSyncPackage,
  IdeasSyncPlanResponse,
  IdeasSyncRefusal,
  IdeasSyncWorkspaceView,
} from '../sync.ts'
import type { IdeasSyncConflict, IdeasSyncMergeField, IdeasSyncMergePlan } from '../sync-merge.ts'
import { classes } from './style.ts'
import { t, type IdeasKey } from './locales.ts'
import {
  canApplySync,
  bulkSyncResolutions,
  initialSyncUiState,
  syncConflictAllowsClear,
  syncPlanCounts,
  syncUiReducer,
  type SyncUiAction,
  type SyncUiError,
} from './sync-state.ts'

/** One side of a conflict, bounded without pretending the full value was shown. */
const CONFLICT_PREVIEW_LIMIT = 2_000
/** Keep a large plan readable; the summary always counts the complete plan. */
const VISIBLE_OPERATIONS = 100

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = () => { reject(reader.error ?? new Error('file-read-failed')) }
    reader.readAsText(file)
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refusalError(refusal: IdeasSyncRefusal): SyncUiError {
  const keys: Record<IdeasSyncErrorCode, IdeasKey> = {
    'invalid-sync-workspace': 'sync.error.invalidWorkspace',
    'invalid-sync-export': 'sync.error.invalidExport',
    'invalid-sync-package': 'sync.error.invalidPackage',
    'sync-workspace-unconfirmed': 'sync.error.workspaceUnconfirmed',
    'sync-key-conflict': 'sync.error.keyConflict',
    'sync-workspace-conflict': 'sync.error.workspaceConflict',
    'sync-preview-stale': 'sync.error.previewStale',
    'sync-idea-conflict': 'sync.error.ideaConflict',
    'sync-reference-missing': 'sync.error.referenceMissing',
    'sync-relation-invalid': 'sync.error.relationInvalid',
    'sync-resolution-invalid': 'sync.error.resolutionInvalid',
    'sync-snapshot-failed': 'sync.error.snapshotFailed',
    'sync-apply-failed': 'sync.error.applyFailed',
  }
  return { code: refusal.error, message: t(keys[refusal.error] ?? 'sync.error.unknown', { message: refusal.message }) }
}

function thrownError(error: unknown): SyncUiError {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    const code = error.code as IdeasSyncErrorCode
    if (code === 'sync-preview-stale') return { code, message: t('sync.error.previewStale') }
  }
  return { message: t('sync.error.unknown', { message: errorText(error) }) }
}

function packageName(pkg: IdeasSyncPackage): string {
  const stamp = new Date(pkg.createdAt).toISOString().replace(/[:.]/g, '-')
  return `ideas-sync-${stamp}-${pkg.snapshotId.slice(0, 8)}.json`
}

/** Download the exact package bytes the Host serializer returned. */
function downloadPackage(pkg: IdeasSyncPackage): string {
  const name = packageName(pkg)
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return name
  const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
  return name
}

function workspaceLabel(workspaceId: string, options: readonly WorkspaceViewLite[]): string {
  return options.find(option => option.workspaceId === workspaceId)?.title ?? workspaceId
}

function workspaceIdentityLabel(workspaceId: string, options: readonly WorkspaceViewLite[]): string {
  const label = workspaceLabel(workspaceId, options)
  return label === workspaceId ? workspaceId : `${label} — ${workspaceId}`
}

function SyncWorkspacePairing({ sourceWorkspaceId, destinationWorkspaceId, syncKey, options }: {
  sourceWorkspaceId: string
  destinationWorkspaceId: string | undefined
  syncKey: string
  options: readonly WorkspaceViewLite[]
}) {
  return (
    <div className={classes.syncPairing} data-dsh-ideas-sync-pairing="">
      <span className={classes.settingsRowTitle}>{t('sync.import.pairingTitle')}</span>
      <span className={classes.settingsRowDesc}>{t('sync.import.pairingRule')}</span>
      <div className={classes.syncPairingGrid}>
        <span>{t('sync.import.sourceWorkspace')}</span>
        <code>{sourceWorkspaceId}</code>
        <span>{t('sync.import.destinationWorkspace')}</span>
        <code>{destinationWorkspaceId === undefined ? t('sync.import.destinationUnpaired') : workspaceIdentityLabel(destinationWorkspaceId, options)}</code>
        <span>{t('sync.import.portableKey')}</span>
        <code>{syncKey}</code>
      </div>
    </div>
  )
}

function fieldLabel(field: IdeasSyncMergeField | undefined): string {
  return field === undefined ? '' : t(`sync.field.${field}` as IdeasKey)
}

function kindLabel(conflict: IdeasSyncConflict): string {
  const kinds: Record<IdeasSyncConflict['kind'], IdeasKey> = {
    'same-field': 'sync.kind.sameField',
    'two-way-difference': 'sync.kind.twoWayDifference',
    'delete-edit': 'sync.kind.deleteEdit',
    'tag-definition': 'sync.kind.tagDefinition',
    'tag-limit': 'sync.kind.tagLimit',
    'relation-limit': 'sync.kind.relationLimit',
    order: 'sync.kind.order',
    'reference-missing': 'sync.kind.referenceMissing',
    'self-reference': 'sync.kind.selfReference',
    'dependency-cycle': 'sync.kind.dependencyCycle',
    'follow-up-cycle': 'sync.kind.followUpCycle',
  }
  return t(kinds[conflict.kind])
}

function boundedValue(value: unknown): { text: string; truncated: boolean } {
  if (value === undefined) return { text: t('sync.conflict.empty'), truncated: false }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > CONFLICT_PREVIEW_LIMIT
    ? { text: `${text.slice(0, CONFLICT_PREVIEW_LIMIT)}\n…`, truncated: true }
    : { text, truncated: false }
}

function ideaTitle(plan: IdeasSyncMergePlan, ideaId: string): string {
  if (ideaId === '') return t('sync.field.rank')
  const operation = plan.operations.find(item => item.ideaId === ideaId)
  return operation?.incoming?.title ?? operation?.local?.title ?? operation?.merged?.title ?? ideaId
}

function resolutionOf(resolutions: readonly IdeasSyncConflictResolution[], conflictId: string): IdeasSyncConflictResolution['choice'] | '' {
  return resolutions.find(item => item.conflictId === conflictId)?.choice ?? ''
}

function extractedSyncKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const workspace = (value as Record<string, unknown>).workspace
  if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) return undefined
  const key = (workspace as Record<string, unknown>).syncKey
  return typeof key === 'string' && key !== '' ? key : undefined
}

export interface SyncPanelProps {
  client: IdeasClient
}

export function SyncPanel({ client }: SyncPanelProps) {
  const [state, dispatch] = useReducer(syncUiReducer, undefined, initialSyncUiState)
  const [, bump] = useState(0)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const importResult = useRef<HTMLDivElement | null>(null)
  const revealImportResult = useRef(false)
  const requestSeq = useRef(0)

  const focusImportResult = (): void => {
    const node = importResult.current
    if (node === null) return
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    node.focus({ preventScroll: true })
  }

  const revealResult = (): void => {
    setTimeout(focusImportResult, 200)
  }

  useEffect(() => client.subscribe(() => { bump(count => count + 1) }), [client])

  useEffect(() => {
    let alive = true
    dispatch({ type: 'pending', pending: true })
    void client.loadSyncOverview().then((overview) => {
      if (alive) dispatch({ type: 'overview', overview })
    }).catch((error) => {
      if (alive) dispatch({ type: 'error', error: thrownError(error) })
    }).finally(() => {
      if (alive) dispatch({ type: 'pending', pending: false })
    })
    return () => { alive = false }
  }, [client])

  const workspaceOptions: readonly WorkspaceViewLite[] = client.workspaceOptions
  const overviewRows: readonly IdeasSyncWorkspaceView[] = state.overview?.workspaces ?? []
  const exportOptions = [...new Map([
    ...overviewRows.map(row => [row.workspaceId, row.workspaceId] as const),
    ...workspaceOptions.map(option => [option.workspaceId, option.workspaceId] as const),
  ]).values()]

  useEffect(() => {
    if (state.exportWorkspaceId === '' && exportOptions[0] !== undefined) {
      dispatch({ type: 'export-workspace', workspaceId: exportOptions[0] })
    }
  }, [exportOptions, state.exportWorkspaceId])

  const currentRevision = client.snapshot?.revision
  useEffect(() => {
    if (state.preview === undefined || currentRevision === undefined) return
    if (state.preview.revision !== currentRevision && !state.stale) dispatch({ type: 'stale', stale: true })
  }, [currentRevision, state.preview, state.stale])

  useEffect(() => {
    if (!revealImportResult.current) return
    if (state.phase !== 'mapping' && state.preview === undefined && !state.stale) return
    revealImportResult.current = false
    revealResult()
  }, [state.phase, state.preview, state.stale])

  if (!client.syncAvailable) {
    return (
      <section className={classes.settingsSection} data-dsh-ideas-sync="">
        <span className={classes.settingsNote}>{t('sync.unavailable')}</span>
      </section>
    )
  }

  const selectedExport = overviewRows.find(row => row.workspaceId === state.exportWorkspaceId)
  const exportReady = selectedExport?.confirmed === true
  const counts = syncPlanCounts(state.preview)
  const preview = state.preview?.plan
  const applyReady = canApplySync(state, currentRevision)
  const mappingOptions = [...new Map([
    ...overviewRows.map(row => [row.workspaceId, row.workspaceId] as const),
    ...workspaceOptions.map(option => [option.workspaceId, option.workspaceId] as const),
  ]).values()]
  const selectedMapping = overviewRows.find(row => row.workspaceId === state.mappingWorkspaceId)
  const incomingKey = state.incoming?.workspace.syncKey
  const needsReplacement = selectedMapping?.syncKey !== undefined
    && incomingKey !== undefined
    && selectedMapping.syncKey !== incomingKey

  const refreshOverview = async (): Promise<void> => {
    const overview = await client.loadSyncOverview()
    dispatch({ type: 'overview', overview })
  }

  const handlePlanRefusal = (refusal: IdeasSyncRefusal, incoming: IdeasSyncPackage, name: string, resolutions: IdeasSyncConflictResolution[]): void => {
    if (refusal.error === 'sync-workspace-unconfirmed') {
      dispatch({
        type: 'mapping-required',
        incoming,
        name,
        syncKey: incoming.workspace.syncKey,
      })
      return
    }
    if (refusal.plan !== undefined) {
      dispatch({
        type: 'preview',
        preview: { ok: true, revision: client.snapshot?.revision ?? state.preview?.revision ?? 0, plan: refusal.plan },
        resolutions,
        incoming,
        name,
      })
    }
    if (refusal.error === 'sync-preview-stale') {
      dispatch({ type: 'stale-import', incoming, name })
      dispatch({ type: 'stale', stale: true })
    }
    dispatch({ type: 'error', error: refusalError(refusal) })
  }

  const previewPackage = async (
    incoming: IdeasSyncPackage,
    name: string,
    resolutions: IdeasSyncConflictResolution[],
  ): Promise<void> => {
    const seq = ++requestSeq.current
    dispatch({ type: 'pending', pending: true })
    let working = resolutions
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const expectedRevision = client.snapshot?.revision
        const outcome = await client.planSyncPackage({
          package: incoming,
          resolutions: working,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        })
        if (seq !== requestSeq.current) return
        if (!outcome.ok) {
          handlePlanRefusal(outcome, incoming, name, working)
          return
        }
        if (outcome.plan.invalidResolutions.length > 0 && attempt < 3) {
          const invalid = new Set(outcome.plan.invalidResolutions)
          working = working.filter(item => !invalid.has(item.conflictId))
          continue
        }
        dispatch({ type: 'preview', preview: outcome, resolutions: working, incoming, name })
        return
      }
    } catch (error) {
      if (seq === requestSeq.current) dispatch({ type: 'error', error: thrownError(error) })
    } finally {
      if (seq === requestSeq.current) dispatch({ type: 'pending', pending: false })
    }
  }

  const onCreateIdentity = async (): Promise<void> => {
    if (!state.exportConsent || state.exportWorkspaceId === '') return
    const seq = ++requestSeq.current
    dispatch({ type: 'pending', pending: true })
    try {
      const outcome = await client.confirmSyncWorkspace({ workspaceId: state.exportWorkspaceId, confirm: true })
      if (seq !== requestSeq.current) return
      if (!outcome.ok) {
        dispatch({ type: 'error', error: refusalError(outcome) })
        return
      }
      await refreshOverview()
    } catch (error) {
      if (seq === requestSeq.current) dispatch({ type: 'error', error: thrownError(error) })
    } finally {
      if (seq === requestSeq.current) dispatch({ type: 'pending', pending: false })
    }
  }

  const onExport = async (): Promise<void> => {
    if (state.exportWorkspaceId === '') return
    const seq = ++requestSeq.current
    dispatch({ type: 'pending', pending: true })
    try {
      const outcome = await client.exportSyncWorkspace({ workspaceId: state.exportWorkspaceId })
      if (seq !== requestSeq.current) return
      if (!outcome.ok) {
        dispatch({ type: 'error', error: refusalError(outcome) })
        return
      }
      downloadPackage(outcome.package)
      dispatch({ type: 'exported', exported: outcome })
      await client.refresh()
    } catch (error) {
      if (seq === requestSeq.current) dispatch({ type: 'error', error: thrownError(error) })
    } finally {
      if (seq === requestSeq.current) dispatch({ type: 'pending', pending: false })
    }
  }

  const onImportFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFileText(file)) as unknown
    } catch {
      dispatch({ type: 'error', error: { code: 'invalid-sync-package', message: t('sync.error.fileInvalid') } })
      return
    }
    const syncKey = extractedSyncKey(parsed)
    if (syncKey === undefined) {
      dispatch({ type: 'error', error: { code: 'invalid-sync-package', message: t('sync.import.fileInvalid') } })
      return
    }
    revealImportResult.current = true
    await previewPackage(parsed as IdeasSyncPackage, file.name, [])
  }

  const onConfirmMapping = async (): Promise<void> => {
    if (state.incoming === undefined || state.incomingName === undefined || !state.mappingConsent || state.mappingWorkspaceId === '') return
    if (needsReplacement && !state.replaceConsent) return
    const seq = ++requestSeq.current
    dispatch({ type: 'pending', pending: true })
    try {
      const outcome = await client.confirmSyncWorkspace({
        workspaceId: state.mappingWorkspaceId,
        syncKey: state.incoming.workspace.syncKey,
        confirm: true,
        ...(needsReplacement ? { replaceExisting: true } : {}),
      })
      if (seq !== requestSeq.current) return
      if (!outcome.ok) {
        dispatch({ type: 'error', error: refusalError(outcome) })
        return
      }
      await refreshOverview()
      await client.refresh()
      revealImportResult.current = true
      await previewPackage(state.incoming, state.incomingName, [])
    } catch (error) {
      if (seq === requestSeq.current) dispatch({ type: 'error', error: thrownError(error) })
    } finally {
      if (seq === requestSeq.current) dispatch({ type: 'pending', pending: false })
    }
  }

  const onResolve = (conflictId: string, choice: IdeasSyncConflictResolution['choice']): void => {
    if (state.incoming === undefined || state.incomingName === undefined) return
    const next = state.resolutions.filter(item => item.conflictId !== conflictId)
    next.push({ conflictId, choice })
    void previewPackage(state.incoming, state.incomingName, next)
  }

  const onBulkResolve = (choice: 'local' | 'remote'): void => {
    if (state.incoming === undefined || state.incomingName === undefined || preview === undefined) return
    const next = bulkSyncResolutions(preview.conflicts, choice, state.resolutions)
    dispatch({ type: 'bulk-cancel' })
    void previewPackage(state.incoming, state.incomingName, next)
  }

  const onRefreshPreview = (): void => {
    if (state.incoming !== undefined && state.incomingName !== undefined) {
      void previewPackage(state.incoming, state.incomingName, state.resolutions)
    }
  }

  const onApply = async (): Promise<void> => {
    if (!applyReady || state.incoming === undefined || state.preview === undefined) return
    const seq = ++requestSeq.current
    dispatch({ type: 'applying' })
    try {
      const outcome = await client.importSyncPackage({
        package: state.incoming,
        resolutions: state.resolutions,
        expectedRevision: state.preview.revision,
      })
      if (seq !== requestSeq.current) return
      if (!outcome.ok) {
        if (outcome.error === 'sync-preview-stale') dispatch({ type: 'stale', stale: true })
        if (outcome.plan !== undefined && currentRevision !== undefined) {
          dispatch({
            type: 'preview',
            preview: { ok: true, revision: currentRevision, plan: outcome.plan },
            resolutions: state.resolutions,
            incoming: state.incoming,
            name: state.incomingName ?? 'incoming.json',
          })
        }
        dispatch({ type: 'error', error: refusalError(outcome) })
        return
      }
      dispatch({ type: 'applied', result: outcome })
      await Promise.allSettled([client.refresh(), client.loadBackups()])
    } catch (error) {
      if (seq === requestSeq.current) dispatch({ type: 'error', error: thrownError(error) })
    } finally {
      if (seq === requestSeq.current) dispatch({ type: 'pending', pending: false })
    }
  }

  const onRollback = async (): Promise<void> => {
    const name = state.result?.displaced?.name
    if (name === undefined || !state.rollbackConsent) return
    dispatch({ type: 'rollback-pending', pending: true })
    const ok = await client.restoreSnapshot({ name })
    dispatch({ type: 'rollback-pending', pending: false })
    if (!ok) {
      dispatch({ type: 'error', error: { message: t('sync.error.unknown', { message: client.backupError ?? 'rollback-failed' }) } })
    }
  }

  const renderConflict = (conflict: IdeasSyncConflict) => {
    const local = boundedValue(conflict.local)
    const incoming = boundedValue(conflict.incoming)
    const base = boundedValue(conflict.base)
    const choice = resolutionOf(state.resolutions, conflict.conflictId)
    const title = ideaTitle(preview!, conflict.ideaId)
    return (
      <div className={classes.syncConflict} key={conflict.conflictId} data-sync-conflict={conflict.conflictId}>
        <div className={classes.syncConflictHeading}>
          <strong>{title}</strong>
          <span className={classes.syncConflictKind}>
            {fieldLabel(conflict.field)} · {kindLabel(conflict)}
            {conflict.tagName === undefined ? '' : ` · ${t('sync.conflict.tag', { tag: conflict.tagName })}`}
          </span>
        </div>
        <div className={classes.syncConflictValues}>
          <div className={classes.syncConflictValue}>
            <span className={classes.syncConflictLabel}>{t('sync.conflict.local')}</span>
            <pre>{local.text}</pre>
            {local.truncated && <span className={classes.syncTruncated}>{t('sync.conflict.truncated')}</span>}
          </div>
          <div className={classes.syncConflictValue}>
            <span className={classes.syncConflictLabel}>{t('sync.conflict.incoming')}</span>
            <pre>{incoming.text}</pre>
            {incoming.truncated && <span className={classes.syncTruncated}>{t('sync.conflict.truncated')}</span>}
          </div>
        </div>
        {conflict.base !== undefined && (
          <div className={classes.syncConflictValue}>
            <span className={classes.syncConflictLabel}>{t('sync.conflict.base')}</span>
            <pre>{base.text}</pre>
            {base.truncated && <span className={classes.syncTruncated}>{t('sync.conflict.truncated')}</span>}
          </div>
        )}
        <div className={classes.syncConflictChoices}>
          <span className={classes.fieldLabel}>{t('sync.conflict.choice')}</span>
          <select
            className={classes.settingsSelect}
            aria-label={`${t('sync.conflict.choice')}: ${title}`}
            value={choice}
            disabled={state.pending}
            onChange={event => { onResolve(conflict.conflictId, event.target.value as IdeasSyncConflictResolution['choice']) }}
          >
            <option value="">—</option>
            <option value="local">{t('sync.conflict.keepLocal')}</option>
            <option value="remote">{t('sync.conflict.keepRemote')}</option>
            {syncConflictAllowsClear(conflict) && <option value="clear">{t('sync.conflict.clear')}</option>}
          </select>
        </div>
        {conflict.resolutionError !== undefined && (
          <span className={classes.settingsError}>{t('sync.conflict.resolutionError', { error: conflict.resolutionError })}</span>
        )}
      </div>
    )
  }

  return (
    <section className={classes.settingsSection} data-dsh-ideas-sync="">
      <div className={classes.sync}>
        <h4 className={classes.syncTitle}>{t('sync.title')}</h4>
        <p className={classes.syncIntro}>{t('sync.intro')}</p>
        <p className={classes.syncNotRestore}>{t('sync.notRestore')}</p>
        {state.error !== undefined && (
          <span className={classes.settingsError} role="alert">{state.error.message}</span>
        )}
        {state.phase === 'applying' && <span className={classes.backupStatus}>{t('sync.applying')}</span>}

        <div className={classes.settingsCard}>
          <div className={classes.settingsGroup}>{t('sync.export.group')}</div>
          <div className={classes.syncForm}>
            <div className={classes.syncFormRow}>
              <span className={classes.settingsRowTitle}>{t('sync.export.workspace')}</span>
              <select
                className={classes.settingsSelect}
                aria-label={t('sync.export.workspace')}
                value={state.exportWorkspaceId}
                disabled={state.pending || exportOptions.length === 0}
                onChange={event => { dispatch({ type: 'export-workspace', workspaceId: event.target.value }) }}
              >
                {exportOptions.length === 0 && <option value="">—</option>}
                {exportOptions.map(workspaceId => (
                  <option key={workspaceId} value={workspaceId}>{workspaceLabel(workspaceId, workspaceOptions)}</option>
                ))}
              </select>
            </div>
            {selectedExport?.syncKey !== undefined && (
              <span className={classes.syncKey}>{t('sync.export.keyLabel', { key: selectedExport.syncKey })}</span>
            )}
            {!exportReady && (
              <>
                <span className={classes.settingsRowDesc}>{t('sync.export.unconfirmed')}</span>
                <label className={classes.syncConsent}>
                  <input
                    type="checkbox"
                    checked={state.exportConsent}
                    disabled={state.pending || state.exportWorkspaceId === ''}
                    onChange={event => { dispatch({ type: 'export-consent', consent: event.target.checked }) }}
                  />
                  <span>{t('sync.export.createConsent')}</span>
                </label>
                <div className={classes.syncActions}>
                  <button
                    type="button"
                    className={classes.ghostButton}
                    disabled={state.pending || !state.exportConsent || state.exportWorkspaceId === ''}
                    onClick={() => { void onCreateIdentity() }}
                  >
                    {t('sync.export.createIdentity')}
                  </button>
                </div>
              </>
            )}
            <div className={classes.syncActions}>
              <button
                type="button"
                className={classes.primaryButton}
                disabled={state.pending || !exportReady}
                onClick={() => { void onExport() }}
              >
                {state.pending ? t('sync.pending') : t('sync.export.action')}
              </button>
            </div>
            {state.exported !== undefined && (
              <SyncDownload exported={state.exported} />
            )}
          </div>
        </div>

        <div className={classes.settingsCard}>
          <div className={classes.settingsGroup}>{t('sync.import.group')}</div>
          <div className={classes.syncForm}>
            <span className={classes.settingsRowDesc}>{t('sync.import.readOnly')} {t('sync.import.compareHint')}</span>
            <div className={classes.syncActions}>
              <input
                ref={fileInput}
                className={classes.backupFile}
                type="file"
                accept="application/json,.json"
                disabled={state.pending}
                aria-label={t('sync.import.action')}
                onChange={event => { void onImportFile(event) }}
              />
              <button
                type="button"
                className={classes.ghostButton}
                disabled={state.pending}
                onClick={() => { fileInput.current?.click() }}
              >
                {state.pending ? t('sync.pending') : t('sync.import.action')}
              </button>
            </div>
            {(state.phase === 'mapping' || state.preview !== undefined || state.stale) && (
              <div className={classes.syncImportNotice} role="status" aria-live="polite" data-dsh-ideas-sync-import-result="">
                <span>
                  {state.phase === 'mapping'
                    ? t('sync.import.resultMapping', { name: state.incomingName ?? '' })
                    : state.stale
                      ? t('sync.preview.staleReady', { name: state.incomingName ?? '' })
                      : t('sync.preview.available', {
                        name: state.incomingName ?? '',
                        changes: counts.create + counts.update + counts.delete,
                        conflicts: counts.conflict,
                      })}
                </span>
                <button type="button" className={classes.ghostButton} onClick={revealResult}>
                  {t('sync.preview.show')}
                </button>
              </div>
            )}
          </div>
        </div>

        {state.phase === 'preview' && state.preview === undefined && state.incoming !== undefined && state.stale && (
          <div ref={importResult} tabIndex={-1} className={classes.settingsCard} data-dsh-ideas-sync-stale="">
            <div className={classes.settingsGroup}>{t('sync.preview.title')}</div>
            <div className={classes.syncForm}>
              <span className={classes.backupStatusWarn}>{t('sync.preview.staleFile', { name: state.incomingName ?? '' })}</span>
              <div className={classes.syncActions}>
                <button type="button" className={classes.primaryButton} disabled={state.pending} onClick={onRefreshPreview}>
                  {t('sync.preview.refresh')}
                </button>
                <button type="button" className={classes.ghostButton} disabled={state.pending} onClick={() => { dispatch({ type: 'reset-import' }) }}>
                  {t('sync.preview.cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {state.phase === 'mapping' && state.incoming !== undefined && (
          <div ref={importResult} tabIndex={-1} className={classes.settingsCard} data-dsh-ideas-sync-mapping="">
            <div className={classes.settingsGroup}>{t('sync.import.mappingTitle')}</div>
            <SyncWorkspacePairing
              sourceWorkspaceId={state.incoming.workspace.sourceWorkspaceId}
              destinationWorkspaceId={state.mappingWorkspaceId === '' ? undefined : state.mappingWorkspaceId}
              syncKey={state.incoming.workspace.syncKey}
              options={workspaceOptions}
            />
            <div className={classes.syncForm}>
              <span className={classes.settingsRowDesc}>
                {t('sync.import.mappingDesc', { key: state.incomingSyncKey ?? state.incoming.workspace.syncKey })}
              </span>
              <div className={classes.syncFormRow}>
                <span className={classes.settingsRowTitle}>{t('sync.import.mappingWorkspace')}</span>
                <select
                  className={classes.settingsSelect}
                  aria-label={t('sync.import.mappingWorkspace')}
                  value={state.mappingWorkspaceId}
                  disabled={state.pending}
                  onChange={event => { dispatch({ type: 'mapping-workspace', workspaceId: event.target.value }) }}
                >
                  <option value="">—</option>
                  {mappingOptions.map(workspaceId => {
                    const mapped = overviewRows.find(row => row.workspaceId === workspaceId)
                    const differentKey = mapped?.syncKey !== undefined && mapped.syncKey !== state.incoming!.workspace.syncKey
                    return (
                      <option key={workspaceId} value={workspaceId}>
                        {workspaceLabel(workspaceId, workspaceOptions)}{differentKey ? ` — ${t('sync.import.mappingCurrent')}` : ''}
                      </option>
                    )
                  })}
                </select>
              </div>
              <label className={classes.syncConsent}>
                <input
                  type="checkbox"
                  checked={state.mappingConsent}
                  disabled={state.pending || state.mappingWorkspaceId === ''}
                  onChange={event => { dispatch({ type: 'mapping-consent', consent: event.target.checked }) }}
                />
                <span>{t('sync.import.mappingConsent')}</span>
              </label>
              {needsReplacement && (
                <div className={classes.syncBulkConfirm} data-dsh-ideas-sync-replace="">
                  <span className={classes.settingsRowTitle}>{t('sync.import.replaceTitle')}</span>
                  <span>
                    {t('sync.import.replaceWarning', {
                      oldKey: selectedMapping?.syncKey ?? '',
                      newKey: state.incoming.workspace.syncKey,
                    })}
                  </span>
                  <label className={classes.syncConsent}>
                    <input
                      type="checkbox"
                      checked={state.replaceConsent}
                      disabled={state.pending}
                      onChange={event => { dispatch({ type: 'replace-consent', consent: event.target.checked }) }}
                    />
                    <span>{t('sync.import.replaceConsent')}</span>
                  </label>
                </div>
              )}
              <div className={classes.syncActions}>
                <button
                  type="button"
                  className={classes.primaryButton}
                  disabled={state.pending || !state.mappingConsent || state.mappingWorkspaceId === '' || (needsReplacement && !state.replaceConsent)}
                  onClick={() => { void onConfirmMapping() }}
                >
                  {needsReplacement ? t('sync.import.mappingReplaceConfirm') : t('sync.import.mappingConfirm')}
                </button>
                <button
                  type="button"
                  className={classes.ghostButton}
                  disabled={state.pending}
                  onClick={() => { dispatch({ type: 'reset-import' }) }}
                >
                  {t('sync.import.mappingCancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {state.phase === 'preview' && state.preview !== undefined && preview !== undefined && (
          <div ref={importResult} tabIndex={-1} className={classes.settingsCard} data-dsh-ideas-sync-preview="">
            <div className={classes.settingsGroup}>{t('sync.preview.title')}</div>
            {state.incoming !== undefined && (
              <SyncWorkspacePairing
                sourceWorkspaceId={state.incoming.workspace.sourceWorkspaceId}
                destinationWorkspaceId={preview.workspaceId}
                syncKey={preview.syncKey}
                options={workspaceOptions}
              />
            )}
            <div className={classes.syncForm}>
              <span className={classes.settingsRowDesc}>{t('sync.preview.revision', { revision: state.preview.revision })}</span>
              <span className={classes.settingsRowDesc}>
                {preview.mode === 'three-way' ? t('sync.preview.modeThree') : t('sync.preview.modeTwo')}
                {preview.mode === 'two-way' && preview.baseSnapshotId !== null ? ` ${t('sync.preview.ancestorMissing')}` : ''}
              </span>
              {state.stale && (
                <>
                  <span className={classes.backupStatusWarn}>{t('sync.preview.stale')}</span>
                  <div className={classes.syncActions}>
                    <button type="button" className={classes.ghostButton} disabled={state.pending} onClick={onRefreshPreview}>
                      {t('sync.preview.refresh')}
                    </button>
                  </div>
                </>
              )}
              <div className={classes.settingsGroup}>{t('sync.preview.counts')}</div>
              <div className={classes.syncSummary}>
                <SyncFigure label={t('sync.preview.create')} value={counts.create} />
                <SyncFigure label={t('sync.preview.update')} value={counts.update} />
                <SyncFigure label={t('sync.preview.delete')} value={counts.delete} />
                <SyncFigure label={t('sync.preview.unchanged')} value={counts.unchanged} />
                <SyncFigure label={t('sync.preview.mappings')} value={counts.mappings} />
                <SyncFigure label={t('sync.preview.duplicates')} value={counts.duplicates} />
                <SyncFigure label={t('sync.preview.conflict')} value={counts.conflict} />
              </div>
              <span className={preview.ready ? classes.backupStatus : classes.backupStatusWarn}>
                {preview.ready ? t('sync.preview.ready') : t('sync.preview.blocked')}
              </span>
              {preview.conflicts.length + preview.invalidResolutions.length > 0 && (
                <span className={classes.settingsRowDesc}>
                  {t('sync.preview.unresolved', { count: preview.conflicts.length + preview.invalidResolutions.length })}
                </span>
              )}
            </div>

            <div className={classes.settingsGroup}>{t('sync.preview.operations')}</div>
            {preview.operations.length === 0 && <span className={classes.settingsNote}>{t('sync.preview.noOperations')}</span>}
            <div className={classes.syncList}>
              {preview.operations.slice(0, VISIBLE_OPERATIONS).map(operation => (
                <div className={classes.syncOperation} key={operation.ideaId}>
                  <span className={classes.syncOperationAction}>{t(`sync.preview.${operation.action}` as IdeasKey)}</span>
                  <span className={classes.syncOperationTitle}>
                    {ideaTitle(preview, operation.ideaId)}
                    {operation.changedFields.length > 0 ? ` — ${operation.changedFields.map(fieldLabel).join(', ')}` : ''}
                  </span>
                </div>
              ))}
            </div>
            {preview.operations.length > VISIBLE_OPERATIONS && (
              <span className={classes.settingsNote}>{t('sync.preview.moreOperations', { count: preview.operations.length - VISIBLE_OPERATIONS })}</span>
            )}

            {preview.conflicts.length > 0 && (
              <>
                <div className={classes.settingsGroup}>{t('sync.conflict.title')}</div>
                <div className={classes.syncBulkActions}>
                  <span className={classes.settingsRowDesc}>{t('sync.bulk.count', { count: preview.conflicts.length })}</span>
                  <button
                    type="button"
                    className={classes.ghostButton}
                    disabled={state.pending}
                    onClick={() => { dispatch({ type: 'bulk-choice', choice: 'remote' }) }}
                  >
                    {t('sync.bulk.incoming')}
                  </button>
                  <button
                    type="button"
                    className={classes.ghostButton}
                    disabled={state.pending}
                    onClick={() => { dispatch({ type: 'bulk-choice', choice: 'local' }) }}
                  >
                    {t('sync.bulk.local')}
                  </button>
                </div>
                {state.bulkChoice !== undefined && (
                  <div className={classes.syncBulkConfirm}>
                    <span>{t('sync.bulk.hint')}</span>
                    <div className={classes.syncActions}>
                      <button
                        type="button"
                        className={classes.primaryButton}
                        disabled={state.pending}
                        onClick={() => { onBulkResolve(state.bulkChoice!) }}
                      >
                        {state.bulkChoice === 'remote' ? t('sync.bulk.confirmIncoming') : t('sync.bulk.confirmLocal')}
                      </button>
                      <button
                        type="button"
                        className={classes.ghostButton}
                        disabled={state.pending}
                        onClick={() => { dispatch({ type: 'bulk-cancel' }) }}
                      >
                        {t('sync.bulk.cancel')}
                      </button>
                    </div>
                  </div>
                )}
                <div className={classes.syncConflicts}>{preview.conflicts.map(renderConflict)}</div>
              </>
            )}

            {preview.duplicateCandidates.length > 0 && (
              <>
                <div className={classes.settingsGroup}>{t('sync.duplicate.title')}</div>
                <span className={classes.settingsRowDesc}>{t('sync.duplicate.hint')}</span>
                <ul className={classes.syncDuplicates}>
                  {preview.duplicateCandidates.map(candidate => (
                    <li key={candidate.candidateId}>
                      {t('sync.duplicate.proposal', {
                        local: ideaTitle(preview, candidate.localId),
                        incoming: ideaTitle(preview, candidate.incomingId),
                        score: candidate.score,
                      })}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className={classes.syncForm}>
              <span className={classes.settingsRowDesc}>{t('sync.preview.applyHint')}</span>
              <label className={classes.syncConsent}>
                <input
                  type="checkbox"
                  checked={state.applyConsent}
                  disabled={state.pending || !preview.ready || state.stale}
                  onChange={event => { dispatch({ type: 'apply-consent', consent: event.target.checked }) }}
                />
                <span>{t('sync.preview.applyConsent')}</span>
              </label>
              <div className={classes.syncActions}>
                <button type="button" className={classes.primaryButton} disabled={!applyReady} onClick={() => { void onApply() }}>
                  {state.pending ? t('sync.pending') : t('sync.preview.apply')}
                </button>
                <button type="button" className={classes.ghostButton} disabled={state.pending} onClick={() => { dispatch({ type: 'reset-import' }) }}>
                  {t('sync.preview.cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {state.phase === 'success' && state.result !== undefined && (
          <SyncSuccess client={client} result={state.result} state={state} dispatch={dispatch} onRollback={onRollback} />
        )}
      </div>
    </section>
  )
}

function SyncFigure({ label, value }: { label: string; value: number }) {
  return (
    <div className={classes.syncFigure}>
      <span className={classes.syncFigureLabel}>{label}</span>
      <span className={classes.syncFigureValue}>{value}</span>
    </div>
  )
}

function SyncDownload({ exported }: { exported: IdeasSyncExportResponse }) {
  const name = packageName(exported.package)
  return (
    <span className={classes.backupStatus}>
      {t('sync.export.downloadReady', { name })}{' '}
      <button type="button" className={classes.ghostButton} onClick={() => { downloadPackage(exported.package) }}>
        {t('sync.export.downloaded')}
      </button>
    </span>
  )
}

function SyncSuccess({ client, result, state, dispatch, onRollback }: {
  client: IdeasClient
  result: IdeasSyncImportResponse
  state: ReturnType<typeof initialSyncUiState>
  dispatch: Dispatch<SyncUiAction>
  onRollback: () => Promise<void>
}) {
  const counts = syncPlanCounts({ ok: true, revision: result.revision, plan: result.plan })
  const snapshotName = result.displaced?.name
  const rollbackDone = client.lastRestore?.source === snapshotName ? client.lastRestore?.displaced.name : undefined
  return (
    <div className={classes.settingsCard} data-dsh-ideas-sync-success="">
      <div className={classes.settingsGroup}>{t('sync.success.title')}</div>
      <div className={classes.syncSuccess}>
        <span className={classes.syncSuccessSummary}>{t('sync.success.summary', { ...counts })}</span>
        {snapshotName === undefined
          ? <span>{t('sync.success.noSnapshot')}</span>
          : <span>{t('sync.success.snapshot', { name: snapshotName })}</span>}
        {rollbackDone !== undefined && <span className={classes.backupStatus}>{t('sync.success.rollbackDone', { name: rollbackDone })}</span>}
        {snapshotName !== undefined && rollbackDone === undefined && (
          <>
            <span>{t('sync.success.rollbackHint')}</span>
            {state.rollbackConsent && <strong>{t('sync.success.rollbackConfirm', { name: snapshotName })}</strong>}
            <label className={classes.syncConsent}>
              <input
                type="checkbox"
                checked={state.rollbackConsent}
                disabled={state.rollbackPending}
                onChange={event => { dispatch({ type: 'rollback-consent', consent: event.target.checked }) }}
              />
              <span>{t('sync.success.rollbackConfirm', { name: snapshotName })}</span>
            </label>
            <div className={classes.syncActions}>
              <button type="button" className={classes.ghostButton} disabled={!state.rollbackConsent || state.rollbackPending} onClick={() => { void onRollback() }}>
                {t('sync.success.rollbackYes')}
              </button>
              <button type="button" className={classes.ghostButton} disabled={state.rollbackPending} onClick={() => { dispatch({ type: 'reset-import' }) }}>
                {t('sync.success.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
