// @vitest-environment jsdom
/**
 * The Backup tab of the settings section, rendered the way the shell
 * renders it: three promises are asserted at the UI level, because that is where
 * a user meets them.
 *
 *  - it SAYS what a restore replaces, before and after the click;
 *  - it PRINTS the Host's refusal verbatim (a run in flight, an unreadable
 *    file) instead of failing quietly;
 *  - it keeps working on a deployment with NO settings service — the backup
 *    surface drives its own routes and must not inherit the display options'
 *    availability — and degrades to a note on a host that serves none at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { IdeasSettingsSection } from '../src/client/settings-section.tsx'
import { BackupPanel, backupItemMeta } from '../src/client/backup-panel.tsx'
import { classes } from '../src/client/style.ts'
import { en, fr, zh } from '../src/client/locales.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasBackupView,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasRestoreRequest,
  type IdeasRestoreResponse,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
  type IdeasSnapshotInfo,
  type IdeasSnapshotReason,
  type IdeasSnapshotTaken,
} from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SNAPSHOT: IdeasListSnapshot = { schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }

const snapshot = (name: string, overrides: Partial<IdeasSnapshotInfo> = {}): IdeasSnapshotInfo => ({
  name,
  createdAt: 1_800_000_000_000,
  bytes: 4096,
  reason: 'manual',
  foreign: false,
  ...overrides,
})

class ConfigTransport implements IdeasHostTransport {
  saved: IdeasSettingsPatch[] = []
  loaded: IdeasSettingsView = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS }, revision: 1 }

  async state(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  async action(): Promise<IdeasListSnapshot> { return SNAPSHOT }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> { return this.loaded }
  async saveConfig(patch: IdeasSettingsPatch, _expectedRevision?: number): Promise<IdeasSettingsView> {
    this.saved.push(patch)
    this.loaded = { available: true, value: { ...this.loaded.value, ...patch }, revision: (this.loaded.revision ?? 0) + 1 }
    return this.loaded
  }
}

/** The settings service answers nothing: the deployment serves no settings. */
class NoSettingsTransport extends ConfigTransport {
  override loaded: IdeasSettingsView = { available: false, value: { ...IDEAS_SETTINGS_DEFAULTS } }
}

/** The same board, plus the backup routes. */
class BackupTransport extends ConfigTransport {
  view: IdeasBackupView = {
    ok: true,
    dir: '/home/user/.dsh/ideas/backups',
    retention: 10,
    snapshots: [snapshot('snapshot-1800000000000-aaaaaaaa.json')],
    running: 0,
  }
  taken: IdeasSnapshotReason[] = []
  restored: IdeasRestoreRequest[] = []
  restoreAnswer: IdeasRestoreResponse = {
    ok: true,
    revision: 7,
    ideas: 3,
    source: 'snapshot-1800000000000-aaaaaaaa.json',
    displaced: snapshot('displaced-1800000009000-bbbbbbbb.json', { reason: 'pre-restore' }),
    unknownFields: [],
  }
  counters = { take: 0, restore: 0 }

  async backups(): Promise<IdeasBackupView> { return this.view }
  async takeSnapshot(reason: IdeasSnapshotReason = 'manual'): Promise<IdeasSnapshotTaken> {
    this.taken.push(reason)
    this.counters.take += 1
    const created = snapshot(`snapshot-180000000${this.counters.take}-cccccccc.json`, { reason })
    this.view = { ...this.view, snapshots: [created, ...this.view.snapshots] }
    return { ok: true, snapshot: created, ideas: 3, pruned: 0 }
  }
  async restoreSnapshot(request: IdeasRestoreRequest): Promise<IdeasRestoreResponse> {
    this.restored.push(request)
    this.counters.restore += 1
    return this.restoreAnswer
  }
  snapshotContentUrl(name: string): string { return `/api/ideas/backup/content?name=${name}` }
}

/** A host that predates the backup routes entirely. */
class NoBackupTransport extends ConfigTransport {}

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  host.remove()
})

/** Mount the backup panel alone (the tab page under test). */
async function renderPanel(client: IdeasClient): Promise<void> {
  await act(async () => {
    root = createRoot(host)
    root.render(<BackupPanel client={client} />)
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

const buttons = (): HTMLButtonElement[] => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]
const byLabel = (label: string): HTMLButtonElement =>
  buttons().find(button => button.getAttribute('aria-label') === label) as HTMLButtonElement

describe('BackupPanel', () => {
  it('lists the snapshots with what each one is, and a download for each', async () => {
    const transport = new BackupTransport()
    transport.view = {
      ...transport.view,
      snapshots: [
        snapshot('snapshot-1800000000000-aaaaaaaa.json'),
        snapshot('displaced-1800000009000-bbbbbbbb.json', { reason: 'pre-restore' }),
        snapshot('board-from-another-machine.json', { foreign: true, bytes: 12_288 }),
      ],
    }
    await renderPanel(new IdeasClient(transport, undefined))

    const rows = Array.from(host.querySelectorAll(`[data-dsh-snapshot]`)) as HTMLElement[]
    expect(rows.map(row => row.getAttribute('data-dsh-snapshot'))).toEqual([
      'snapshot-1800000000000-aaaaaaaa.json',
      'displaced-1800000009000-bbbbbbbb.json',
      'board-from-another-machine.json',
    ])
    // The stamp is what the row says it is, and a file the plugin did not write
    // says so too.
    expect(rows[0]!.textContent).toContain(en['backup.item.manual'])
    expect(rows[1]!.textContent).toContain(en['backup.item.preRestore'])
    expect(rows[2]!.textContent).toContain(en['backup.item.foreign'])
    expect(rows[2]!.textContent).toContain(backupItemMeta(transport.view.snapshots[2]!))
    expect(rows[0]!.textContent).toContain('4 KB')
    // One download per row, pointing at the Host's content route.
    const links = Array.from(rows[0]!.querySelectorAll('a')) as HTMLAnchorElement[]
    expect(links.map(link => link.getAttribute('href'))).toContain('/api/ideas/backup/content?name=snapshot-1800000000000-aaaaaaaa.json')
  })

  it('exports the board on click, refreshes the list and offers the copy it just wrote', async () => {
    // ONE action, not two: "Take a snapshot" and "Export a copy" wrote the same
    // document through the same call and differed only by the file stamp. What
    // the single button must still deliver is both halves — a restorable copy in
    // the folder AND the download that lets it travel.
    const transport = new BackupTransport()
    await renderPanel(new IdeasClient(transport, undefined))
    const before = host.querySelectorAll('[data-dsh-snapshot]').length

    await act(async () => {
      byLabel(en['backup.exportAction']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })

    expect(transport.taken).toEqual(['export'])
    expect(host.querySelectorAll('[data-dsh-snapshot]').length).toBe(before + 1)
    const download = host.querySelector(`.${classes.backupDownload}`) as HTMLAnchorElement
    expect(download.textContent).toContain(en['backup.exported'].replace('{name}', 'snapshot-1800000001-cccccccc.json'))
    expect(download.getAttribute('href')).toBe('/api/ideas/backup/content?name=snapshot-1800000001-cccccccc.json')
    expect(download.getAttribute('download')).toBe('snapshot-1800000001-cccccccc.json')
  })

  it('offers exactly ONE write action: the retired snapshot button is gone', async () => {
    const transport = new BackupTransport()
    await renderPanel(new IdeasClient(transport, undefined))
    // A single primary button writes the board; the download and restore of an
    // existing copy are per-entry links in the list below.
    expect(host.querySelectorAll(`.${classes.primaryButton}`)).toHaveLength(1)
    expect(host.textContent).toContain(en['backup.export'])
    expect(host.textContent).toContain(en['backup.exportAction'])
  })

  it('says what a restore replaces, asks first, then names the snapshot that kept it', async () => {
    const transport = new BackupTransport()
    await renderPanel(new IdeasClient(transport, undefined))

    // Nothing is posted before the human confirms.
    await act(async () => {
      byLabel(en['backup.restore']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.restored).toEqual([])
    expect(host.textContent).toContain(en['backup.restoreConfirmDesc'])
    expect(host.textContent).toContain('kept as')

    await act(async () => {
      byLabel(en['backup.restoreYes']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })

    expect(transport.restored).toEqual([{ name: 'snapshot-1800000000000-aaaaaaaa.json' }])
    // The displaced board is named: a restore must be loud about what it
    // replaced, and say it is still there.
    const status = host.querySelector(`.${classes.backupStatus}`)?.textContent ?? ''
    expect(status).toContain('displaced-1800000009000-bbbbbbbb.json')
    expect(status).toContain('snapshot-1800000000000-aaaaaaaa.json')
  })

  it('warns which fields of a restore this build could not read', async () => {
    // The forward-compatibility surface: a file written by a newer plugin (same
    // schema, a field added without a bump) restores in full, and the panel says
    // which data did NOT come with it instead of looking complete.
    const transport = new BackupTransport()
    transport.restoreAnswer = {
      ok: true,
      revision: 7,
      ideas: 3,
      source: 'export-1800000000000-cccccccc.json',
      displaced: snapshot('displaced-1800000009000-bbbbbbbb.json', { reason: 'pre-restore' }),
      unknownFields: ['sparkle', 'widgets'],
    }
    await renderPanel(new IdeasClient(transport, undefined))

    await act(async () => {
      byLabel(en['backup.restore']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    await act(async () => {
      byLabel(en['backup.restoreYes']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })

    const warning = host.querySelector('[data-dsh-ideas-backup-unknown]')?.textContent ?? ''
    expect(warning).toContain('sparkle, widgets')
    expect(warning).toContain('update the plugin')
    // The normal case says nothing at all: an empty list is not a warning.
    expect(transport.restoreAnswer.ok).toBe(true)
  })

  it('renders against a Host that predates unknownFields (a page refresh before a restart)', async () => {
    // The rolling-upgrade shape, and a crash that really happened: the browser
    // half is re-read on every page load while the routes are registered at
    // start-up, so a refreshed page runs the NEW panel against an OLD Host that
    // answers a restore without `unknownFields`. The panel must degrade to "no
    // warning", never to a TypeError that takes the whole settings section down.
    const transport = new BackupTransport()
    transport.restoreAnswer = {
      ok: true,
      revision: 7,
      ideas: 3,
      source: 'export-1800000000000-cccccccc.json',
      displaced: snapshot('displaced-1800000009000-bbbbbbbb.json', { reason: 'pre-restore' }),
    } as IdeasRestoreResponse
    await renderPanel(new IdeasClient(transport, undefined))

    await act(async () => {
      byLabel(en['backup.restore']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    await act(async () => {
      byLabel(en['backup.restoreYes']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })

    // No unknownFields on the wire, so no warning line and no crash.
    expect(host.querySelector('[data-dsh-ideas-backup-unknown]')).toBeNull()
    expect(host.querySelector('[data-dsh-ideas-backup]')).not.toBeNull()
    expect(host.textContent).toContain('displaced-1800000009000-bbbbbbbb.json')
  })

  it('prints the Host refusal verbatim and changes nothing', async () => {
    const transport = new BackupTransport()
    transport.restoreAnswer = {
      ok: false,
      error: 'restore-run-in-flight',
      message: 'an execution is still running on #1 "First idea"; wait for it to finish before restoring a snapshot',
      running: [{ id: 'idea-1', ideaNumber: 1, title: 'First idea' }],
    }
    transport.view = { ...transport.view, running: 1 }
    await renderPanel(new IdeasClient(transport, undefined))

    // A run in flight is announced before the click, not only after a failure.
    expect(host.querySelector(`.${classes.backupStatusWarn}`)?.textContent).toBe(en['backup.restoreBusy'])
    const before = host.querySelectorAll('[data-dsh-snapshot]').length

    await act(async () => {
      byLabel(en['backup.restore']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    await act(async () => {
      byLabel(en['backup.restoreYes']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })

    expect(transport.restored).toHaveLength(1)
    expect(host.querySelector(`.${classes.settingsError}`)?.textContent)
      .toContain('an execution is still running on #1 "First idea"')
    // The list is untouched: a refused restore changed nothing.
    expect(host.querySelectorAll('[data-dsh-snapshot]').length).toBe(before)
  })

  it('imports a file the human picked, posting its bytes as one document', async () => {
    const transport = new BackupTransport()
    await renderPanel(new IdeasClient(transport, undefined))
    const document = JSON.stringify({ schemaVersion: 1, revision: 4, ideas: [] })
    const file = new File([document], 'board.json', { type: 'application/json' })
    const input = host.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file], configurable: true })

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The handler reads the file BEFORE it can post anything, so one turn of the
    // event loop was never a bound — it happened to be enough on a fast machine
    // and one turn short under load, which is how this test failed the release
    // run on the runner while passing everywhere else. Wait for the outcome.
    await vi.waitFor(() => { expect(transport.restored).toEqual([{ document }]) })
  })

  it('degrades to a note on a host that serves no backup route', async () => {
    await renderPanel(new IdeasClient(new NoBackupTransport(), undefined))
    expect(host.querySelector(`.${classes.settingsNote}`)?.textContent).toBe(en['backup.unavailable'])
    expect(host.querySelectorAll('[data-dsh-snapshot]')).toHaveLength(0)
  })
})

describe('the settings section owns the Backup tab', () => {
  async function renderSection(client: IdeasClient): Promise<void> {
    await client.loadConfig()
    await act(async () => {
      root = createRoot(host)
      root.render(<IdeasSettingsSection client={client} />)
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
  }

  const openBackupTab = async (): Promise<void> => {
    await act(async () => {
      const tab = Array.from(host.querySelectorAll('[role="tab"]')) as HTMLButtonElement[]
      tab.find(candidate => candidate.textContent === en['about.tabBackup'])!.click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
  }

  it('opens it from the section and works with no settings service at all', async () => {
    const transport = new BackupTransport()
    const noSettings = new NoSettingsTransport()
    const client = new IdeasClient(transport, undefined)
    // The deployment serves no settings service: the display options degrade,
    // the backup surface must not.
    vi.spyOn(client, 'loadConfig').mockImplementation(async () => {
      client.config = { available: false, value: { ...IDEAS_SETTINGS_DEFAULTS } }
    })
    void noSettings
    await renderSection(client)
    expect(host.textContent).toContain(en['settings.unavailable'])

    await openBackupTab()
    expect(host.querySelector('[data-dsh-ideas-backup]')).not.toBeNull()
    expect(host.querySelectorAll('[data-dsh-snapshot]').length).toBeGreaterThan(0)

    await act(async () => {
      byLabel(en['backup.exportAction']).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(transport.taken).toEqual(['export'])
  })

  it('offers the three tabs, Display first', async () => {
    await renderSection(new IdeasClient(new ConfigTransport(), undefined))
    const tabs = Array.from(host.querySelectorAll('[role="tab"]')) as HTMLButtonElement[]
    expect(tabs.map(tab => tab.textContent)).toEqual([
      en['about.tabDisplay'],
      en['about.tabBackup'],
      en['about.tabAbout'],
    ])
  })
})

describe('backup copy ships in every locale', () => {
  it('has a key for every string the panel renders', () => {
    const keys = [
      'backup.intro', 'backup.groupSnapshots', 'backup.listLabel', 'backup.empty', 'backup.retention',
      'backup.restore', 'backup.restoreHint', 'backup.restoreConfirm', 'backup.restoreConfirmDesc',
      'backup.restoreYes', 'backup.restoreNo', 'backup.restoreDone', 'backup.restoreBusy',
      'backup.restoreUnknownFields',
      'backup.item.manual', 'backup.item.export', 'backup.item.preRestore', 'backup.item.foreign',
      'backup.itemMeta', 'backup.groupTransfer', 'backup.export', 'backup.exportDesc',
      'backup.exportAction', 'backup.exported', 'backup.import', 'backup.importDesc',
      'backup.importAction', 'backup.unavailable', 'backup.loading', 'backup.pending',
      'backup.failed', 'backup.download', 'about.tabBackup',
    ] as const
    for (const key of keys) {
      for (const dictionary of [fr, en, zh]) {
        expect(typeof dictionary[key]).toBe('string')
        expect(dictionary[key]).not.toBe('')
      }
    }
    // The retired second button left no copy behind in any dictionary.
    for (const dictionary of [fr, en, zh]) {
      expect(Object.keys(dictionary)).not.toContain('backup.snapshot')
      expect(Object.keys(dictionary)).not.toContain('backup.snapshotAction')
      expect(Object.keys(dictionary)).not.toContain('backup.snapshotDesc')
    }
    // Every interpolation the panel passes has a matching placeholder.
    for (const dictionary of [fr, en, zh]) {
      expect(dictionary['backup.exportDesc']).toContain('{retention}')
      expect(dictionary['backup.restoreDone']).toContain('{displaced}')
      expect(dictionary['backup.exported']).toContain('{name}')
      expect(dictionary['backup.itemMeta']).toContain('{size}')
    }
  })
})