import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildReanalysisPrompt } from '../src/client/session-queue.ts'
import { IdeasHostService } from '../src/host-service.ts'
import { buildIdeasReadSnapshot, toListSnapshot } from '../src/protocol.ts'
import { makePerfDataset, perfImportAction, PERF_IDEA_COUNT } from './perf-fixture.ts'

let dir: string | undefined
let service: IdeasHostService | undefined
afterEach(() => {
  try { service?.dispose() } catch { /* already released */ }
  service = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function fixtureService(): { service: IdeasHostService; dir: string } {
  dir = mkdtempSync(join(tmpdir(), 'ideas-analyst-context-'))
  service = new IdeasHostService({ dir })
  service.apply('fixture-import', perfImportAction(makePerfDataset()))
  return { service, dir }
}

describe('idea #64 summary-first analyst context', () => {
  it('bounds a 140-card reanalysis prompt to metadata and never embeds the target body', () => {
    const ideas = makePerfDataset()
    const target = ideas.find(idea => idea.id === 'perf-idea-112')!
    const prompt = buildReanalysisPrompt({
      workspaceId: target.workspaceId!,
      workspaceTitle: 'Perf workspace',
      ideaId: target.id,
      ideaNumber: target.ideaNumber,
      title: target.title,
      ...(target.summary === undefined ? {} : { summary: target.summary }),
      status: target.status,
      tags: (target.tags ?? []).map(tag => tag.name),
    }, 'http://127.0.0.1:3101')

    expect(prompt).toContain('state?view=summary&id=perf-idea-112')
    expect(prompt).toContain('idea?id=perf-idea-112')
    expect(prompt).not.toContain(target.body)
    for (const unrelated of ideas.filter(idea => idea.id !== target.id && idea.followUpOfId !== target.id)) {
      expect(prompt).not.toContain(unrelated.body.slice(0, 120))
    }
  })

  it('loads target plus only directly related follow-ups, then fully analyzes and persists the target', () => {
    const { service: host } = fixtureService()
    const list = buildIdeasReadSnapshot(host.snapshot(), { view: 'summary', limit: 200 })
    expect(list.ideas).toHaveLength(PERF_IDEA_COUNT)
    expect(list.ideas.every(idea => !('body' in idea))).toBe(true)

    const targetRow = list.ideas.find(idea => idea.id === 'perf-idea-114')!
    expect(targetRow.ideaNumber).toBeDefined()
    expect(targetRow.workspaceId).toBeDefined()
    const directRelated = list.ideas.filter(idea => idea.followUpOfId === targetRow.id)
    expect(directRelated.map(idea => idea.id)).toEqual(['perf-idea-3'])

    // This is the bounded read sequence prescribed by the skill.
    const target = host.idea(targetRow.id)!
    const related = directRelated.map(row => host.idea(row.id)!)
    const context = [target, ...related].map(idea => idea.body).join('\n')
    expect(context).toContain(`TARGET_BODY:${target.id}:FOLLOWUP:${directRelated[0]!.id}`)
    expect(context).toContain(`FOLLOWUP_BODY:${directRelated[0]!.id}:PARENT:${target.id}`)
    const unrelated = host.idea('perf-idea-1')!
    expect(context).not.toContain(unrelated.body.slice(0, 120))

    const analysis = `## Context\nTarget ${target.id} (#${target.ideaNumber}).\n\n## Value\nHigh.\n\n## Effort\nMedium.\n\n## First steps\nUse docs/idea-64.md.\n\n## Risks\nEscalate on identity mismatch.`
    host.apply('analyst-update', { kind: 'update', ideaId: target.id, patch: { body: analysis, summary: 'Bounded, fully analyzed target.', tags: [{ name: 'context' }] } })
    host.apply('analyst-triage', { kind: 'triage', ideaId: target.id, patch: { value: 3, effort: 2, rationale: 'High-value bounded workflow.' } })
    const persisted = host.idea(target.id)!
    expect(persisted.body).toBe(analysis)
    expect(persisted.summary).toBe('Bounded, fully analyzed target.')
    expect(persisted.value).toBe(3)
    expect(persisted.effort).toBe(2)
  })

  it('keeps the full /state contract while the analyst uses the lean list projection', () => {
    const { service: host } = fixtureService()
    expect(host.snapshot().ideas).toHaveLength(PERF_IDEA_COUNT)
    expect(host.snapshot().ideas.every(idea => typeof idea.body === 'string')).toBe(true)
    expect(toListSnapshot(host.snapshot()).ideas.every(idea => !('body' in idea))).toBe(true)
  })
})
