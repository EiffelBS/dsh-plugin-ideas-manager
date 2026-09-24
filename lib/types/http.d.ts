/**
 * Shared JSON body/response helpers for the ideas host routes. Follows the
 * dsh-task-board family discipline (strict bounded body reader + one JSON
 * writer) so the /api/ideas fence behaves identically to the sibling plugin
 * families without importing any of their code.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
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
export declare function decodeRequestBody(buffer: Buffer): string;
/**
 * Strict bounded body reader: parse a request body of at most maxBytes as
 * JSON. Uses {@link decodeRequestBody} so an ANSI-codepage (PowerShell 5.1)
 * body is repaired instead of corrupted to U+FFFD.
 * @throws 'body too large' past the cap, or the JSON.parse error for an
 *   invalid or empty payload.
 */
export declare function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown>;
/** Narrow a value to a JSON object, or undefined when it is not one. */
export declare function asJsonObject(value: unknown): Record<string, unknown> | undefined;
/**
 * Write one JSON response. Default headers are the family defaults
 * (content-type and referrer-policy); caller headers are appended or
 * override them.
 */
export declare function writeJson(res: ServerResponse, status: number, body: unknown, headers?: OutgoingHttpHeaders): void;
