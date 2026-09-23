/**
 * Rank/status coherence under repeated transactional triage (idea #34, spec
 * step 8): after EVERY step of a successive-op sequence - not just at the
 * end - assert no duplicate rank, no hole, no cross-group drift, and that
 * closed columns are never re-ranked by a triage. Runs in the normal suite
 * (correctness, not timing): the ops are in-memory and fast.
 *
 * The fixture ranks every (status, workspace) group contiguously, so
 * "coherent" means: each group still ranks 1..n with a stable order.
 */

import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostLedger } from '../src/host-ledger.ts'
import { rankGroupKey, type IdeaRecord, type IdeaStatus } from '../src/core/ideas.ts'
import type { IdeasAction } from '../src/protocol.ts'
import { groupedIdOrder } from '../src/client/ordering.ts'
import { makePerfDataset, perfImportAction } from './perf-fixture.ts'

let dir: string

function freshLedger(): IdeasHostLedger {
  dir = join(tmpdir(), `ideas-coherence-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const ledger = new IdeasHostLedger({ dir })
  ledger.applyRequest('coherence-seed', perfImportAction(makePerfDataset()))
  return ledger
}

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** Full observable board state: status per id + ranks per peer group. */
function coherenceOf(ideas: readonly IdeaRecord[]): {
  status: Map<string, IdeaStatus>
  ranks: Map<string, Map<string, number>>
} {
  const status = new Map<string, IdeaStatus>()
  const ranks = new Map<string, Map<string, number>>()
  for (const idea of ideas) {
    status.set(idea.id, idea.status)
    const key = rankGroupKey(idea.status, idea.workspaceId)
    const group = ranks.get(key) ?? new Map<string, number>()
    group.set(idea.id, idea.rank ?? Number.MAX_SAFE_INTEGER)
    ranks.set(key, group)
  }
  return { status, ranks }
}

/** One entry per duplicate rank, hole, or missing rank inside a group. */
function violations(ideas: readonly IdeaRecord[]): string[] {
  const groups = new Map<string, { id: string; rank: number | undefined }[]>()
  for (const idea of ideas) {
    const key = rankGroupKey(idea.status, idea.workspaceId)
    const rows = groups.get(key) ?? []
    rows.push({ id: idea.id, rank: idea.rank })
    groups.set(key, rows)
  }
  const issues: string[] = []
  for (const [key, rows] of groups) {
    const seen = new Set<number>()
    for (const row of rows) {
      if (row.rank === undefined) issues.push(`${key}: ${row.id} has no rank`)
      else if (seen.has(row.rank)) issues.push(`${key}: duplicate rank ${row.rank}`)
      if (row.rank !== undefined) seen.add(row.rank)
    }
    const defined = rows.map(row => row.rank).filter((rank): rank is number => rank !== undefined).sort((a, b) => a - b)
    defined.forEach((rank, index) => {
      if (rank !== index + 1) issues.push(`${key}: hole at position ${index + 1} (rank ${rank})`)
    })
  }
  return issues
}

/** Ranks sorted by value: the group's visible order as id list. */
function orderOf(group: Map<string, number>): string[] {
  return [...group.entries()].sort((a, b) => a[1] - b[1]).map(entry => entry[0])
}

describe('triage coherence at load (140 ideas, 100 open)', () => {
  it('stays coherent across 20 successive rank-1 triages, no cross-group drift', () => {
    const ledger = freshLedger()
    try {
      const open = ledger.snapshot().ideas.filter(idea => idea.status === 'open')
      expect(open.length).toBeGreaterThanOrEqual(100)
      expect(violations(ledger.snapshot().ideas)).toEqual([])

      // Round-robin across ALL open groups so every workspace group is
      // triaged at least once while the others must stay untouched.
      for (let step = 0; step < 20; step++) {
        const candidate = open[(step * 5) % open.length]!
        const before = coherenceOf(ledger.snapshot().ideas)
        const movedGroup = rankGroupKey('open', candidate.workspaceId)

        ledger.applyRequest(`seq-triage-${step}-${randomUUID()}`, {
          kind: 'triage',
          ideaId: candidate.id,
          patch: { rank: 1, value: (step % 5) + 1, effort: 1, rationale: `step ${step}` },
        })
        const after = coherenceOf(ledger.snapshot().ideas)

        // 1. Statuses never move under a triage (rank-only verb).
        expect(after.status, `status drift at step ${step}`).toEqual(before.status)
        // 2. The whole board stays coherent: no duplicate, no hole anywhere.
        expect(violations(ledger.snapshot().ideas), `coherence broken at step ${step}`).toEqual([])
        // 3. The moved card leads its own open group.
        expect(orderOf(after.ranks.get(movedGroup)!)[0], `moved card not first at step ${step}`).toBe(candidate.id)
        // 4. Every OTHER group - foreign open peers AND all closed columns -
        //    is byte-identical (ranks untouched by a foreign triage).
        for (const [key, group] of before.ranks) {
          if (key === movedGroup) continue
          expect([...after.ranks.get(key)!], `group ${JSON.stringify(key)} touched at step ${step}`).toEqual([...group])
        }
        // 5. The ledger stays transactional: revision advances per accepted
        //    op (the seed import landed revision 1, step 0 -> 2, ...).
        expect(ledger.snapshot().revision).toBe(step + 2)
      }
    } finally {
      ledger.dispose()
    }
  })

  it('clamps out-of-range ranks, appends on a missing rank, and heals unranked peers', () => {
    const ledger = freshLedger()
    try {
      const open = ledger.snapshot().ideas.filter(idea => idea.status === 'open')
      const group = rankGroupKey('open', open[0]!.workspaceId)
      const peersOf = (): IdeaRecord[] =>
        ledger.snapshot().ideas.filter(idea => idea.status === 'open' && rankGroupKey('open', idea.workspaceId) === group)
      const size = peersOf().length
      expect(size).toBeGreaterThan(3)
      const tail = peersOf()[size - 1]!

      const applyRank = (rank: number | undefined): string[] => {
        const action: IdeasAction = rank === undefined
          ? { kind: 'triage', ideaId: tail.id, patch: {} }
          : { kind: 'triage', ideaId: tail.id, patch: { rank } }
        ledger.applyRequest(`clamp-${randomUUID()}-${String(rank)}`, action)
        return orderOf(coherenceOf(ledger.snapshot().ideas).ranks.get(group)!)
      }

      // rank 0 / negative clamp to the head, a huge rank clamps to the tail.
      expect(applyRank(0)[0]).toBe(tail.id)
      expect(applyRank(-7)[0]).toBe(tail.id)
      expect(applyRank(9_999)[size - 1]).toBe(tail.id)
      // A triage without a rank appends (the "no rank opinion" semantics).
      expect(applyRank(undefined)[size - 1]).toBe(tail.id)
      expect(violations(ledger.snapshot().ideas)).toEqual([])

      // An unranked open card (a create/import without a rank opinion) is
      // healed into the 1..n sequence by the next triage of ITS group: the
      // verb numbers every member, not just the moved one.
      const unranked = {
        id: `rank-less-${randomUUID()}`,
        title: 'Captured without a rank opinion',
        body: 'No suggested rank at capture time.',
        status: 'open' as const,
        workspaceId: open[0]!.workspaceId,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_000,
      }
      ledger.applyRequest(`rankless-import-${randomUUID()}`, {
        kind: 'import',
        sourceId: `rankless-${randomUUID()}`,
        ideas: [unranked],
      })
      expect(ledger.snapshot().ideas.find(idea => idea.id === unranked.id)?.rank).toBeUndefined()

      const middle = peersOf()[Math.floor(size / 2)]!
      ledger.applyRequest(`heal-${randomUUID()}`, { kind: 'triage', ideaId: middle.id, patch: { rank: 2 } })
      expect(violations(ledger.snapshot().ideas)).toEqual([])
      const healed = peersOf()
      expect(healed).toHaveLength(size + 1)
      expect(healed.find(idea => idea.id === unranked.id)?.rank).toBeTypeOf('number')
    } finally {
      ledger.dispose()
    }
  })

  it('triage on a closed card re-ranks nothing (columns keep residual ranks)', () => {
    const ledger = freshLedger()
    try {
      const archived = ledger.snapshot().ideas.filter(idea => idea.status === 'archived')
      expect(archived.length).toBeGreaterThan(0)
      const before = coherenceOf(ledger.snapshot().ideas)

      ledger.applyRequest(`closed-triage-${randomUUID()}`, {
        kind: 'triage',
        ideaId: archived[0]!.id,
        patch: { rank: 1, value: 5, effort: 1, rationale: 'closed triage' },
      })
      const after = coherenceOf(ledger.snapshot().ideas)

      // Ranks identical EVERYWHERE (the opinion fields may change).
      for (const [key, group] of before.ranks) {
        expect([...after.ranks.get(key)!], `group ${JSON.stringify(key)} re-ranked by a closed triage`).toEqual([...group])
      }
      expect(after.status).toEqual(before.status)
      expect(violations(ledger.snapshot().ideas)).toEqual([])
    } finally {
      ledger.dispose()
    }
  })

  it('interleaved triage + reorder never diverges from the wire order', () => {
    const ledger = freshLedger()
    try {
      const open = ledger.snapshot().ideas.filter(idea => idea.status === 'open')
      for (let step = 0; step < 8; step++) {
        if (step % 2 === 0) {
          const candidate = open[(step * 7) % open.length]!
          ledger.applyRequest(`mix-triage-${step}-${randomUUID()}`, {
            kind: 'triage',
            ideaId: candidate.id,
            patch: { rank: (step % 4) + 1 },
          })
          expect(violations(ledger.snapshot().ideas), `after triage step ${step}`).toEqual([])
        } else {
          // The client rebuilds the full status-major id order and the host
          // re-derives every group's ranks from its appearance order.
          const wire = groupedIdOrder(ledger.snapshot().ideas)
          ledger.applyRequest(`mix-reorder-${step}-${randomUUID()}`, { kind: 'reorder', orderedIds: wire })
          const state = ledger.snapshot()
          expect(violations(state.ideas), `after reorder step ${step}`).toEqual([])
          // Per group: rank order == wire appearance order (no divergence).
          const position = new Map(wire.map((id, index) => [id, index]))
          const coherence = coherenceOf(state.ideas)
          for (const [key, group] of coherence.ranks) {
            const byRank = orderOf(group)
            const byWire = [...group.keys()].sort((a, b) => position.get(a)! - position.get(b)!)
            expect(byRank, `group ${JSON.stringify(key)} diverged at reorder step ${step}`).toEqual(byWire)
          }
        }
      }
    } finally {
      ledger.dispose()
    }
  })
})
