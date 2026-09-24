/**
 * Shared JSON body/response helpers for the ideas host routes. Follows the
 * dsh-task-board family discipline (strict bounded body reader + one JSON
 * writer) so the /api/ideas fence behaves identically to the sibling plugin
 * families without importing any of their code.
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

/** Default body cap for readBoundedJson: 64 KiB. */
const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024

/** Default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

/**
 * Decode an inbound JSON request body to a string, then parse it.
 *
 * RFC 8259 mandates UTF-8 for JSON exchanged outside a closed ecosystem, and
 * the browser (the usual caller of /api/ideas) always sends UTF-8. The
 * ideas-analyst agent, however, is launched through PowerShell 5.1 on Windows:
 * PS 5.1 sends a `-Body <string>` in the system ANSI codepage (windows-1252 on
 * Western/European locales) unless the caller explicitly passes
 * `[Text.Encoding]::UTF8.GetBytes(...)` bytes. A single accented byte (e.g.
 * e-acute = 0xE9) is an invalid UTF-8 lead byte, so Node's lenient
 * `Buffer.toString('utf8')` replaces it with U+FFFD -- and that replacement is
 * LOSSY: the original byte is irrecoverable, so the corruption is persisted
 * into the ledger as a mojibake card and surfaces on every read.
 *
 * The fix lives at the source-of-truth boundary (the moment the agent's bytes
 * become canonical ledger text) so both storage and display are protected:
 *
 *   1. If the bytes are valid UTF-8 (the common case, including CJK), decode
 *      as UTF-8 -- byte-for-byte identical to the previous behavior, so no
 *      regression for correct clients.
 *   2. Otherwise the stream is a raw ANSI codepage (the PowerShell 5.1 trap):
 *      decode as windows-1252. This recovers the Latin-1 accented letters
 *      (e-acute, e-grave, a-circumflex, c-cedilla, ...) AND the CP1252
 *      printable characters in 0x80..0x9F that the analyst emits constantly
 *      (curly apostrophes/quotes, o-ligature, euro). Every byte is defined in
 *      windows-1252, so there is never an unknown byte.
 *
 * Conservative: valid UTF-8 is never reinterpreted (no false repair of correct
 * text); only genuinely-invalid UTF-8 is re-decoded, and that can only happen
 * for single-byte codepage streams (the corruption mode documented above).
 */
export function decodeRequestBody(buffer: Buffer): string {
  const asUtf8 = buffer.toString('utf8')
  // Round-trip test: a byte sequence is valid UTF-8 iff decoding it as UTF-8
  // and re-encoding the result reproduces the exact bytes. Invalid bytes were
  // replaced with U+FFFD (0xEF 0xBF 0xBD), which does NOT round-trip, so a
  // mismatch signals a raw ANSI codepage stream that must be re-decoded.
  if (Buffer.from(asUtf8, 'utf8').equals(buffer)) return asUtf8
  return decodeAsWindows1252(buffer)
}

/**
 * windows-1252 fallback decoder: `toString('latin1')` already maps every byte
 * 0xA0..0xFF to the correct code point (identical to windows-1252 in that
 * range), so only the C1 range 0x80..0x9F needs a lookup table -- that is where
 * windows-1252 defines printable glyphs (euro, curly quotes, o-ligature) that
 * latin1 leaves as control characters. The table is ASCII-only in source
 * (unicode escapes) so the file survives the write tool's double-encoding.
 */
function decodeAsWindows1252(buffer: Buffer): string {
  const CP1252_C1: Record<number, string> = {
    0x80: '\u20ac', // euro sign
    0x82: '\u201a', // single low-9 quotation mark
    0x83: '\u0192', // florin/currency sign
    0x84: '\u201e', // double low-9 quotation mark
    0x85: '\u2026', // horizontal ellipsis
    0x86: '\u2020', // dagger
    0x87: '\u2021', // double dagger
    0x88: '\u02c6', // modifier letter circumflex accent
    0x89: '\u2030', // per mille sign
    0x8a: '\u0160', // S with caron
    0x8b: '\u2039', // single left-pointing angle quotation mark
    0x8c: '\u0152', // O with ligature
    0x8e: '\u017d', // Z with caron
    0x91: '\u2018', // left single quotation mark
    0x92: '\u2019', // right single quotation mark
    0x93: '\u201c', // left double quotation mark
    0x94: '\u201d', // right double quotation mark
    0x95: '\u2022', // bullet
    0x96: '\u2013', // en dash
    0x97: '\u2014', // em dash
    0x98: '\u02dc', // small tilde
    0x99: '\u2122', // trade mark sign
    0x9a: '\u0161', // s with caron
    0x9b: '\u203a', // single right-pointing angle quotation mark
    0x9c: '\u0153', // o with ligature
    0x9e: '\u017e', // z with caron
    0x9f: '\u0178', // Y with diaeresis
  }
  const latin1 = buffer.toString('latin1')
  let out = ''
  for (const ch of latin1) {
    const code = ch.charCodeAt(0)
    out += (code >= 0x80 && code <= 0x9f && CP1252_C1[code] !== undefined) ? CP1252_C1[code]! : ch
  }
  return out
}

/**
 * Strict bounded body reader: parse a request body of at most maxBytes as
 * JSON. Uses {@link decodeRequestBody} so an ANSI-codepage (PowerShell 5.1)
 * body is repaired instead of corrupted to U+FFFD.
 * @throws 'body too large' past the cap, or the JSON.parse error for an
 *   invalid or empty payload.
 */
export async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(buffer)
  }
  return JSON.parse(decodeRequestBody(Buffer.concat(chunks)))
}

/** Whether a value is a JSON object: typeof object, not null, not an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a value to a JSON object, or undefined when it is not one. */
export function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined
}

/**
 * Write one JSON response. Default headers are the family defaults
 * (content-type and referrer-policy); caller headers are appended or
 * override them.
 */
export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(payload)
}
