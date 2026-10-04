/**
 * Delivery-note extraction.
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

import { normalizeDeliveryNote } from './core/ideas.ts'

/**
 * How many messages the harvest page asks for. The note is the run's LAST
 * assistant message, so the page only has to reach far enough back to contain
 * one: a run whose tail is a long tool-call chain still ends on an assistant
 * message, and 24 messages covers a closing turn plus its tool round-trips
 * without pulling the whole session across the RPC.
 */
export const DELIVERY_NOTE_PAGE_MESSAGES = 24

/**
 * The visible text of one assistant message: its `text` blocks, in order,
 * joined by a blank line. Reasoning blocks, tool calls and tool results are
 * deliberately NOT included — a delivery note is what the run reported, not
 * what it thought about or which tools it called.
 */
function assistantTextOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const row = block as { type?: unknown; text?: unknown }
    if (row.type !== 'text' || typeof row.text !== 'string') continue
    const text = row.text.trim()
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

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
export function deliveryNoteOfRecords(records: readonly unknown[] | undefined): string | undefined {
  if (!Array.isArray(records)) return undefined
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (typeof record !== 'object' || record === null) continue
    const event = (record as { event?: unknown }).event ?? record
    if (typeof event !== 'object' || event === null) continue
    const row = event as { type?: unknown; data?: unknown }
    if (row.type !== 'assistant/message') continue
    const data = row.data
    if (typeof data !== 'object' || data === null) continue
    const text = assistantTextOf((data as { message?: unknown }).message)
    if (text === undefined) continue
    const note = normalizeDeliveryNote(text)
    if (note !== undefined) return note
  }
  return undefined
}

/**
 * The session id of a TaskBoard card's last execution, read off the board
 * snapshot the under-review poll already holds (card backend).
 *
 * The mirrored card does not own a session the ideas plugin can read; what it
 * owns is the pointer to the one its runner used. The task-board records one
 * `executions[]` entry per attempt (`{sessionId, startedAt, endedAt, result}`)
 * and keeps the latest first-to-last, so the LAST entry is the run that just
 * settled. Returns undefined when the board exposes no such field — an older
 * board, a hand-built ledger, a card that never ran — and the caller then
 * leaves the note empty and says so in the UI.
 */
export function cardSessionOf(task: Record<string, unknown> | undefined): string | undefined {
  if (task === undefined) return undefined
  const executions = task['executions']
  if (!Array.isArray(executions)) return undefined
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const entry = executions[index]
    if (typeof entry !== 'object' || entry === null) continue
    const sessionId = (entry as { sessionId?: unknown }).sessionId
    if (typeof sessionId === 'string' && sessionId.trim() !== '') return sessionId.trim()
  }
  return undefined
}