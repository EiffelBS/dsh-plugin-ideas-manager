// @vitest-environment jsdom
/** Synchronization UI: read-only preview, explicit mapping, decisions and safety. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasClient } from '../src/client/ideas-client.ts'
import { IdeasApiError, type IdeasHostTransport } from '../src/client/host-api.ts'
import { SyncPanel } from '../src/client/sync-panel.tsx'
import { en, fr, zh } from '../src/client/locales.ts'
import type { WorkspacesSource } from '../src/client/workspaces.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasBackupView,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasRestoreRequest,
  type IdeasRestoreResponse,
  type IdeasSnapshotInfo,
} from '../src/protocol.ts'
import {
  IDEAS_SYNC_FORMAT,
  IDEAS_SYNC_VERSION,
  type IdeasSyncConflictResolution,
  type IdeasSyncExportRequest,
  type IdeasSyncImportRequest,
  type IdeasSyncOverview,
  type IdeasSyncPackage,
  type IdeasSyncPlanRequest,
  type IdeasSyncRefusal,
  type IdeasSyncWorkspaceRequest,
} from '../src/sync.ts'
import type { IdeasSyncMergePlan } from '../src/sync-merge.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE_A = 'workspace-a'
const WORKSPACE_B = 'workspace-b'
const SYNC_KEY = 'sync_12345678'

function syncPackage(key = SYNC_KEY): IdeasSyncPackage {
  return {
    format: IDEAS_SYNC_FORMAT,
    version: IDEAS_SYNC_VERSION,
    deviceId: 'device-remote',
    snapshotId: 'snapshot-remote',
    baseSnapshotId: null,
    createdAt: 1_800_000_000_000,
    workspace: { syncKey: key, sourceWorkspaceId: 'workspace-remote' },
    ideas: [
      { id: 'shared', title: 'Incoming title', body: 'Incoming body', status: 'open', createdAt: 1, updatedAt: 2 },
      { id: 'created', title: 'Created idea', body: 'B', status: 'open', createdAt: 1, updatedAt: 1 },
    ],
  }
}

function mergePlan(pkg: IdeasSyncPackage, resolved: boolean): IdeasSyncMergePlan {
  const conflictId = 'shared\u0000title\u0000two-way-difference'
  return {
    format: 'dsh-ideas-merge-plan',
    version: 1,
    mode: 'two-way',
    incomingSnapshotId: pkg.snapshotId,
    baseSnapshotId: null,
    ancestorSnapshotId: null,
    workspaceId: WORKSPACE_A,
    syncKey: pkg.workspace.syncKey,
    operations: [
      {
        ideaId: 'shared',
        action: resolved ? 'update' : 'conflict',
        local: { id: 'shared', title: 'Local title', body: 'Local body', status: 'open', createdAt: 1, updatedAt: 1 },
        incoming: pkg.ideas[0],
        merged: { id: 'shared', title: resolved ? 'Incoming title' : 'Local title', body: 'Local body', status: 'open', createdAt: 1, updatedAt: 2 },
        changedFields: resolved ? ['title', 'updatedAt'] : [],
      },
      { ideaId: 'created', action: 'create', incoming: pkg.ideas[1], merged: pkg.ideas[1], changedFields: [] },
      { ideaId: 'deleted', action: 'delete', local: { id: 'deleted', title: 'Deleted idea', body: 'B', status: 'open', createdAt: 1, updatedAt: 1 }, changedFields: [] },
      { ideaId: 'same', action: 'unchanged', local: { id: 'same', title: 'Same idea', body: 'B', status: 'open', createdAt: 1, updatedAt: 1 }, changedFields: [] },
    ],
    ideas: pkg.ideas,
    conflicts: resolved ? [] : [{
      conflictId,
      kind: 'two-way-difference',
      ideaId: 'shared',
      field: 'title',
      local: 'Local title',
      incoming: 'Incoming title',
      message: 'title differs',
    }],
    invalidResolutions: [],
    duplicateCandidates: [{
      candidateId: 'duplicate\u0000same\u0000created',
      localId: 'same',
      incomingId: 'created',
      score: 0.9,
      signals: ['title'],
      proposedMerge: { kind: 'merge', sourceId: 'created', targetId: 'same', mode: 'keepTargetRank' },
    }],
    reorder: null,
    ready: resolved,
  }
}

function refusal(code: IdeasSyncRefusal['error'], message: string, plan?: IdeasSyncMergePlan): IdeasSyncRefusal {
  return { ok: false, error: code, message, ...(plan === undefined ? {} : { plan }) }
}

class SyncTransport implements IdeasHostTransport {
  revision = 1
  overview: IdeasSyncOverview = {
    ok: true,
    deviceId: 'device-local',
    workspaces: [{ workspaceId: WORKSPACE_A, ideaCount: 2, syncKey: SYNC_KEY, confirmed: true, confirmedAt: 1, baseSnapshotId: null }],
  }
  planCalls: IdeasSyncPlanRequest[] = []
  workspaceCalls: IdeasSyncWorkspaceRequest[] = []
  exportCalls: IdeasSyncExportRequest[] = []
  importCalls: IdeasSyncImportRequest[] = []
  restoreCalls: IdeasRestoreRequest[] = []
  importRefusal: IdeasSyncRefusal | undefined
  planRefusal: IdeasSyncRefusal | undefined
  initiallyReady = false

  async state(): Promise<IdeasListSnapshot> {
    return { schemaVersion: IDEAS_SCHEMA_VERSION, revision: this.revision, ideas: [] }
  }
  async action(): Promise<IdeasListSnapshot> { return await this.state() }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }

  async syncOverview(): Promise<IdeasSyncOverview> { return this.overview }
  async syncWorkspaces(request: IdeasSyncWorkspaceRequest) {
    this.workspaceCalls.push(request)
    this.revision += 1
    const key = request.syncKey ?? SYNC_KEY
    const existing = this.overview.workspaces.find(row => row.workspaceId === request.workspaceId)
    this.overview = {
      ...this.overview,
      workspaces: existing === undefined
        ? [...this.overview.workspaces, { workspaceId: request.workspaceId, ideaCount: 0, syncKey: key, confirmed: true, confirmedAt: 2, baseSnapshotId: null }]
        : this.overview.workspaces.map(row => row.workspaceId === request.workspaceId
          ? { ...row, syncKey: key, confirmed: true, confirmedAt: 2 }
          : row),
    }
    return {
      ok: true as const,
      mapping: { syncKey: key, workspaceId: request.workspaceId, confirmedAt: 2, baseSnapshotId: null, snapshots: [] },
    }
  }
  async syncExport(request: IdeasSyncExportRequest) {
    this.exportCalls.push(request)
    this.revision += 1
    return { ok: true as const, package: syncPackage(this.overview.workspaces.find(row => row.workspaceId === request.workspaceId)?.syncKey ?? SYNC_KEY) }
  }
  async syncPlan(request: IdeasSyncPlanRequest) {
    this.planCalls.push(request)
    if (this.planRefusal !== undefined) {
      const answer = this.planRefusal
      this.planRefusal = undefined
      throw new IdeasApiError(answer.message, answer.error, answer)
    }
    const mapped = this.overview.workspaces.some(row => row.confirmed && row.syncKey === request.package.workspace.syncKey)
    if (!mapped) {
      const answer = refusal('sync-workspace-unconfirmed', 'confirm the workspace pairing')
      throw new IdeasApiError(answer.message, answer.error, answer)
    }
    const resolved = this.initiallyReady || (request.resolutions?.some(item => item.choice === 'remote') ?? false)
    return { ok: true as const, revision: this.revision, plan: mergePlan(request.package, resolved) }
  }
  async syncImport(request: IdeasSyncImportRequest) {
    this.importCalls.push(request)
    if (this.importRefusal !== undefined) throw new IdeasApiError(this.importRefusal.message, this.importRefusal.error, this.importRefusal)
    this.revision += 1
    return {
      ok: true as const,
      snapshotId: request.package.snapshotId,
      syncKey: request.package.workspace.syncKey,
      workspaceId: WORKSPACE_A,
      imported: 1,
      skipped: 1,
      revision: this.revision,
      plan: mergePlan(request.package, true),
      displaced: snapshot('presync-1800000000000-aaaaaaaa.json', 'pre-sync'),
    }
  }

  async backups(): Promise<IdeasBackupView> {
    return { ok: true, dir: '/tmp/backups', retention: 10, snapshots: [], running: 0 }
  }
  async restoreSnapshot(request: IdeasRestoreRequest): Promise<IdeasRestoreResponse> {
    this.restoreCalls.push(request)
    this.revision += 1
    return {
      ok: true,
      revision: this.revision,
      ideas: 2,
      source: request.name ?? request.document ?? '',
      displaced: snapshot('displaced-1800000009000-bbbbbbbb.json', 'pre-restore'),
      unknownFields: [],
    }
  }
}

function snapshot(name: string, reason: IdeasSnapshotInfo['reason']): IdeasSnapshotInfo {
  return { name, createdAt: 1_800_000_000_000, bytes: 1024, reason, foreign: false }
}

const workspaces: WorkspacesSource = {
  list: () => [{ workspaceId: WORKSPACE_A, title: 'Alpha' }, { workspaceId: WORKSPACE_B, title: 'Beta' }],
  subscribe: () => () => {},
  dispose: () => {},
}

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root !== undefined) act(() => { root!.unmount() })
  root = undefined
  host.remove()
})

async function waitForUi(assertion: () => void): Promise<void> {
  await act(async () => { await vi.waitFor(assertion, { timeout: 5_000 }) })
}

async function render(transport: SyncTransport): Promise<IdeasClient> {
  const client = new IdeasClient(transport, workspaces)
  await client.refresh()
  await act(async () => {
    root = createRoot(host)
    root.render(<SyncPanel client={client} />)
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
  await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync]')).not.toBeNull() })
  return client
}

const button = (label: string): HTMLButtonElement =>
  Array.from(host.querySelectorAll('button')).find(item => item.textContent === label || item.getAttribute('aria-label') === label) as HTMLButtonElement

async function chooseCheckbox(index = 0): Promise<void> {
  const input = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]!
  await act(async () => { input.click() })
}

async function chooseSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function upload(pkg: IdeasSyncPackage = syncPackage()): Promise<void> {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File([JSON.stringify(pkg)], 'incoming.json', { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

describe('SyncPanel', () => {
  it('previews without writes and shows every required count', async () => {
    const transport = new SyncTransport()
    await render(transport)
    await upload()
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-preview]')).not.toBeNull() })

    const notice = host.querySelector('[data-dsh-ideas-sync-import-result]') as HTMLElement
    expect(notice.textContent).toContain('Preview ready for incoming.json')
    expect(button(en['sync.preview.show'])).toBeDefined()
    const previewNode = host.querySelector('[data-dsh-ideas-sync-preview]') as HTMLElement
    expect(previewNode.tabIndex).toBe(-1)
    await waitForUi(() => { expect(document.activeElement).toBe(previewNode) })
    const pairing = host.querySelector('[data-dsh-ideas-sync-pairing]') as HTMLElement
    expect(pairing.textContent).toContain('workspace-remote')
    expect(pairing.textContent).toContain(WORKSPACE_A)
    expect(pairing.textContent).toContain(SYNC_KEY)
    expect(pairing.textContent).toContain(en['sync.import.pairingRule'])

    expect(transport.planCalls).toHaveLength(1)
    expect(transport.workspaceCalls).toEqual([])
    expect(transport.importCalls).toEqual([])
    expect(transport.revision).toBe(1)
    const figures = Array.from(host.querySelectorAll('.dsh-ideas-sync-figure')).map(node => node.textContent)
    expect(figures).toEqual(expect.arrayContaining([
      `${en['sync.preview.create']}1`,
      `${en['sync.preview.update']}0`,
      `${en['sync.preview.delete']}1`,
      `${en['sync.preview.unchanged']}1`,
      `${en['sync.preview.mappings']}1`,
      `${en['sync.preview.duplicates']}1`,
      `${en['sync.preview.conflict']}1`,
    ]))
    expect(button(en['sync.preview.apply']).disabled).toBe(true)
  })

  it('requires an explicit destination mapping before it will preview an unknown key', async () => {
    const transport = new SyncTransport()
    transport.overview = {
      ...transport.overview,
      workspaces: [{ workspaceId: WORKSPACE_A, ideaCount: 2, confirmed: false }],
    }
    await render(transport)
    await upload()
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-mapping]')).not.toBeNull() })

    expect(host.querySelector('[data-dsh-ideas-sync-import-result]')?.textContent).toContain('Workspace pairing required for incoming.json')
    const pairing = host.querySelector('[data-dsh-ideas-sync-pairing]') as HTMLElement
    expect(pairing.textContent).toContain('workspace-remote')
    expect(pairing.textContent).toContain(SYNC_KEY)
    expect(pairing.textContent).toContain(en['sync.import.destinationUnpaired'])
    expect(transport.planCalls).toHaveLength(1)
    expect(transport.workspaceCalls).toEqual([])
    const select = host.querySelector('select[aria-label="' + en['sync.import.mappingWorkspace'] + '"]') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(button(en['sync.import.mappingConfirm']).disabled).toBe(true)
    await chooseSelect(select, WORKSPACE_B)
    expect(pairing.textContent).toContain(WORKSPACE_B)
    expect(button(en['sync.import.mappingConfirm']).disabled).toBe(true)
    const mappingCheckbox = host.querySelector('[data-dsh-ideas-sync-mapping] input[type="checkbox"]') as HTMLInputElement
    await act(async () => { mappingCheckbox.click() })
    expect(button(en['sync.import.mappingConfirm']).disabled).toBe(false)
    await act(async () => { button(en['sync.import.mappingConfirm']).click() })
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-preview]')).not.toBeNull() })
    expect(transport.workspaceCalls).toEqual([{ workspaceId: WORKSPACE_B, syncKey: SYNC_KEY, confirm: true }])
    expect(transport.planCalls).toHaveLength(2)
  })

  it('shows conflicts side by side, refuses apply until resolved, then names the safety snapshot and supports rollback', async () => {
    const transport = new SyncTransport()
    await render(transport)
    await upload()
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-preview]')).not.toBeNull() })

    const conflict = host.querySelector('[data-sync-conflict]') as HTMLElement
    expect(conflict.textContent).toContain('Local title')
    expect(conflict.textContent).toContain('Incoming title')
    expect(button(en['sync.preview.apply']).disabled).toBe(true)
    const choice = conflict.querySelector('select') as HTMLSelectElement
    await chooseSelect(choice, 'remote')
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20) }) })
    await waitForUi(() => { expect(host.querySelectorAll('[data-sync-conflict]')).toHaveLength(0) })
    expect(transport.planCalls[1]?.resolutions).toEqual([{ conflictId: 'shared\u0000title\u0000two-way-difference', choice: 'remote' }])

    await chooseCheckbox()
    expect(button(en['sync.preview.apply']).disabled).toBe(false)
    await act(async () => { button(en['sync.preview.apply']).click() })
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-success]')).not.toBeNull() })
    expect(transport.importCalls[0]).toMatchObject({ expectedRevision: 1, resolutions: [{ choice: 'remote' }] })
    const success = host.querySelector('[data-dsh-ideas-sync-success]') as HTMLElement
    expect(success.textContent).toContain('presync-1800000000000-aaaaaaaa.json')
    expect(success.textContent).toContain(en['sync.success.summary'].replace('{create}', '1').replace('{update}', '1').replace('{delete}', '1').replace('{unchanged}', '1'))

    await chooseCheckbox()
    await act(async () => { button(en['sync.success.rollbackYes']).click() })
    await waitForUi(() => { expect(transport.restoreCalls).toEqual([{ name: 'presync-1800000000000-aaaaaaaa.json' }]) })
    expect(host.textContent).toContain(en['sync.success.rollbackDone'].replace('{name}', 'displaced-1800000009000-bbbbbbbb.json'))
  })

  it('offers a confirmed bulk incoming choice and re-plans every conflict', async () => {
    const transport = new SyncTransport()
    await render(transport)
    await upload()
    await waitForUi(() => { expect(host.querySelector('[data-sync-conflict]')).not.toBeNull() })
    expect(button(en['sync.preview.apply']).disabled).toBe(true)

    await act(async () => { button(en['sync.bulk.incoming']).click() })
    expect(host.textContent).toContain(en['sync.bulk.hint'])
    expect(transport.planCalls).toHaveLength(1)
    await act(async () => { button(en['sync.bulk.confirmIncoming']).click(); await new Promise(resolve => { setTimeout(resolve, 20) }) })
    await waitForUi(() => { expect(host.querySelectorAll('[data-sync-conflict]')).toHaveLength(0) })
    expect(transport.planCalls[1]?.resolutions).toEqual([{ conflictId: 'shared\u0000title\u0000two-way-difference', choice: 'remote' }])
    await chooseCheckbox()
    expect(button(en['sync.preview.apply']).disabled).toBe(false)
  })

  it('offers a retry when the first preview is already stale', async () => {
    const transport = new SyncTransport()
    transport.planRefusal = refusal('sync-preview-stale', 'the board changed')
    await render(transport)
    await upload()
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-stale]')).not.toBeNull() })
    expect(host.textContent).toContain(en['sync.preview.staleFile'].replace('{name}', 'incoming.json'))
    await act(async () => { button(en['sync.preview.refresh']).click(); await new Promise(resolve => { setTimeout(resolve, 20) }) })
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-preview]')).not.toBeNull() })
    expect(transport.planCalls).toHaveLength(2)
  })

  it('keeps apply disabled and reports a stale-preview refusal', async () => {
    const transport = new SyncTransport()
    transport.initiallyReady = true
    transport.importRefusal = refusal('sync-preview-stale', 'the board changed')
    await render(transport)
    await upload()
    await waitForUi(() => { expect(host.querySelector('[data-dsh-ideas-sync-preview]')).not.toBeNull() })
    await chooseCheckbox()
    expect(button(en['sync.preview.apply']).disabled).toBe(false)
    await act(async () => { button(en['sync.preview.apply']).click(); await new Promise(resolve => { setTimeout(resolve, 20) }) })
    await waitForUi(() => { expect(host.querySelector('[role="alert"]')?.textContent).toContain(en['sync.error.previewStale']) })
    expect(button(en['sync.preview.apply']).disabled).toBe(true)
    expect(host.querySelector('[data-dsh-ideas-sync-success]')).toBeNull()
    expect(transport.revision).toBe(1)
  })

  it('creates an export identity only after consent, then exports through the Host', async () => {
    const transport = new SyncTransport()
    transport.overview = {
      ...transport.overview,
      workspaces: [{ workspaceId: WORKSPACE_A, ideaCount: 2, confirmed: false }],
    }
    await render(transport)
    expect(button(en['sync.export.action']).disabled).toBe(true)
    expect(button(en['sync.export.createIdentity']).disabled).toBe(true)
    await chooseCheckbox()
    const exportSelect = host.querySelector('select[aria-label="' + en['sync.export.workspace'] + '"]') as HTMLSelectElement
    await chooseSelect(exportSelect, WORKSPACE_B)
    expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]?.checked).toBe(false)
    expect(button(en['sync.export.createIdentity']).disabled).toBe(true)
    await chooseSelect(exportSelect, WORKSPACE_A)
    expect(button(en['sync.export.createIdentity']).disabled).toBe(true)
    await chooseCheckbox()
    await act(async () => { button(en['sync.export.createIdentity']).click() })
    await waitForUi(() => { expect(button(en['sync.export.action']).disabled).toBe(false) })
    expect(transport.workspaceCalls).toEqual([{ workspaceId: WORKSPACE_A, confirm: true }])
    await act(async () => { button(en['sync.export.action']).click() })
    await waitForUi(() => { expect(transport.exportCalls).toEqual([{ workspaceId: WORKSPACE_A }]) })
    expect(host.textContent).toContain(en['sync.export.downloadReady'].replace('{name}', 'ideas-sync-2027-01-15T08-00-00-000Z-snapshot.json'))
  })

  it('ships non-empty synchronization copy in every dictionary', () => {
    for (const dictionary of [fr, en, zh]) {
      for (const [key, value] of Object.entries(dictionary)) {
        if (key.startsWith('sync.')) {
          expect(typeof value).toBe('string')
          expect(value).not.toBe('')
        }
      }
    }
  })
})
