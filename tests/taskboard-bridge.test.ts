/**
 * P2 TaskBoard bridge tests: availability feature-detect with backoff, the
 * create->backlog / update / decline->archive / restore mirror mappings, the
 * loopback self-request transport against a real node:http server, the idea
 * #35 duplicate guard (empty/unknown snapshot keeps the binding, deterministic
 * card id, get-before-create adoption, per-idea serialization), and the
 * host-service integration (bind taskBoardId, replay never re-mirrors, a
 * failed mirror never rolls the idea back).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdea } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { IdeasHostService } from '../src/host-service.ts'
import {
  HttpTaskBoardTransport,
  TaskBoardMirror,
  deriveSummary,
  type TaskBoardActionEnvelope,
  type TaskBoardTransport,
} from '../src/taskboard-bridge.ts'

let dir: string

function freshDir(): string {
  dir = join(tmpdir(), `ideas-bridge-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

class FakeTransport implements TaskBoardTransport {
  stateStatus = 200
  actionStatus = 200
  getStateCalls = 0
  posts: TaskBoardActionEnvelope[] = []
  /** Optional task rows served by getState (the under-review poll's input). */
  stateTasks: Array<{ id: string; status: string }> | undefined
  async getState() {
    this.getStateCalls += 1
    return {
      status: this.stateStatus,
      ...(this.stateTasks === undefined ? {} : { body: { schemaVersion: 3, revision: 1, tasks: this.stateTasks } }),
    }
  }
  async postAction(envelope: TaskBoardActionEnvelope) {
    this.posts.push(envelope)
    return { status: this.actionStatus }
  }
}

const T0 = Date.parse('2026-09-16T08:00:00.000Z')

function idea(overrides: Record<string, unknown> = {}): ReturnType<typeof createIdea> {
  return {
    ...createIdea({
      title: 'Port YuE2 score',
      body: 'Render the ABC score on the board.',
      workspaceId: 'ot',
      tags: [{ name: 'work', promptPrefix: 'Render music scores.' }, { name: 'ui' }],
    }, T0, 'idea-1'),
    ...overrides,
  }
}

describe('TaskBoardMirror availability', () => {
  it('probes once and caches a positive detection', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    expect(await mirror.availableNow()).toBe(true)
    expect(await mirror.availableNow()).toBe(true)
    expect(transport.getStateCalls).toBe(1)
  })

  it('backs off re-probing after a negative result', async () => {
    const transport = new FakeTransport()
    let now = T0
    const mirror = new TaskBoardMirror({ transport, now: () => now })
    transport.stateStatus = 404
    expect(await mirror.availableNow()).toBe(false)
    expect(transport.getStateCalls).toBe(1)
    expect(await mirror.availableNow()).toBe(false)
    expect(transport.getStateCalls).toBe(1)
    now += 31_000
    transport.stateStatus = 200
    expect(await mirror.availableNow()).toBe(true)
    expect(transport.getStateCalls).toBe(2)
  })
})

describe('TaskBoardMirror mappings', () => {
  it('mirrorCreate posts create (read-only, backlog) then move to backlog', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const taskId = await mirror.mirrorCreate(idea())
    expect(transport.posts).toHaveLength(2)
    const [create, move] = transport.posts
    expect(create?.action.kind).toBe('create')
    const input = (create!.action as { input: { title: string; description: string; permission: string; workspaceId: string; prompt: string; tags: { name: string }[] } }).input
    expect(input.title).toBe('Port YuE2 score')
    expect(input.description).toBe('Render the ABC score on the board.')
    expect(input.permission).toBe('read-only')
    expect(input.workspaceId).toBe('ot')
    expect(input.prompt).toBe('Render music scores.')
    expect(input.tags?.map(tag => tag.name)).toEqual(['work', 'ui'])
    expect(move?.action).toEqual({ kind: 'move', taskId, status: 'backlog' })
  })

  it('joins only the non-blank tag prompt lines into the task prompt', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    await mirror.mirrorCreate(idea({ tags: [{ name: 'a' }, { name: 'b', promptPrefix: '  Alpha.  ' }, { name: 'c' }] }))
    const input = (transport.posts[0]!.action as { input: { prompt: string } }).input
    expect(input.prompt).toBe('Alpha.')
  })

  it('never ships an empty prompt: bare tags fall back to a mission derived from the card', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    await mirror.mirrorCreate(idea({ tags: [{ name: 'ideas-manager' }, { name: 'ai-capture' }], ideaNumber: 30 }))
    const input = (transport.posts[0]!.action as { input: { prompt: string } }).input
    expect(input.prompt).toContain('You are implementing the idea below #30')
    expect(input.prompt).toContain('"Port YuE2 score"')
    expect(input.prompt).toContain('Render the ABC score on the board.')
  })

  it('falls back to the derived mission when the idea has no tags at all', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    await mirror.mirrorCreate(idea({ tags: undefined, ideaNumber: undefined }))
    const input = (transport.posts[0]!.action as { input: { prompt: string } }).input
    expect(input.prompt).toContain('You are implementing the idea below — "Port YuE2 score"')
    expect(input.prompt).toContain('Render the ABC score on the board.')
  })

  it('recreates the card when the bound taskBoardId points at a deleted card', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [{ id: 'other-card', status: 'backlog' }]
    const mirror = new TaskBoardMirror({ transport })
    const bound = await mirror.mirrorUpdate(idea({ taskBoardId: 'ghost-card' }))
    expect(bound).not.toBe('ghost-card')
    expect(bound).toMatch(/^idea-/)
    const kinds = transport.posts.map(p => p.action.kind)
    expect(kinds).toEqual(['create', 'move', 'update'])
  })

  it('trusts the bound taskBoardId while the card still exists (no duplicate create)', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [{ id: 'live-card', status: 'backlog' }]
    const mirror = new TaskBoardMirror({ transport })
    const bound = await mirror.mirrorUpdate(idea({ taskBoardId: 'live-card' }))
    expect(bound).toBe('live-card')
    const kinds = transport.posts.map(p => p.action.kind)
    expect(kinds).toEqual(['update'])
  })

  it('mirrorUpdate self-heals an unbound idea (create + move) then updates', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const taskId = await mirror.mirrorUpdate(idea())
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move', 'update'])
    const update = transport.posts[2]!.action as { kind: 'update'; taskId: string; patch: { title: string } }
    expect(update.taskId).toBe(taskId)
    expect(update.patch.title).toBe('Port YuE2 score')
  })

  it('mirrorUpdate on a bound idea only posts the update', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const taskId = await mirror.mirrorUpdate(idea({ taskBoardId: 'task-9' }))
    expect(taskId).toBe('task-9')
    expect(transport.posts.map(post => post.action.kind)).toEqual(['update'])
  })

  it('mirrorArchive posts archive for the bound task', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const taskId = await mirror.mirrorArchive(idea({ taskBoardId: 'task-9' }))
    expect(taskId).toBe('task-9')
    expect(transport.posts[0]?.action).toEqual({ kind: 'archive', taskId: 'task-9' })
  })

  it('mirrorRestore posts restore when bound and is a no-op when unbound', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    await mirror.mirrorRestore(idea({ taskBoardId: 'task-9' }))
    expect(transport.posts.map(post => post.action.kind)).toEqual(['restore'])
    await mirror.mirrorRestore(idea({}))
    expect(transport.posts).toHaveLength(1)
  })

  it('throws on a non-2xx action response', async () => {
    const transport = new FakeTransport()
    transport.actionStatus = 400
    const mirror = new TaskBoardMirror({ transport })
    await expect(mirror.mirrorCreate(idea())).rejects.toThrow(/task-board create -> 400/)
  })
})

describe('TaskBoardMirror duplicate guard (idea #35)', () => {
  it('keeps the binding on an EMPTY snapshot instead of recreating (transient state)', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = []
    const logs: string[] = []
    const mirror = new TaskBoardMirror({ transport, log: (message) => { logs.push(message) } })
    const bound = await mirror.mirrorUpdate(idea({ taskBoardId: 'live-card' }))
    expect(bound).toBe('live-card')
    // The patch still targets the bound card; no create ever fires.
    expect(transport.posts.map(post => post.action.kind)).toEqual(['update'])
    expect(transport.posts[0]!.action).toMatchObject({ taskId: 'live-card' })
    expect(logs.some(line => line.includes('branch=trust-binding-snapshot-empty'))).toBe(true)
  })

  it('keeps the binding when the snapshot is unknown (malformed / board hiccup) and says so', async () => {
    const transport = new FakeTransport()
    const logs: string[] = []
    const mirror = new TaskBoardMirror({ transport, log: (message) => { logs.push(message) } })
    const bound = await mirror.mirrorUpdate(idea({ taskBoardId: 'live-card' }))
    expect(bound).toBe('live-card')
    expect(transport.posts.map(post => post.action.kind)).toEqual(['update'])
    const line = logs.find(entry => entry.includes('branch=trust-binding-snapshot-unknown'))
    expect(line).toBeDefined()
    expect(line).toContain('idea=idea-1')
    expect(line).toContain('bound=live-card')
    expect(line).toContain('tasks=?')
  })

  it('recreates a genuinely deleted card under the DETERMINISTIC id with a visible log event', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [{ id: 'other-card', status: 'backlog' }]
    const logs: string[] = []
    const mirror = new TaskBoardMirror({ transport, log: (message) => { logs.push(message) } })
    const bound = await mirror.mirrorUpdate(idea({ taskBoardId: 'ghost-card' }))
    expect(bound).toBe('idea-idea-1')
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move', 'update'])
    expect(transport.posts[0]!.action).toMatchObject({ kind: 'create', id: 'idea-idea-1' })
    const line = logs.find(entry => entry.includes('branch=recreate-deleted-card'))
    expect(line).toBeDefined()
    expect(line).toContain('idea=idea-1')
    expect(line).toContain('bound=ghost-card')
    expect(line).toContain('tasks=1')
  })

  it('adopts the deterministic card for an unbound idea (get-before-create, no duplicate)', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [{ id: 'idea-idea-1', status: 'backlog' }]
    const logs: string[] = []
    const mirror = new TaskBoardMirror({ transport, log: (message) => { logs.push(message) } })
    const bound = await mirror.mirrorUpdate(idea())
    expect(bound).toBe('idea-idea-1')
    expect(transport.posts.map(post => post.action.kind)).toEqual(['update'])
    expect(logs.some(line => line.includes('branch=adopt-existing-card'))).toBe(true)
  })

  it('adopts the deterministic card when a legacy binding points at a deleted card', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [
      { id: 'other-card', status: 'backlog' },
      { id: 'idea-idea-1', status: 'backlog' },
    ]
    const logs: string[] = []
    const mirror = new TaskBoardMirror({ transport, log: (message) => { logs.push(message) } })
    const bound = await mirror.mirrorUpdate(idea({ taskBoardId: 'legacy-random' }))
    expect(bound).toBe('idea-idea-1')
    expect(transport.posts.map(post => post.action.kind)).toEqual(['update'])
    expect(logs.some(line => line.includes('branch=adopt-deterministic-card'))).toBe(true)
  })

  it('mirrorCreate mints the deterministic card id (re-execution touches the same card)', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const taskId = await mirror.mirrorCreate(idea())
    expect(taskId).toBe('idea-idea-1')
    expect(transport.posts[0]!.action).toMatchObject({ kind: 'create', id: 'idea-idea-1' })
    expect(transport.posts[1]!.action).toEqual({ kind: 'move', taskId: 'idea-idea-1', status: 'backlog' })
  })
})

describe('TaskBoard card description weight (idea summary)', () => {
  it('ships the analyst summary as the description while the prompt keeps the full body', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const longBody = `## Context\n\n${'The analysis paragraph. '.repeat(40)}\n\n## Value\n\nMore.`
    // No promptPrefix tag: the prompt falls back to the derived mission, which
    // is the production case (0 of 13 live ideas carry a promptPrefix).
    await mirror.mirrorCreate(idea({ body: longBody, summary: 'Tight abstract of the idea.', tags: [{ name: 'ideas-manager' }] }))
    const input = transport.posts[0]!.action as { input: { description: string; prompt: string } }
    expect(input.input.description).toBe('Tight abstract of the idea.')
    // The run instruction is UNCHANGED: it still carries the full analysis.
    expect(input.input.prompt).toContain('The analysis paragraph.')
    expect(input.input.prompt).toContain('## Value')
  })

  it('patches the description to the summary too (update path)', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [{ id: 'task-9', status: 'backlog' }]
    const mirror = new TaskBoardMirror({ transport })
    await mirror.mirrorUpdate(idea({ taskBoardId: 'task-9', summary: 'Patched abstract.' }))
    const update = transport.posts[0]!.action as { kind: 'update'; patch: { description: string; prompt: string } }
    expect(update.patch.description).toBe('Patched abstract.')
    // Prompt logic untouched: the fixture's promptPrefix tag still wins.
    expect(update.patch.prompt).toBe('Render music scores.')
  })

  it('deriveSummary skips pure heading blocks and collapses to the first content paragraph', () => {
    expect(deriveSummary('## Context\n\ntext content')).toBe('text content')
    expect(deriveSummary('## Context\n\n## Value')).toBe('')
    expect(deriveSummary('')).toBe('')
    expect(deriveSummary('# Title only line\n\nReal first paragraph.')).toBe('Real first paragraph.')
  })

  it('deriveSummary cuts a long first paragraph at a word boundary within 300 chars', () => {
    const derived = deriveSummary('word '.repeat(200))
    expect(derived.length).toBeLessThanOrEqual(300)
    expect(derived.endsWith('...')).toBe(true)
    expect(derived.includes('  ')).toBe(false)
  })
})

describe('IdeasHostService mirror serialization (idea #35)', () => {
  it('runs create + update for one idea in order: exactly one card, latest content', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('r1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    service.apply('r2', { kind: 'update', ideaId: 'idea-1', patch: { title: 'T2', body: 'B2' } })
    await service.flushMirror()
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move', 'update'])
    const update = transport.posts[2]!.action as { taskId: string; patch: { title: string } }
    expect(update.taskId).toBe('idea-idea-1')
    expect(update.patch.title).toBe('T2')
    expect(service.snapshot().ideas[0]!.taskBoardId).toBe('idea-idea-1')
    service.dispose()
  })

  it('runs the follow-up child create ahead of the first child update (one card)', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('seed-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    ledger.applyRequest('seed-2', { kind: 'move', ideaId: 'idea-1', status: 'underReview' })
    const service = new IdeasHostService({ ledger, mirror, autoMirror: true })
    service.apply('r1', { kind: 'followUp', ideaId: 'idea-1', input: { title: 'Child', body: 'CB' } })
    const child = service.snapshot().ideas.find(item => item.followUpOfId === 'idea-1')
    expect(child).toBeDefined()
    service.apply('r2', { kind: 'update', ideaId: child!.id, patch: { title: 'Child v2' } })
    await service.flushMirror()
    const creates = transport.posts.filter(post => post.action.kind === 'create')
    expect(creates).toHaveLength(1)
    expect(creates[0]!.action).toMatchObject({ kind: 'create', id: `idea-${child!.id}` })
    const update = transport.posts.find(post => post.action.kind === 'update')!.action as { taskId: string; patch: { title: string } }
    expect(update.taskId).toBe(`idea-${child!.id}`)
    expect(update.patch.title).toBe('Child v2')
    expect(service.snapshot().ideas.find(item => item.id === child!.id)!.taskBoardId).toBe(`idea-${child!.id}`)
    service.dispose()
  })
})

describe('IdeasHostService mirror integration', () => {
  it('mirrors a create, binds the task id and bumps the revision', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B', workspaceId: 'ot' } })
    expect(service.snapshot().ideas[0]!.taskBoardId).toBeUndefined()
    await service.flushMirror()
    const state = service.snapshot()
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move'])
    expect(state.ideas[0]!.taskBoardId).toBeDefined()
    expect(state.revision).toBe(2)
    service.dispose()
  })

  it('does not mirror a replayed request id', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    const action = { kind: 'create' as const, id: 'idea-1', input: { title: 'T', body: 'B' } }
    service.apply('req-1', action)
    await service.flushMirror()
    const posts = transport.posts.length
    service.apply('req-1', action)
    await service.flushMirror()
    expect(transport.posts.length).toBe(posts)
    service.dispose()
  })

  it('reflects decline as archive and restore as task restore', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    const service = new IdeasHostService({ ledger, mirror, autoMirror: true })
    service.apply('req-2', { kind: 'decline', ideaId: 'idea-1' })
    await service.flushMirror()
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move', 'archive'])
    service.apply('req-3', { kind: 'restore', ideaId: 'idea-1' })
    await service.flushMirror()
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move', 'archive', 'restore'])
    service.dispose()
  })

  it('mirrors a delivery as an archive of the bound task', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    const service = new IdeasHostService({ ledger, mirror, autoMirror: true })
    service.apply('req-2', { kind: 'deliver', ideaId: 'idea-1' })
    await service.flushMirror()
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move', 'archive'])
    service.dispose()
  })

  it('never mirrors a triage (opinions and ranks are ideas-side only)', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    service.apply('req-2', { kind: 'triage', ideaId: 'idea-1', patch: { value: 3, effort: 1 } })
    service.apply('req-3', { kind: 'triage', ideaId: 'idea-1', patch: { rationale: 'Top value' } })
    await service.flushMirror()
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move'])
    service.dispose()
  })

  it('never rolls back an idea when the mirror fails', async () => {
    const transport = new FakeTransport()
    transport.actionStatus = 500
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    await service.flushMirror()
    const state = service.snapshot()
    expect(state.ideas).toHaveLength(1)
    expect(state.revision).toBe(1)
    expect(state.ideas[0]!.taskBoardId).toBeUndefined()
    service.dispose()
  })

  it('stays autonomous when the task-board plugin is absent', async () => {
    const transport = new FakeTransport()
    transport.stateStatus = 404
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    await service.flushMirror()
    expect(transport.posts).toHaveLength(0)
    expect(service.snapshot().ideas).toHaveLength(1)
    service.dispose()
  })

  it('fetchTaskStatuses maps task id -> status from the state body', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [
      { id: 'task-1', status: 'backlog' },
      { id: 'task-2', status: 'done' },
    ]
    const mirror = new TaskBoardMirror({ transport })
    const statuses = await mirror.fetchTaskStatuses()
    expect(statuses).toEqual(new Map([
      ['task-1', 'backlog'],
      ['task-2', 'done'],
    ]))
  })

  it('fetchTaskStatuses returns undefined without tasks (absent plugin / malformed body)', async () => {
    const empty = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport: empty })
    expect(await mirror.fetchTaskStatuses()).toBeUndefined()
    const broken = new FakeTransport()
    broken.stateStatus = 404
    const brokenMirror = new TaskBoardMirror({ transport: broken })
    expect(await brokenMirror.fetchTaskStatuses()).toBeUndefined()
  })

  it('the under-review poll moves open ideas whose card is done', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = [
      { id: 'task-9', status: 'done' },
      { id: 'task-8', status: 'backlog' },
    ]
    const mirror = new TaskBoardMirror({ transport })
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    ledger.applyRequest('r2', { kind: 'create', id: 'idea-2', input: { title: 'U', body: 'B' } })
    ledger.bindTaskBoardId('idea-1', 'task-9')
    ledger.bindTaskBoardId('idea-2', 'task-8')
    const service = new IdeasHostService({ ledger, mirror, autoMirror: true })
    await service.pollUnderReviewTransitions()
    // Only the idea whose card reached done crossed the recette gate; the one
    // still in backlog stays open.
    expect(service.snapshot().ideas.find(idea => idea.id === 'idea-1')!.status).toBe('underReview')
    expect(service.snapshot().ideas.find(idea => idea.id === 'idea-2')!.status).toBe('open')
    expect(transport.posts).toHaveLength(0)
    service.dispose()
  })

  it('the under-review poll is a no-op when autoMirror is off or the card is gone', async () => {
    const transport = new FakeTransport()
    transport.stateTasks = []
    const mirror = new TaskBoardMirror({ transport })
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    ledger.bindTaskBoardId('idea-1', 'task-9')
    const off = new IdeasHostService({ ledger, mirror, autoMirror: false })
    await off.pollUnderReviewTransitions()
    expect(off.snapshot().ideas[0]!.status).toBe('open')
    off.dispose()
  })

  it('does not mirror when autoMirror is off', async () => {
    const transport = new FakeTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: false })
    service.apply('req-1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    await service.flushMirror()
    expect(transport.getStateCalls).toBe(0)
    expect(transport.posts).toHaveLength(0)
    service.dispose()
  })
})

describe('HttpTaskBoardTransport', () => {
  it('passes the loopback self-request discipline and JSON envelope', async () => {
    const seen: Array<{ method: string; url: string; origin: string | undefined; fetchSite: string | undefined; body?: unknown }> = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          origin: req.headers.origin,
          fetchSite: req.headers['sec-fetch-site'],
          ...(raw === '' ? {} : { body: JSON.parse(raw) }),
        })
        res.writeHead(req.url === '/api/task-board/state' ? 200 : 200, { 'content-type': 'application/json' })
        res.end(req.url === '/api/task-board/state' ? '{"schemaVersion":3,"revision":1}' : '{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const transport = new HttpTaskBoardTransport(() => `http://127.0.0.1:${port}`)
    try {
      const state = await transport.getState()
      expect(state.status).toBe(200)
      await transport.postAction({ requestId: 'ideas-mirror-x', action: { kind: 'archive', taskId: 't-1' } })
      expect(seen.map(entry => entry.url)).toEqual(['/api/task-board/state', '/api/task-board/action'])
      expect(seen[0]?.origin).toBe(`http://127.0.0.1:${port}`)
      expect(seen[0]?.fetchSite).toBe('same-origin')
      expect(seen[1]?.body).toEqual({ requestId: 'ideas-mirror-x', action: { kind: 'archive', taskId: 't-1' } })
      expect(seen[1]?.method).toBe('POST')
    } finally {
      server.close()
    }
  })

  it('reads a snapshot larger than the old 128 KiB ceiling', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ schemaVersion: 3, revision: 1, tasks: [{ id: 't-1', status: 'backlog' }], pad: 'x'.repeat(140_000) }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const transport = new HttpTaskBoardTransport(() => `http://127.0.0.1:${port}`)
    try {
      const state = await transport.getState()
      expect(state.status).toBe(200)
      const tasks = (state.body as { tasks?: unknown }).tasks as Array<{ id: string }>
      expect(tasks.map(task => task.id)).toEqual(['t-1'])
    } finally {
      server.close()
    }
  })

  it('REJECTS instead of hanging when a response exceeds the cap', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ schemaVersion: 3, revision: 1, pad: 'x'.repeat(4_000) }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const transport = new HttpTaskBoardTransport(() => `http://127.0.0.1:${port}`, { maxResponseBytes: 1024 })
    try {
      // Regression guard for the stalled-poll incident: the old code destroyed
      // the oversized response WITHOUT settling, so this promise hung forever
      // (a hang fails this test via the vitest timeout instead of passing).
      await expect(transport.getState()).rejects.toThrow(/too large/)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it('times out a stalled response instead of hanging', async () => {
    const server = createServer(() => { /* never answer: exercises the fatal timeout */ })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const transport = new HttpTaskBoardTransport(() => `http://127.0.0.1:${port}`, { timeoutMs: 150 })
    try {
      await expect(transport.getState()).rejects.toThrow(/timed out/)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})