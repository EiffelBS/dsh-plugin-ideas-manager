/**
 * P3 one-shot OT migration: parse the OpenTimbre IDEAS.md / IDEAS-ARCHIVE.md
 * capture documents into import payloads for the ideas ledger `/api/ideas`
 * `import` verb.
 *
 * Faithful mapping (documented in README.md §Migration):
 * - a `## Idea #N ...` section -> one idea `{ id: "ot-<N>", title, body, status }`
 * - IDEAS.md sections -> `open`; IDEAS-ARCHIVE.md sections -> `archived`,
 *   except the `DECLINED` ones -> `declined`
 * - `createdAt` from the first `captured YYYY-MM-DD` (or `DELIVERED …`) date
 *   in the heading; `archivedAt` (non-open) from the first
 *   `DELIVERED`/`DECLINED YYYY-MM-DD` date; both fall back to "now" when the
 *   heading carries no parseable date
 * - `workspaceId`: the target workspace resolved by TITLE in the target
 *   registry (default title "OpenTimbre"); `--workspace <id>` overrides;
 *   the legacy "ot" id remains the fallback when no registry/title match
 * - `rank`: from the "Suggested priority" table when it ranks the idea
 * - the body is kept verbatim (the recipe is the value)
 *
 * Run modes: no flag = dry-run (prints the counts + a per-idea summary, POSTs
 * nothing); `--apply` (with `--ideas <path> --archive <path> --base <origin>`)
 * POSTs the import envelope to `{base}/api/ideas/action` over loopback with
 * the family same-origin markers.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { homedir } from 'node:os'

export const OT_IMPORT_SOURCE_ID = 'ot-ideas-v1'
const OT_WORKSPACE_ID = 'ot'
const OT_WORKSPACE_TITLE = 'OpenTimbre'
/** Default target workspace registry (DSH storages) for title resolution. */
const DEFAULT_REGISTRY = join(homedir(), '.dsh', 'storages', 'workspace.json')
const DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/
const HEADING_RE = /^## Idea #(\d+)/
const PRIORITY_ROW_RE = /^\|\s*(\d+)\s*\|\s*#(\d+)(?:\s*\([^)]*\))*\s*\|/

/** Parseable date -> epoch ms at UTC midnight; undefined for junk years. */
function dateToMs(raw) {
  if (raw === undefined) return undefined
  const match = String(raw).match(DATE_RE)
  if (match === null) return undefined
  const year = Number(match[1])
  if (year < 2020 || year > 2100) return undefined
  const ms = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`)
  return Number.isNaN(ms) ? undefined : ms
}

/** First capture/delivery date found anywhere in the heading line. */
function dateInHeading(heading) {
  const match = heading.match(DATE_RE)
  return match === null ? undefined : dateToMs(match[0])
}

/**
 * Split a heading's title away from the `*(…)*` meta suffix and the
 * `Idea #N <labels> <sep>` prefix. Falls back to the whole region when the
 * shape does not match.
 */
export function titleFromHeading(rawHeading) {
  const region = rawHeading.replace(/^\s*##\s+/, '').replace(/\s*\*\(.*\)\*$/, '').trim()
  const match = region.match(/^Idea #\d+(?:\s*\([^)]*\))*\s*(?:—|-)\s*(.+)$/)
  return match === null ? region : match[1].trim()
}

/**
 * Parse one OT capture document (IDEAS.md or IDEAS-ARCHIVE.md text).
 * @param {string} text - the document content, UTF-8.
 * @param {{ status: 'open'|'archived'|'declined', ranks?: Map<number, number>, now?: number, workspaceId?: string }} options
 * @returns {{ ideas: Array<object>, sections: number }}
 */
export function parseOtIdeasDocument(text, options) {
  const now = options.now ?? Date.now()
  const workspaceId = options.workspaceId ?? OT_WORKSPACE_ID
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const ideas = []
  let sections = 0
  let current
  const flush = () => {
    if (current === undefined) return
    const status = /DECLINED/i.test(`${current.heading}\n${current.body.join('\n')}`) ? 'declined' : options.status
    const createdAt = dateInHeading(current.heading) ?? now
    const rank = options.ranks === undefined ? undefined : options.ranks.get(current.number)
    ideas.push({
      id: `ot-${current.number}`,
      title: titleFromHeading(current.heading),
      body: current.body.join('\n').trim(),
      status,
      ...(rank === undefined ? {} : { rank }),
      ...(status === 'open' ? {} : { archivedAt: dateInHeading(current.heading) ?? now }),
      createdAt,
      updatedAt: now,
      workspaceId,
    })
    sections += 1
    current = undefined
  }
  for (const line of lines) {
    const match = line.match(HEADING_RE)
    if (match !== null) {
      flush()
      current = { number: Number(match[1]), heading: line, body: [] }
      continue
    }
    if (current !== undefined) current.body.push(line)
  }
  flush()
  return { ideas, sections }
}

/**
 * Parse the "Suggested priority" table of IDEAS.md into `idea #N -> rank`.
 * Only rows that look like `| <rank> | #<id> | …` are read.
 */
export function parseOtPriorityRanks(text) {
  const ranks = new Map()
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match = line.match(PRIORITY_ROW_RE)
    if (match !== null) ranks.set(Number(match[2]), Number(match[1]))
  }
  return ranks
}

/** Read both OT documents and return the merged import rows, deduped by id. */
export function parseOtMigration(ideasMd, archiveMd, options = {}) {
  const ranks = parseOtPriorityRanks(ideasMd)
  const open = parseOtIdeasDocument(ideasMd, { status: 'open', ranks, ...options }).ideas
  const closed = parseOtIdeasDocument(archiveMd, { status: 'archived', ...options }).ideas
  // On id collisions (the OT docs hard-split an idea, e.g. #15 has an open
  // "(remaining)" backlog slice AND a DELIVERED "(slice)" archive record) the
  // live backlog wins: the archive doc stays the history of record, and the
  // board keeps the open work. The collision is counted, not silenced.
  const byId = new Map()
  let collisions = 0
  for (const row of [...open, ...closed]) {
    if (byId.has(row.id)) {
      collisions += 1
      continue
    }
    byId.set(row.id, row)
  }
  const ideas = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  return {
    ideas,
    open: ideas.filter((row) => row.status === 'open'),
    archived: ideas.filter((row) => row.status === 'archived'),
    declined: ideas.filter((row) => row.status === 'declined'),
    collisions,
  }
}

/**
 * Resolve the target workspace id for the OT migration.
 * Precedence: explicit `--workspace` id > a single TITLE match in the target
 * workspace registry (`tables.workspaces`, DSH storages) > the legacy "ot"
 * fallback. Ambiguous titles pick the first match and warn; a missing or
 * unreadable registry warns and falls back.
 * @param {{ explicit?: string, registryPath?: string, title?: string }} options
 * @returns {{ workspaceId: string, via: string }}
 */
export function resolveWorkspaceId(options) {
  const explicit = options.explicit === undefined ? undefined : options.explicit.trim()
  if (explicit !== undefined && explicit !== '') {
    return { workspaceId: explicit, via: '--workspace' }
  }
  const registryPath = options.registryPath === undefined ? undefined : options.registryPath.trim()
  const title = (options.title ?? OT_WORKSPACE_TITLE).trim()
  if (registryPath === undefined || registryPath === '') {
    console.error(`[migrate-ot-ideas] no --registry supplied; using legacy workspace "${OT_WORKSPACE_ID}"`)
    return { workspaceId: OT_WORKSPACE_ID, via: 'legacy fallback ("ot")' }
  }
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'))
    const table = parsed?.tables?.workspaces
    if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
      const wanted = title.toLowerCase()
      const matches = Object.entries(table)
        .filter(([, row]) => row !== null && typeof row === 'object' && typeof row.title === 'string' && row.title.trim().toLowerCase() === wanted)
        .map(([id, row]) => ({ id, title: row.title }))
      if (matches.length === 1) {
        return { workspaceId: matches[0].id, via: `title "${title}" in ${registryPath}` }
      }
      if (matches.length > 1) {
        console.error(`[migrate-ot-ideas] ${matches.length} workspaces titled "${title}"; using ${matches[0].id} (pass --workspace to disambiguate)`)
        return { workspaceId: matches[0].id, via: 'first title match (ambiguous)' }
      }
      console.error(`[migrate-ot-ideas] no workspace titled "${title}" in ${registryPath}; using legacy "${OT_WORKSPACE_ID}"`)
    } else {
      console.error(`[migrate-ot-ideas] registry ${registryPath} has no tables.workspaces map; using legacy "${OT_WORKSPACE_ID}"`)
    }
  } catch (error) {
    console.error(`[migrate-ot-ideas] workspace registry unreadable (${error instanceof Error ? error.message : String(error)}); using legacy "${OT_WORKSPACE_ID}"`)
  }
  return { workspaceId: OT_WORKSPACE_ID, via: 'legacy fallback ("ot")' }
}

function flagOf(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    if (arg === name && i + 1 < argv.length) return argv[i + 1]
  }
  return undefined
}

function postJson(url, body) {
  const parsed = new URL(url)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          origin: `${parsed.protocol}//${parsed.host}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', (error) => reject(error))
      },
    )
    outgoing.setTimeout(15_000)
    outgoing.on('error', (error) => reject(error))
    outgoing.write(payload)
    outgoing.end()
  })
}

async function main(argv) {
  const apply = argv.includes('--apply')
  const ideasPath = flagOf(argv, '--ideas')
  const archivePath = flagOf(argv, '--archive')
  const base = flagOf(argv, '--base') ?? 'http://127.0.0.1:3101'
  const workspace = resolveWorkspaceId({
    explicit: flagOf(argv, '--workspace'),
    registryPath: flagOf(argv, '--registry') ?? DEFAULT_REGISTRY,
    title: flagOf(argv, '--workspace-title'),
  })
  if (ideasPath === undefined || archivePath === undefined) {
    console.error('usage: migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md> [--base <origin>] [--registry <workspace.json>] [--workspace-title <title>] [--workspace <id>] [--export-out <dir>] [--apply]')
    return 1
  }
  const parsed = parseOtMigration(readFileSync(ideasPath, 'utf8'), readFileSync(archivePath, 'utf8'), { workspaceId: workspace.workspaceId })
  console.log(`OT migration: ${parsed.ideas.length} ideas (${parsed.open.length} open, ${parsed.archived.length} archived, ${parsed.declined.length} declined${parsed.collisions > 0 ? `; ${parsed.collisions} split-idea collision(s) resolved toward the open backlog` : ''}) -> workspace "${workspace.workspaceId}" (${workspace.via})`)
  for (const row of parsed.ideas) {
    const rank = row.rank === undefined ? '-' : String(row.rank)
    console.log(`  ${row.id.padEnd(7)} rank ${rank.padEnd(3)} ${row.status.padEnd(8)} ${row.title}`)
  }
  if (!apply) {
    console.log('dry-run (no POST). Pass --apply to import.')
  } else {
    const envelope = {
      requestId: 'ot-migration-v1',
      action: { kind: 'import', sourceId: OT_IMPORT_SOURCE_ID, ideas: parsed.ideas },
    }
    const httpResult = await postJson(`${base}/api/ideas/action`, envelope)
    console.log(`POST ${base}/api/ideas/action -> HTTP ${httpResult.status}`)
    if (httpResult.status < 200 || httpResult.status >= 300) return 2
  }
  const exportOut = flagOf(argv, '--export-out')
  if (exportOut !== undefined) {
    // Fresh request id per export: a replayed id is deduped by the Host and
    // returns the state without the markdown payload.
    const result = await postJson(`${base}/api/ideas/action`, {
      requestId: `ot-export-review-${randomUUID()}`,
      action: { kind: 'export', workspaceId: workspace.workspaceId },
    })
    if (result.status < 200 || result.status >= 300) {
      console.error(`export POST -> HTTP ${result.status}: ${result.body}`)
      return 3
    }
    const body = JSON.parse(result.body)
    const out = body?.export
    if (out === undefined || typeof out.ideasMd !== 'string' || typeof out.archiveMd !== 'string') {
      console.error('export response missing the markdown payload:', result.body.slice(0, 200))
      return 3
    }
    mkdirSync(exportOut, { recursive: true })
    writeFileSync(join(exportOut, 'IDEAS.generated.md'), out.ideasMd, 'utf8')
    writeFileSync(join(exportOut, 'IDEAS-ARCHIVE.generated.md'), out.archiveMd, 'utf8')
    console.log(`export saved to ${exportOut} (${Buffer.byteLength(out.ideasMd)} B + ${Buffer.byteLength(out.archiveMd)} B)`)
  }
  return 0
}

const isDirect = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) {
  process.exitCode = await main(process.argv.slice(2))
}