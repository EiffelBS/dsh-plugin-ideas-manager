#!/usr/bin/env node
/**
 * Scan a ledger JSON document for mojibake in every string field of the idea
 * records (title, summary, tags, rationale, decision, body, audit). Two
 * detectors:
 *
 *  1. U+FFFD replacement character - the signature of bytes that were NOT
 *     valid UTF-8 when the server decoded the request body (e.g. a CP1252
 *     byte from a PowerShell 5.1 string body).
 *  2. Double-encoded UTF-8: the text was encoded as UTF-8, then those bytes
 *     were misread as CP1252/Latin-1 and re-saved (the DSH write-tool
 *     mangling signature, "Ã©" instead of "é"). Detection: the string can be
 *     re-encoded to CP1252 single bytes and decoded as strict UTF-8 back to
 *     a DIFFERENT valid text. Legitimate French text almost never survives
 *     that round trip (two raw 0xE9 bytes are not a valid UTF-8 sequence), so
 *     a hit is a strong corruption signal, not a false positive.
 *
 * Usage: node scripts/scan-mojibake.mjs <ledger.json> [more.json ...]
 * Exit code 1 when any field is flagged, 0 when clean (2 = unreadable file).
 */

import { readFileSync } from 'node:fs'

const cp1252 = new TextDecoder('windows-1252')
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Build the codepoint->byte table once by probing the windows-1252 decoder. */
const byteTable = new Map()
for (let byte = 0x80; byte < 0x100; byte += 1) {
  const ch = cp1252.decode(new Uint8Array([byte]))
  if (!byteTable.has(ch)) byteTable.set(ch, byte)
}

function cp1252ByteOf(ch) {
  return byteTable.get(ch) ?? -1
}

/** True when `text` is double-encoded UTF-8 (repairable to a different text). */
function looksDoubleEncoded(text) {
  if (!/[\u0080-\u00ff]/.test(text)) return false
  const bytes = []
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x80) { bytes.push(code); continue }
    const byte = cp1252ByteOf(ch)
    if (byte === -1) return false
    bytes.push(byte)
  }
  try {
    const repaired = strictUtf8.decode(Uint8Array.from(bytes))
    return repaired !== text && repaired.length > 0
  } catch {
    return false
  }
}

function* walkStrings(value, path) {
  if (typeof value === 'string') {
    yield [path, value]
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) yield* walkStrings(value[i], `${path}[${i}]`)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) yield* walkStrings(child, `${path}.${key}`)
  }
}

let flagged = 0
for (const file of process.argv.slice(2)) {
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`unreadable: ${file}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    continue
  }
  const ideas = Array.isArray(doc.ideas) ? doc.ideas : []
  for (const idea of ideas) {
    if (typeof idea !== 'object' || idea === null) continue
    for (const [path, text] of walkStrings(idea, `ideas[${idea.id ?? '?'}]`)) {
      const problems = []
      if (text.includes('\u{fffd}')) problems.push('U+FFFD replacement char')
      if (looksDoubleEncoded(text)) problems.push('double-encoded UTF-8')
      if (problems.length > 0) {
        flagged += 1
        const preview = text.length > 90 ? `${text.slice(0, 90)}...` : text
        console.log(`${file} :: ${path}: ${problems.join(' + ')} :: ${preview}`)
      }
    }
  }
}
if (flagged === 0 && process.exitCode !== 2) {
  console.log(`clean: ${process.argv.slice(2).join(', ')}`)
} else if (flagged > 0) {
  process.exitCode = 1
}
