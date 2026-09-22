/**
 * Idea #30 (re-analyze action) tests: the wire verb, the host audit stamp
 * (prior analysis preserved, restart-safe), the import round-trip, and the
 * re-analysis launch prompt + launcher face. Idea #35 adds the mirror-cycle
 * regression: a re-analyze run's analyst rewrite must UPDATE the bound
 * TaskBoard card — never mint a duplicate.
 */

import { describe, expect, it } from 'vitest'
import { parseActionEnvelope } from '../src/protocol.ts'
import { isIdeaRecord } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { IdeasHostService } from '../src/host-service.ts'
import {
  TaskBoardMirror,
  type TaskBoardActionEnvelope,
  type TaskBoardTransport,
} from '../src/taskboard-bridge.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  buildReanalysisPrompt,
  resolveSessionLauncher,
} from '../src/client/session-queue.ts'
import { IDEAS_ANALYST_SKILL_CONTENT } from '../src/skills/ideas-analyst.ts'

const envelope = (action: unknown) => ({ requestId: 'r1', action })

/** In-memory task-board double (always answers 200; serves a mutable snapshot). */
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

describe('protocol reanalyze verb', () => {
  it('parses the verb with an ideaId', () => {
    expect(parseActionEnvelope(envelope({ kind: 'reanalyze', ideaId: 'idea-1' }))?.action).toEqual({
      kind: 'reanalyze',
      ideaId: 'idea-1',
    })
  })

  it('rejects a missing ideaId and extra keys', () => {
    expect(parseActionEnvelope(envelope({ kind: 'reanalyze' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'reanalyze', ideaId: 'idea-1', extra: true }))).toBeUndefined()
  })

  it('round-trips the audit fields through an import', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'import',
      sourceId: 'src-1',
      ideas: [{
        id: 'idea-1',
        title: 'Imported',
        body: 'Body',
        status: 'open',
        createdAt: 1,
        updatedAt: 2,
        reanalyzeAt: 3,
        analysisAudit: { at: 3, title: 'Before', body: 'Old body', tags: [{ name: 'a' }], value: 2, effort: 3, rationale: 'old' },
      }],
    }))
    expect(parsed).toBeDefined()
    const idea = parsed && parsed.action.kind === 'import' ? parsed.action.ideas[0] : undefined
    expect(idea?.reanalyzeAt).toBe(3)
    expect(idea?.analysisAudit).toEqual({ at: 3, title: 'Before', body: 'Old body', tags: [{ name: 'a' }], value: 2, effort: 3, rationale: 'old' })
    expect(isIdeaRecord(idea)).toBe(true)
  })
})

describe('host ledger reanalyze stamp', () => {
  it('preserves the current content as the prior-analysis audit trail', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir(), now: () => 1000 })
    ledger.applyRequest('r1', {
      kind: 'create',
      id: 'idea-1',
      input: { title: 'Before', body: 'Old analysis', workspaceId: 'ws-1', value: 2, effort: 3, rationale: 'old reason', tags: [{ name: 'a' }] },
    })
    ledger.applyRequest('r2', { kind: 'reanalyze', ideaId: 'idea-1' })
    const idea = ledger.snapshot().ideas[0]
    expect(idea.reanalyzeAt).toBe(1000)
    expect(idea.analysisAudit).toEqual({
      at: 1000,
      title: 'Before',
      body: 'Old analysis',
      tags: [{ name: 'a' }],
      value: 2,
      effort: 3,
      rationale: 'old reason',
    })
    // The stamp does not change the card content itself.
    expect(idea.title).toBe('Before')
    expect(idea.status).toBe('open')
    ledger.dispose()
  })

  it('keeps the audit intact when the analyst update+triage overwrite the card', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir(), now: () => 1000 })
    ledger.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'Before', body: 'Old analysis' } })
    ledger.applyRequest('r2', { kind: 'reanalyze', ideaId: 'idea-1' })
    ledger.applyRequest('r3', { kind: 'update', ideaId: 'idea-1', patch: { title: 'After', body: 'New analysis', tags: null } })
    ledger.applyRequest('r4', { kind: 'triage', ideaId: 'idea-1', patch: { value: 3, effort: 1, rationale: 'new reason', rank: 1 } })
    const idea = ledger.snapshot().ideas[0]
    expect(idea.title).toBe('After')
    expect(idea.body).toBe('New analysis')
    expect(idea.value).toBe(3)
    expect(idea.rationale).toBe('new reason')
    expect(idea.analysisAudit?.title).toBe('Before')
    expect(idea.analysisAudit?.body).toBe('Old analysis')
    expect(idea.analysisAudit?.rationale).toBeUndefined()
    ledger.dispose()
  })

  it('persists the stamp and the audit across instances (restart-safe)', () => {
    const dir = freshDir()
    const first = new IdeasHostLedger({ dir, now: () => 1000 })
    first.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'Before', body: 'Old analysis' } })
    first.applyRequest('r2', { kind: 'reanalyze', ideaId: 'idea-1' })
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    const idea = second.snapshot().ideas[0]
    expect(idea.reanalyzeAt).toBe(1000)
    expect(idea.analysisAudit).toEqual({ at: 1000, title: 'Before', body: 'Old analysis' })
    second.dispose()
  })

  it('supersedes the previous audit (one level deep) and rejects an unknown idea', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir(), now: () => 1000 })
    ledger.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'V1', body: 'B1' } })
    ledger.applyRequest('r2', { kind: 'update', ideaId: 'idea-1', patch: { title: 'V2', body: 'B2' } })
    ledger.applyRequest('r3', { kind: 'reanalyze', ideaId: 'idea-1' })
    ledger.applyRequest('r4', { kind: 'update', ideaId: 'idea-1', patch: { title: 'V3', body: 'B3' } })
    ledger.applyRequest('r5', { kind: 'reanalyze', ideaId: 'idea-1' })
    // One level deep: the second cycle supersedes the first audit and
    // snapshots the CURRENT content (V3), the one the next analyst run
    // will overwrite.
    expect(ledger.snapshot().ideas[0].analysisAudit).toEqual({ at: 1000, title: 'V3', body: 'B3' })
    expect(() => ledger.applyRequest('r6', { kind: 'reanalyze', ideaId: 'missing' })).toThrow('idea not found')
    ledger.dispose()
  })
})

describe('re-analyze TaskBoard mirror cycle (idea #35)', () => {
  it('create -> re-analyze -> analyst rewrite ends with ONE card and the same binding', async () => {
    const transport = new FakeTaskBoardTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('r1', { kind: 'create', id: 'idea-1', input: { title: 'Before', body: 'Old analysis' } })
    await service.flushMirror()
    const bound = service.snapshot().ideas[0]!.taskBoardId!
    expect(bound).toBe('idea-idea-1')
    // The board now holds exactly the bound card (as the live task-board does).
    transport.stateTasks = [{ id: bound, status: 'backlog' }]
    // The re-analyze verb itself mirrors nothing (stamp only).
    service.apply('r2', { kind: 'reanalyze', ideaId: 'idea-1' })
    await service.flushMirror()
    expect(transport.posts.map(post => post.action.kind)).toEqual(['create', 'move'])
    // The analyst's rewrite: update + triage on the same idea id.
    service.apply('r3', { kind: 'update', ideaId: 'idea-1', patch: { title: 'After', body: 'New analysis' } })
    service.apply('r4', { kind: 'triage', ideaId: 'idea-1', patch: { value: 3, effort: 1, rank: 1 } })
    await service.flushMirror()
    // The #35 regression: exactly one card ever created, the update patched it.
    const creates = transport.posts.filter(post => post.action.kind === 'create')
    expect(creates).toHaveLength(1)
    const updates = transport.posts.filter(post => post.action.kind === 'update')
    expect(updates).toHaveLength(1)
    expect((updates[0]!.action as { taskId: string }).taskId).toBe(bound)
    expect(service.snapshot().ideas[0]!.taskBoardId).toBe(bound)
    service.dispose()
  })

  it('a transient EMPTY board snapshot at the analyst update never creates a second card', async () => {
    const transport = new FakeTaskBoardTransport()
    const mirror = new TaskBoardMirror({ transport })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('r1', { kind: 'create', id: 'idea-1', input: { title: 'Before', body: 'Old analysis' } })
    await service.flushMirror()
    const bound = service.snapshot().ideas[0]!.taskBoardId!
    transport.stateTasks = [{ id: bound, status: 'backlog' }]
    service.apply('r2', { kind: 'reanalyze', ideaId: 'idea-1' })
    await service.flushMirror()
    // The suspected live cause: /state answers 200 with a transiently empty
    // task list right when the analyst's update mirrors. The guard keeps the
    // binding — the old code read "id absent" and minted a duplicate card.
    transport.stateTasks = []
    service.apply('r3', { kind: 'update', ideaId: 'idea-1', patch: { title: 'After', body: 'New analysis' } })
    await service.flushMirror()
    const creates = transport.posts.filter(post => post.action.kind === 'create')
    expect(creates).toHaveLength(1)
    expect(service.snapshot().ideas[0]!.taskBoardId).toBe(bound)
    service.dispose()
  })

  it('a genuinely deleted card is rebuilt ONCE under the deterministic id (visible event)', async () => {
    const transport = new FakeTaskBoardTransport()
    const logs: string[] = []
    const mirror = new TaskBoardMirror({ transport, log: (message) => { logs.push(message) } })
    const service = new IdeasHostService({ dir: freshDir(), mirror, autoMirror: true })
    service.apply('r1', { kind: 'create', id: 'idea-1', input: { title: 'Before', body: 'Old analysis' } })
    await service.flushMirror()
    // Out-of-band cleanup removed the card; other cards remain (non-empty).
    transport.stateTasks = [{ id: 'unrelated-card', status: 'backlog' }]
    service.apply('r2', { kind: 'update', ideaId: 'idea-1', patch: { title: 'After', body: 'New' } })
    await service.flushMirror()
    // Initial mirror + exactly ONE sanctioned rebuild — and both target the
    // SAME deterministic id (a real board would reject a colliding create,
    // so even a lying snapshot cannot yield a second distinct card).
    const creates = transport.posts.filter(post => post.action.kind === 'create')
    expect(creates).toHaveLength(2)
    expect((creates[0]!.action as { id: string }).id).toBe('idea-idea-1')
    expect((creates[1]!.action as { id: string }).id).toBe('idea-idea-1')
    expect(logs.some(line => line.includes('branch=recreate-deleted-card'))).toBe(true)
    // The rebuild re-binds the idea to the deterministic id.
    expect(service.snapshot().ideas[0]!.taskBoardId).toBe('idea-idea-1')
    service.dispose()
  })
})

describe('reanalysis launch', () => {
  it('prompt names the idea id, the ai-reanalyze initiator and the no-create / no-recursion rules', () => {
    const prompt = buildReanalysisPrompt(
      {
        workspaceId: 'ws-1',
        workspaceTitle: 'Alpha',
        ideaId: 'idea-42',
        ideaNumber: 7,
        title: 'Stored title',
        body: 'Stored analysis',
        tags: ['a', 'b'],
        value: 2,
        effort: 3,
        rationale: 'old reason',
      },
      'http://127.0.0.1:3101',
    )
    expect(prompt).toContain('RE-ANALYZE')
    expect(prompt).toContain('"Alpha" (workspaceId ws-1)')
    expect(prompt).toContain('ideaId idea-42')
    expect(prompt).toContain('http://127.0.0.1:3101')
    expect(prompt).toContain('plugin:ideas-manager:ai-reanalyze')
    expect(prompt).toContain('NEVER use the create verb')
    expect(prompt).toContain('your summary')
    expect(prompt).toContain('#7')
    expect(prompt).toContain('Stored title')
    expect(prompt).toContain('Stored analysis')
    expect(prompt).toContain('Tags (current): a, b')
    expect(prompt).toContain('value: 2')
    expect(prompt).toContain('Load the skill named "ideas-analyst"')
  })

  it('the skill documents the re-analysis overrides', () => {
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('## Re-analysis runs (re-analyze action)')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('plugin:ideas-manager:ai-reanalyze')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('NEVER use the create verb')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('Report and stop.')
  })

  it('the skill requires the <=300-char summary on every analysis', () => {
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('SUMMARY - a tight abstract')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('AT MOST 300')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('"summary": "<your at-most-300-char abstract>"')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('your FRESH summary')
  })

  it('the launcher face exposes launchReanalyze', () => {
    const created: { workspaceId?: string }[] = []
    const prompts: string[] = []
    const controller = {
      create: (opts?: { workspaceId?: string }) => {
        created.push(opts ?? {})
        return Promise.resolve('session-1')
      },
      scope: () => ({}) as unknown,
      sessionOf: () => ({
        prompt: (parts: readonly { type: string; text?: string }[]) => {
          prompts.push(parts.map(part => part.text ?? '').join(''))
          return Promise.resolve({ ok: true, value: { accepted: true } })
        },
      }),
    }
    const launcher = resolveSessionLauncher({ get: () => controller })
    expect(launcher).toBeDefined()
    const result = launcher!.launchReanalyze({
      workspaceId: 'ws-1',
      workspaceTitle: 'Alpha',
      ideaId: 'idea-42',
      title: 'Stored title',
      body: 'Stored analysis',
      tags: [],
    })
    return result.then(accepted => {
      expect(accepted.accepted).toBe(true)
      expect(created[0]?.workspaceId).toBe('ws-1')
      expect(prompts[0]).toContain('RE-ANALYZE')
    })
  })
})

function freshDir(): string {
  return join(tmpdir(), `ideas-reanalyze-test-${process.pid}-${randomUUID()}`)
}
