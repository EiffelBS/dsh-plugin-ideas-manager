/**
 * Phase 3 session-queue tests: the structured analyst prompt (data fidelity,
 * channel contract) and the defensive launcher resolution + launch flow
 * against a stubbed DSH session controller.
 *
 * The split (see docs/agent-write-channel.md §Phase 3): the prompt carries the
 * per-capture data and the write-channel contract ONLY; the analysis
 * methodology (body structure, title/tag/rank rules, the report) lives
 * in the installed `ideas-analyst` skill, which the analysing session loads
 * itself. These tests therefore assert the prompt's dynamic data + channel
 * text + the skill reference, never a re-statement of the methodology.
 */

import { describe, expect, it } from 'vitest'
import { buildAnalysisPrompt, resolveSessionLauncher, type SessionLauncher } from '../src/client/session-queue.ts'
import { IDEAS_ANALYST_SKILL_CONTENT } from '../src/skills/ideas-analyst.ts'

describe('buildAnalysisPrompt', () => {
  it('carries the captured idea, the workspace and the write-channel contract', () => {
    const prompt = buildAnalysisPrompt(
      { workspaceId: 'ws-1', workspaceTitle: 'Alpha', title: 'Night mode', body: 'Context lines', tags: ['ui', 'polish'], value: 2 },
      'http://127.0.0.1:3101',
    )
    expect(prompt).toContain('"Alpha" (workspaceId ws-1)')
    expect(prompt).toContain('Night mode')
    expect(prompt).toContain('Context lines')
    expect(prompt).toContain('Tags (human suggestion): ui, polish')
    expect(prompt).toContain('http://127.0.0.1:3101/api/ideas/state')
    expect(prompt).toContain('Sec-Fetch-Site: same-origin')
    expect(prompt).toContain('plugin:ideas-manager:ai-capture')
    expect(prompt).toContain('"workspaceId": "ws-1"')
    // The human's opinion is echoed, never replaced by a placeholder.
    expect(prompt).toContain('value: 2')
    expect(prompt).not.toContain('undefined')
  })

  it('mints the strict tags format and keeps the authoritative channel text', () => {
    const prompt = buildAnalysisPrompt(
      { workspaceId: 'ws-1', workspaceTitle: 'Alpha', title: 'T', body: 'draft', tags: ['ui'] },
      'http://127.0.0.1:3101',
    )
    // Wire rule the first agent run hit: tag OBJECTS, never plain strings.
    expect(prompt).toContain('{"name": "ui"}')
    expect(prompt).toContain('an array of plain strings is REJECTED with 400 invalid-action')
    // Self-sufficient: no source reading, UTF-8 guidance for PowerShell.
    expect(prompt).toContain('do not go read plugin sources')
    expect(prompt).toContain('[Text.Encoding]::UTF8.GetBytes')
  })

  it('references the installed ideas-analyst skill without re-stating its methodology', () => {
    const prompt = buildAnalysisPrompt(
      { workspaceId: 'ws-1', workspaceTitle: 'Alpha', title: 'T', body: '', tags: [] },
      'http://127.0.0.1:3101',
    )
    expect(prompt).toContain('Load the skill named "ideas-analyst"')
    expect(prompt).toContain('available_skills catalog')
    expect(prompt).toContain('If the skill is not available')
    // The methodology is NOT duplicated in the prompt: it lives in the skill.
    expect(prompt).not.toContain('## Context')
    expect(prompt).not.toContain('## Value')
    expect(prompt).not.toContain('RANKS are RELATIVE')
    expect(prompt).not.toContain('otherwise rewrite it to a more precise one')
    expect(prompt).not.toContain('at most 4 sentences')
    // The skill really is the home of those rules.
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('## Context')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('ranks are RELATIVE per workspace')
    expect(IDEAS_ANALYST_SKILL_CONTENT).toContain('otherwise rewrite it to a more precise one')
    // The report language follows the requester; never a hard-coded language.
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
})
