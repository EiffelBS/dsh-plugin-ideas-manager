/**
 * Host-side load profile (idea #34): the exact server path of
 * GET /api/ideas/state (service.snapshot() deep clone + JSON.stringify) and
 * the transactional triage / reorder paths, measured at the 140-idea fixture
 * (100 open cards - the spec's measurable "<1s" objective set).
 *
 * Opt-in: IDEAS_PERF=1 (see perf-fixture). Timings are machine-local and
 * printed as [perf-host] lines for the before/after report; ASSERTIONS only
 * guard correctness invariants (payload shape, rank coherence), never a
 * wall-clock threshold.
 */

import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { rankGroupKey, type IdeaRecord } from '../src/core/ideas.ts'
import { groupedIdOrder } from '../src/client/ordering.ts'
import { toListSnapshot } from '../src/protocol.ts'
import {
  PERF_IDEA_COUNT,
  PERF_OPEN_COUNT,
  bodySizeStats,
  makePerfDataset,
  perfImportAction,
  timeMs,
} from './perf-fixture.ts'

let dir: string
let service: IdeasHostService | undefined

function freshService(): IdeasHostService {
  dir = join(tmpdir(), `ideas-perf-host-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir })
  return service
}

afterEach(() => {
  try { service?.dispose() } catch { /* lock already released */ }
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** Median wall-clock of `runs` executions after one warm-up run. */
function medianMs(runs: number, fn: () => void): number {
  fn() // JIT warm-up, not sampled
  const samples: number[] = []
  for (let i = 0; i < runs; i++) samples.push(timeMs(fn))
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]!
}

/** Group ranks as (groupKey -> id -> rank), for coherence comparisons. */
function ranksByGroup(ideas: readonly IdeaRecord[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const idea of ideas) {
    const key = rankGroupKey(idea.status, idea.workspaceId)
    const group = out.get(key) ?? new Map<string, number>()
    group.set(idea.id, idea.rank ?? Number.MAX_SAFE_INTEGER)
    out.set(key, group)
  }
  return out
}

/** Every group ranks contiguous 1..n (no duplicate, no hole). */
function expectAllGroupsCoherent(ideas: readonly IdeaRecord[]): void {
  for (const [key, group] of ranksByGroup(ideas)) {
    const ranks = [...group.values()].sort((a, b) => a - b)
    expect(new Set(ranks).size, `duplicate ranks in group ${JSON.stringify(key)}`).toBe(ranks.length)
    ranks.forEach((rank, index) => {
      expect(rank, `hole in group ${JSON.stringify(key)} at position ${index}`).toBe(index + 1)
    })
  }
}

describe.runIf(process.env.IDEAS_PERF === '1')('perf-host: state payload + transactional paths at 140 ideas', () => {
  it('profiles snapshot/serialize/parse, triage shift and reorder', () => {
    const ideas = makePerfDataset()
    const stats = bodySizeStats(ideas)
    console.log(`[perf-host] dataset: count=${stats.count} open=${PERF_OPEN_COUNT} bodies total=${(stats.total / 1024).toFixed(1)} KiB min=${stats.min} p50=${stats.p50} p90=${stats.p90} max=${stats.max} avg=${stats.avg}`)

    const host = freshService()

    // Seed through the real import transaction (persists the ledger file).
    const importMs = timeMs(() => { host.apply('perf-import-1', perfImportAction(ideas)) })
    console.log(`[perf-host] import apply (seed ${PERF_IDEA_COUNT} ideas, one transaction): ${importMs.toFixed(1)} ms`)
    expect(host.snapshot().ideas).toHaveLength(PERF_IDEA_COUNT)
    expectAllGroupsCoherent(host.snapshot().ideas)

    // --- GET /api/ideas/state server path -------------------------------
    // The route does: guard -> service.snapshot() (deep clone) -> JSON.stringify.
    const cloneMs = medianMs(20, () => { void host.snapshot() })
    let json = ''
    const serializeMs = medianMs(20, () => { json = JSON.stringify(host.snapshot()) })
    const endToEndMs = medianMs(20, () => { JSON.stringify(host.snapshot()) })
    const bytes = Buffer.byteLength(json, 'utf8')
    const gzipBytes = gzipSync(Buffer.from(json, 'utf8')).length
    console.log(`[perf-host] GET /state snapshot() deep clone: ${cloneMs.toFixed(2)} ms (median/20)`)
    console.log(`[perf-host] GET /state clone+stringify (server end-to-end): ${endToEndMs.toFixed(2)} ms (median/20)`)
    console.log(`[perf-host] GET /state payload: ${(bytes / 1024).toFixed(1)} KiB raw (gzip reference: ${(gzipBytes / 1024).toFixed(1)} KiB)`)

    // Client parse proxy: what the browser pays before React runs.
    const parseMs = medianMs(20, () => { JSON.parse(json) })
    console.log(`[perf-host] client JSON.parse of the state payload: ${parseMs.toFixed(2)} ms (median/20)`)

    // --- the idea#34 LEAN poll wire (?view=list) ------------------------
    // What GET /api/ideas/state?view=list actually serves: same clone +
    // stringify path, projection drops the bodies before serialization.
    let listJson = ''
    const listSerializeMs = medianMs(20, () => { listJson = JSON.stringify(toListSnapshot(host.snapshot())) })
    const listBytes = Buffer.byteLength(listJson, 'utf8')
    const listGzipBytes = gzipSync(Buffer.from(listJson, 'utf8')).length
    const listParseMs = medianMs(20, () => { JSON.parse(listJson) })
    console.log(`[perf-host] LEAN ?view=list clone+project+stringify: ${listSerializeMs.toFixed(2)} ms (median/20)`)
    console.log(`[perf-host] LEAN ?view=list payload: ${(listBytes / 1024).toFixed(1)} KiB raw (gzip reference: ${(listGzipBytes / 1024).toFixed(1)} KiB), ${(100 * listBytes / bytes).toFixed(1)}% of the full snapshot`)
    console.log(`[perf-host] client JSON.parse of the LEAN payload: ${listParseMs.toFixed(2)} ms (median/20)`)

    // --- transactional triage: reinsert at rank 1 + shift ---------------
    const snapshot0 = host.snapshot()
    const openGroups = new Map<string, string[]>()
    for (const idea of snapshot0.ideas) {
      if (idea.status !== 'open') continue
      const key = rankGroupKey('open', idea.workspaceId)
      const list = openGroups.get(key) ?? []
      list.push(idea.id)
      openGroups.set(key, list)
    }
    const largest = [...openGroups.entries()].sort((a, b) => b[1].length - a[1].length)[0]!
    const [groupKey, groupIds] = largest
    const movedId = groupIds[groupIds.length - 1]! // last-ranked card reinserted at 1
    const shiftCount = groupIds.length - 1
    const before = ranksByGroup(snapshot0.ideas)

    // Headline worst case, applied ONCE: last-ranked -> rank 1 shifts every
    // peer of the largest open group.
    const worstMs = timeMs(() => {
      host.apply(`perf-triage-worst-${randomUUID()}`, { kind: 'triage', ideaId: movedId, patch: { rank: 1, value: 3, effort: 2, rationale: 'perf run' } })
    })
    const afterTriage = host.snapshot()
    const triagePayloadMs = medianMs(10, () => { JSON.stringify(host.snapshot()) })
    console.log(`[perf-host] triage reinsert at rank 1 (shift ${shiftCount} peers, group ${JSON.stringify(groupKey)}): ${worstMs.toFixed(2)} ms apply (worst case), response serialize ${triagePayloadMs.toFixed(2)} ms`)

    // Coherence: the moved card sits at 1, its group contiguous, EVERY other
    // group (open peers of other workspaces AND all closed columns) unchanged.
    expectAllGroupsCoherent(afterTriage.ideas)
    const after = ranksByGroup(afterTriage.ideas)
    const movedGroupAfter = [...after.get(groupKey)!.entries()].sort((a, b) => a[1] - b[1]).map(entry => entry[0])
    expect(movedGroupAfter[0]).toBe(movedId)
    expect(movedGroupAfter.length).toBe(groupIds.length)
    const expectedRest = groupIds.filter(id => id !== movedId)
    expect(movedGroupAfter.slice(1)).toEqual(expectedRest)
    for (const [key, group] of before) {
      if (key === groupKey) continue
      expect([...after.get(key)!], `group ${JSON.stringify(key)} was touched by a foreign triage`).toEqual([...group])
    }

    // Median over rotating DISTINCT cards of the group (each op shifts a
    // card that is not yet at rank 1, so every sample pays a real shift).
    const rotation = groupIds.filter((_, index) => index % 3 === 0).slice(0, 10)
    let rotate = 0
    const rotateMs = medianMs(rotation.length, () => {
      const id = rotation[rotate % rotation.length]!
      rotate++
      host.apply(`perf-triage-${randomUUID()}`, { kind: 'triage', ideaId: id, patch: { rank: 1 } })
    })
    console.log(`[perf-host] triage reinsert at rank 1 over ${rotation.length} rotating cards: ${rotateMs.toFixed(2)} ms (median)`)
    expectAllGroupsCoherent(host.snapshot().ideas)

    // --- successive triages stay coherent -------------------------------
    // 10 rotating ops (rank 1 / middle / end, across workspaces), coherence
    // re-asserted after every step: no duplicate, no hole, no order drift.
    const candidates = [...ideas]
      .filter(idea => idea.status === 'open')
      .filter((_, index) => index % 7 === 0)
      .slice(0, 10)
    let successiveMs = 0
    let step = 0
    for (const candidate of candidates) {
      const target = (step % 3) + 1 // 1, 2, 3 (near-head positions shift the most)
      successiveMs += timeMs(() => {
        host.apply(`perf-seq-${step}-${randomUUID()}`, { kind: 'triage', ideaId: candidate.id, patch: { rank: target } })
      })
      expectAllGroupsCoherent(host.snapshot().ideas)
      step++
    }
    console.log(`[perf-host] ${step} successive triage ops (coherent each step): total ${successiveMs.toFixed(1)} ms, avg ${(successiveMs / step).toFixed(2)} ms`)

    // --- full-ledger reorder (the drag & drop wire call) -----------------
    const wire = groupedIdOrder(host.snapshot().ideas)
    expect(wire).toHaveLength(PERF_IDEA_COUNT)
    const reorderMs = medianMs(10, () => {
      host.apply(`perf-reorder-${randomUUID()}`, { kind: 'reorder', orderedIds: wire })
    })
    const afterReorder = host.snapshot()
    console.log(`[perf-host] reorder full ledger (${wire.length} ids): ${reorderMs.toFixed(2)} ms apply (median/10)`)
    expectAllGroupsCoherent(afterReorder.ideas)
    // Order follows the wire: per group, rank order == wire appearance order.
    const wirePosition = new Map(wire.map((id, index) => [id, index]))
    const check = ranksByGroup(afterReorder.ideas)
    for (const [key, group] of check) {
      const ids = [...group.keys()]
      const byRank = [...ids].sort((a, b) => group.get(a)! - group.get(b)!)
      const byWire = [...ids].sort((a, b) => wirePosition.get(a)! - wirePosition.get(b)!)
      expect(byRank, `group ${JSON.stringify(key)} diverged from the wire order`).toEqual(byWire)
    }
  }, 60_000)
})
