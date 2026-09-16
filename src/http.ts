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
 * Strict bounded body reader: parse a request body of at most maxBytes as
 * JSON.
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
