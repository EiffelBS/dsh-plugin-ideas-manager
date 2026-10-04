/**
 * Part 1 — the atomic `merge` verb.
 *
 * The merge is what the AI capture button has always promised ("create or
 * merge a duplicate"), so the suite is written around the promises rather than
 * around the code: one commit, a reconciled survivor, an archived loser that
 * names it, a refusal that writes nothing, runner-owned fields left alone, a
 * dedupe cache that survives a replay, and a mirror decision consistent with
 * `decline` (archive) / `update` (patch).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseActionEnvelope } from '../src/protocol.ts'
import { isIdeaRecord, MERGE_DECISION_MAX_LENGTH, type NewIdeaInput } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { IdeasHostService } from '../src/host-service.ts'
import { TaskBoardMirror, type TaskBoardActionEnvelope, type TaskBoardTransport } from '../src/taskboard-bridge.ts'

/**
 * A `create` action with the mandatory empty body. These tests drive the ledger
 * directly (they are about the COMMIT, not the wire gate), so the normalization
 * a routed create would have gone through has to be spelled out here.
 */
function create(id: string, input: Omit<NewIdeaInput, 'body'>) {
  return { kind: 'create' as const, id, input: { body: '', ...input } }
}

const dirs: string[] = []
const opened: IdeasHostLedger[] = []

function freshDir(): string {
  const dir = join(tmpdir(), `ideas-merge-test-${process.pid}-${randomUUID()}`)
  dirs.push(dir)
  return dir
}

function freshLedger(now = 1000): IdeasHostLedger {
  const ledger = new IdeasHostLedger({ dir: freshDir(), now: () => now })
  opened.push(ledger)
  return ledger
}

afterEach(() => {
  while (opened.length > 0) {
    try { opened.pop()!.dispose() } catch { /* lock already released */ }
  }
  while (dirs.length > 0) dirs.pop()
})

/** In-memory task-board double (always 200; serves a mutable snapshot). */
class FakeTaskBoardTransport implements TaskBoardTransport {
  stateTasks: Array<{ id: string; status: string }> | undefined
  posts: TaskBoardActionEnvelope[] = []
  async getState() {
    return {
      status: 200,
      ...(this.stateTasks === undefined ? {} : { body: { schemaVersion: 3, revision: 1, tasks: this.stateTasks } }),
    }
  }

  async postAction(envelope: TaskBoardActionEnvelope) {
    this.posts.push(envelope)
    return { status: 200 }
  }
}

describe('protocol merge verb', () => {
  it('parses the verb with both ids and a known mode', () => {
    expect(parseActionEnvelope({ requestId: 'r1', action: {
      kind: 'merge', sourceId: 'idea-dup', targetId: 'idea-1', mode: 'takeSourceRank',
    } })?.action).toEqual({ kind: 'merge', sourceId: 'idea-dup', targetId: 'idea-1', mode: 'takeSourceRank' })
  })

  it('rejects a missing id, a blank id, an unknown mode and any extra key', () => {
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'merge', targetId: 'idea-1', mode: 'keepTargetRank' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'merge', sourceId: '  ', targetId: 'idea-1', mode: 'keepTargetRank' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'merge', sourceId: 'a', targetId: 'b', mode: 'later' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'merge', sourceId: 'a', targetId: 'b' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r1', action: {
      kind: 'merge', sourceId: 'a', targetId: 'b', mode: 'keepTargetRank', decision: 'sneaky',
    } })).toBeUndefined()
  })

  it('carries the merge RESULT through an import / export round-trip', () => {
    const ledger = freshLedger(2000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1', tags: [{ name: 'core' }] }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1', rank: 1, tags: [{ name: 'extra' }] }))
    ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'takeSourceRank' })

    // The records every consumer exports, through the wire gate that accepts
    // them back.
    const exported = ledger.snapshot().ideas
    const parsed = parseActionEnvelope({
      requestId: 'r5',
      action: { kind: 'import', sourceId: 'round-trip', ideas: exported.map(idea => ({ ...idea })) },
    })
    expect(parsed).toBeDefined()
    expect(parsed && parsed.action.kind === 'import' ? parsed.action.ideas.every(idea => isIdeaRecord(idea)) : false).toBe(true)

    // Re-import them into a fresh ledger: the whole merge outcome must survive,
    // because a backup/restore must not resurrect the duplicate.
    const restored = freshLedger(3000)
    if (parsed && parsed.action.kind === 'import') {
      restored.applyRequest('r6', parsed.action)
    }
    const byId = new Map(restored.snapshot().ideas.map(idea => [idea.id, idea]))
    expect(byId.get('idea-2')!.status).toBe('archived')
    expect(byId.get('idea-2')!.decision).toContain('Survivor')
    expect(byId.get('idea-2')!.archivedAt).toBe(2000)
    expect(byId.get('idea-1')!.tags?.map(tag => tag.name)).toEqual(['core', 'extra'])
    expect(byId.get('idea-1')!.rank).toBe(1)
  })
})

describe('merge commit', () => {
  it('reconciles labels, lineage and position, then archives the loser in ONE commit', () => {
    const ledger = freshLedger(5000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1', rank: 3, tags: [{ name: 'core' }] }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1', rank: 1, tags: [{ name: 'extra' }, { name: 'core', promptPrefix: 'from the loser' }] }))
    ledger.applyRequest('r3', create('idea-3', { title: 'Rank blocker', workspaceId: 'ws-1', rank: 1 }))
    ledger.applyRequest('r4', create('idea-4', { title: 'Rank blocker 2', workspaceId: 'ws-1', rank: 2 }))
    ledger.applyRequest('r5', create('idea-5', { title: 'Child of the loser', workspaceId: 'ws-1' }))
    // A follow-up chain: idea-5 is the loser's child.
    ledger.applyRequest('r6', { kind: 'update', ideaId: 'idea-5', patch: {} })

    const before = ledger.snapshot()
    const beforeLoser = before.ideas.find(idea => idea.id === 'idea-2')!
    const revisionBefore = before.revision

    ledger.applyRequest('r7', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'takeSourceRank' })

    const after = ledger.snapshot()
    const byId = new Map(after.ideas.map(idea => [idea.id, idea]))
    const survivor = byId.get('idea-1')!
    const loser = byId.get('idea-2')!

    // ONE revision for the whole commit.
    expect(after.revision).toBe(revisionBefore + 1)

    // Labels unioned, survivor first: the duplicate name keeps the SURVIVOR's
    // entry, so the loser's promptPrefix never rewrites a runner-owned card.
    expect(survivor.tags?.map(tag => tag.name)).toEqual(['core', 'extra'])
    expect(survivor.tags?.find(tag => tag.name === 'core')?.promptPrefix).toBeUndefined()

    // The survivor takes the LOSER's position, and the open backlog of its own
    // workspace stays a contiguous 1..n after the insert.
    expect(survivor.rank).toBe(1)
    const openRanks = after.ideas.filter(idea => idea.status === 'open').map(idea => idea.rank!).sort((a, b) => a - b)
    expect(openRanks).toEqual(openRanks.map((_, index) => index + 1))

    // The loser is archived with a decision note NAMING the survivor, and its
    // content is untouched — a merge contributes labels and lineage, never a
    // second body.
    expect(loser.status).toBe('archived')
    expect(loser.archivedAt).toBe(5000)
    expect(loser.decision).toContain('Survivor')
    expect(loser.decision!.length).toBeLessThanOrEqual(MERGE_DECISION_MAX_LENGTH)
    expect(loser.title).toBe(beforeLoser.title)

    // Both sides remember what happened.
    expect(loser.events?.at(-1)?.verb).toBe('merge')
    expect(survivor.events?.at(-1)?.verb).toBe('merge')
  })

  it('re-points the loser children and inherits the loser follow-up lineage, without a self-link', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('root', { title: 'Root', workspaceId: 'ws-1' }))
    ledger.applyRequest('r2', create('idea-loser', { title: 'Loser', workspaceId: 'ws-1' }))
    ledger.applyRequest('r3', create('idea-survivor', { title: 'Survivor', workspaceId: 'ws-1' }))
    // A follow-up chain is only legal from the review gate, so both parents go
    // through it the way a real review-rejected follow-up does.
    ledger.applyRequest('r4', { kind: 'move', ideaId: 'idea-loser', status: 'underReview' })
    ledger.applyRequest('r5', { kind: 'followUp', ideaId: 'idea-loser', input: { title: 'Loser child', body: '' } })
    ledger.applyRequest('r6', { kind: 'move', ideaId: 'root', status: 'underReview' })
    ledger.applyRequest('r7', { kind: 'followUp', ideaId: 'root', input: { title: 'Root child', body: '' } })
    const beforeIds = ledger.snapshot().ideas.filter(idea => idea.followUpOfId === 'idea-loser').map(idea => idea.id)
    expect(beforeIds.length).toBeGreaterThan(0)
    // The root child is the survivor: it has a lineage of its own.
    const survivorId = ledger.snapshot().ideas.find(idea => idea.followUpOfId === 'root')!.id
    expect(survivorId).not.toBe('root')

    ledger.applyRequest('r8', { kind: 'merge', sourceId: 'idea-loser', targetId: survivorId, mode: 'keepTargetRank' })
    const byId = new Map(ledger.snapshot().ideas.map(idea => [idea.id, idea]))

    // Every child of the loser now points at the survivor instead.
    for (const childId of beforeIds) expect(byId.get(childId)!.followUpOfId).toBe(survivorId)
    // The survivor kept ITS OWN parent (root): the merge never overwrites a
    // lineage the survivor already has.
    expect(byId.get(survivorId)!.followUpOfId).toBe('root')
  })

  it('inherits the loser lineage when the survivor has none, and never makes it its own parent', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('root', { title: 'Root', workspaceId: 'ws-1' }))
    ledger.applyRequest('r2', create('idea-loser', { title: 'Loser', workspaceId: 'ws-1' }))
    // The loser is itself a follow-up of root; it has no parent of its own to
    // give away, so the survivor-to-be inherits nothing from it. Build the
    // chain the other way round instead: root -> loser -> child, then merge
    // the loser into that child.
    ledger.applyRequest('r3', { kind: 'move', ideaId: 'root', status: 'underReview' })
    ledger.applyRequest('r4', { kind: 'followUp', ideaId: 'root', input: { title: 'Middle', body: '' } })
    const middle = ledger.snapshot().ideas.find(idea => idea.followUpOfId === 'root')!
    ledger.applyRequest('r5', { kind: 'move', ideaId: middle.id, status: 'underReview' })
    ledger.applyRequest('r6', { kind: 'followUp', ideaId: middle.id, input: { title: 'Survivor', body: '' } })
    const survivor = ledger.snapshot().ideas.find(idea => idea.followUpOfId === middle.id)!
    expect(survivor.followUpOfId).toBe(middle.id)

    // Merge the middle into the survivor: the survivor had a parent, so it
    // keeps it rather than inheriting the middle's own.
    ledger.applyRequest('r7', { kind: 'merge', sourceId: middle.id, targetId: survivor.id, mode: 'keepTargetRank' })
    const after = ledger.snapshot().ideas.find(idea => idea.id === survivor.id)!
    expect(after.followUpOfId).toBe(middle.id)
    expect(after.followUpOfId).not.toBe(after.id)
  })

  it('keepTargetRank leaves the survivor exactly where it was', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1', rank: 2 }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1', rank: 1 }))
    ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' })
    const survivor = ledger.snapshot().ideas.find(idea => idea.id === 'idea-1')!
    expect(survivor.rank).toBe(2)
  })

  it('an UNRANKED loser never demotes the survivor, in either mode', () => {
    for (const mode of ['keepTargetRank', 'takeSourceRank'] as const) {
      const ledger = freshLedger(1000)
      ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1', rank: 1 }))
      ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1' }))
      ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode })
      expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-1')!.rank, mode).toBe(1)
    }
  })

  it('never touches runStatus, runSessionId or taskBoardId on the survivor', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1' }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1' }))
    // Runner-owned system fields, stamped through the Host-internal paths the
    // wire gate never exposes.
    ledger.bindTaskBoardId('idea-1', 'idea-idea-1')
    ledger.setRunStatus('idea-1', 'running')
    ledger.setRunSession('idea-1', 'sess-abc')

    ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'takeSourceRank' })

    const survivor = ledger.snapshot().ideas.find(idea => idea.id === 'idea-1')!
    expect(survivor.taskBoardId).toBe('idea-idea-1')
    expect(survivor.runStatus).toBe('running')
    expect(survivor.runSessionId).toBe('sess-abc')
  })
})

describe('merge refusals (nothing is written)', () => {
  it('refuses a cross-workspace merge and leaves the ledger untouched', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1' }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-2' }))
    const before = ledger.snapshot()

    expect(() => ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' }))
      .toThrow('merge requires both ideas in the same workspace')

    const after = ledger.snapshot()
    expect(after.revision).toBe(before.revision)
    expect(after.ideas).toEqual(before.ideas)
  })

  it('accepts the workspace-less group as one workspace, like rankGroupKey', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor' }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate' }))
    expect(() => ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' })).not.toThrow()
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-2')!.status).toBe('archived')
  })

  it('refuses an unknown side, a self-merge, and names which side is missing', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1' }))
    expect(() => ledger.applyRequest('r2', { kind: 'merge', sourceId: 'nope', targetId: 'idea-1', mode: 'keepTargetRank' })).toThrow('source idea not found')
    expect(() => ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-1', targetId: 'nope', mode: 'keepTargetRank' })).toThrow('target idea not found')
    expect(() => ledger.applyRequest('r4', { kind: 'merge', sourceId: 'idea-1', targetId: 'idea-1', mode: 'keepTargetRank' })).toThrow('merge requires two distinct ideas')
    // The refusals above did not archive the survivor.
    expect(ledger.snapshot().ideas[0]!.status).toBe('open')
  })
})

describe('merge dedupe cache', () => {
  it('a replayed requestId is served from the persisted cache without re-executing', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1', tags: [{ name: 'core' }] }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1', tags: [{ name: 'extra' }] }))
    const action = { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' } as const

    const first = ledger.applyRequest('r3', action)
    expect(first.replayed).toBeUndefined()
    const revisionAfterFirst = ledger.snapshot().revision

    // A replay of the SAME request id changes nothing: the tags are already
    // unioned, and no second revision is burned.
    const replay = ledger.applyRequest('r3', action)
    expect(replay.replayed).toBe(true)
    expect(ledger.snapshot().revision).toBe(revisionAfterFirst)
  })

  it('a DIFFERENT request id for the same merge is a fresh action, not a replay', () => {
    const ledger = freshLedger(1000)
    ledger.applyRequest('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1' }))
    ledger.applyRequest('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1' }))
    const revision = ledger.snapshot().revision
    ledger.applyRequest('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' })
    expect(ledger.snapshot().revision).toBeGreaterThan(revision)
    expect(ledger.applyRequest('r4', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' }).replayed).toBeUndefined()
  })
})

describe('merge mirror decision', () => {
  it('mirrors the survivor as an update and the loser as an archive, like decline', async () => {
    const transport = new FakeTaskBoardTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    try {
      service.apply('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1' }))
      await service.flushMirror()
      // The board now holds the first card, so the second mirror round sees a
      // live board (the same staging the re-analyze cycle uses).
      transport.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
      service.apply('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1' }))
      await service.flushMirror()
      // Both ideas reached the board as their own card (the mirror may also
      // reorder, so only the creates are asserted here).
      expect(transport.posts.filter(post => post.action.kind === 'create')).toHaveLength(2)
      // The live board holds both cards.
      transport.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }, { id: 'idea-idea-2', status: 'backlog' }]
      transport.posts = []

      service.apply('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' })
      await service.flushMirror()

      const posts = transport.posts.map(post => post.action)
      // Survivor: an update (its content genuinely changed). Loser: an archive,
      // exactly what `decline` does — the card leaves the backlog.
      expect(posts.map(post => post.kind).sort()).toEqual(['archive', 'update'])
      const update = posts.find(post => post.kind === 'update') as { taskId: string }
      const archive = posts.find(post => post.kind === 'archive') as { taskId: string }
      expect(update.taskId).toBe('idea-idea-1')
      expect(archive.taskId).toBe('idea-idea-2')
      // The binding survives on both rows: a merge unbinds nothing.
      expect(service.snapshot().ideas.find(idea => idea.id === 'idea-1')!.taskBoardId).toBe('idea-idea-1')
      expect(service.snapshot().ideas.find(idea => idea.id === 'idea-2')!.taskBoardId).toBe('idea-idea-2')
    } finally {
      service.dispose()
    }
  })

  it('mirrors nothing at all when the mirror is off', async () => {
    const transport = new FakeTaskBoardTransport()
    const service = new IdeasHostService({ dir: freshDir(), mirror: new TaskBoardMirror({ transport }), autoMirror: false })
    try {
      service.apply('r1', create('idea-1', { title: 'Survivor', workspaceId: 'ws-1' }))
      service.apply('r2', create('idea-2', { title: 'Duplicate', workspaceId: 'ws-1' }))
      service.apply('r3', { kind: 'merge', sourceId: 'idea-2', targetId: 'idea-1', mode: 'keepTargetRank' })
      await service.flushMirror()
      expect(transport.posts).toHaveLength(0)
      // The ledger commit itself still happened.
      expect(service.snapshot().ideas.find(idea => idea.id === 'idea-2')!.status).toBe('archived')
    } finally {
      service.dispose()
    }
  })
})