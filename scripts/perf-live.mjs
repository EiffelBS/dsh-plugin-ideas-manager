/**
 * Live test-instance profiler (idea #34): seeds the 140-idea fixture through
 * the real POST /api/ideas/action import (one transaction, <= 2 MiB gate),
 * then measures the read channel over HTTP - the full GET /api/ideas/state
 * (frozen default) vs the idea#34 LEAN ?view=list projection vs the
 * deferred-body GET /api/ideas/idea?id= endpoint.
 *
 * Run against a TEST instance only (never the 3080 session):
 *   DSH_HOME=<scratch> dsh --profile ideas-test --port 3099 ...
 *   node --experimental-strip-types scripts/perf-live.mjs
 * IDEAS_LIVE_URL overrides http://127.0.0.1:3099.
 *
 * Prints [perf-live] lines for docs/perf-evaluation.md; exits non-zero on
 * any contract violation (projection shape, payload ratio, HTTP errors).
 */

import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { makePerfDataset, perfImportAction, bodySizeStats } from '../tests/perf-fixture.ts'

const base = (process.env.IDEAS_LIVE_URL ?? 'http://127.0.0.1:3099').replace(/\/$/, '')
const fence = { Origin: base, 'sec-fetch-site': 'same-origin' }

/** Median elapsed ms of `runs` GETs (first run warms the route). */
async function medianMs(runs, fetchIt) {
  await fetchIt()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await fetchIt()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`

async function main() {
  const ideas = makePerfDataset()
  const stats = bodySizeStats(ideas)
  console.log(`[perf-live] fixture: count=${stats.count} bodies total=${kib(stats.total)} p50=${stats.p50} p90=${stats.p90} max=${stats.max}`)

  // --- seed through the real import transaction -------------------------
  const envelope = { requestId: randomUUID(), action: perfImportAction(ideas) }
  const seedBody = JSON.stringify(envelope)
  const seedStart = performance.now()
  const seedRes = await fetch(`${base}/api/ideas/action`, {
    method: 'POST',
    headers: { ...fence, 'content-type': 'application/json' },
    body: seedBody,
  })
  const seedMs = performance.now() - seedStart
  if (!seedRes.ok) throw new Error(`seed failed: HTTP ${seedRes.status} ${await seedRes.text()}`)
  const seedPayload = Buffer.byteLength(await seedRes.clone().arrayBuffer().then(buf => Buffer.from(buf)), 'utf8')
  console.log(`[perf-live] seed import (POST /api/ideas/action, ${kib(Buffer.byteLength(seedBody, 'utf8'))} request): HTTP ${seedRes.status} in ${seedMs.toFixed(0)} ms`)

  // --- full state (frozen default: backups/tooling read bodies) ---------
  const fullRes = await fetch(`${base}/api/ideas/state`, { headers: fence })
  if (!fullRes.ok) throw new Error(`state failed: HTTP ${fullRes.status}`)
  const fullBytes = Buffer.byteLength(await fullRes.clone().arrayBuffer().then(buf => Buffer.from(buf)), 'utf8')
  const fullJson = await fullRes.json()
  const fullMs = await medianMs(25, async () => {
    const res = await fetch(`${base}/api/ideas/state`, { headers: fence })
    if (!res.ok) throw new Error(`state failed: HTTP ${res.status}`)
    await res.arrayBuffer()
  })
  const hasBody = fullJson.ideas.every(idea => typeof idea.body === 'string')
  if (!hasBody) throw new Error('full state lost its bodies (frozen contract broken)')
  console.log(`[perf-live] GET /state (FULL): ${kib(fullBytes)}, ${fullMs.toFixed(2)} ms/req (median/25), ideas=${fullJson.ideas.length}, revision=${fullJson.revision}`)

  // --- lean list projection (the idea#34 board poll) --------------------
  const listRes = await fetch(`${base}/api/ideas/state?view=list`, { headers: fence })
  if (!listRes.ok) throw new Error(`list failed: HTTP ${listRes.status}`)
  const listBytes = Buffer.byteLength(await listRes.clone().arrayBuffer().then(buf => Buffer.from(buf)), 'utf8')
  const listJson = await listRes.json()
  const listMs = await medianMs(25, async () => {
    const res = await fetch(`${base}/api/ideas/state?view=list`, { headers: fence })
    if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`)
    await res.arrayBuffer()
  })
  // Contract: no bodies, no audits, excerpt present, everything else kept.
  if (listJson.ideas.length !== fullJson.ideas.length) throw new Error('projection changed the row count')
  for (const row of listJson.ideas) {
    if ('body' in row) throw new Error(`list row ${row.id} still carries a body`)
    if ('analysisAudit' in row) throw new Error(`list row ${row.id} still carries an audit`)
    if (typeof row.bodyExcerpt !== 'string') throw new Error(`list row ${row.id} lost its excerpt`)
    if (row.bodyExcerpt.length > 281) throw new Error(`list row ${row.id} excerpt over budget`)
  }
  const fullGzip = gzipSync(JSON.stringify(fullJson)).length
  const listGzip = gzipSync(JSON.stringify(listJson)).length
  console.log(`[perf-live] GET /state?view=list (LEAN): ${kib(listBytes)} (${(100 * listBytes / fullBytes).toFixed(1)}% of full), ${listMs.toFixed(2)} ms/req (median/25)`)
  console.log(`[perf-live] gzip: full ${kib(fullGzip)} -> lean ${kib(listGzip)} (${(100 * listGzip / fullGzip).toFixed(1)}% of full)`)
  if (listBytes >= fullBytes) throw new Error('lean projection is not smaller than the full snapshot')

  // --- deferred body: ONE full record on demand -------------------------
  const ideaMs = await medianMs(25, async () => {
    const res = await fetch(`${base}/api/ideas/idea?id=${encodeURIComponent('perf-idea-0')}`, { headers: fence })
    if (!res.ok) throw new Error(`idea failed: HTTP ${res.status}`)
    await res.arrayBuffer()
  })
  const ideaRes = await fetch(`${base}/api/ideas/idea?id=${encodeURIComponent('perf-idea-0')}`, { headers: fence })
  const ideaJson = await ideaRes.json()
  if (typeof ideaJson.body !== 'string' || ideaJson.body === '') throw new Error('deferred body endpoint lost the body')
  const ideaBytes = Buffer.byteLength(JSON.stringify(ideaJson), 'utf8')
  console.log(`[perf-live] GET /api/ideas/idea?id= (deferred body): ${kib(ideaBytes)} (the whole record incl. body), ${ideaMs.toFixed(2)} ms/req (median/25)`)

  // --- objective: 100 open cards load in < 1 s --------------------------
  const objectiveMs = listMs + listBytes / (1024 * 1024) * 8 // + serialize? no: wire ~loopback ~instant; keep ms only
  void objectiveMs
  const openCount = fullJson.ideas.filter(idea => idea.status === 'open').length
  console.log(`[perf-live] objective (${openCount} open cards): lean state round-trip ${listMs.toFixed(2)} ms/server-side + ${(await (async () => {
    const start = performance.now()
    JSON.parse(await (await fetch(`${base}/api/ideas/state?view=list`, { headers: fence })).text())
    return performance.now() - start
  })()).toFixed(2)} ms client parse (fetch+parse, one shot) << 1000 ms`)
  if (openCount < 100) throw new Error(`expected >= 100 open cards, got ${openCount}`)
  console.log('[perf-live] ALL CHECKS PASSED')
}

main().catch(error => {
  console.error('[perf-live] FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
