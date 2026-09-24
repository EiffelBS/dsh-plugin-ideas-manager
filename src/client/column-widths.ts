/**
 * Per-column kanban width persistence (idea #53): the user's individual column
 * widths survive reloads through a storage pair (localStorage on the page, an
 * injectable seam in tests). The map is keyed by idea status and holds pixel
 * widths; anything wrong on the way back — unknown key, non-numeric value,
 * out-of-range number — is dropped so a corrupt entry can never break layout.
 * The board clamps each width against the current [min, max] bounds at render
 * time, so this module only needs to keep the stored values sane.
 */

import { IDEA_COLUMNS, type IdeaStatus } from '../core/ideas.ts'

/** Storage key of the persisted per-column widths. */
export const COLUMN_WIDTHS_STORAGE_KEY = 'dsh.ideas.columnWidths'

/** Per-column pixel widths keyed by idea status (absent = default flex share). */
export type ColumnWidths = Partial<Record<IdeaStatus, number>>

/** The storage seam the persistence helpers read (localStorage-compatible). */
export interface ColumnWidthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Inclusive sanity bounds for a stored pixel width (the render clamps tighter). */
export const COLUMN_WIDTH_STORE_MIN = 80
export const COLUMN_WIDTH_STORE_MAX = 2000

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Read + validate the persisted widths; any hiccup falls back to an empty map. */
export function readColumnWidths(storage: ColumnWidthStorage | undefined): ColumnWidths {
  if (storage === undefined) return {}
  let raw: string | null = null
  try {
    raw = storage.getItem(COLUMN_WIDTHS_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const widths: ColumnWidths = {}
  for (const status of IDEA_COLUMNS) {
    const value = (parsed as Record<string, unknown>)[status]
    if (isFiniteNumber(value) && value >= COLUMN_WIDTH_STORE_MIN && value <= COLUMN_WIDTH_STORE_MAX) {
      widths[status] = Math.round(value)
    }
  }
  return widths
}

/** Persist the widths; storage failures are ignored (never throw). */
export function writeColumnWidths(storage: ColumnWidthStorage | undefined, widths: ColumnWidths): void {
  if (storage === undefined) return
  const clean: ColumnWidths = {}
  for (const status of IDEA_COLUMNS) {
    const value = widths[status]
    if (isFiniteNumber(value)) clean[status] = Math.round(value)
  }
  try {
    storage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // Private browsing, quota, or a disabled storage must not break the board.
  }
}

/** Clamp a pixel width into [lo, hi]; unordered bounds are normalized here. */
export function clampColumnWidth(width: number, lo: number, hi: number): number {
  const floor = Math.min(lo, hi)
  const ceil = Math.max(lo, hi)
  if (!Number.isFinite(width)) return floor
  return Math.round(Math.min(ceil, Math.max(floor, width)))
}
