#!/usr/bin/env node
/**
 * reassign-workspace.mjs - batch re-home every idea and task card from one
 * DSH workspace to another, WITHOUT touching the ledger files.
 *
 * WHY AN HTTP BATCH AND NOT A FILE EDIT
 * Both ledgers are Host-authoritative and single-writer: the running server
 * holds the document in memory and rewrites it on the next commit, so editing
 * `~/.dsh/ideas/ledger-v2.json` (or `~/.dsh/task-board/ledger-v2.json`) behind
 * a live instance is lost work. The wire verbs already carry the field:
 *
 *   POST /api/ideas/action      { kind: 'update', ideaId, patch: { workspaceId } }
 *   POST /api/task-board/action { kind: 'update', taskId,  patch: { workspaceId } }
 *
 * Both patches only move the record between `rankGroupKey(status, workspaceId)`
 * groups and bump `updatedAt`; nothing else is touched, so statuses, ranks,
 * tags, bodies, executions and the idea <-> card binding survive.
 *
 * USAGE
 *   node scripts/reassign-workspace.mjs --from <uuid> --to <uuid> [--base URL]
 *   node scripts/reassign-workspace.mjs ... --apply      # dry-run otherwise
 *
 * OPTIONS
 *   --base    DSH origin (default http://127.0.0.1:3080)
 *   --from    source workspaceId (required)
 *   --to      destination workspaceId (required)
 *   --scope   ideas | board | both   (default both)
 *   --apply   perform the writes; without it the script only reports
 *   --archived  also re-home ARCHIVED task cards (restore -> update ->
 *             archive round-trip; the board rejects any other write on an
 *             archived card, and `restore` clears `archivedAt` only, so the
 *             status, tags, executions and schedule survive the round-trip)
 *   --limit   stop after N records per ledger (safety rehearsal)
 *   --backup  snapshot path (default: os tmpdir + /dsh-reassign-<ts>.json)
 *
 * Exit code 0 = every planned record landed on `--to` (dry-run: plan is
 * consistent), 1 = any refusal or any leftover source record.
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) return fallback
  return value
}

const base = (flag('base', 'http://127.0.0.1:3080')).replace(/\/$/, '')
const from = flag('from')
const to = flag('to')
const scope = flag('scope', 'both')
const apply = argv.includes('--apply')
const includeArchived = argv.includes('--archived')
const limit = Number(flag('limit', '0')) || 0

if (from === undefined || to === undefined) {
  console.error('usage: node scripts/reassign-workspace.mjs --from <uuid> --to <uuid> [--base URL] [--scope ideas|board|both] [--limit N] [--apply]')
  process.exit(1)
}
if (from === to) {
  console.error('refusing: --from and --to are the same workspace')
  process.exit(1)
}
if (!['ideas', 'board', 'both'].includes(scope)) {
  console.error(`refusing: unknown --scope ${scope}`)
  process.exit(1)
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

async function postJson(path, action, tag) {
  // A replayed requestId answers WITHOUT its payload (the dedupe cache), so
  // every single call carries a fresh one.
  const response = await fetch(base + path, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      requestId: `reassign-ws-${tag}-${randomUUID()}`,
      action,
      initiator: 'plugin:ideas-manager:reassign-workspace',
    }),
  })
  let body
  try { body = await response.json() } catch { body = undefined }
  if (!response.ok) {
    throw new Error(`POST ${path} ${action.kind} -> ${response.status}: ${body?.error ?? JSON.stringify(body)}`)
  }
  return body
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = flag('backup', join(tmpdir(), `dsh-reassign-${stamp}.json`))

const state = await getJson('/api/ideas/state')
const board = await getJson('/api/task-board/state')

writeFileSync(backupPath, JSON.stringify({ base, from, to, ideas: state, board }, null, 1), 'utf8')
console.log(`base    ${base}`)
console.log(`from    ${from}`)
console.log(`to      ${to}`)
console.log(`revisions ideas=${state.revision} board=${board.revision}`)
console.log(`backup   ${backupPath}`)

const ideas = state.ideas.filter(idea => idea.workspaceId === from)
const onBoard = board.tasks.filter(task => task.workspaceId === from)
const liveTasks = onBoard.filter(task => task.archivedAt === undefined)
const archivedTasks = onBoard.filter(task => task.archivedAt !== undefined)
const tasks = includeArchived ? onBoard : liveTasks

const title = (row) => `#${row.ideaNumber ?? '?'} ${row.title}`
const taskTitle = (row) => `${row.status} | ${row.title}`

console.log('')
console.log(`ideas on ${from}: ${ideas.length}`)
for (const idea of ideas.slice(0, 12)) console.log(`  ${title(idea)}`)
if (ideas.length > 12) console.log(`  ... +${ideas.length - 12} more`)
console.log(`tasks on ${from}: ${onBoard.length} (${liveTasks.length} on the board, ${archivedTasks.length} archived)`)
for (const task of tasks.slice(0, 12)) console.log(`  ${task.archivedAt === undefined ? '' : '[archived] '}${taskTitle(task)}`)
if (tasks.length > 12) console.log(`  ... +${tasks.length - 12} more`)
if (archivedTasks.length > 0 && !includeArchived) {
  console.log(`note: ${archivedTasks.length} archived card(s) need --archived (the board refuses every write on an archived card).`)
}

if (!apply) {
  console.log('')
  console.log(`dry run - nothing written. Re-run with --apply to move them.`)
  process.exit(0)
}

const plannedIdeas = limit > 0 ? ideas.slice(0, limit) : ideas
const plannedTasks = limit > 0 ? tasks.slice(0, limit) : tasks
const plannedArchived = limit > 0 ? archivedTasks.slice(0, limit) : archivedTasks

let failed = 0

if (scope === 'ideas' || scope === 'both') {
  for (const idea of plannedIdeas) {
    try {
      const result = await postJson('/api/ideas/action', {
        kind: 'update',
        ideaId: idea.id,
        patch: { workspaceId: to },
      }, 'idea')
      const revision = result?.state?.revision ?? '?'
      console.log(`idea ${title(idea)} -> ${to} (revision ${revision})`)
    } catch (error) {
      failed += 1
      console.error(`idea FAILED ${title(idea)}: ${error.message}`)
    }
  }
}

// The mirror sends `workspaceId: idea.workspaceId` on every ensure, so the
// ideas pass above already re-homes its cards; the direct pass covers the
// cards that were never bound to an idea.
if (scope === 'board' || scope === 'both') {
  for (const task of plannedTasks.filter(row => row.archivedAt === undefined)) {
    try {
      await postJson('/api/task-board/action', {
        kind: 'update',
        taskId: task.id,
        patch: { workspaceId: to },
      }, 'task')
      console.log(`task ${taskTitle(task)} -> ${to}`)
    } catch (error) {
      failed += 1
      console.error(`task FAILED ${taskTitle(task)}: ${error.message}`)
    }
  }

  if (plannedArchived.length > 0) {
    // Round-trip the archived cards: the board refuses `update` while
    // `archivedAt` is set, and `restore` clears that field alone (status,
    // tags, executions and schedule are untouched). A restore also revives the
    // card's archived ancestors and subtasks, so the revived set is measured,
    // not assumed.
    // Every card archived BEFORE the round-trip, so a restore that also pulled
    // an ancestor or a subtask out of the archive is measured, not assumed.
    const wasArchived = new Map(board.tasks.map(task => [task.id, task.archivedAt !== undefined]))
    for (const task of plannedArchived) {
      try {
        await postJson('/api/task-board/action', { kind: 'restore', taskId: task.id }, 'restore')
      } catch (error) {
        failed += 1
        console.error(`task RESTORE FAILED ${taskTitle(task)}: ${error.message}`)
      }
    }
    const mid = await getJson('/api/task-board/state')
    const revived = mid.tasks.filter(task => task.archivedAt === undefined && wasArchived.get(task.id) === true)
    for (const task of revived) {
      try {
        if (task.workspaceId === from) {
          await postJson('/api/task-board/action', {
            kind: 'update',
            taskId: task.id,
            patch: { workspaceId: to },
          }, 'task-archived')
        }
        console.log(`task [archived] ${taskTitle(task)} -> ${task.workspaceId === from ? to : `(untouched, ws ${task.workspaceId ?? 'none'})`}`)
      } catch (error) {
        failed += 1
        console.error(`task FAILED ${taskTitle(task)}: ${error.message}`)
      }
    }
    for (const task of revived) {
      try {
        await postJson('/api/task-board/action', { kind: 'archive', taskId: task.id }, 'archive')
      } catch (error) {
        failed += 1
        console.error(`task RE-ARCHIVE FAILED ${taskTitle(task)}: ${error.message}`)
      }
    }
    console.log(`archived cards re-homed: ${revived.length} (all ${revived.length} re-archived)`)
  }
}

const after = await getJson('/api/ideas/state?view=list')
const afterBoard = await getJson('/api/task-board/state')
const leftIdeas = after.ideas.filter(idea => idea.workspaceId === from)
const leftTasks = afterBoard.tasks.filter(task => task.workspaceId === from)
const nowIdeas = after.ideas.filter(idea => idea.workspaceId === to).length
const nowTasks = afterBoard.tasks.filter(task => task.workspaceId === to).length

console.log('')
console.log(`remaining on ${from}: ideas=${leftIdeas.length} tasks=${leftTasks.length}`)
console.log(`now on ${to}:         ideas=${nowIdeas} tasks=${nowTasks}`)

if (failed > 0 || leftIdeas.length > 0 || leftTasks.length > 0) {
  console.error(`INCOMPLETE: ${failed} refused write(s), ${leftIdeas.length + leftTasks.length} record(s) still on the source workspace.`)
  process.exit(1)
}
console.log('done.')
