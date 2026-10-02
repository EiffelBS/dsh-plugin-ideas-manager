/**
 * Delivery-note extraction (idea #91, part A).
 *
 * A finished run settles into `underReview` and the reviewer is left with a
 * column and a verdict — the one thing the board never showed them was what
 * the run actually said. This module turns the raw journal of a run into that
 * missing sentence, and nothing else: it never summarizes, never asks a model,
 * never invents. A run with no assistant answer yields no note, and the board
 * says so in the review gate instead of filling the gap.
 *
 * Pure and framework-free on purpose (same rule as core/ideas.ts): the wire
 * shape it reads is duck-typed, so it is unit-testable without a Host, and a
 * Host that changes its journal shape degrades to "no note" instead of
 * throwing inside a settle.
 */
/**
 * How many messages the harvest page asks for. The note is the run's LAST
 * assistant message, so the page only has to reach far enough back to contain
 * one: a run whose tail is a long tool-call chain still ends on an assistant
 * message, and 24 messages covers a closing turn plus its tool round-trips
 * without pulling the whole session across the RPC.
 */
export declare const DELIVERY_NOTE_PAGE_MESSAGES = 24;
/**
 * The delivery note carried by one `session/page` record list: the text of the
 * LAST `assistant/message` event in it.
 *
 * The records arrive oldest-first, and "last" is the run's conclusion — an
 * earlier assistant message is a mid-run remark ("let me check the schema")
 * that would be actively misleading as a delivery note. Returns undefined for
 * an empty page, a page with no assistant turn, or any shape the host has since
 * changed: an unreadable journal means no note, never a guess.
 */
export declare function deliveryNoteOfRecords(records: readonly unknown[] | undefined): string | undefined;
/**
 * The session id of a TaskBoard card's last execution, read off the board
 * snapshot the under-review poll already holds (idea #91, part A, card
 * backend).
 *
 * The mirrored card does not own a session the ideas plugin can read; what it
 * owns is the pointer to the one its runner used. The task-board records one
 * `executions[]` entry per attempt (`{sessionId, startedAt, endedAt, result}`)
 * and keeps the latest first-to-last, so the LAST entry is the run that just
 * settled. Returns undefined when the board exposes no such field — an older
 * board, a hand-built ledger, a card that never ran — and the caller then
 * leaves the note empty and says so in the UI.
 */
export declare function cardSessionOf(task: Record<string, unknown> | undefined): string | undefined;
