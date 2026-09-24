/**
 * Encoding round-trip tests (idea #55: mojibake in analyst-generated titles /
 * descriptions). The ideas-analyst agent is launched through PowerShell 5.1 on
 * Windows, which sends a `-Body <string>` in the system ANSI codepage
 * (windows-1252 on Western/European locales) unless the caller explicitly
 * passes UTF-8 bytes. A single accented byte (e.g. e-acute = 0xE9) is an
 * invalid UTF-8 lead byte, so a naive `Buffer.toString('utf8')` replaces it
 * with U+FFFD and the corruption is persisted to the ledger as a mojibake card.
 *
 * These tests pin the fix at the source-of-truth boundary (the ingest decode in
 * `decodeRequestBody`) and prove the full round trip: intended text -> POST
 * bytes -> stored ledger file -> GET /api/ideas/state re-read, for BOTH the
 * valid-UTF-8 transport and the ANSI (PowerShell 5.1) transport. The non-ASCII
 * characters are spelled as \uXXXX escapes so this source file stays ASCII
 * (the write tool double-encodes literal accents).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeasHostService } from '../src/host-service.ts'
import { makeIdeasRoutes } from '../src/host-routes.ts'
import { decodeRequestBody } from '../src/http.ts'
import { IDEAS_API_PREFIX, type IdeasSnapshot } from '../src/protocol.ts'

let dir = ''
let server: Server | undefined
let service: IdeasHostService | undefined

afterEach(async () => {
  const openServer = server
  server = undefined
  if (openServer !== undefined) {
    await new Promise<void>(resolve => { openServer.close(() => { resolve() }) })
  }
  // Dispose BEFORE rm: the ledger holds its lock file (Windows cannot delete
  // an open file) - same discipline as the config-route tests.
  service?.dispose()
  service = undefined
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

function freshService(): IdeasHostService {
  dir = join(tmpdir(), `ideas-encoding-test-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  service = new IdeasHostService({ dir, autoMirror: false })
  return service
}

/** Serve the plugin routes on a real loopback socket. */
async function serve(): Promise<string> {
  const routes = makeIdeasRoutes(freshService())
  const open = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void Promise.resolve(route.handler(req as IncomingMessage, res as ServerResponse)).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => { open.listen(0, '127.0.0.1', () => { resolve() }) })
  server = open
  const address = open.address()
  if (address === null || typeof address === 'string') throw new Error('no listen address')
  return `http://127.0.0.1:${address.port}`
}

/** GET the full snapshot with the browser same-origin marker the fence requires. */
function getState(base: string): Promise<IdeasSnapshot> {
  return fetch(`${base}${IDEAS_API_PREFIX}/state`, { headers: { 'sec-fetch-site': 'same-origin' } })
    .then(response => response.json() as Promise<IdeasSnapshot>)
}

/** POST a raw byte body (the exact bytes the client put on the wire). */
function postRaw(base: string, bytes: Buffer): Promise<Response> {
  return fetch(`${base}${IDEAS_API_PREFIX}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: bytes,
  })
}

/**
 * windows-1252 ENCODER (the inverse of decodeAsWindows1252): the exact bytes a
 * PowerShell 5.1 string body would put on the wire for this text. ASCII and
 * the Latin-1 range are identity; the CP1252 C1 glyphs map through the table.
 */
function encodeCp1252(str: string): Buffer {
  const INV: Record<string, number> = {
    '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85,
    '\u2020': 0x86, '\u2021': 0x87, '\u02c6': 0x88, '\u2030': 0x89, '\u0160': 0x8a,
    '\u2039': 0x8b, '\u0152': 0x8c, '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92,
    '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
    '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b, '\u0153': 0x9c,
    '\u017e': 0x9e, '\u0178': 0x9f,
  }
  const out: number[] = []
  for (const ch of str) {
    const code = ch.codePointAt(0)!
    if (code < 0x80) { out.push(code); continue }
    if (code >= 0xa0 && code <= 0xff) { out.push(code); continue }
    const byte = INV[ch]
    if (byte === undefined) throw new Error(`unmappable for cp1252: ${JSON.stringify(ch)}`)
    out.push(byte)
  }
  return Buffer.from(out)
}

/** True when the buffer is NOT valid UTF-8 (i.e. a raw ANSI codepage stream). */
function isValidUtf8(buffer: Buffer): boolean {
  const asUtf8 = buffer.toString('utf8')
  return Buffer.from(asUtf8, 'utf8').equals(buffer)
}

/** The intended card content, spelled with \uXXXX so the source stays ASCII. */
const TITLE = 'Corriger le mojibake des titres g\u00e9n\u00e9r\u00e9s' // ...générés
const BODY = [
  '## Context',
  "Le board affiche du mojibake : d'id\u00e9es d\u00e9j\u00e0, caf\u00e9 co\u00fbt.", // d'idées déjà, café coût.
  '',
  '## Value',
  'R\u00e9sum\u00e9 \u00e0 caract\u00e8re accentu\u00e9 : caf\u00e9 d\u00e9j\u00e0.', // Résumé à caractère accentué.
].join('\n')
const SUMMARY = 'R\u00e9sum\u00e9 accentu\u00e9 : caf\u00e9 d\u00e9j\u00e0.' // Résumé accentué : café déjà.
const TAGS = [{ name: 'encodage' }, { name: 'utf8' }]

/** Build the create action envelope with a fresh id + requestId. */
function createAction(): Record<string, unknown> {
  const id = `idea-${randomUUID()}`
  return {
    requestId: `req-${randomUUID()}`,
    initiator: 'plugin:ideas-manager:ai-capture',
    action: {
      kind: 'create',
      id,
      input: { title: TITLE, body: BODY, summary: SUMMARY, tags: TAGS },
    },
  }
}

describe('decodeRequestBody (source-of-truth ingest decode)', () => {
  it('passes valid UTF-8 through byte-for-byte (French + CJK + curly quotes)', () => {
    const text = 'Corriger le mojibake : g\u00e9n\u00e9r\u00e9s \u2014 \u4e1c\u4eac \u00ab \u00bb \u0153 \u20ac'
    expect(decodeRequestBody(Buffer.from(text, 'utf8'))).toBe(text)
  })

  it('recovers a windows-1252 (ANSI) byte stream that is invalid UTF-8', () => {
    const text = 'caf\u00e9 d\u00e9j\u00e0 co\u00fbt \u20ac \u00ab \u00bb \u0153' // café déjà coût € « » œ
    const bytes = encodeCp1252(text)
    // Sanity: the raw bytes are NOT valid UTF-8, so a naive toString('utf8')
    // would have corrupted them to U+FFFD (the bug).
    expect(isValidUtf8(bytes)).toBe(false)
    // The fix recovers the intended text exactly.
    expect(decodeRequestBody(bytes)).toBe(text)
  })

  it('recovers curly quotes and euro from their CP1252 C1 bytes', () => {
    const text = "L\u2019application d\u2019id\u00e9es" // L'application d'idées (curly ')
    expect(decodeRequestBody(encodeCp1252(text))).toBe(text)
  })

  it('returns an empty string for an empty body', () => {
    expect(decodeRequestBody(Buffer.alloc(0))).toBe('')
  })
})

describe('HTTP round-trip through the real ingest boundary', () => {
  it('round-trips French + curly quotes over a valid UTF-8 transport', async () => {
    const base = await serve()
    const action = createAction()
    const bytes = Buffer.from(JSON.stringify(action), 'utf8')
    expect(isValidUtf8(bytes)).toBe(true) // the browser / Node fetch always send this

    const response = await postRaw(base, bytes)
    expect(response.status).toBe(200)
    const created = await response.json() as IdeasSnapshot
    const ideaId = created.ideas.find(row => row.title === TITLE)?.id
    expect(ideaId).toBeDefined()

    // After storage: the ledger file holds correct UTF-8 (no U+FFFD, no raw
    // ANSI bytes) for every text field.
    const stored = JSON.parse(readFileSync(join(dir, 'ledger-v2.json'), 'utf8')) as { ideas: Array<Record<string, unknown>> }
    const row = stored.ideas.find(item => item.id === ideaId)!
    expect(row.title).toBe(TITLE)
    expect(row.body).toBe(BODY.trim())
    expect(row.summary).toBe(SUMMARY)
    expect(JSON.stringify(row)).not.toContain('\u{fffd}')

    // After GET re-read: the board sees the same text.
    const snapshot = await getState(base)
    const live = snapshot.ideas.find(row => row.id === ideaId)!
    expect(live.title).toBe(TITLE)
    expect(live.body).toBe(BODY.trim())
    expect(live.summary).toBe(SUMMARY)
  })

  it('round-trips CJK over a valid UTF-8 transport (broader charset)', async () => {
    const base = await serve()
    const action: Record<string, unknown> = {
      requestId: `req-${randomUUID()}`,
      initiator: 'plugin:ideas-manager:ai-capture',
      action: {
        kind: 'create',
        id: `idea-${randomUUID()}`,
        input: { title: '\u4e1c\u4eac\u306e\u30a2\u30a4\u30c7\u30a3\u30a2', body: '## Context\nCJK body \u4e1c\u4eac' },
      },
    }
    const bytes = Buffer.from(JSON.stringify(action), 'utf8')
    const response = await postRaw(base, bytes)
    expect(response.status).toBe(200)
    const created = await response.json() as IdeasSnapshot
    const ideaId = created.ideas.find(row => row.title === '\u4e1c\u4eac\u306e\u30a2\u30a4\u30c7\u30a3\u30a2')?.id
    expect(ideaId).toBeDefined()
    const snapshot = await getState(base)
    const live = snapshot.ideas.find(row => row.id === ideaId)!
    expect(live.title).toBe('\u4e1c\u4eac\u306e\u30a2\u30a4\u30c7\u30a3\u30a2')
    expect(live.body).toBe('## Context\nCJK body \u4e1c\u4eac'.trim())
  })

  it('recovers an ANSI (PowerShell 5.1) transport instead of corrupting to U+FFFD', async () => {
    const base = await serve()
    const action = createAction()
    // The exact bytes a PS 5.1 string body would send: windows-1252, NOT valid
    // UTF-8 (the accented single high bytes are invalid UTF-8 lead bytes).
    const bytes = encodeCp1252(JSON.stringify(action))
    expect(isValidUtf8(bytes)).toBe(false)

    const response = await postRaw(base, bytes)
    expect(response.status).toBe(200)
    const created = await response.json() as IdeasSnapshot
    const ideaId = created.ideas.find(row => row.title === TITLE)?.id
    expect(ideaId).toBeDefined()

    // After storage: the ledger file holds the RECOVERED text, not U+FFFD.
    const stored = JSON.parse(readFileSync(join(dir, 'ledger-v2.json'), 'utf8')) as { ideas: Array<Record<string, unknown>> }
    const row = stored.ideas.find(item => item.id === ideaId)!
    expect(row.title).toBe(TITLE)
    expect(row.body).toBe(BODY.trim())
    expect(row.summary).toBe(SUMMARY)
    expect(JSON.stringify(row)).not.toContain('\u{fffd}')

    // After GET re-read: the board sees the recovered text.
    const snapshot = await getState(base)
    const live = snapshot.ideas.find(row => row.id === ideaId)!
    expect(live.title).toBe(TITLE)
    expect(live.body).toBe(BODY.trim())
    expect(live.summary).toBe(SUMMARY)
  })
})
