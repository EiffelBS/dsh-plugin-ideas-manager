/**
 * Snapshots, restore and the portable round trip (idea #95).
 *
 * The suite is organized around the three promises the feature makes, plus the
 * failures that must be loud rather than silent:
 *  - a snapshot is a real, timestamped, atomically-written copy of the whole
 *    ledger, taken through the ledger that owns the single-writer lock, with an
 *    explicit retention policy;
 *  - a restore REFUSES while a run is in flight, says why, and changes nothing;
 *  - an exported document round-trips every field the ledger holds — including
 *    the ones a naive export would drop (events, runStatus, runSessionId,
 *    taskBoardId, the analysis audit and the delivery note);
 *  - what a restore replaces is DISPLACED, not overwritten, and a broken
 *    document is refused (and quarantined) instead of half-adopted.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { IdeasHostService } from '../src/host-service.ts'
import { IDEAS_BACKUP_DIR_NAME, IDEAS_SNAPSHOT_RETENTION } from '../src/backup.ts'
import { IDEAS_SCHEMA_VERSION } from '../src/protocol.ts'

let dir = ''
let clock = 1_800_000_000_000

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
  dir = ''
})

/** Scratch home for one test, with a clock the test controls. */
function freshDir(): string {
  dir = join(tmpdir(), `ideas-backup-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A ledger on the scratch home, with a monotonically stepping clock. */
function ledger(): IdeasHostLedger {
  return new IdeasHostLedger({ dir, now: () => { clock += 1_000; return clock } })
}

/** Absolute path of the snapshot folder. */
function backupDir(): string {
  return join(dir, IDEAS_BACKUP_DIR_NAME)
}

/** File names of the snapshot folder, sorted (quarantined files included). */
function snapshotFiles(): string[] {
  if (!existsSync(backupDir())) return []
  return readdirSync(backupDir()).sort()
}

/** Read a snapshot file back as JSON. */
function readSnapshot(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(backupDir(), name), 'utf8')) as Record<string, unknown>
}

const create = (id: string, title = 'Idea title', workspaceId?: string) => ({
  kind: 'create' as const,
  id,
  input: { title, body: `Body of ${title}`, ...(workspaceId === undefined ? {} : { workspaceId }) },
})

/**
 * An idea carrying EVERY field the ledger holds, built through the ordinary
 * verbs so the round-trip assertion is about what the ledger really stores.
 */
function fullyPopulated(ledgerRef: IdeasHostLedger): string {
  ledgerRef.applyRequest('seed-1', {
    kind: 'create',
    id: 'idea-rich',
    input: {
      title: 'Backup and restore',
      body: '# Analysis\n\nThe whole story.',
      summary: 'A compact card summary',
      workspaceId: 'ws-1',
      rank: 2,
      value: 3,
      effort: 2,
      rationale: 'It protects the only source of truth',
      tags: [{ name: 'safety', promptPrefix: 'Read the README first.' }, { name: 'ledger' }],
    },
  })
  ledgerRef.applyRequest('seed-2', { kind: 'reanalyze', ideaId: 'idea-rich' })
  ledgerRef.applyRequest('seed-3', {
    kind: 'triage',
    ideaId: 'idea-rich',
    patch: { value: 3, effort: 1, rationale: 'Still the best order', rank: 1 },
  })
  // Runner-owned stamps, exactly as the Host writes them at settle time.
  ledgerRef.bindTaskBoardId('idea-rich', 'idea-idea-rich')
  ledgerRef.setTaskBoardStatus('idea-rich', 'done')
  ledgerRef.setRunStatus('idea-rich', 'done')
  ledgerRef.setRunSession('idea-rich', 'session-abc')
  ledgerRef.setDeliveryNote('idea-rich', 'The last assistant message of the run.')
  ledgerRef.recordEvent('idea-rich', 'run', 'Execution finished')
  // A follow-up chain and a closed idea, so the round trip covers more than one row.
  ledgerRef.applyRequest('seed-4', { kind: 'move', ideaId: 'idea-rich', status: 'underReview' })
  ledgerRef.applyRequest('seed-5', {
    kind: 'followUp',
    ideaId: 'idea-rich',
    input: { title: 'Follow-up', body: 'Because the first attempt was partial' },
  })
  ledgerRef.applyRequest('seed-6', create('idea-2', 'Second idea', 'ws-1'))
  ledgerRef.applyRequest('seed-7', { kind: 'decline', ideaId: 'idea-2', decision: 'Not worth it now' })
  return 'idea-rich'
}

describe('snapshot folder', () => {
  it('writes a timestamped snapshot of the whole document and leaves no tmp file', () => {
    const home = freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    const taken = store.takeSnapshot()

    expect(taken.ideas).toBe(1)
    expect(taken.pruned).toBe(0)
    expect(taken.snapshot.name).toMatch(/^snapshot-\d{13}-[0-9a-f]{8}\.json$/)
    expect(taken.snapshot.createdAt).toBe(clock)
    expect(taken.snapshot.path.startsWith(join(home, IDEAS_BACKUP_DIR_NAME))).toBe(true)
    // Atomic write: no *.tmp-* survives a successful snapshot.
    expect(snapshotFiles().filter(name => name.includes('.tmp-'))).toEqual([])

    const document = readSnapshot(taken.snapshot.name)
    expect(document.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    expect(document.revision).toBe(store.snapshot().revision)
    expect((document.ideas as Array<{ id: string }>).map(idea => idea.id)).toEqual(['idea-1'])
    // The in-document stamp says what the file is, so a copy that travelled to
    // another machine still identifies itself.
    expect(document.snapshot).toMatchObject({ version: 1, reason: 'manual', ideas: 1 })
    store.dispose()
  })

  it('keeps the last N snapshots and removes the older ones', () => {
    freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    for (let index = 0; index < IDEAS_SNAPSHOT_RETENTION + 3; index += 1) store.takeSnapshot()

    const managed = store.snapshots()
    expect(managed).toHaveLength(IDEAS_SNAPSHOT_RETENTION)
    expect(managed.every(file => file.managed)).toBe(true)
    expect(managed.map(file => file.createdAt)).toEqual([...managed.map(file => file.createdAt)].sort((a, b) => b - a))
    // The newest survives; the oldest is gone.
    expect(readFileSync(join(backupDir(), managed[0]!.name), 'utf8')).toContain('idea-1')
    store.dispose()
  })

  it('never prunes a file the plugin did not write (an export dropped in by hand)', () => {
    const home = freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    const foreign = join(backupDir(), 'board-from-another-machine.json')
    mkdirSync(backupDir(), { recursive: true })
    writeFileSync(foreign, JSON.stringify({ schemaVersion: IDEAS_SCHEMA_VERSION, revision: 1, ideas: [] }))

    for (let index = 0; index < IDEAS_SNAPSHOT_RETENTION + 2; index += 1) store.takeSnapshot()

    expect(store.snapshots().filter(file => !file.managed).map(file => file.name)).toEqual(['board-from-another-machine.json'])
    expect(existsSync(join(home, IDEAS_BACKUP_DIR_NAME, 'board-from-another-machine.json'))).toBe(true)
    store.dispose()
  })

  it('never creates the folder before the first snapshot', () => {
    freshDir()
    const store = ledger()
    expect(existsSync(backupDir())).toBe(false)
    expect(store.snapshots()).toEqual([])
    store.dispose()
  })
})

describe('restore is refused while a run is in flight', () => {
  it('refuses with the idea that is running and changes nothing', () => {
    freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1', 'Ship the exporter'))
    store.setRunStatus('idea-1', 'running')
    store.setRunSession('idea-1', 'session-live')
    const taken = store.takeSnapshot()
    store.setRunStatus('idea-1', 'running')
    const before = store.snapshot()

    const outcome = store.restore({ name: taken.snapshot.name })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('restore-run-in-flight')
    // It says WHY, and it names the run that blocks it.
    expect(outcome.message).toContain('#1')
    expect(outcome.message).toContain('Ship the exporter')
    expect(outcome.running?.map(idea => idea.id)).toEqual(['idea-1'])
    // Nothing moved: no displacement, no adopt, no revision churn.
    expect(store.snapshot()).toEqual(before)
    expect(store.snapshots().map(file => file.name)).toEqual([taken.snapshot.name])
    store.dispose()
  })

  it('does not quarantine a broken snapshot while a run blocks the restore', () => {
    freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    store.setRunStatus('idea-1', 'running')
    const taken = store.takeSnapshot()
    const broken = join(backupDir(), taken.snapshot.name)
    writeFileSync(broken, '{ this is not json')
    store.setRunStatus('idea-1', 'running')

    const outcome = store.restore({ name: taken.snapshot.name })

    expect(outcome.ok).toBe(false)
    // The state check runs first, so a refusal has no filesystem side effect.
    expect(existsSync(broken)).toBe(true)
    expect(snapshotFiles()).toEqual([taken.snapshot.name])
    store.dispose()
  })
})

describe('restore displaces what it replaces', () => {
  it('keeps the replaced board as its own snapshot and adopts the snapshot', () => {
    freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1', 'Before the accident'))
    const taken = store.takeSnapshot()

    store.applyRequest('req-2', create('idea-2', 'Added after the snapshot'))
    store.applyRequest('req-3', create('idea-3', 'Also after'))
    expect(store.snapshot().ideas).toHaveLength(3)
    const revisionBefore = store.snapshot().revision

    const outcome = store.restore({ name: taken.snapshot.name })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected a restore')
    expect(outcome.source).toBe(taken.snapshot.name)
    expect(outcome.ideas).toBe(1)
    // The revision only ever moves forward: the browser poll must never mistake
    // the restored board for the one it already holds.
    expect(outcome.revision).toBe(revisionBefore + 1)
    expect(store.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1'])
    // The displaced board is kept, byte for byte, as a restorable snapshot.
    expect(outcome.displaced.reason).toBe('pre-restore')
    const displaced = readSnapshot(outcome.displaced.name)
    expect(displaced.schemaVersion).toBe(IDEAS_SCHEMA_VERSION)
    expect((displaced.ideas as Array<{ id: string }>).map(idea => idea.id)).toEqual(['idea-1', 'idea-2', 'idea-3'])
    // ...and it really is restorable: restoring it brings the three ideas back.
    expect(store.restore({ name: outcome.displaced.name }).ok).toBe(true)
    expect(store.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1', 'idea-2', 'idea-3'])
    store.dispose()
  })

  it('never rewinds the request-id dedupe cache', () => {
    freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    const taken = store.takeSnapshot()
    store.applyRequest('req-2', create('idea-2'))
    store.restore({ name: taken.snapshot.name })

    // Replaying a request id that already ran must still be a replay, even
    // though the board it ran on is gone: re-executing it would resurrect work
    // the restore just rolled back.
    const replay = store.applyRequest('req-2', create('idea-2'))
    expect(replay.replayed).toBe(true)
    expect(store.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1'])
    store.dispose()
  })
})

describe('restore refuses a document it cannot adopt', () => {
  function withSnapshot(mutate: (name: string) => void): IdeasHostLedger {
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    const taken = store.takeSnapshot()
    mutate(taken.snapshot.name)
    return store
  }

  it('quarantines a file that is not JSON and keeps the board untouched', () => {
    freshDir()
    const store = withSnapshot(name => { writeFileSync(join(backupDir(), name), 'not json at all') })
    const before = store.snapshot()

    const outcome = store.restore({ name: snapshotFiles()[0]! })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('snapshot-unreadable')
    expect(outcome.quarantined).toBeDefined()
    // The evidence is renamed beside itself, never deleted: the folder holds
    // exactly the quarantined file, and the API list no longer offers it.
    const quarantined = readdirSync(backupDir())
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toContain('.corrupt-')
    expect(store.snapshots()).toEqual([])
    expect(store.snapshot()).toEqual(before)
    store.dispose()
  })

  it('refuses a ledger written by another schema version', () => {
    freshDir()
    const store = withSnapshot(name => {
      writeFileSync(join(backupDir(), name), JSON.stringify({ schemaVersion: 2, revision: 1, ideas: [] }))
    })

    const outcome = store.restore({ name: snapshotFiles()[0]! })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('snapshot-schema')
    expect(outcome.message).toContain('schema 2')
    expect(store.snapshot().ideas).toHaveLength(1)
    store.dispose()
  })

  it('refuses a document carrying a file that is not a ledger document at all', () => {
    freshDir()
    const store = ledger()
    const outcome = store.restore({ document: JSON.stringify({ hello: 'world' }) })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('snapshot-schema')
    store.dispose()
  })

  it('refuses a half-broken document instead of importing the readable half', () => {
    freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    const document = {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 4,
      ideaSequence: 7,
      ideas: [
        { id: 'a', title: 'Fine', body: '', status: 'open', createdAt: 1, updatedAt: 2 },
        { id: '', title: 'No id', body: '', status: 'open', createdAt: 1, updatedAt: 2 },
        { id: 'c', title: 'Also fine', body: '', status: 'archived', createdAt: 1, updatedAt: 2 },
      ],
    }

    const outcome = store.restore({ document: JSON.stringify(document) })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('snapshot-records')
    expect(outcome.message).toContain('record 2 of 3')
    // The live board is exactly what it was: no partial import.
    expect(store.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1'])
    store.dispose()
  })

  it('refuses two records sharing one id (they would collapse into one)', () => {
    freshDir()
    const store = ledger()
    const row = { title: 'Twin', body: '', status: 'open', createdAt: 1, updatedAt: 2 }

    const outcome = store.restore({
      document: JSON.stringify({
        schemaVersion: IDEAS_SCHEMA_VERSION,
        revision: 1,
        ideas: [{ id: 'same', ...row }, { id: 'same', ...row }],
      }),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.message).toContain('same')
    store.dispose()
  })

  it('refuses an unreadable document handed in inline (nothing is quarantined)', () => {
    freshDir()
    const store = ledger()
    const outcome = store.restore({ document: '{"schemaVersion": 1, "revision": "nope"}' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('snapshot-shape')
    // An inline import is nobody's file on disk: there is nothing to move aside.
    expect(snapshotFiles()).toEqual([])
    store.dispose()
  })

  it('reports a missing snapshot by name', () => {
    freshDir()
    const store = ledger()
    const outcome = store.restore({ name: 'snapshot-1800000000000-deadbeef.json' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('snapshot-not-found')
    store.dispose()
  })
})

describe('portable export / import round trip', () => {
  it('round-trips every field the ledger holds, on another home', () => {
    // Machine A: a board that holds everything the ledger can store.
    freshDir()
    const source = ledger()
    const richId = fullyPopulated(source)
    const sourceIdeas = source.snapshot().ideas
    const taken = source.takeSnapshot('export')
    const exported = readFileSync(taken.snapshot.path, 'utf8')
    const sourceSequence = source.snapshot().ideas.reduce((max, idea) => Math.max(max, idea.ideaNumber ?? 0), 0)
    source.dispose()

    // Machine B: an empty home. The same document, adopted whole.
    dir = join(tmpdir(), `ideas-backup-target-${process.pid}-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const target = ledger()
    const outcome = target.restore({ document: exported })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected a restore')
    expect(outcome.source).toBe('the imported ledger')
    expect(outcome.ideas).toBe(sourceIdeas.length)
    // Every field, on every row, byte-identical after the round trip.
    expect(target.snapshot().ideas).toEqual(sourceIdeas)
    target.dispose()

    // ...and the ledger's own invariants travelled with them: the capture
    // sequence never re-issues a #N, and the next create continues after it.
    const reopened = ledger()
    expect(reopened.snapshot().ideas.find(idea => idea.id === richId)?.ideaNumber).toBe(1)
    reopened.applyRequest('after-import', create('idea-new', 'Captured after the import'))
    expect(reopened.snapshot().ideas.at(-1)?.ideaNumber).toBe(sourceSequence + 1)
    reopened.dispose()
  })

  it('carries the fields a naive export would drop', () => {
    freshDir()
    const source = ledger()
    const richId = fullyPopulated(source)
    const exported = readFileSync(source.takeSnapshot('export').snapshot.path, 'utf8')
    const rich = source.snapshot().ideas.find(idea => idea.id === richId)!
    source.dispose()

    dir = join(tmpdir(), `ideas-backup-target-${process.pid}-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const target = ledger()
    target.restore({ document: exported })
    const restored = target.snapshot().ideas.find(idea => idea.id === richId)!

    // The activity log, the run stamps, the card binding, the analysis audit and
    // the delivery note are the fields the spec names; each is asserted here.
    expect(restored.events?.length ?? 0).toBeGreaterThan(0)
    expect(restored.events?.[0]).toMatchObject({ actor: 'human' })
    expect(restored.runStatus).toBe('done')
    expect(restored.runSessionId).toBe('session-abc')
    expect(restored.taskBoardId).toBe('idea-idea-rich')
    expect(restored.taskBoardStatus).toBe('done')
    expect(restored.analysisAudit?.body).toBe('# Analysis\n\nThe whole story.')
    expect(restored.analysisAudit?.tags).toEqual([{ name: 'safety', promptPrefix: 'Read the README first.' }, { name: 'ledger' }])
    expect(restored.deliveryNote).toBe('The last assistant message of the run.')
    expect(restored.tags).toEqual([{ name: 'safety', promptPrefix: 'Read the README first.' }, { name: 'ledger' }])
    expect(restored.status).toBe('archived')
    expect(restored.archivedAt).toBeTypeOf('number')
    // The follow-up chain is a link between two rows, so it is asserted on both.
    const child = target.snapshot().ideas.find(idea => idea.followUpOfId === richId)
    expect(child?.title).toBe('Follow-up')
    expect(target.snapshot().ideas.find(idea => idea.id === child!.id)?.events?.[0]).toMatchObject({ verb: 'create' })
    // A declined idea keeps its decision.
    expect(target.snapshot().ideas.find(idea => idea.id === 'idea-2')?.decision).toBe('Not worth it now')
    target.dispose()
  })

  it('restores a file the user dropped into the folder by name', () => {
    freshDir()
    const store = ledger()
    store.applyRequest('req-1', create('idea-1'))
    mkdirSync(backupDir(), { recursive: true })
    writeFileSync(join(backupDir(), 'board-from-another-machine.json'), JSON.stringify({
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: 12,
      ideaSequence: 3,
      ideas: [{ id: 'foreign-1', title: 'From elsewhere', body: 'b', status: 'open', createdAt: 1, updatedAt: 1 }],
    }))

    const listed = store.snapshots()
    expect(listed.map(file => file.name)).toEqual(['board-from-another-machine.json'])
    expect(listed[0]!.managed).toBe(false)

    const outcome = store.restore({ name: 'board-from-another-machine.json' })
    expect(outcome.ok).toBe(true)
    expect(store.snapshot().ideas.map(idea => idea.id)).toEqual(['foreign-1'])
    store.dispose()
  })
})

describe('single-writer discipline', () => {
  it('a second ledger on the same home refuses to start, snapshots included', () => {
    const home = freshDir()
    const first = ledger()
    first.applyRequest('req-1', create('idea-1'))
    first.takeSnapshot()

    expect(() => new IdeasHostLedger({ dir: home })).toThrow(/already owned by process/)
    first.dispose()
  })
})

describe('host service surface', () => {
  it('reports the folder, the retention and the runs in flight', () => {
    const home = freshDir()
    const service = new IdeasHostService({ dir: home })
    service.apply('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    service.ledger.setRunStatus('idea-1', 'running')

    let view = service.backupsView()
    expect(view.ok).toBe(true)
    expect(view.dir).toBe(join(home, IDEAS_BACKUP_DIR_NAME))
    expect(view.retention).toBe(IDEAS_SNAPSHOT_RETENTION)
    expect(view.snapshots).toEqual([])
    expect(view.running).toBe(1)

    const taken = service.takeSnapshot()
    expect(taken.ok).toBe(true)
    expect(taken.snapshot.name).toMatch(/^snapshot-/)
    expect(taken.snapshot.foreign).toBe(false)

    // The panel never prints this path; the API does, for agents and scripts.
    view = service.backupsView()
    expect(view.snapshots.map(snapshot => snapshot.name)).toEqual([taken.snapshot.name])
    expect(service.snapshotContent(taken.snapshot.name)).toContain('"schemaVersion": 1')
    expect(service.snapshotContent('nope.json')).toBeUndefined()
    service.dispose()
  })

  it('answers a restore refusal with the Host sentence, not an exception', () => {
    freshDir()
    const service = new IdeasHostService({ dir })
    service.apply('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    service.ledger.setRunStatus('idea-1', 'running')
    const taken = service.takeSnapshot()
    service.ledger.setRunStatus('idea-1', 'running')

    const outcome = service.restoreBoard({ name: taken.snapshot.name })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.error).toBe('restore-run-in-flight')
    expect(outcome.message).toContain('still running')
    expect(outcome.running).toEqual([{ id: 'idea-1', ideaNumber: 1, title: 'T' }])
    service.dispose()
  })

  it('refuses every backup operation while the plugin is disabled', () => {
    freshDir()
    const service = new IdeasHostService({ dir })
    service.setActive(false)
    expect(() => service.backupsView()).toThrow('ideas plugin is disabled')
    expect(() => service.takeSnapshot()).toThrow('ideas plugin is disabled')
    expect(() => service.restoreBoard({ name: 'x.json' })).toThrow('ideas plugin is disabled')
    service.setActive(true)
    service.dispose()
  })
})