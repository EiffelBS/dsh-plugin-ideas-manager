/**
 * Shared JSON body/response helpers for the ideas host routes. Follows the
 * dsh-task-board family discipline (strict bounded body reader + one JSON
 * writer) so the /api/ideas fence behaves identically to the sibling plugin
 * families without importing any of their code.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
/**
 * Strict bounded body reader: parse a request body of at most maxBytes as
 * JSON.
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
