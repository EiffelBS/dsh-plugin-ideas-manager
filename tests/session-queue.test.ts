/**
 * Phase 3 session-queue tests: the structured analyst prompt (data fidelity
 * and the skill reference) and the defensive launcher resolution + launch flow
 * against a stubbed DSH session controller.
 *
 * The split (see docs/agent-write-channel.md §Phase 3): the prompt is MINIMAL
 * and carries ONLY the per-capture data (workspace, draft, priority hints)
 * plus the dynamic server origin; the analysis methodology AND the full
 * write-channel contract live in the installed `ideas-analyst` skill, which
 * the analysing session loads itself. These tests assert the prompt is thin
 * and that the skill really is the home of the contract.
 */

import { describe, expect, it } from 'vitest'
import {
  buildAnalysisPrompt,
  currentSessionSelectionOf,
  matchSessionSelection,
  resolveSessionLauncher,
  type SessionLauncher,
} from '../src/client/session-queue.ts'
import { IDEAS_ANALYST_SKILL_CONTENT } from '../src/skills/ideas-analyst.ts'

describe('buildAnalysisPrompt', () => {
  it('carries the captured idea, the workspace and the server origin — nothing else technical', () => {
    const prompt = buildAnalysisPrompt(
      { workspaceId: 'ws-1', workspaceTitle: 'Alpha', title: 'Night mode', body: 'Context lines', tags: ['ui', 'polish'], value: 2 },
      'http://127.0.0.1:3101',
    )
    expect(prompt).toContain('"Alpha" (workspaceId ws-1)')
    expect(prompt).toContain('Night mode')
    expect(prompt).toContain('Context lines')
    expect(prompt).toContain('Tags (human suggestion): ui, polish')
    // The dynamic origin is present (the skill does not know it).
    expect(prompt).toContain('http://127.0.0.1:3101')
    // The contract details are NOT duplicated in the prompt: they live in the skill.
    expect(prompt).not.toContain('Sec-Fetch-Site')
    expect(prompt).not.toContain('plugin:ideas-manager:ai-capture')
    expect(prompt).not.toContain('`invalid-action`')
    expect(prompt).not.toContain('[Text.Encoding]::UTF8.GetBytes')
    expect(prompt).not.toContain('/api/ideas/state')
    expect(prompt).not.toContain('"kind": "create"')
    // The human's opinion is echoed, never replaced by a placeholder.
    expect(prompt).toContain('value: 2')
    expect(prompt).not.toContain('undefined')
  })

  it('points at the skill and never re-states the methodology or the contract', () => {
    const prompt = buildAnalysisPrompt(
      { workspaceId: 'ws-1', workspaceTitle: 'Alpha', title: 'T', body: 'draft', tags: [] },
      'http://127.0.0.1:3101',
    )
    expect(prompt).toContain('Load the skill named "ideas-analyst"')
    expect(prompt).toContain('available_skills catalog')
    expect(prompt).toContain('If the skill is not available')
    // No methodology duplication in the prompt.
    expect(prompt).not.toContain('## Context')
    expect(prompt).not.toContain('## Value')
    expect(prompt).not.toContain('RANKS are RELATIVE')
    expect(prompt).not.toContain('otherwise rewrite it to a more precise one')
    expect(prompt).not.toContain('at most 4 sentences')
  })

  it('the skill is the single home of the methodology AND the write-channel contract', () => {
    // Methodology.
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('## Context')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('ranks are RELATIVE per workspace')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('otherwise rewrite it to a more precise one')
    // Contract details that must live in the skill, not the prompt.
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('Sec-Fetch-Site: same-origin')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('plugin:ideas-manager:ai-capture')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('an array of\n  plain strings is REJECTED with 400 invalid-action')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('[Text.Encoding]::UTF8.GetBytes')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('GET <origin>/api/ideas/state')
    // Report language follows the requester; never hard-coded.
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain("in the requester's language")
    expect(IDEAS_ANALYST_SKILL_CONTENT).not.toContain('in French')
  })

  it('marks unset opinions for the analyst to decide and renders empty tags as a dash', () => {
    const prompt = buildAnalysisPrompt(
      { workspaceId: 'ws-1', workspaceTitle: 'Alpha', title: 'T', body: '', tags: [] },
      'http://127.0.0.1:3101',
    )
    expect(prompt).toContain('Tags (human suggestion): —')
    expect(prompt).toContain('value: not set (you decide)')
    expect(prompt).toContain('effort: not set (you decide)')
    expect(prompt).toContain('suggested rank: not set (you decide)')
  })
})

describe('resolveSessionLauncher', () => {
  it('returns undefined when the sessions service is absent or malformed', () => {
    expect(resolveSessionLauncher({ get: () => undefined })).toBeUndefined()
    expect(resolveSessionLauncher({ get: () => ({ list: {} }) })).toBeUndefined()
    expect(resolveSessionLauncher({ get: () => ({ create: async () => 'x' }) })).toBeUndefined()
  })

  it('launches a capture: create -> scope -> sessionOf -> queued prompt on the workspace', async () => {
    const created: Array<{ workspaceId?: string }> = []
    let seenPrompt: { content: readonly { type: 'text'; text: string }[]; mode: string } | undefined
    const controller = {
      create: async (opts: { workspaceId?: string }): Promise<string> => { created.push(opts); return 'session-1' },
      scope: (id: string): unknown => ({ id }),
      sessionOf: (ctx: unknown): unknown => ({
        prompt: async (content: readonly { type: 'text'; text: string }[], mode: string) => {
          seenPrompt = { content, mode }
          return { ok: true, value: { accepted: true } }
        },
      }),
    }
    const launcher = resolveSessionLauncher({ get: (name: string): unknown => name === 'sessions' ? controller : undefined })
    expect(launcher).toBeDefined()
    const result = await launcher!.launch({
      workspaceId: 'ws-1',
      workspaceTitle: 'Alpha',
      title: 'T',
      body: 'B',
      tags: ['a'],
    })
    expect(result).toEqual({ accepted: true })
    expect(created).toEqual([{ workspaceId: 'ws-1' }])
    expect(seenPrompt?.mode).toBe('queue')
    expect(seenPrompt?.content[0]?.type).toBe('text')
    expect((seenPrompt?.content[0] as { text: string }).text).toContain('ws-1')
  })

  it('rejects when the prompt is refused by the session controller', async () => {
    const controller = {
      create: async (): Promise<string> => 's',
      scope: (): unknown => ({}),
      sessionOf: (): unknown => ({ prompt: async () => ({ ok: false, error: { code: 'session/agent-busy' } }) }),
    }
    const launcher = resolveSessionLauncher({ get: () => controller }) as SessionLauncher
    await expect(launcher.launch({ workspaceId: 'w', workspaceTitle: 'T', title: 'x', body: '', tags: [] }))
      .rejects.toThrow(/session-prompt-rejected/)
  })

  it('rejects when the session face cannot be resolved or creation fails', async () => {
    const noFace = resolveSessionLauncher({
      get: () => ({ create: async () => 's', scope: () => ({}), sessionOf: () => undefined }),
    }) as SessionLauncher
    await expect(noFace.launch({ workspaceId: 'w', workspaceTitle: 'T', title: 'x', body: '', tags: [] }))
      .rejects.toThrow(/session-face-unavailable/)

    const failingCreate = resolveSessionLauncher({
      get: () => ({ create: async () => { throw new Error('gateway-down') }, scope: () => ({}), sessionOf: () => ({}) }),
    }) as SessionLauncher
    await expect(failingCreate.launch({ workspaceId: 'w', workspaceTitle: 'T', title: 'x', body: '', tags: [] }))
      .rejects.toThrow('gateway-down')
  })

  it('lists models by flattening the catalog groups', async () => {
    const controller = {
      create: async (): Promise<string> => 's',
      scope: () => ({}),
      sessionOf: () => undefined,
      modelCatalog: async () => ({
        ok: true,
        value: {
          groups: [
            { id: 'p1', name: 'Provider One', models: [{ id: 'm1', name: 'Model A' }, { id: 'm2', name: 'Model B' }] },
            { id: 'p2', name: 'Provider Two', models: [{ id: 'm3', name: 'Model C' }] },
          ],
        },
      }),
    }
    const launcher = resolveSessionLauncher({ get: () => controller }) as SessionLauncher
    const choices = await launcher.listModels()
    expect(choices).toEqual([
      { provider: 'p1', model: 'm1', label: 'Provider One · Model A' },
      { provider: 'p1', model: 'm2', label: 'Provider One · Model B' },
      { provider: 'p2', model: 'm3', label: 'Provider Two · Model C' },
    ])
  })

  it('selects the model on the fresh session before prompting', async () => {
    const selected: Array<{ sessionId?: string; provider?: string; model?: string }> = []
    const controller = {
      create: async (): Promise<string> => 'session-sel',
      scope: () => ({}),
      sessionOf: (ctx: unknown): unknown => ({
        prompt: async () => ({ ok: true, value: { accepted: true } }),
      }),
      selectModel: async (sel: { sessionId: string; provider: string; model: string }): Promise<{ ok: boolean; value: { selected: unknown } }> => {
        selected.push(sel)
        return { ok: true, value: { selected: sel } }
      },
    }
    const launcher = resolveSessionLauncher({ get: () => controller }) as SessionLauncher
    const result = await launcher.launch({
      workspaceId: 'w', workspaceTitle: 'T', title: 'x', body: '', tags: [],
      model: { provider: 'p1', model: 'm1', label: 'Provider One · Model A' },
    })
    expect(result).toEqual({ accepted: true })
    expect(selected).toEqual([{ sessionId: 'session-sel', provider: 'p1', model: 'm1' }])
  })

  it('proceeds on the session default when selectModel is absent or rejects', async () => {
    const controller = {
      create: async (): Promise<string> => 's',
      scope: () => ({}),
      sessionOf: () => undefined,
      selectModel: async () => ({ ok: false, error: { code: 'session/model-unavailable' } }),
    }
    const launcher = resolveSessionLauncher({ get: () => controller }) as SessionLauncher
    // Without a prompt session the launcher still throws session-face-unavailable,
    // but the model failure came first and is non-fatal (no throw from selectModel).
    await expect(launcher.launch({
      workspaceId: 'w', workspaceTitle: 'T', title: 'x', body: '', tags: [],
      model: { provider: 'p1', model: 'm1', label: 'P · M' },
    })).rejects.toThrow(/session-face-unavailable/)
  })
})

describe('currentSessionSelectionOf', () => {
  /** Build a minimal session controller exposing the projection faces. */
  const controllerWithProjection = (snapshot: unknown): unknown => ({
    create: async () => 's', scope: () => ({}), sessionOf: () => undefined,
    list: { getSnapshot: () => ({ current: 'session-current' }) },
    binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => snapshot }) } } }),
  })

  it('reads the pending selection from the session modelSelection projection', () => {
    const selection = currentSessionSelectionOf(controllerWithProjection({
      next: { provider: 'p1', model: 'm-cheap' },
      lastUsed: { provider: 'p1', model: 'm-expensive' },
    }) as Parameters<typeof currentSessionSelectionOf>[0])
    expect(selection).toEqual({ provider: 'p1', model: 'm-cheap' })
  })

  it('falls back to lastUsed when there is no pending selection', () => {
    const selection = currentSessionSelectionOf(controllerWithProjection({
      next: null,
      lastUsed: { provider: 'p1', model: 'm-used', reasoningEffort: 'high' },
    }) as Parameters<typeof currentSessionSelectionOf>[0])
    expect(selection).toEqual({ provider: 'p1', model: 'm-used', reasoningEffort: 'high' })
  })

  it('returns undefined when the projection/session faces are absent or malformed', () => {
    // No list, no binding.
    expect(currentSessionSelectionOf({} as Parameters<typeof currentSessionSelectionOf>[0])).toBeUndefined()
    // Binding present but no session.
    expect(currentSessionSelectionOf({
      list: { getSnapshot: () => ({ current: 'c' }) },
      binding: () => undefined,
    } as unknown as Parameters<typeof currentSessionSelectionOf>[0])).toBeUndefined()
    // Projection snapshot without usable provider/model.
    expect(currentSessionSelectionOf(
      controllerWithProjection({ next: { provider: '' }, lastUsed: null }) as Parameters<typeof currentSessionSelectionOf>[0],
    )).toBeUndefined()
    // Throwing faces degrade to undefined.
    expect(currentSessionSelectionOf({
      list: { getSnapshot: () => { throw new Error('boom') } },
    } as unknown as Parameters<typeof currentSessionSelectionOf>[0])).toBeUndefined()
  })
})

describe('matchSessionSelection', () => {
  const choices = [
    { provider: 'p1', model: 'm1', label: 'Provider One · Model A' },
    { provider: 'p1', model: 'm2', label: 'Provider One · Model B' },
    { provider: 'p2', model: 'm3', label: 'Provider Two · Model C' },
  ]

  it('matches provider+model and carries the reasoning effort', () => {
    expect(matchSessionSelection({ provider: 'p1', model: 'm2', reasoningEffort: 'high' }, choices))
      .toEqual({ provider: 'p1', model: 'm2', label: 'Provider One · Model B', reasoningEffort: 'high' })
  })

  it('returns undefined for an unknown selection (never rolls to the first catalog row)', () => {
    expect(matchSessionSelection(undefined, choices)).toBeUndefined()
    expect(matchSessionSelection({ provider: 'p3', model: 'unknown' }, choices)).toBeUndefined()
    expect(matchSessionSelection({ provider: 'p1', model: 'unknown' }, choices)).toBeUndefined()
  })
})

describe('SessionLauncher.currentModel', () => {
  it('exposes the current host session model selection on the launcher', async () => {
    const controller = {
      create: async (): Promise<string> => 's', scope: () => ({}), sessionOf: () => ({}),
      list: { getSnapshot: () => ({ current: 'session-current' }) },
      binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => ({
        next: null,
        lastUsed: { provider: 'deepseek', model: 'deepseek-v3' },
      }) }) } } }),
    }
    const launcher = resolveSessionLauncher({ get: () => controller }) as SessionLauncher
    await expect(launcher.currentModel()).resolves.toEqual({ provider: 'deepseek', model: 'deepseek-v3' })
  })

  it('resolves to undefined when no session projection exists', async () => {
    const controller = { create: async (): Promise<string> => 's', scope: () => ({}), sessionOf: () => ({}) }
    const launcher = resolveSessionLauncher({ get: () => controller }) as SessionLauncher
    await expect(launcher.currentModel()).resolves.toBeUndefined()
  })
})
