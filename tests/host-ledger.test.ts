/**
 * Host ledger persistence tests: restart-safety (file survives a new
 * instance), request-id dedupe across instances, corruption quarantine,
 * row repair, and the process lock.
 */

import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdea } from '../src/core/ideas.ts'
import { IdeasHostLedger } from '../src/host-ledger.ts'

let dir: string

function freshDir(): string {
  dir = join(tmpdir(), `ideas-ledger-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

const createAction = (id: string, title = 'Idea title', workspaceId?: string) => ({
  kind: 'create' as const,
  id,
  input: { title, body: 'Body', ...(workspaceId === undefined ? {} : { workspaceId }) },
})

describe('IdeasHostLedger persistence', () => {
  it('persists a create across instances (restart-safe) and continues the revision', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('req-1', createAction('idea-1'))
    expect(first.snapshot().revision).toBe(1)
    expect(first.snapshot().ideas).toHaveLength(1)
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    expect(second.snapshot().revision).toBe(1)
    expect(second.snapshot().ideas.map(idea => idea.id)).toEqual(['idea-1'])
    second.applyRequest('req-2', createAction('idea-2'))
    expect(second.snapshot().revision).toBe(2)
    second.dispose()
  })

  it('does not replay a mutating action after a restart (persisted request cache)', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('req-1', createAction('idea-1'))
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    const replay = second.applyRequest('req-1', createAction('idea-1'))
    expect(replay.state.ideas).toHaveLength(1)
    expect(replay.state.revision).toBe(1)
    expect(second.snapshot().ideas).toHaveLength(1)
    second.dispose()
  })

  it('rejects a reused request id carrying a different action', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-1', createAction('idea-1'))
    expect(() => ledger.applyRequest('req-1', createAction('idea-1', 'Different')))
      .toThrowError(/reused with a different action/)
    ledger.dispose()
  })

  it('advances the idea sequence past the largest imported ideaNumber', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    const imported = [5, 17, 28].map(number => ({
      id: `migrated-${number}`,
      title: `Imported idea ${number}`,
      body: 'Body',
      status: 'open' as const,
      ideaNumber: number,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
    }))
    const importedResult = ledger.applyRequest('req-import', {
      kind: 'import',
      sourceId: 'migration-test',
      ideas: imported,
    })
    expect(importedResult.state.ideas).toHaveLength(3)

    // The next create must not re-issue an ideaNumber already in use: the
    // import carried #28, so the next capture is #29.
    const created = ledger.applyRequest('req-create', createAction('post-migration'))
    const createdIdea = created.state.ideas.find(idea => idea.id === 'post-migration')
    expect(createdIdea?.ideaNumber).toBe(29)
    ledger.dispose()
  })

  it('leaves the sequence untouched by an import without ideaNumbers', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('req-import', {
      kind: 'import',
      sourceId: 'plain-import',
      ideas: [
        { id: 'a-1', title: 'A one', body: 'Body', status: 'open' as const, createdAt: 1_700_000_000, updatedAt: 1_700_000_000 },
        { id: 'a-2', title: 'A two', body: 'Body', status: 'open' as const, createdAt: 1_700_000_000, updatedAt: 1_700_000_000 },
      ],
    })
    const created = ledger.applyRequest('req-create', createAction('first-after-plain'))
    const createdIdea = created.state.ideas.find(idea => idea.id === 'first-after-plain')
    expect(createdIdea?.ideaNumber).toBe(1)
    ledger.dispose()
  })

  it('quarantines a corrupt document and starts empty', () => {
    const dirHere = freshDir()
    writeFileSync(join(dirHere, 'ledger-v2.json'), '{ not json !!!', 'utf8')
    const ledger = new IdeasHostLedger({ dir: dirHere })
    expect(ledger.snapshot().revision).toBe(0)
    expect(ledger.snapshot().ideas).toHaveLength(0)
    ledger.dispose()
    const quarantined = readdirSync(dirHere).filter(name => name.includes('corrupt'))
    expect(quarantined.length).toBeGreaterThan(0)
  })

  it('repairs malformed persisted rows on load', () => {
    const dirHere = freshDir()
    const now = Date.now()
    const row = { ...createIdea({ title: ' Broken ', body: ' x ' }, now, 'idea-9'), status: 'bogus', tags: [{ name: '' }, { name: 'ok' }, { name: 'ok' }] }
    writeFileSync(join(dirHere, 'ledger-v2.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      ideas: [row],
      importedSources: [],
      recentRequests: [],
    }), 'utf8')
    const ledger = new IdeasHostLedger({ dir: dirHere })
    const idea = ledger.snapshot().ideas[0]!
    expect(idea.status).toBe('open')
    expect(idea.title).toBe('Broken')
    expect(idea.tags?.map(tag => tag.name)).toEqual(['ok'])
    expect(ledger.snapshot().revision).toBe(3)
    ledger.dispose()
  })

  it('keeps an empty ledger file and releases the lock on dispose', () => {
    const dirHere = freshDir()
    const first = new IdeasHostLedger({ dir: dirHere })
    expect(existsSync(join(dirHere, 'ledger-v2.json'))).toBe(true)
    expect(existsSync(join(dirHere, 'ledger-v2.lock'))).toBe(true)
    first.dispose()
    expect(existsSync(join(dirHere, 'ledger-v2.lock'))).toBe(false)
    const second = new IdeasHostLedger({ dir: dirHere })
    second.dispose()
  })

  it('refuses a second live instance on the same ledger', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    try {
      expect(() => new IdeasHostLedger({ dir })).toThrowError(/already owned by process/)
    } finally {
      first.dispose()
    }
  })

  it('leaves no tmp file behind after a commit', () => {
    const dirHere = freshDir()
    const ledger = new IdeasHostLedger({ dir: dirHere })
    ledger.applyRequest('req-1', createAction('idea-1'))
    const remaining = readdirSync(dirHere).filter(name => name.includes('.tmp-'))
    expect(remaining).toHaveLength(0)
    ledger.dispose()
  })
})

describe('IdeasHostLedger T1 lifecycle (triage / deliver / decline / numbering)', () => {
  it('assigns monotonic idea numbers that survive a restart (persisted sequence)', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('req-1', createAction('idea-1'))
    first.applyRequest('req-2', createAction('idea-2'))
    expect(first.snapshot().ideas.map(idea => idea.ideaNumber)).toEqual([1, 2])
    first.dispose()

    const second = new IdeasHostLedger({ dir })
    second.applyRequest('req-3', createAction('idea-3'))
    expect(second.snapshot().ideas.map(idea => idea.ideaNumber)).toEqual([1, 2, 3])
    second.dispose()
  })

  it('triage stores the opinion and re-inserts the idea at the target rank', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a', 'A'))
    ledger.applyRequest('r2', createAction('idea-b', 'B'))
    ledger.applyRequest('r3', createAction('idea-c', 'C'))
    ledger.applyRequest('r4', {
      kind: 'triage',
      ideaId: 'idea-c',
      patch: { value: 3, effort: 1, rationale: 'Top value', rank: 1 },
    })
    const open = [...ledger.snapshot().ideas.filter(idea => idea.status === 'open')]
      .sort((x, y) => (x.rank ?? Number.MAX_SAFE_INTEGER) - (y.rank ?? Number.MAX_SAFE_INTEGER))
    expect(open.map(idea => idea.id)).toEqual(['idea-c', 'idea-a', 'idea-b'])
    expect(open[0]!.value).toBe(3)
    expect(open[0]!.effort).toBe(1)
    expect(open[0]!.rationale).toBe('Top value')
    // Every open idea now carries a concrete 1-based rank, not just the moved one.
    expect(open.map(idea => idea.rank)).toEqual([1, 2, 3])
    ledger.dispose()
  })

  it('triage appends when no rank is given and leaves delivered ideas in place', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a', 'A'))
    ledger.applyRequest('r2', createAction('idea-b', 'B'))
    ledger.applyRequest('r3', { kind: 'triage', ideaId: 'idea-a', patch: { value: 5 } })
    const open = [...ledger.snapshot().ideas.filter(idea => idea.status === 'open')]
      .sort((x, y) => (x.rank ?? Number.MAX_SAFE_INTEGER) - (y.rank ?? Number.MAX_SAFE_INTEGER))
    expect(open.map(idea => idea.id)).toEqual(['idea-b', 'idea-a'])
    // A note-only triage on a delivered idea updates the opinion without
    // re-ranking the closed columns.
    ledger.applyRequest('r4', { kind: 'deliver', ideaId: 'idea-b' })
    ledger.applyRequest('r5', { kind: 'triage', ideaId: 'idea-a', patch: { rationale: 'note only' } })
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-a')!.rationale).toBe('note only')
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-b')!.status).toBe('archived')
    // Ranks are PER GROUP: the triage re-ranks only the open group (idea-a at
    // 1), so the delivered idea keeps its archived-group rank (1) untouched.
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-a')!.rank).toBe(1)
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-b')!.rank).toBe(1)
    ledger.dispose()
  })

  it('triage re-ranks only the moved idea\'s workspace group (per-workspace ranks)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('a1', 'A1', 'ws-a'))
    ledger.applyRequest('r2', createAction('a2', 'A2', 'ws-a'))
    ledger.applyRequest('r3', createAction('b1', 'B1', 'ws-b'))
    ledger.applyRequest('r4', createAction('g1', 'G1')) // the generic group
    // Give every group its initial ranks (a1/a2 at 1..2, b1 at 1, g1 at 1).
    ledger.applyRequest('r5', { kind: 'reorder', orderedIds: ['a1', 'a2', 'b1', 'g1'] })
    ledger.applyRequest('r6', { kind: 'triage', ideaId: 'a2', patch: { value: 3, rank: 1 } })
    const byId = new Map(ledger.snapshot().ideas.map(row => [row.id, row] as const))
    expect(byId.get('a2')!.rank).toBe(1)
    expect(byId.get('a1')!.rank).toBe(2) // shifted down inside ws-a only
    expect(byId.get('b1')!.rank).toBe(1) // untouched
    expect(byId.get('g1')!.rank).toBe(1) // untouched
    ledger.dispose()
  })

  it('reorder re-derives per-group ranks from the id order (every group independently)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('a1', 'A1', 'ws-a'))
    ledger.applyRequest('r2', createAction('a2', 'A2', 'ws-a'))
    ledger.applyRequest('r3', createAction('b1', 'B1', 'ws-b'))
    ledger.applyRequest('r4', createAction('b2', 'B2', 'ws-b'))
    ledger.applyRequest('r5', createAction('g1', 'G1')) // the generic group
    // One wire list with the ws-b rows flipped and the groups interleaved:
    // each (status, workspace) group still gets its OWN 1-based ranks.
    ledger.applyRequest('r6', {
      kind: 'reorder',
      orderedIds: ['b2', 'a1', 'g1', 'b1', 'a2'],
    })
    const byId = new Map(ledger.snapshot().ideas.map(row => [row.id, row] as const))
    expect(byId.get('b2')!.rank).toBe(1)
    expect(byId.get('b1')!.rank).toBe(2)
    expect(byId.get('a1')!.rank).toBe(1)
    expect(byId.get('a2')!.rank).toBe(2)
    expect(byId.get('g1')!.rank).toBe(1)
    ledger.dispose()
  })

  it('deliver archives an open idea and stamps deliveredAt; a closed idea is untouched', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'deliver', ideaId: 'idea-a' })
    const delivered = ledger.snapshot().ideas[0]!
    expect(delivered.status).toBe('archived')
    expect(delivered.deliveredAt).toBeDefined()
    expect(delivered.archivedAt).toBeDefined()
    const before = delivered.updatedAt
    ledger.applyRequest('r3', { kind: 'deliver', ideaId: 'idea-a' })
    expect(ledger.snapshot().ideas[0]!.updatedAt).toBe(before)
    ledger.dispose()
  })

  it('decline records the decision (a blank decision is dropped)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'decline', ideaId: 'idea-a', decision: 'Covered by the sidecar' })
    const declined = ledger.snapshot().ideas[0]!
    expect(declined.status).toBe('declined')
    expect(declined.decision).toBe('Covered by the sidecar')
    ledger.applyRequest('r3', createAction('idea-b'))
    ledger.applyRequest('r4', { kind: 'decline', ideaId: 'idea-b', decision: '   ' })
    expect(ledger.snapshot().ideas.find(idea => idea.id === 'idea-b')!.decision).toBeUndefined()
    ledger.dispose()
  })

  it('an update patch can re-justify a rationale (a blank rationale clears it)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'update', ideaId: 'idea-a', patch: { rationale: 'after delivery' } })
    expect(ledger.snapshot().ideas[0]!.rationale).toBe('after delivery')
    ledger.applyRequest('r3', { kind: 'update', ideaId: 'idea-a', patch: { rationale: '  ' } })
    expect(ledger.snapshot().ideas[0]!.rationale).toBeUndefined()
    ledger.dispose()
  })
})

describe('IdeasHostLedger under-review cycle (recette)', () => {
  it('move sends an idea into the underReview column (open -> underReview)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    const idea = ledger.snapshot().ideas[0]!
    expect(idea.status).toBe('underReview')
    expect(idea.archivedAt).toBeUndefined()
    expect(idea.deliveredAt).toBeUndefined()
    ledger.dispose()
  })

  it('recette OK (deliver) archives an under-review idea with the delivery stamp', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    ledger.applyRequest('r3', { kind: 'deliver', ideaId: 'idea-a' })
    const delivered = ledger.snapshot().ideas[0]!
    expect(delivered.status).toBe('archived')
    expect(delivered.deliveredAt).toBeDefined()
    expect(delivered.archivedAt).toBeDefined()
    ledger.dispose()
  })

  it('recette NOK (followUp) creates a linked open child and archives the parent atomically', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', { ...createAction('idea-a', 'Parent'), id: 'idea-a', input: { title: 'Parent', body: 'Parent summary', workspaceId: 'w1' } })
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    ledger.applyRequest('r3', {
      kind: 'followUp',
      ideaId: 'idea-a',
      input: { title: 'Rework the fade-out', body: 'Justification text\n\n---\n\n**Summary**\n\nParent summary' },
    })
    const ideas = ledger.snapshot().ideas
    expect(ideas).toHaveLength(2)
    const parent = ideas.find(idea => idea.id === 'idea-a')!
    const child = ideas.find(idea => idea.id !== 'idea-a')!
    expect(parent.status).toBe('archived')
    expect(parent.archivedAt).toBeDefined()
    expect(parent.deliveredAt).toBeUndefined()
    expect(child.status).toBe('open')
    expect(child.followUpOfId).toBe('idea-a')
    expect(child.workspaceId).toBe('w1')
    expect(child.title).toBe('Rework the fade-out')
    expect(child.body).toContain('Justification text')
    // The child continues the monotonic numbering sequence.
    expect(child.ideaNumber).toBe(2)
    ledger.dispose()
  })

  it('followUp requires an under-review parent (open is rejected)', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    expect(() => ledger.applyRequest('r2', {
      kind: 'followUp',
      ideaId: 'idea-a',
      input: { title: 'Follow-up', body: 'Body' },
    })).toThrowError(/follow-up requires an under-review idea/)
    // The failed verb must not have mutated the ledger.
    expect(ledger.snapshot().ideas).toHaveLength(1)
    expect(ledger.snapshot().ideas[0]!.status).toBe('open')
    ledger.dispose()
  })

  it('followUp rejects a blank child title', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', createAction('idea-a'))
    ledger.applyRequest('r2', { kind: 'move', ideaId: 'idea-a', status: 'underReview' })
    expect(() => ledger.applyRequest('r3', {
      kind: 'followUp',
      ideaId: 'idea-a',
      input: { title: '   ', body: 'Body' },
    })).toThrowError(/title is required/)
    expect(ledger.snapshot().ideas).toHaveLength(1)
    expect(ledger.snapshot().ideas[0]!.status).toBe('underReview')
    ledger.dispose()
  })
})

describe('IdeasHostLedger summary (compact card abstract)', () => {
  it('trims on create, caps at 300 chars, and clears on a blank or null patch', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir() })
    ledger.applyRequest('r1', {
      kind: 'create',
      id: 'idea-1',
      input: { title: 'T', body: 'Body', summary: '  A tight abstract.  ' },
    })
    expect(ledger.snapshot().ideas[0]!.summary).toBe('A tight abstract.')
    ledger.applyRequest('r2', { kind: 'update', ideaId: 'idea-1', patch: { summary: 'x'.repeat(500) } })
    expect(ledger.snapshot().ideas[0]!.summary).toHaveLength(300)
    ledger.applyRequest('r3', { kind: 'update', ideaId: 'idea-1', patch: { summary: '   ' } })
    expect(ledger.snapshot().ideas[0]!.summary).toBeUndefined()
    ledger.applyRequest('r4', { kind: 'update', ideaId: 'idea-1', patch: { summary: 'Back again' } })
    expect(ledger.snapshot().ideas[0]!.summary).toBe('Back again')
    ledger.applyRequest('r5', { kind: 'update', ideaId: 'idea-1', patch: { summary: null } })
    expect(ledger.snapshot().ideas[0]!.summary).toBeUndefined()
    ledger.dispose()
  })

  it('persists the summary across instances (restart-safe)', () => {
    const first = new IdeasHostLedger({ dir: freshDir() })
    first.applyRequest('r1', {
      kind: 'create',
      id: 'idea-1',
      input: { title: 'T', body: 'Body', summary: 'Stored abstract' },
    })
    first.dispose()
    const second = new IdeasHostLedger({ dir })
    expect(second.snapshot().ideas[0]!.summary).toBe('Stored abstract')
    second.dispose()
  })

  it('keeps the prior summary in the re-analyze audit', () => {
    const ledger = new IdeasHostLedger({ dir: freshDir(), now: () => 1000 })
    ledger.applyRequest('r1', {
      kind: 'create',
      id: 'idea-1',
      input: { title: 'Before', body: 'Old', summary: 'Old abstract' },
    })
    ledger.applyRequest('r2', { kind: 'reanalyze', ideaId: 'idea-1' })
    expect(ledger.snapshot().ideas[0]!.analysisAudit).toMatchObject({
      at: 1000,
      title: 'Before',
      body: 'Old',
      summary: 'Old abstract',
    })
    // The analyst's rewrite replaces the live summary; the audit keeps the old one.
    ledger.applyRequest('r3', { kind: 'update', ideaId: 'idea-1', patch: { summary: 'New abstract' } })
    expect(ledger.snapshot().ideas[0]!.summary).toBe('New abstract')
    expect(ledger.snapshot().ideas[0]!.analysisAudit?.summary).toBe('Old abstract')
    ledger.dispose()
  })
})

describe('IdeasHostLedger mirrored task status (failed-task badge)', () => {
  it('persists the observed status across a restart and no-ops when unchanged', () => {
    const here = freshDir()
    const first = new IdeasHostLedger({ dir: here })
    first.applyRequest('r1', { kind: 'create', id: 'idea-1', input: { title: 'T', body: 'B' } })
    const baseline = first.snapshot().revision
    expect(first.setTaskBoardStatus('idea-1', 'failed')).toBe(true)
    expect(first.snapshot().ideas[0]!.taskBoardStatus).toBe('failed')
    const afterFailure = first.snapshot().revision
    expect(afterFailure).toBeGreaterThan(baseline)
    // Same observation: no write, no revision churn (the 30 s poll stays quiet).
    expect(first.setTaskBoardStatus('idea-1', 'failed')).toBe(false)
    expect(first.snapshot().revision).toBe(afterFailure)
    // Unknown idea: ignored.
    expect(first.setTaskBoardStatus('nope', 'failed')).toBe(false)
    first.dispose()

    // The observation survives a restart (it is part of the persisted record).
    const second = new IdeasHostLedger({ dir: here })
    expect(second.snapshot().ideas[0]!.taskBoardStatus).toBe('failed')
    // A retry updates it; a blank value clears it.
    expect(second.setTaskBoardStatus('idea-1', 'backlog')).toBe(true)
    expect(second.snapshot().ideas[0]!.taskBoardStatus).toBe('backlog')
    expect(second.setTaskBoardStatus('idea-1', '   ')).toBe(true)
    expect(second.snapshot().ideas[0]!.taskBoardStatus).toBeUndefined()
    second.dispose()
  })

  it('normalizes the stored status (trim, lowercase, cap) at repair time', () => {
    const here = freshDir()
    const file = join(here, 'ledger-v2.json')
    mkdirSync(here, { recursive: true })
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      ideaSequence: 1,
      importedSources: [],
      recentRequests: [],
      ideas: [{
        id: 'idea-1',
        title: 'T',
        body: 'B',
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
        taskBoardStatus: '  FaIlEd  ',
      }],
    }), 'utf8')
    const ledger = new IdeasHostLedger({ dir: here })
    expect(ledger.snapshot().ideas[0]!.taskBoardStatus).toBe('failed')
    ledger.dispose()
  })
})