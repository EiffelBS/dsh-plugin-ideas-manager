#!/usr/bin/env node
/**
 * reconcile-taskboard-mirror.mjs - clean up orphan duplicate cards left by
 * the pre-#35 TaskBoard mirror (a re-analyze run could mint a second card
 * instead of patching the bound one).
 *
 * Frozen rule (idea #35): a duplicate is ARCHIVED, never deleted; the BOUND
 * card (the idea's taskBoardId) is always the one kept.
 *
 * A card is an orphan duplicate when ALL hold:
 *   - it is NOT archived yet;
 *   - its id is not the taskBoardId of ANY idea in the ledger;
 *   - some idea has the EXACT same title, is bound to a different card, and
 *     that bound twin is present in the live snapshot.
 *
 * Dry-run by default: it only prints what it would archive. Pass --apply to
 * post the archive actions through the same loopback same-origin discipline
 * the mirror itself uses (origin + sec-fetch-site markers).
 *
 * Usage:
 *   node scripts/reconcile-taskboard-mirror.mjs [--url http://127.0.0.1:3102]
 *       [--ledger <path-to-ledger-v2.json>] [--apply]
 *
 * Defaults: --url http://127.0.0.1:3102 (a TEST instance; never point --apply
 * at the 3080 session server without explicit user approval), --ledger
 * $DSH_HOME/ideas/ledger-v2.json else ~/.dsh/ideas/ledger-v2.json.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

const apply = process.argv.includes('--apply')
const base = (argValue('--url') ?? 'http://127.0.0.1:3102').replace(/\/$/, '')
const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const ledgerPath = argValue('--ledger') ?? join(home, 'ideas', 'ledger-v2.json')

function headers(extra = {}) {
  return {
    origin: base,
    'sec-fetch-site': 'same-origin',
    ...extra,
  }
}

async function getJson(path) {
  const response = await fetch(base + path, { headers: headers() })
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`)
  return response.json()
}

async function postAction(action, requestId) {
  const response = await fetch(`${base}/api/task-board/action`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ requestId, action }),
  })
  const body = await response.json().catch(() => undefined)
  return { status: response.status, body }
}

const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
if (!Array.isArray(ledger.ideas)) throw new Error(`unexpected ledger shape: ${ledgerPath}`)
const ideas = ledger.ideas

const state = await getJson('/api/task-board/state')
if (!Array.isArray(state.tasks)) throw new Error('task-board state has no tasks array')
const tasks = state.tasks

const boundIds = new Set(ideas.map(idea => idea.taskBoardId).filter(id => typeof id === 'string' && id !== ''))
const liveIds = new Set(tasks.map(task => task.id).filter(id => typeof id === 'string'))

// ideas with a live bound twin, grouped by exact title
const byTitle = new Map()
for (const idea of ideas) {
  if (typeof idea.taskBoardId !== 'string' || idea.taskBoardId === '') continue
  if (!liveIds.has(idea.taskBoardId)) continue
  const bucket = byTitle.get(idea.title) ?? []
  bucket.push(idea)
  byTitle.set(idea.title, bucket)
}

const candidates = []
for (const task of tasks) {
  if (typeof task.id !== 'string' || typeof task.title !== 'string') continue
  if (task.archivedAt !== undefined) continue // already archived / reconciled
  if (boundIds.has(task.id)) continue // a BOUND card is always kept
  const twins = byTitle.get(task.title)
  if (twins === undefined || twins.length === 0) continue
  const twin = twins[0]
  candidates.push({
    taskId: task.id,
    title: task.title,
    status: task.status,
    keptTaskId: twin.taskBoardId,
    ideaNumber: twin.ideaNumber,
    ideaId: twin.id,
  })
}

console.log(`ledger : ${ledgerPath} (${ideas.length} ideas, ${boundIds.size} bound cards)`)
console.log(`board  : ${base}/api/task-board/state (${tasks.length} cards)`)
console.log(`rule   : archive the unbound duplicate, keep the bound card (never delete)`)
if (candidates.length === 0) {
  console.log('result : no orphan duplicates found - nothing to do')
  process.exit(0)
}

for (const candidate of candidates) {
  console.log(`candidate: ${candidate.taskId}`)
  console.log(`  title    : ${candidate.title}`)
  console.log(`  duplicate of idea #${candidate.ideaNumber} (${candidate.ideaId}), bound card kept: ${candidate.keptTaskId}`)
}

if (!apply) {
  console.log(`dry-run : ${candidates.length} orphan duplicate(s) would be archived (re-run with --apply to execute)`)
  process.exit(0)
}

let archived = 0
let failed = 0
for (const candidate of candidates) {
  const result = await postAction(
    { kind: 'archive', taskId: candidate.taskId },
    `reconcile-${Date.now()}-${candidate.taskId}`,
  )
  if (result.status >= 200 && result.status < 300) {
    archived += 1
    console.log(`archived: ${candidate.taskId}`)
  } else {
    failed += 1
    console.log(`FAILED  : ${candidate.taskId} -> ${result.status} ${JSON.stringify(result.body ?? {})}`)
  }
}
console.log(`result : ${archived} archived, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
