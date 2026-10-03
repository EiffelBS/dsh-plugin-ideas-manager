/**
 * Backup surface of the settings section (idea #95): timestamped snapshots of
 * the whole board, a restore that keeps what it replaces, and the portable
 * export/import that moves a ledger between machines.
 *
 * Three rules shape the panel, and all three are about being honest rather than
 * convenient:
 *
 *  - **A restore is loud before and after.** It asks first, spelling out that
 *    the current board is displaced but kept, and after the click it NAMES the
 *    snapshot holding the board that was replaced — "it was overwritten" and
 *    "you can go back to it" are different sentences.
 *  - **A refusal is a sentence, not a spinner.** The Host answers a refusal with
 *    its own reason (a run in flight, an unreadable file, a ledger written by
 *    another version) and the panel prints it verbatim. A restore that failed
 *    quietly is indistinguishable from one that worked.
 *  - **Nothing here depends on the settings service.** The panel drives its own
 *    routes, so a deployment whose settings surface is unavailable still gets
 *    snapshots and restore; only the display options above are degraded.
 *
 * The download is a plain link to the Host's content route, not a blob: the
 * bytes are the ledger's own, so the file the browser stores is exactly the
 * document a restore adopts on the other machine.
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import type { IdeasSnapshotInfo } from '../protocol.ts'
import { classes } from './style.ts'
import { t } from './locales.ts'
import { SettingsRow } from './settings-row.tsx'

/** Props of the backup panel (the client it drives is the only dependency). */
export interface BackupPanelProps {
  client: IdeasClient
}

/** Compact human size, so the list reads without counting digits. */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Timestamp of a snapshot, in the reader's own locale. */
function dateLabel(at: number): string {
  try {
    return new Date(at).toLocaleString()
  } catch {
    return String(at)
  }
}

/** What one snapshot IS, from its stamp (or from the fact it is a foreign file). */
function reasonLabel(snapshot: IdeasSnapshotInfo): string {
  if (snapshot.foreign) return t('backup.item.foreign')
  if (snapshot.reason === 'export') return t('backup.item.export')
  if (snapshot.reason === 'pre-restore') return t('backup.item.preRestore')
  return t('backup.item.manual')
}

/**
 * Read a picked file as text.
 *
 * `FileReader` rather than `File.text()`: the promise form is the one every
 * browser implements (and the one a DOM double implements too), and a reader
 * also reports a file it cannot open as an error instead of resolving to an
 * empty string — which would look exactly like an empty ledger.
 */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = () => { reject(reader.error ?? new Error('the file could not be read')) }
    reader.readAsText(file)
  })
}

/** Compact date + size line of one snapshot. */
export function backupItemMeta(snapshot: IdeasSnapshotInfo): string {
  return t('backup.itemMeta', { date: dateLabel(snapshot.createdAt), size: sizeLabel(snapshot.bytes) })
}

export function BackupPanel({ client }: BackupPanelProps) {
  const [, bump] = useState(0)
  useEffect(() => client.subscribe(() => { bump(count => count + 1) }), [client])
  // The folder is read when the tab is opened, not on every client change: the
  // list is a browsable surface, and a settings edit must not re-read it.
  const [loading, setLoading] = useState(false)
  // The row whose restore is being confirmed (one at a time, never a stack of
  // dialogs on a list the human is reading).
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (loading) return
    setLoading(true)
    void client.loadBackups().finally(() => { setLoading(false) })
  }, [client])

  const view = client.backups
  const pending = client.backupPending
  const disabled = pending || loading
  const exported = client.exported
  const restore = client.lastRestore

  const onImportFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    // Clear the input first: importing the same file twice must be possible.
    event.target.value = ''
    if (file === undefined) return
    try {
      await client.restoreSnapshot({ document: await readFileText(file) })
    } catch (error) {
      // A file the browser itself could not open never reaches the Host, so the
      // reason is reported here — a silent no-op would read as "nothing to do".
      client.reportBackupError(error instanceof Error ? error.message : String(error))
    }
  }

  if (!client.backupAvailable) {
    return (
      <section className={classes.settingsSection} data-dsh-ideas-backup="">
        <span className={classes.settingsNote}>{t('backup.unavailable')}</span>
      </section>
    )
  }

  return (
    <section className={classes.settingsSection} data-dsh-ideas-backup="">
      <p className={classes.settingsIntro}>{t('backup.intro')}</p>
      {client.backupError !== undefined && (
        <span className={classes.settingsError}>{t('backup.failed', { error: client.backupError })}</span>
      )}
      {view?.running !== undefined && view.running > 0 && (
        <span className={classes.backupStatusWarn}>{t('backup.restoreBusy')}</span>
      )}
      {restore !== undefined && (
        <span className={classes.backupStatus}>
          {t('backup.restoreDone', {
            source: restore.source,
            count: restore.ideas,
            displaced: restore.displaced.name,
          })}
        </span>
      )}
      {/* A file written by a NEWER plugin can carry fields this build does not
          know, and the reader is a whitelist: those were not restored. Say so
          here rather than let a partial restore look complete. */}
      {restore !== undefined && restore.unknownFields.length > 0 && (
        <span className={classes.backupStatusWarn} data-dsh-ideas-backup-unknown="">
          {t('backup.restoreUnknownFields', { fields: restore.unknownFields.join(', ') })}
        </span>
      )}

      <div className={classes.settingsCard}>
        <div className={classes.settingsGroup}>{t('backup.groupSnapshots')}</div>
        <SettingsRow
          title={t('backup.snapshot')}
          desc={t('backup.snapshotDesc', { retention: view?.retention ?? 0 })}
          control={(
            <button
              type="button"
              className={classes.primaryButton}
              disabled={disabled}
              aria-label={t('backup.snapshotAction')}
              onClick={() => { void client.takeSnapshot('manual') }}
            >
              {pending ? t('backup.pending') : t('backup.snapshotAction')}
            </button>
          )}
        />
        <SettingsRow
          title={t('backup.export')}
          desc={t('backup.exportDesc')}
          control={(
            <button
              type="button"
              className={classes.primaryButton}
              disabled={disabled}
              aria-label={t('backup.exportAction')}
              onClick={() => { void client.takeSnapshot('export') }}
            >
              {pending ? t('backup.pending') : t('backup.exportAction')}
            </button>
          )}
        />
        {exported !== undefined && (
          <a
            className={classes.backupDownload}
            href={client.snapshotContentUrl(exported.name) ?? '#'}
            download={exported.name}
          >
            {t('backup.exported', { name: exported.name })}
          </a>
        )}
        <SettingsRow
          title={t('backup.import')}
          desc={t('backup.importDesc')}
          control={(
            <>
              <input
                ref={fileInput}
                className={classes.backupFile}
                type="file"
                accept="application/json,.json"
                disabled={disabled}
                aria-label={t('backup.importAction')}
                onChange={event => { void onImportFile(event) }}
              />
              <button
                type="button"
                className={classes.ghostButton}
                disabled={disabled}
                onClick={() => { fileInput.current?.click() }}
              >
                {t('backup.importAction')}
              </button>
            </>
          )}
        />
      </div>

      <div className={classes.settingsCard}>
        <div className={classes.settingsGroup}>{t('backup.listLabel')}</div>
        <span className={classes.settingsRowDesc}>
          {t('backup.retention', { retention: view?.retention ?? 0 })}
        </span>
        <div className={classes.backupList}>
          {(view?.snapshots ?? []).map(snapshot => (
            <div className={classes.backupItem} key={snapshot.name} data-dsh-snapshot={snapshot.name}>
              <span className={classes.backupItemMeta}>
                <span>{reasonLabel(snapshot)}</span>
                <span>{backupItemMeta(snapshot)}</span>
              </span>
              <span className={classes.backupItemActions}>
                <a className={classes.ghostButton} href={client.snapshotContentUrl(snapshot.name) ?? '#'} download={snapshot.name}>
                  {t('backup.download')}
                </a>
                <button
                  type="button"
                  className={classes.ghostButton}
                  disabled={disabled}
                  title={t('backup.restoreHint')}
                  aria-label={t('backup.restore')}
                  onClick={() => { setConfirming(confirming === snapshot.name ? undefined : snapshot.name) }}
                >
                  {t('backup.restore')}
                </button>
              </span>
              {confirming === snapshot.name && (
                <span className={classes.backupItemActions}>
                  <span className={classes.settingsRowDesc}>
                    <span>{t('backup.restoreConfirm')}</span>
                    {' '}
                    {t('backup.restoreConfirmDesc')}
                  </span>
                  <button
                    type="button"
                    className={classes.dangerButton}
                    aria-label={t('backup.restoreYes')}
                    onClick={async () => {
                      setConfirming(undefined)
                      await client.restoreSnapshot({ name: snapshot.name })
                    }}
                  >
                    {t('backup.restoreYes')}
                  </button>
                  <button
                    type="button"
                    className={classes.ghostButton}
                    aria-label={t('backup.restoreNo')}
                    onClick={() => { setConfirming(undefined) }}
                  >
                    {t('backup.restoreNo')}
                  </button>
                </span>
              )}
            </div>
          ))}
          {(view?.snapshots ?? []).length === 0 && !loading && (
            <span className={classes.settingsNote}>{t('backup.empty')}</span>
          )}
        </div>
      </div>
    </section>
  )
}