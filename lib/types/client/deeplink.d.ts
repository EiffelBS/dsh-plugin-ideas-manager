/**
 * Deep-link to an idea: the PURE half.
 *
 * Two references reach the board — the `#N` a human reads and an idea id a
 * system holds — and both have to become one card. Nothing here touches the
 * DOM, the React tree, the transport or the cordis context: parsing, resolution
 * and the bounded read that answers the same question against the Host are three
 * small functions, and they are the ones worth unit-testing.
 *
 * The number is the reference a human is ever given. An id is accepted because
 * an agent, a log line or a copied link carries one, but it is NOT stable: a
 * board re-imported on another machine mints fresh ids while keeping its `ideaNumber`
 * sequence. That asymmetry is why `parseIdeaRef` accepts both and why the board's
 * own copy only ever shows the number.
 *
 * The mirrored TaskBoard card id is accepted too: card ids are deterministic
 * (`idea-` + the idea id, see docs/architecture.md), so a card id copied out of
 * the TaskBoard lands on the right idea without anyone having to translate it.
 */
import type { IdeaStatus } from '../core/ideas.ts';
import type { IdeasReadQuery } from '../protocol.ts';
/** A reference the board can be asked to focus. */
export type IdeaRef = {
    kind: 'number';
    number: number;
} | {
    kind: 'id';
    id: string;
};
/** The fields a focus decision reads; a list row and a read row both fit. */
export interface FocusableIdea {
    id: string;
    /** Stable human reference (`#N`), absent on a record imported without one. */
    ideaNumber?: number;
    status: IdeaStatus;
    workspaceId?: string;
}
/**
 * Parse a reference into a number or an id.
 *
 * Accepted, in the order they are tried: `#42`, `42`, `idea-<uuid>`, `<uuid>`.
 * A leading `#` is decoration; the rest decides the kind. Digits are ALWAYS a
 * number and never an id — an id is a uuid, and reading a digit string as one
 * would silently miss every idea on the board.
 *
 * @param raw - whatever the caller typed or passed (`'  #7 '`, `'idea-abc'`).
 * @returns the parsed reference, or undefined when there is nothing to look up.
 */
export declare function parseIdeaRef(raw: string): IdeaRef | undefined;
/**
 * Find the idea a reference names.
 *
 * The caller passes the WHOLE board on purpose: the number is the stable human
 * reference, so it has to resolve whatever the current workspace scope happens
 * to be. Scoping is the board's job at render time, never the resolver's.
 *
 * @param ref - a parsed reference.
 * @param ideas - every idea the client currently holds, all workspaces.
 * @returns the matching idea, or undefined.
 */
export declare function resolveIdeaRef<T extends FocusableIdea>(ref: IdeaRef, ideas: readonly T[]): T | undefined;
/**
 * The bounded read that answers the same question against the Host.
 *
 * This is the EXISTING `?view=summary` projection with its `numbers` / `ids`
 * selector and a one-row limit — no route, no query parameter and no response
 * shape was added for the deep-link. It is the cold path: the 2.5 s poll only
 * runs while the board is open, so a board that has been closed since a capture
 * has no row to resolve and must ask once.
 *
 * @param ref - a parsed reference.
 * @returns a one-row bounded read query for it.
 */
export declare function focusReadQuery(ref: IdeaRef): IdeasReadQuery;
