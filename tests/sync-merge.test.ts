/** Table-driven contract for the deterministic three-way synchronization planner. */

import { describe, expect, it } from 'vitest'
import type { IdeaRecord } from '../src/core/ideas.ts'
import { planIdeasSyncMerge } from '../src/sync-merge.ts'
import type {
  IdeasSyncConflictResolution,
  IdeasSyncIdea,
  IdeasSyncPackage,
} from '../src/sync.ts'

function idea(id: string, patch: Partial<IdeasSyncIdea> = {}): IdeasSyncIdea {
  return {
    id,
    title: `Title ${id}`,
    body: `Body ${id}`,
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function localRecord(id: string, patch: Partial<IdeasSyncIdea> = {}, local: Partial<IdeaRecord> = {}): IdeaRecord {
  return { ...idea(id, patch), workspaceId: 'workspace-local', ...local }
}

function pkg(ideas: readonly IdeasSyncIdea[], baseSnapshotId: string | null = 'snapshot-base'): IdeasSyncPackage {
  return {
    format: 'dsh-ideas-sync',
    version: 1,
    deviceId: 'device-remote',
    snapshotId: 'snapshot-remote',
    baseSnapshotId,
    createdAt: 2,
    workspace: { syncKey: 'sync_12345678', sourceWorkspaceId: 'workspace-remote' },
    ideas: JSON.parse(JSON.stringify(ideas)) as IdeasSyncIdea[],
  }
}

function plan(options: {
  base?: readonly IdeasSyncIdea[]
  local: readonly IdeaRecord[]
  incoming: readonly IdeasSyncIdea[]
  baseSnapshotId?: string | null
  resolutions?: readonly IdeasSyncConflictResolution[]
}) {
  return planIdeasSyncMerge({
    localIdeas: options.local,
    workspaceId: 'workspace-local',
    incoming: pkg(options.incoming, options.baseSnapshotId === undefined ? 'snapshot-base' : options.baseSnapshotId),
    ...(options.base === undefined ? {} : { ancestorIdeas: options.base }),
    resolutions: options.resolutions,
  })
}

function operation(result: ReturnType<typeof plan>, id: string) {
  const found = result.operations.find(item => item.ideaId === id)
  if (found === undefined) throw new Error(`missing operation for ${id}`)
  return found
}

describe('three-way presence and scalar fields', () => {
  it('plans a one-sided remote creation', () => {
    const result = plan({ base: [], local: [], incoming: [idea('new', { rank: 1 })] })
    expect(result.ready).toBe(true)
    expect(operation(result, 'new').action).toBe('create')
    expect(result.ideas.map(item => item.id)).toEqual(['new'])
    expect(result.ideas[0]?.rank).toBeUndefined()
  })

  it('accepts a one-sided remote edit', () => {
    const base = idea('a')
    const result = plan({
      base: [base],
      local: [localRecord('a')],
      incoming: [idea('a', { body: 'Remote edit', updatedAt: 2 })],
    })
    expect(result.ready).toBe(true)
    expect(operation(result, 'a')).toMatchObject({ action: 'update', changedFields: ['body', 'updatedAt'] })
    expect(result.ideas[0]?.body).toBe('Remote edit')
  })

  it('merges disjoint edits without treating updatedAt as a content winner', () => {
    const base = idea('a')
    const result = plan({
      base: [base],
      local: [localRecord('a', { title: 'Local title', updatedAt: 50 })],
      incoming: [idea('a', { body: 'Remote body', updatedAt: 2 })],
    })
    expect(result.ready).toBe(true)
    expect(result.conflicts).toEqual([])
    expect(result.ideas[0]).toMatchObject({ title: 'Local title', body: 'Remote body', updatedAt: 50 })
  })

  it('emits an explicit same-field conflict and accepts either decision', () => {
    const base = idea('a')
    const input = {
      base: [base],
      local: [localRecord('a', { title: 'Local title' })],
      incoming: [idea('a', { title: 'Remote title' })],
    }
    const unresolved = plan(input)
    expect(unresolved.ready).toBe(false)
    expect(operation(unresolved, 'a').action).toBe('conflict')
    expect(unresolved.conflicts).toHaveLength(1)
    expect(unresolved.conflicts[0]).toMatchObject({ kind: 'same-field', ideaId: 'a', field: 'title' })

    const local = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'local' }] })
    expect(local.ready).toBe(true)
    expect(local.ideas[0]?.title).toBe('Local title')
    const remote = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'remote' }] })
    expect(remote.ready).toBe(true)
    expect(remote.ideas[0]?.title).toBe('Remote title')
  })

  it('plans delete/delete as an explicit deletion', () => {
    const result = plan({ base: [idea('a')], local: [], incoming: [] })
    expect(result.ready).toBe(true)
    expect(operation(result, 'a').action).toBe('delete')
    expect(result.ideas).toEqual([])
  })

  it.each(['local', 'remote'] as const)('treats delete/edit as a conflict in %s deletion direction', side => {
    const base = idea('a')
    const changed = idea('a', { body: 'Changed after the ancestor' })
    const input = side === 'local'
      ? { base: [base], local: [localRecord('a', { body: 'Changed after the ancestor' })], incoming: [] as IdeasSyncIdea[] }
      : { base: [base], local: [] as IdeaRecord[], incoming: [changed] }
    const unresolved = plan(input)
    expect(unresolved.ready).toBe(false)
    expect(unresolved.conflicts[0]).toMatchObject({ kind: 'delete-edit', ideaId: 'a' })
    const keepLocal = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'local' }] })
    expect(keepLocal.ready).toBe(true)
    expect(keepLocal.ideas).toEqual(side === 'local' ? [expect.objectContaining({ id: 'a' })] : [])
    const keepRemote = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'remote' }] })
    expect(keepRemote.ready).toBe(true)
    expect(keepRemote.ideas).toEqual(side === 'remote' ? [expect.objectContaining({ id: 'a' })] : [])
  })

  it('does not accept a decision for a deletion that was not a conflict', () => {
    const base = idea('a')
    const result = plan({
      base: [base],
      local: [localRecord('a')],
      incoming: [],
      resolutions: [{ conflictId: 'a\u0000existence\u0000delete-edit', choice: 'local' }],
    })
    expect(result.ready).toBe(false)
    expect(result.invalidResolutions).toEqual(['a\u0000existence\u0000delete-edit'])
  })

  it('uses conservative two-way mode when the ancestor is unavailable and never infers deletion', () => {
    const result = plan({
      local: [localRecord('local-only')],
      incoming: [],
      baseSnapshotId: 'snapshot-evicted',
    })
    expect(result.mode).toBe('two-way')
    expect(result.ancestorSnapshotId).toBeNull()
    expect(result.ready).toBe(true)
    expect(operation(result, 'local-only').action).toBe('unchanged')
    expect(result.ideas.map(item => item.id)).toEqual(['local-only'])
  })

  it('makes every differing common field explicit in two-way mode', () => {
    const result = plan({
      local: [localRecord('a', { body: 'Local' })],
      incoming: [idea('a', { body: 'Remote' })],
      baseSnapshotId: null,
    })
    expect(result.mode).toBe('two-way')
    expect(result.ready).toBe(false)
    expect(result.conflicts[0]).toMatchObject({ kind: 'two-way-difference', field: 'body' })
  })

  it('ignores destination execution pointers and display identity', () => {
    const base = idea('a')
    const result = plan({
      base: [base],
      local: [localRecord('a', {}, {
        ideaNumber: 99,
        runStatus: 'running',
        runSessionId: 'session-local',
        taskBoardId: 'card-local',
        taskBoardStatus: 'running',
      })],
      incoming: [idea('a')],
    })
    expect(result.ready).toBe(true)
    expect(operation(result, 'a').action).toBe('unchanged')
    expect(result.ideas[0]).not.toHaveProperty('runStatus')
    expect(result.ideas[0]).not.toHaveProperty('ideaNumber')
  })
})

describe('tags, duplicates, and order', () => {
  it('unions additive tags and preserves each promptPrefix', () => {
    const base = idea('a', { tags: [{ name: 'base' }] })
    const result = plan({
      base: [base],
      local: [localRecord('a', { tags: [{ name: 'base' }, { name: 'local', promptPrefix: 'Local prompt' }] })],
      incoming: [idea('a', { tags: [{ name: 'base' }, { name: 'remote', promptPrefix: 'Remote prompt' }] })],
    })
    expect(result.ready).toBe(true)
    expect(result.ideas[0]?.tags).toEqual([
      { name: 'base' },
      { name: 'local', promptPrefix: 'Local prompt' },
      { name: 'remote', promptPrefix: 'Remote prompt' },
    ])
  })

  it('requires a decision for conflicting promptPrefix definitions', () => {
    const base = idea('a', { tags: [{ name: 'ai', promptPrefix: 'Original prompt' }] })
    const input = {
      base: [base],
      local: [localRecord('a', { tags: [{ name: 'ai', promptPrefix: 'Local prompt' }] })],
      incoming: [idea('a', { tags: [{ name: 'ai', promptPrefix: 'Remote prompt' }] })],
    }
    const unresolved = plan(input)
    expect(unresolved.ready).toBe(false)
    expect(unresolved.conflicts[0]).toMatchObject({ kind: 'tag-definition', tagName: 'ai' })
    const remote = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'remote' }] })
    expect(remote.ready).toBe(true)
    expect(remote.ideas[0]?.tags).toEqual([{ name: 'ai', promptPrefix: 'Remote prompt' }])
    const cleared = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'clear' }] })
    expect(cleared.ready).toBe(true)
    expect(cleared.ideas[0]?.tags).toBeUndefined()
  })

  it('requires an explicit decision when the additive tag union exceeds the persisted limit', () => {
    const localTags = Array.from({ length: 8 }, (_, index) => ({ name: `local-${index}` }))
    const incomingTags = Array.from({ length: 8 }, (_, index) => ({ name: `remote-${index}` }))
    const input = {
      base: [] as IdeasSyncIdea[],
      local: [localRecord('a', { tags: localTags })],
      incoming: [idea('a', { tags: incomingTags })],
    }
    const unresolved = plan(input)
    expect(unresolved.ready).toBe(false)
    expect(unresolved.conflicts[0]).toMatchObject({ kind: 'tag-limit', field: 'tags' })
    const local = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'local' }] })
    expect(local.ready).toBe(true)
    expect(local.ideas[0]?.tags).toEqual(localTags)
  })

  it('detects independently created near-duplicates and only proposes the existing merge', () => {
    const result = plan({
      base: [],
      local: [localRecord('local-copy', { title: 'Ship the synchronization planner' })],
      incoming: [idea('remote-copy', { title: 'Ship the synchronization planner' })],
    })
    expect(result.ready).toBe(true)
    expect(result.operations.map(item => item.action)).toEqual(['unchanged', 'create'])
    expect(result.duplicateCandidates).toEqual([expect.objectContaining({
      localId: 'local-copy',
      incomingId: 'remote-copy',
      proposedMerge: { kind: 'merge', sourceId: 'remote-copy', targetId: 'local-copy', mode: 'keepTargetRank' },
    })])
    expect(result.ideas).toHaveLength(2)
  })

  it('preserves destination order unless the remote reorder is unambiguous', () => {
    const base = [idea('a', { rank: 1 }), idea('b', { rank: 2 }), idea('c', { rank: 3 })]
    const result = plan({
      base,
      local: base.map(item => localRecord(item.id, item)),
      incoming: [idea('c', { rank: 1 }), idea('b', { rank: 2 }), idea('a', { rank: 3 })],
    })
    expect(result.ready).toBe(true)
    expect(result.reorder).toEqual({ status: 'open', orderedIds: ['c', 'b', 'a'] })
    expect(result.ideas.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(result.ideas.map(item => item.rank)).toEqual([1, 2, 3])
  })

  it('keeps destination-only anchors in place while applying a remote reorder', () => {
    const base = [idea('a', { rank: 1 }), idea('b', { rank: 2 }), idea('c', { rank: 3 })]
    const result = plan({
      base,
      local: [
        localRecord('a', { rank: 1 }),
        localRecord('local-anchor', { rank: 2 }),
        localRecord('b', { rank: 3 }),
        localRecord('c', { rank: 4 }),
      ],
      incoming: [idea('c', { rank: 1 }), idea('b', { rank: 2 }), idea('a', { rank: 3 })],
    })
    expect(result.reorder?.orderedIds).toEqual(['c', 'local-anchor', 'b', 'a'])
  })

  it('emits an order conflict for divergent reorders and accepts an explicit side', () => {
    const base = [idea('a', { rank: 1 }), idea('b', { rank: 2 }), idea('c', { rank: 3 })]
    const input = {
      base,
      local: [localRecord('b', { rank: 1 }), localRecord('a', { rank: 2 }), localRecord('c', { rank: 3 })],
      incoming: [idea('c', { rank: 1 }), idea('b', { rank: 2 }), idea('a', { rank: 3 })],
    }
    const unresolved = plan(input)
    expect(unresolved.ready).toBe(false)
    expect(unresolved.conflicts[0]).toMatchObject({ kind: 'order', field: 'rank' })
    const remote = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'remote' }] })
    expect(remote.ready).toBe(true)
    expect(remote.reorder?.orderedIds).toEqual(['c', 'b', 'a'])
    const local = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'local' }] })
    expect(local.ready).toBe(true)
    expect(local.reorder).toBeNull()
  })
})

describe('relations and reference validity', () => {
  it('accepts one-sided relation changes and re-imposes symmetry', () => {
    const base = [idea('a'), idea('b')]
    const result = plan({
      base,
      local: base.map(item => localRecord(item.id, item)),
      incoming: [idea('a', { relatesTo: ['b'] }), idea('b')],
    })
    expect(result.ready).toBe(true)
    expect(result.ideas.find(item => item.id === 'a')?.relatesTo).toEqual(['b'])
    expect(result.ideas.find(item => item.id === 'b')?.relatesTo).toEqual(['a'])
  })

  it('includes cross-workspace reverse relation repairs in the per-idea plan', () => {
    const base = [idea('a')]
    const external = { ...idea('external'), workspaceId: 'workspace-other' }
    const result = plan({
      base,
      local: [localRecord('a'), external],
      incoming: [idea('a', { relatesTo: ['external'] })],
    })
    expect(result.ready).toBe(true)
    expect(operation(result, 'external').action).toBe('update')
    expect(result.ideas.find(item => item.id === 'external')?.relatesTo).toEqual(['a'])
  })

  it('refuses a symmetry repair that would exceed the relation limit', () => {
    const peers = Array.from({ length: 20 }, (_, index) => `peer-${String(index).padStart(2, '0')}`)
    const base = [
      idea('a'),
      idea('hub', { relatesTo: peers }),
      ...peers.map(id => idea(id, { relatesTo: ['hub'] })),
    ]
    const incoming = [
      idea('a', { relatesTo: ['hub'] }),
      idea('hub', { relatesTo: peers }),
      ...peers.map(id => idea(id, { relatesTo: ['hub'] })),
    ]
    const result = plan({ base, local: base.map(item => localRecord(item.id, item)), incoming })
    expect(result.ready).toBe(false)
    expect(result.conflicts[0]).toMatchObject({ kind: 'relation-limit', ideaId: 'a', field: 'relatesTo' })
  })

  it('refuses a dependency cycle introduced by combining two individually valid sides', () => {
    const base = [idea('a'), idea('b')]
    const input = {
      base,
      local: [localRecord('a', { blocks: ['b'] }), localRecord('b')],
      incoming: [idea('a'), idea('b', { blocks: ['a'] })],
    }
    const unresolved = plan(input)
    expect(unresolved.ready).toBe(false)
    expect(unresolved.conflicts[0]).toMatchObject({ kind: 'dependency-cycle', field: 'blocks' })
    const cleared = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'clear' }] })
    expect(cleared.ready).toBe(true)
    expect(cleared.ideas.flatMap(item => item.blocks ?? [])).toHaveLength(1)
  })

  it('refuses a dangling follow-up created by deleting its parent, with explicit clear as the resolution', () => {
    const parent = idea('parent', { status: 'archived' })
    const child = idea('child', { followUpOfId: 'parent' })
    const input = {
      base: [parent, child],
      local: [localRecord('parent', parent), localRecord('child', child)],
      incoming: [child],
    }
    const unresolved = plan(input)
    expect(unresolved.ready).toBe(false)
    expect(unresolved.conflicts[0]).toMatchObject({ kind: 'reference-missing', ideaId: 'child', field: 'followUpOfId' })
    const cleared = plan({ ...input, resolutions: [{ conflictId: unresolved.conflicts[0]!.conflictId, choice: 'clear' }] })
    expect(cleared.ready).toBe(true)
    expect(cleared.ideas.find(item => item.id === 'child')?.followUpOfId).toBeUndefined()
  })

  it('detects a follow-up cycle instead of silently dropping lineage', () => {
    const base = [idea('a'), idea('b')]
    const result = plan({
      base,
      local: [localRecord('a', { followUpOfId: 'b' }), localRecord('b')],
      incoming: [idea('a'), idea('b', { followUpOfId: 'a' })],
    })
    expect(result.ready).toBe(false)
    expect(result.conflicts[0]).toMatchObject({ kind: 'follow-up-cycle', field: 'followUpOfId' })
  })
})

describe('planner purity and resolution validation', () => {
  it('is deterministic and does not mutate its inputs', () => {
    const input = {
      base: [idea('a')],
      local: [localRecord('a', { title: 'Local' })],
      incoming: [idea('a', { body: 'Remote' })],
    }
    const before = JSON.stringify(input)
    const first = plan(input)
    const second = plan(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(second).toEqual(first)
  })

  it('rejects unknown decisions and clearing a required field', () => {
    const base = idea('a')
    const input = {
      base: [base],
      local: [localRecord('a', { title: 'Local' })],
      incoming: [idea('a', { title: 'Remote' })],
    }
    const unknown = plan({ ...input, resolutions: [{ conflictId: 'not-a-conflict', choice: 'local' }] })
    expect(unknown.ready).toBe(false)
    expect(unknown.invalidResolutions).toEqual(['not-a-conflict'])
    const conflict = unknown.conflicts[0]!
    const invalidClear = plan({ ...input, resolutions: [{ conflictId: conflict.conflictId, choice: 'clear' }] })
    expect(invalidClear.ready).toBe(false)
    expect(invalidClear.conflicts[0]?.resolutionError).toContain('required')
  })
})
