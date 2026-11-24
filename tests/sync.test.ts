/**
 * Portable synchronization identities and cross-machine workspace mapping.
 *
 * The central fixture uses two independent Homes with different workspace UUIDs.
 * It proves that a confirmed sync key, not a local id or display number, carries
 * workspace identity across the exchange.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdeasHostLedger, KNOWN_IDEA_FIELDS } from '../src/host-ledger.ts'
import {
  IDEAS_SYNC_LOCAL_IDEA_FIELDS,
  IDEAS_SYNC_PORTABLE_IDEA_FIELDS,
  IDEAS_SYNC_SNAPSHOT_CACHE_LIMIT,
  IDEAS_SYNC_VERSION,
  buildIdeasSyncPackage,
  cacheIdeasSyncSnapshot,
  parseIdeasSyncPackage,
  parseIdeasSyncState,
  parseIdeasSyncWorkspaceRequest,
  type IdeasSyncPackage,
  type IdeasSyncState,
} from '../src/sync.ts'

const homes: Array<{ dir: string; ledger: IdeasHostLedger }> = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    home.ledger.dispose()
    try { rmSync(home.dir, { recursive: true, force: true }) } catch {
      // Best-effort cleanup.
    }
  }
})

function freshHome(clockStart = 1_800_000_000_000): { dir: string; ledger: IdeasHostLedger } {
  const dir = join(tmpdir(), `ideas-sync-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  let clock = clockStart
  const ledger = new IdeasHostLedger({ dir, now: () => { clock += 1_000; return clock } })
  const home = { dir, ledger }
  homes.push(home)
  return home
}

function create(ledger: IdeasHostLedger, id: string, title: string, workspaceId: string, requestId = id): void {
  ledger.applyRequest(requestId, {
    kind: 'create',
    id,
    input: { title, body: `Body of ${title}`, workspaceId },
  })
}

function confirm(ledger: IdeasHostLedger, workspaceId: string, syncKey?: string): string {
  const outcome = ledger.confirmSyncWorkspace({
    workspaceId,
    ...(syncKey === undefined ? {} : { syncKey }),
    confirm: true,
  })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.mapping.syncKey
}

function exportPackage(ledger: IdeasHostLedger, workspaceId: string): IdeasSyncPackage {
  const outcome = ledger.exportSyncWorkspace({ workspaceId })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.package
}

const SYNC_STATE_FIELDS = ['deviceId', 'workspaces'] as const
const SYNC_MAPPING_FIELDS = ['syncKey', 'workspaceId', 'confirmedAt', 'baseSnapshotId', 'snapshots'] as const
const SYNC_PACKAGE_FIELDS = [
  'format', 'version', 'deviceId', 'snapshotId', 'baseSnapshotId',
  'createdAt', 'workspace', 'ideas',
] as const

describe('sync package contract', () => {
  it('classifies every persisted idea field exactly once', () => {
    const classified = [...IDEAS_SYNC_PORTABLE_IDEA_FIELDS, ...IDEAS_SYNC_LOCAL_IDEA_FIELDS].sort()
    expect(classified).toEqual([...KNOWN_IDEA_FIELDS].sort())
    expect(new Set(classified).size).toBe(classified.length)
  })

  it('pins the persisted sync state and package field surfaces with literals', () => {
    const state: IdeasSyncState = {
      deviceId: 'device-a',
      workspaces: [{
        syncKey: 'sync_12345678',
        workspaceId: 'workspace-a',
        confirmedAt: 1,
        baseSnapshotId: null,
        snapshots: [],
      }],
    }
    expect(Object.keys(state).sort()).toEqual([...SYNC_STATE_FIELDS].sort())
    expect(Object.keys(state.workspaces[0]!).sort()).toEqual([...SYNC_MAPPING_FIELDS].sort())
    const pkg = buildIdeasSyncPackage({
      ideas: [],
      mapping: state.workspaces[0]!,
      deviceId: state.deviceId,
      snapshotId: 'snapshot-a',
      createdAt: 2,
    })
    expect(Object.keys(pkg).sort()).toEqual([...SYNC_PACKAGE_FIELDS].sort())
  })

  it('bounds the common-ancestor cache and replaces a repeated snapshot id', () => {
    let mapping: IdeasSyncState['workspaces'][number] = {
      syncKey: 'sync_12345678',
      workspaceId: 'workspace-a',
      confirmedAt: 1,
      baseSnapshotId: null,
      snapshots: [],
    }
    for (let index = 0; index < IDEAS_SYNC_SNAPSHOT_CACHE_LIMIT + 2; index += 1) {
      mapping = { ...mapping, snapshots: cacheIdeasSyncSnapshot(mapping, `snapshot-${index}`, []) }
    }
    expect(mapping.snapshots.map(snapshot => snapshot.snapshotId)).toEqual([
      'snapshot-2', 'snapshot-3', 'snapshot-4', 'snapshot-5',
    ])
    mapping = { ...mapping, snapshots: cacheIdeasSyncSnapshot(mapping, 'snapshot-3', []) }
    expect(mapping.snapshots.map(snapshot => snapshot.snapshotId)).toEqual([
      'snapshot-2', 'snapshot-4', 'snapshot-5', 'snapshot-3',
    ])
  })

  it('refuses local execution fields instead of silently dropping them', () => {
    const pkg = buildIdeasSyncPackage({
      ideas: [{
        id: 'idea-a',
        title: 'Portable',
        body: 'Body',
        status: 'open',
        createdAt: 1,
        updatedAt: 2,
      }],
      mapping: { syncKey: 'sync_12345678', workspaceId: 'workspace-a', confirmedAt: 1, baseSnapshotId: null, snapshots: [] },
      deviceId: 'device-a',
      snapshotId: 'snapshot-a',
      createdAt: 3,
    })
    expect(parseIdeasSyncPackage(pkg)).toBeDefined()
    expect(parseIdeasSyncPackage({
      ...pkg,
      ideas: [{ ...pkg.ideas[0], runStatus: 'running', runSessionId: 'session-a' }],
    })).toBeUndefined()
    expect(parseIdeasSyncPackage({
      ...pkg,
      ideas: [{ ...pkg.ideas[0], taskBoardId: 'card-a', taskBoardStatus: 'running' }],
    })).toBeUndefined()
    expect(parseIdeasSyncPackage({
      ...pkg,
      ideas: [{ ...pkg.ideas[0], workspaceId: 'workspace-a', ideaNumber: 7 }],
    })).toBeUndefined()
  })

  it('refuses executable fields, duplicate ids, and newer package versions', () => {
    const pkg = buildIdeasSyncPackage({
      ideas: [{ id: 'idea-a', title: 'A', body: 'B', status: 'open', createdAt: 1, updatedAt: 1 }],
      mapping: { syncKey: 'sync_12345678', workspaceId: 'workspace-a', confirmedAt: 1, baseSnapshotId: null, snapshots: [] },
      deviceId: 'device-a',
      snapshotId: 'snapshot-a',
      createdAt: 2,
    })
    expect(parseIdeasSyncPackage({ ...pkg, version: IDEAS_SYNC_VERSION + 1 })).toBeUndefined()
    expect(parseIdeasSyncPackage({ ...pkg, ideas: [pkg.ideas[0], pkg.ideas[0]] })).toBeUndefined()
    expect(parseIdeasSyncPackage({
      ...pkg,
      ideas: [{ ...pkg.ideas[0], command: 'rm -rf /' }],
    })).toBeUndefined()
  })

  it('requires an explicit confirmation and unique mapping identities', () => {
    expect(parseIdeasSyncWorkspaceRequest({ workspaceId: 'workspace-a', confirm: false })).toBeUndefined()
    expect(parseIdeasSyncWorkspaceRequest({ workspaceId: 'workspace-a' })).toBeUndefined()
    expect(parseIdeasSyncWorkspaceRequest({ workspaceId: 'workspace-a', confirm: true })).toEqual({
      workspaceId: 'workspace-a',
      confirm: true,
    })
    const mapping = {
      syncKey: 'sync_12345678',
      workspaceId: 'workspace-a',
      confirmedAt: 1,
      baseSnapshotId: null,
      snapshots: [],
    }
    expect(parseIdeasSyncState({ deviceId: 'device-a', workspaces: [mapping, mapping] })).toBeUndefined()
    expect(parseIdeasSyncState({
      deviceId: 'device-a',
      workspaces: [mapping, { ...mapping, workspaceId: 'workspace-b' }],
    })).toBeUndefined()
  })
})

describe('two independent Homes exchange one workspace', () => {
  it('preserves ids and references, allocates local numbers, and quarantines execution state', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    const source = sourceHome.ledger
    const target = targetHome.ledger

    create(source, 'source-local', 'Only on source', sourceWorkspace)
    create(source, 'parent', 'Parent', sourceWorkspace)
    source.applyRequest('review-parent', { kind: 'move', ideaId: 'parent', status: 'underReview' })
    source.applyRequest('follow-up', {
      kind: 'followUp',
      ideaId: 'parent',
      input: { title: 'Child', body: 'The parent needs another pass' },
    })
    create(source, 'peer', 'Peer', sourceWorkspace)
    source.applyRequest('relate', { kind: 'update', ideaId: 'parent', patch: { relatesTo: ['peer'] } })
    source.applyRequest('block', { kind: 'update', ideaId: 'parent', patch: { blocks: ['peer'] } })

    // A live execution on the source is exportable, but none of its pointers may
    // become active state on the destination.
    source.setRunStatus('parent', 'running')
    source.setRunSession('parent', 'session-on-source')
    source.bindTaskBoardId('parent', 'card-on-source')
    source.setTaskBoardStatus('parent', 'running')

    create(target, 'target-local', 'Only on target', targetWorkspace)
    const syncKey = confirm(source, sourceWorkspace)
    confirm(target, targetWorkspace, syncKey)
    expect(sourceWorkspace).not.toBe(targetWorkspace)

    const sourceIds = source.snapshot().ideas.map(idea => idea.id)
    const pkg = exportPackage(source, sourceWorkspace)
    expect(pkg.format).toBe('dsh-ideas-sync')
    expect(pkg.version).toBe(IDEAS_SYNC_VERSION)
    expect(pkg.deviceId).toBe(source.syncOverview().deviceId)
    expect(pkg.snapshotId).not.toBe('')
    expect(pkg.baseSnapshotId).toBeNull()
    expect(pkg.workspace).toEqual({ syncKey, sourceWorkspaceId: sourceWorkspace })
    expect(pkg.ideas.map(idea => idea.id)).toEqual(sourceIds)
    for (const idea of pkg.ideas) {
      expect(Object.keys(idea).some(key => (IDEAS_SYNC_LOCAL_IDEA_FIELDS as readonly string[]).includes(key))).toBe(false)
    }

    const outcome = target.importSyncPackage(pkg)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome).toMatchObject({ imported: 4, skipped: 0, syncKey, workspaceId: targetWorkspace })
    const imported = target.snapshot().ideas
    expect(imported.map(idea => idea.id)).toEqual(['target-local', ...sourceIds])
    expect(new Set(imported.map(idea => idea.ideaNumber)).size).toBe(imported.length)
    expect(imported.every(idea => typeof idea.ideaNumber === 'number')).toBe(true)
    expect(imported.find(idea => idea.id === 'target-local')?.ideaNumber).toBe(1)
    // The source's #2 is not the destination's #2: display numbers are local.
    expect(imported.find(idea => idea.id === 'parent')?.ideaNumber).not.toBe(2)

    const parent = imported.find(idea => idea.id === 'parent')!
    const child = imported.find(idea => idea.followUpOfId === 'parent')!
    expect(child.id).toBe(source.snapshot().ideas.find(idea => idea.followUpOfId === 'parent')!.id)
    expect(parent.relatesTo).toEqual(['peer'])
    expect(imported.find(idea => idea.id === 'peer')?.relatesTo).toEqual(['parent'])
    expect(parent.blocks).toEqual(['peer'])
    expect(parent.events?.length ?? 0).toBeGreaterThan(0)
    expect(parent.runStatus).toBeUndefined()
    expect(parent.runSessionId).toBeUndefined()
    expect(parent.taskBoardId).toBeUndefined()
    expect(parent.taskBoardStatus).toBeUndefined()

    // Re-importing the same snapshot is idempotent and never reissues a number.
    // Destination-owned execution state on an existing id is preserved too.
    target.setRunStatus('parent', 'running')
    target.setRunSession('parent', 'session-on-target')
    target.bindTaskBoardId('parent', 'card-on-target')
    target.setTaskBoardStatus('parent', 'running')
    const revision = target.snapshot().revision
    const replay = target.importSyncPackage(pkg)
    expect(replay).toMatchObject({ ok: true, imported: 0, skipped: 4, revision })
    expect(target.snapshot().ideas.map(idea => idea.ideaNumber)).toEqual(imported.map(idea => idea.ideaNumber))
    expect(target.snapshot().ideas.find(idea => idea.id === 'parent')).toMatchObject({
      runStatus: 'running',
      runSessionId: 'session-on-target',
      taskBoardId: 'card-on-target',
      taskBoardStatus: 'running',
    })

    // The destination now exports the same ids under its own device and local
    // workspace, based on the snapshot it just adopted.
    const back = exportPackage(target, targetWorkspace)
    expect(back.deviceId).not.toBe(pkg.deviceId)
    expect(back.workspace).toEqual({ syncKey, sourceWorkspaceId: targetWorkspace })
    expect(back.baseSnapshotId).toBe(pkg.snapshotId)
    expect(back.ideas.map(idea => idea.id)).toEqual(imported.map(idea => idea.id))
    create(target, 'after-import', 'Captured after import', targetWorkspace)
    expect(target.snapshot().ideas.at(-1)?.ideaNumber).toBe(Math.max(...imported.map(idea => idea.ideaNumber!)) + 1)
  })

  it('refuses differing portable content rather than attempting a merge', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    create(sourceHome.ledger, 'shared', 'Original', sourceWorkspace)
    create(targetHome.ledger, 'local', 'Destination only', targetWorkspace)
    const key = confirm(sourceHome.ledger, sourceWorkspace)
    confirm(targetHome.ledger, targetWorkspace, key)
    const first = exportPackage(sourceHome.ledger, sourceWorkspace)
    expect(targetHome.ledger.importSyncPackage(first).ok).toBe(true)

    sourceHome.ledger.applyRequest('edit-source', {
      kind: 'update',
      ideaId: 'shared',
      patch: { body: 'Changed on the source after the first exchange' },
    })
    const second = exportPackage(sourceHome.ledger, sourceWorkspace)
    const before = targetHome.ledger.snapshot()
    const refusal = targetHome.ledger.importSyncPackage(second)
    expect(refusal.ok).toBe(false)
    if (refusal.ok) throw new Error('expected a conflict refusal')
    expect(refusal.error).toBe('sync-idea-conflict')
    expect(refusal.message).toContain('shared')
    expect(targetHome.ledger.snapshot()).toEqual(before)
  })

  it('plans read-only, then applies disjoint edits atomically through the existing transitions', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    const source = sourceHome.ledger
    const target = targetHome.ledger
    create(source, 'shared', 'Original', sourceWorkspace)
    create(target, 'target-local', 'Destination only', targetWorkspace)
    const key = confirm(source, sourceWorkspace)
    confirm(target, targetWorkspace, key)
    const first = exportPackage(source, sourceWorkspace)
    expect(target.importSyncPackage(first).ok).toBe(true)

    source.applyRequest('source-title', { kind: 'update', ideaId: 'shared', patch: { title: 'Source title' } })
    target.applyRequest('target-body', { kind: 'update', ideaId: 'shared', patch: { body: 'Target body' } })
    target.setRunStatus('shared', 'running')
    target.setRunSession('shared', 'session-target')
    const second = exportPackage(target, targetWorkspace)
    expect(second.baseSnapshotId).toBe(first.snapshotId)

    const beforePlan = target.snapshot()
    const sourceBeforePlan = source.snapshot()
    const sourceBytes = readFileSync(join(sourceHome.dir, 'ledger-v2.json'), 'utf8')
    const planned = source.planSyncPackage({ package: second })
    expect(planned.ok).toBe(true)
    if (!planned.ok) throw new Error(planned.message)
    expect(planned.plan.mode).toBe('three-way')
    expect(planned.plan.ancestorSnapshotId).toBe(first.snapshotId)
    // Both Hosts appended an activity entry, whose bounded history has no
    // stable cross-machine event identity yet. That field is an explicit
    // conflict; the disjoint title/body edits themselves are merged.
    expect(planned.plan.conflicts.map(conflict => conflict.field)).toEqual(['events'])
    expect(source.snapshot()).toEqual(sourceBeforePlan)
    expect(readFileSync(join(sourceHome.dir, 'ledger-v2.json'), 'utf8')).toBe(sourceBytes)
    expect(source.snapshots()).toHaveLength(0)

    const resolutions = planned.plan.conflicts.map(conflict => ({ conflictId: conflict.conflictId, choice: 'local' as const }))
    const applied = source.importSyncPackage(second, resolutions)
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error(applied.message)
    expect(applied.plan.ready).toBe(true)
    expect(applied.displaced?.reason).toBe('pre-sync')
    expect(source.snapshot().ideas.find(idea => idea.id === 'shared')).toMatchObject({
      title: 'Source title',
      body: 'Target body',
    })
    expect(source.snapshot().ideas.find(idea => idea.id === 'shared')?.runStatus).toBeUndefined()
    expect(source.snapshot().ideas.find(idea => idea.id === 'shared')?.runSessionId).toBeUndefined()
    expect(source.snapshot().revision).toBe(sourceBeforePlan.revision + 1)
    expect(source.snapshots().some(snapshot => snapshot.reason === 'pre-sync')).toBe(true)
    expect(target.snapshot()).toEqual(beforePlan)
  })

  it('applies an unambiguous remote backlog reorder through the existing reorder transition', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    const source = sourceHome.ledger
    const target = targetHome.ledger
    for (const id of ['a', 'b', 'c']) create(source, id, id.toUpperCase(), sourceWorkspace)
    source.applyRequest('initial-order', { kind: 'reorder', orderedIds: ['a', 'b', 'c'] })
    create(target, 'target-local', 'Destination only', targetWorkspace)
    const key = confirm(source, sourceWorkspace)
    confirm(target, targetWorkspace, key)
    const first = exportPackage(source, sourceWorkspace)
    expect(target.importSyncPackage(first).ok).toBe(true)
    target.applyRequest('remote-order', { kind: 'reorder', orderedIds: ['c', 'b', 'a', 'target-local'] })
    const second = exportPackage(target, targetWorkspace)

    const planned = source.planSyncPackage({ package: second })
    expect(planned.ok).toBe(true)
    if (!planned.ok) throw new Error(planned.message)
    expect(planned.plan.ready).toBe(true)
    expect(planned.plan.reorder?.orderedIds).toEqual(['c', 'b', 'a', 'target-local'])
    expect(planned.plan.operations.every(operation => operation.action !== 'update')).toBe(true)
    const applied = source.importSyncPackage(second)
    expect(applied.ok).toBe(true)
    const ordered = source.snapshot().ideas
      .filter(idea => ['a', 'b', 'c'].includes(idea.id))
      .sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0))
      .map(idea => idea.id)
    expect(ordered).toEqual(['c', 'b', 'a'])
  })

  it('refuses the whole apply while any conflict is unresolved, then applies every decision in one commit', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    const source = sourceHome.ledger
    const target = targetHome.ledger
    create(source, 'shared', 'Original', sourceWorkspace)
    create(target, 'target-local', 'Destination only', targetWorkspace)
    const key = confirm(source, sourceWorkspace)
    confirm(target, targetWorkspace, key)
    const first = exportPackage(source, sourceWorkspace)
    expect(target.importSyncPackage(first).ok).toBe(true)

    source.applyRequest('source-conflict', { kind: 'update', ideaId: 'shared', patch: { title: 'Source title' } })
    target.applyRequest('target-conflict', { kind: 'update', ideaId: 'shared', patch: { title: 'Target title' } })
    create(target, 'remote-new', 'Created on target', targetWorkspace)
    const second = exportPackage(target, targetWorkspace)
    const before = source.snapshot()
    const snapshotCount = source.snapshots().length
    const refused = source.importSyncPackage(second)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected unresolved conflicts')
    expect(refused.error).toBe('sync-idea-conflict')
    expect(refused.plan?.conflicts.length).toBeGreaterThan(0)
    expect(source.snapshot()).toEqual(before)
    expect(source.snapshots()).toHaveLength(snapshotCount)
    expect(source.snapshot().ideas.some(idea => idea.id === 'remote-new')).toBe(false)

    const resolved = source.importSyncPackage(second, refused.plan!.conflicts.map(conflict => ({
      conflictId: conflict.conflictId,
      choice: 'local',
    })))
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error(resolved.message)
    expect(source.snapshot().revision).toBe(before.revision + 1)
    expect(source.snapshot().ideas.find(idea => idea.id === 'shared')?.title).toBe('Source title')
    expect(source.snapshot().ideas.find(idea => idea.id === 'remote-new')?.title).toBe('Created on target')
    expect(source.snapshots()).toHaveLength(snapshotCount + 1)
  })

  it('restores the in-memory board when an apply transition fails after the safety snapshot', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    create(sourceHome.ledger, 'incoming', 'Incoming', sourceWorkspace)
    const key = confirm(sourceHome.ledger, sourceWorkspace)
    confirm(targetHome.ledger, targetWorkspace, key)
    const pkg = exportPackage(sourceHome.ledger, sourceWorkspace)
    const before = targetHome.ledger.snapshot()
    const applyTarget = targetHome.ledger as unknown as { apply: (...args: unknown[]) => unknown }
    const apply = vi.spyOn(applyTarget, 'apply').mockImplementationOnce(() => {
      throw new Error('forced transition failure')
    })

    const outcome = targetHome.ledger.importSyncPackage(pkg)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected an apply refusal')
    expect(outcome.error).toBe('sync-apply-failed')
    expect(outcome.message).toContain('board is unchanged')
    expect(targetHome.ledger.snapshot()).toEqual(before)
    expect(targetHome.ledger.snapshots()).toHaveLength(1)
    expect(targetHome.ledger.snapshots()[0]?.reason).toBe('pre-sync')
    apply.mockRestore()
  })

  it('requires the destination mapping to be confirmed first', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    create(sourceHome.ledger, 'a', 'A', sourceWorkspace)
    create(targetHome.ledger, 'b', 'B', targetWorkspace)
    confirm(sourceHome.ledger, sourceWorkspace)
    const pkg = exportPackage(sourceHome.ledger, sourceWorkspace)
    const refusal = targetHome.ledger.importSyncPackage(pkg)
    expect(refusal.ok).toBe(false)
    if (refusal.ok) throw new Error('expected an unconfirmed refusal')
    expect(refusal.error).toBe('sync-workspace-unconfirmed')
  })

  it('refuses dangling references instead of dropping an edge', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    create(sourceHome.ledger, 'a', 'A', sourceWorkspace)
    create(targetHome.ledger, 'b', 'B', targetWorkspace)
    const key = confirm(sourceHome.ledger, sourceWorkspace)
    confirm(targetHome.ledger, targetWorkspace, key)
    const pkg = exportPackage(sourceHome.ledger, sourceWorkspace)
    pkg.ideas[0]!.relatesTo = ['missing-elsewhere']
    const before = targetHome.ledger.snapshot()
    const refusal = targetHome.ledger.importSyncPackage(parseIdeasSyncPackage(pkg)!)
    expect(refusal.ok).toBe(false)
    if (refusal.ok) throw new Error('expected a missing-reference refusal')
    expect(refusal.error).toBe('sync-reference-missing')
    expect(targetHome.ledger.snapshot()).toEqual(before)
  })
})

describe('sync identity persistence and backup surface', () => {
  it('resolves a common ancestor after the exporting Host restarts', () => {
    const sourceHome = freshHome()
    const targetHome = freshHome(1_900_000_000_000)
    const sourceWorkspace = randomUUID()
    const targetWorkspace = randomUUID()
    create(sourceHome.ledger, 'shared', 'Original', sourceWorkspace)
    create(targetHome.ledger, 'target-local', 'Destination only', targetWorkspace)
    const key = confirm(sourceHome.ledger, sourceWorkspace)
    confirm(targetHome.ledger, targetWorkspace, key)
    const first = exportPackage(sourceHome.ledger, sourceWorkspace)
    expect(targetHome.ledger.importSyncPackage(first).ok).toBe(true)

    sourceHome.ledger.dispose()
    homes.splice(homes.indexOf(sourceHome), 1)
    const reopened = new IdeasHostLedger({ dir: sourceHome.dir })
    homes.push({ dir: sourceHome.dir, ledger: reopened })
    targetHome.ledger.applyRequest('remote-body', { kind: 'update', ideaId: 'shared', patch: { body: 'Remote body' } })
    const second = exportPackage(targetHome.ledger, targetWorkspace)
    const planned = reopened.planSyncPackage({ package: second })
    expect(planned.ok).toBe(true)
    if (!planned.ok) throw new Error(planned.message)
    expect(planned.plan.mode).toBe('three-way')
    expect(planned.plan.ancestorSnapshotId).toBe(first.snapshotId)
    expect(planned.plan.ready).toBe(true)
  })

  it('keeps the device id and confirmed mapping across restart', () => {
    const firstHome = freshHome()
    const workspaceId = randomUUID()
    create(firstHome.ledger, 'a', 'A', workspaceId)
    const key = confirm(firstHome.ledger, workspaceId)
    const before = firstHome.ledger.syncOverview()
    firstHome.ledger.dispose()
    homes.splice(homes.indexOf(firstHome), 1)

    const reopened = new IdeasHostLedger({ dir: firstHome.dir })
    homes.push({ dir: firstHome.dir, ledger: reopened })
    expect(reopened.syncOverview()).toEqual(before)
    expect(reopened.syncOverview().workspaces[0]?.syncKey).toBe(key)
  })

  it('carries the machine-local sync state through the existing backup/restore format', () => {
    const sourceHome = freshHome()
    const workspaceId = randomUUID()
    create(sourceHome.ledger, 'a', 'A', workspaceId)
    confirm(sourceHome.ledger, workspaceId, 'sync_backup01')
    const state = sourceHome.ledger.syncOverview()
    const snapshot = sourceHome.ledger.takeSnapshot('export')
    const document = JSON.parse(readFileSync(snapshot.snapshot.path, 'utf8')) as { sync: IdeasSyncState }
    expect(Object.keys(document.sync).sort()).toEqual([...SYNC_STATE_FIELDS].sort())
    expect(Object.keys(document.sync.workspaces[0]!).sort()).toEqual([...SYNC_MAPPING_FIELDS].sort())

    const targetHome = freshHome(1_900_000_000_000)
    const restored = targetHome.ledger.restore({ document: readFileSync(snapshot.snapshot.path, 'utf8') })
    expect(restored.ok).toBe(true)
    expect(targetHome.ledger.syncOverview()).toEqual(state)
  })

  it('does not let one local workspace hold two keys or one key hold two workspaces', () => {
    const home = freshHome()
    const workspaceA = randomUUID()
    const workspaceB = randomUUID()
    create(home.ledger, 'a', 'A', workspaceA)
    create(home.ledger, 'b', 'B', workspaceB)
    confirm(home.ledger, workspaceA, 'sync_key0001')
    const keyConflict = home.ledger.confirmSyncWorkspace({ workspaceId: workspaceB, syncKey: 'sync_key0001', confirm: true })
    expect(keyConflict.ok).toBe(false)
    if (keyConflict.ok) throw new Error('expected a key conflict')
    expect(keyConflict.error).toBe('sync-key-conflict')
    const workspaceConflict = home.ledger.confirmSyncWorkspace({ workspaceId: workspaceA, syncKey: 'sync_key0002', confirm: true })
    expect(workspaceConflict.ok).toBe(false)
    if (workspaceConflict.ok) throw new Error('expected a workspace conflict')
    expect(workspaceConflict.error).toBe('sync-workspace-conflict')
  })
})
