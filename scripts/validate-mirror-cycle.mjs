#!/usr/bin/env node
/**
 * validate-mirror-cycle.mjs - live acceptance run for idea #35 against a RUNNING
 * test instance (DSH_HOME scratch, free port; NEVER the 3080 session server):
 *
 *   create -> re-analyze -> analyst rewrite (update+triage) -> archive
 *
 * asserting the TaskBoard mirror ends with EXACTLY ONE card for the idea:
 *   1. /api/ideas/state and /api/task-board/state both answer;
 *   2. create binds the DETERMINISTIC card id (`idea-` + idea.id);
 *   3. the board holds exactly one card for the idea (backlog);
 *   4. the re-analyze verb mirrors nothing (still one card);
 *   5. the analyst update+triage PATCHES that card (title changes in place,
 *      still one card, same id) - the #35 acceptance;
 *   6. contract probe: task-board rejects a create of the bound id with
 *      400 `task id already exists` (why the bridge is get-before-create);
 *   7. under-review poll: the bound card is marked done (runner-owned status,
 *      set through the import path) and the OPEN idea must move to
 *      `underReview` within one 30 s poll cycle;
 *   8. decline archives the SAME card (create -> ... -> archive cycle).
 *
 * Usage: node scripts/validate-mirror-cycle.mjs [--base http://127.0.0.1:3102]
 * Exit code 0 = all steps passed.
 */

import { randomUUID } from 'node:crypto'

const base = (process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:3102').replace(/\/$/, '')

let step = 0
function ok(message) {
  step += 1
  console.log(`step ${step}: ${message}`)
}
function fail(message) {
  console.error(`FAILED at step ${step + 1}: ${message}`)
  process.exit(1)
}
function check(condition, message) {
  if (!condition) fail(message)
}

const headers = (extra = {}) => ({
  origin: base,
  'sec-fetch-site': 'same-origin',
  ...extra,
})

async function getJson(path) {
  const response = await fetch(base + path, { headers: headers() })
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`)
  return response.json()
}

async function postJson(path, payload) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  let body
  try { body = await response.json() } catch { body = undefined }
  return { status: response.status, body }
}

const ideasAction = (action, tag) => postJson('/api/ideas/action', {
  requestId: `validate35-${tag}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  action,
})

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(label, predicate, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return
    await sleep(250)
  }
  fail(`timeout waiting for: ${label}`)
}

function cardsFor(board, title) {
  return board.tasks.filter(task => task.title === title)
}

// --- 1. both APIs answer -----------------------------------------------------
const ideas0 = await getJson('/api/ideas/state').catch(error => { fail(`ideas state unreachable: ${error.message}`) })
const board0 = await getJson('/api/task-board/state').catch(error => { fail(`task-board state unreachable: ${error.message}`) })
check(Array.isArray(ideas0.ideas), 'ideas state has no ideas array')
check(Array.isArray(board0.tasks), 'task-board state has no tasks array')
ok(`both APIs live (ideas=${ideas0.ideas.length}, cards=${board0.tasks.length})`)

// --- 2. create + deterministic binding --------------------------------------
const ideaId = randomUUID()
const title = `Mirror cycle #35 ${Date.now()}`
const seedBody = `Cycle validation body: ${'lorem ipsum dolor sit amet '.repeat(80)}`
const created = await ideasAction({ kind: 'create', id: ideaId, input: { title, body: seedBody } }, 'create')
check(created.status === 200, `create -> ${created.status}`)
await waitFor('the deterministic card binding', async () => {
  const state = await getJson('/api/ideas/state')
  return state.ideas.find(idea => idea.id === ideaId)?.taskBoardId !== undefined
})
const bound = (await getJson('/api/ideas/state')).ideas.find(idea => idea.id === ideaId).taskBoardId
check(bound === `idea-${ideaId}`, `binding is ${bound}, expected deterministic idea-${ideaId}`)
ok(`create bound the DETERMINISTIC card id ${bound}`)

// --- 3. exactly one card, light description ---------------------------------
await waitFor('exactly one card for the idea', async () => cardsFor(await getJson('/api/task-board/state'), title).length === 1)
let cards = cardsFor(await getJson('/api/task-board/state'), title)
check(cards[0].id === bound, `card id ${cards[0].id} != bound ${bound}`)
check(cards[0].status === 'backlog', `card status ${cards[0].status}, expected backlog`)
// Weight contract: description <= ~300 chars (derived excerpt, no summary
// yet), full body still riding the prompt.
check(cards[0].description.length <= 305, `description too heavy: ${cards[0].description.length} chars`)
check(cards[0].prompt.includes('Cycle validation body'), 'prompt must keep the full body')
ok('board holds exactly one backlog card, light description, full-body prompt')

// --- 4. re-analyze mirrors nothing ------------------------------------------
const reanalyzed = await ideasAction({ kind: 'reanalyze', ideaId }, 'reanalyze')
check(reanalyzed.status === 200, `reanalyze -> ${reanalyzed.status}`)
await sleep(750)
cards = cardsFor(await getJson('/api/task-board/state'), title)
check(cards.length === 1, `re-analyze changed the card count to ${cards.length}`)
ok('re-analyze verb mirrored nothing (still one card)')

// --- 5. analyst rewrite patches in place ------------------------------------
const rewritten = `${title} - rewritten`
const rewriteSummary = 'Rewritten summary for the review (<= 300 chars).'
const updated = await ideasAction({ kind: 'update', ideaId, patch: { title: rewritten, body: 'Rewritten analysis body.', summary: rewriteSummary } }, 'update')
check(updated.status === 200, `update -> ${updated.status}`)
const triaged = await ideasAction({ kind: 'triage', ideaId, patch: { value: 3, effort: 1, rank: 1 } }, 'triage')
check(triaged.status === 200, `triage -> ${triaged.status}`)
await waitFor('the rewritten card title', async () => {
  const board = await getJson('/api/task-board/state')
  return cardsFor(board, rewritten).length === 1
})
cards = cardsFor(await getJson('/api/task-board/state'), rewritten)
check(cards.length === 1, `rewrite produced ${cards.length} cards with the new title`)
check(cards[0].id === bound, `rewrite rebound the card: ${cards[0].id} != ${bound}`)
check(cards[0].description === rewriteSummary, `description is not the wire summary: ${cards[0].description}`)
check(cardsFor(await getJson('/api/task-board/state'), title).length === 0, 'old-title card still present (a duplicate)')
const bindingAfter = (await getJson('/api/ideas/state')).ideas.find(idea => idea.id === ideaId).taskBoardId
check(bindingAfter === bound, `binding drifted to ${bindingAfter}`)
ok('analyst update PATCHED the bound card in place: one card, same id, description = summary')

// --- 6. contract probe: duplicate create is refused --------------------------
const clash = await postJson('/api/task-board/action', {
  requestId: `validate35-clash-${Date.now()}`,
  action: { kind: 'create', id: bound, input: { title: 'should clash', description: '', prompt: '' } },
})
check(clash.status === 400, `duplicate create returned ${clash.status}, expected 400`)
check(String(clash.body?.error).includes('task id already exists'), `unexpected error: ${JSON.stringify(clash.body)}`)
ok('task-board refuses create of an existing id (400 task id already exists)')

// --- 7. under-review poll: done -> underReview ------------------------------
// `done` is runner-owned on the board (MANUAL_STATUSES = backlog/todo), so the
// the acceptance run marks the bound card done through the import path (the newer
// updatedAt wins the merge), exactly like a settled run would. The state must
// be fully readable here: a >cap snapshot would hang the poll forever (the
// 2026-09-22 production incident: 190,947-byte state vs 128 KiB cap).
const boardBeforeFlip = await getJson('/api/task-board/state')
const boundCard = boardBeforeFlip.tasks.find(task => task.id === bound)
check(boundCard !== undefined, 'bound card missing before the poll step')
const flip = await postJson('/api/task-board/action', {
  requestId: `validate35-poll-${Date.now()}`,
  action: {
    kind: 'import',
    sourceId: `validate35-poll-${Date.now()}`,
    tasks: [{ ...boundCard, status: 'done', updatedAt: Date.now() + 60_000 }],
  },
})
check(flip.status === 200, `done flip via import -> ${flip.status}`)
await waitFor('the under-review transition (poll interval 30 s)', async () => {
  const state = await getJson('/api/ideas/state')
  return state.ideas.find(idea => idea.id === ideaId)?.status === 'underReview'
}, 160)
ok('under-review poll moved the open idea to underReview once its card hit done')

// --- 8. decline archives the same card --------------------------------------
const declined = await ideasAction({ kind: 'decline', ideaId, decision: 'cycle validation' }, 'decline')
check(declined.status === 200, `decline -> ${declined.status}`)
await waitFor('the card to archive', async () => {
  const board = await getJson('/api/task-board/state')
  const card = board.tasks.find(task => task.id === bound)
  return card !== undefined && card.archivedAt !== undefined
})
const board = await getJson('/api/task-board/state')
check(board.tasks.filter(task => task.id === bound).length === 1, 'bound card vanished on decline')
check(cardsFor(board, rewritten).length === 1, 'archived card lost its title')
ok('decline archived the SAME card (cycle complete: one card total)')

console.log('PASS: full cycle create -> re-analyze -> update -> under-review -> archive kept ONE card')
