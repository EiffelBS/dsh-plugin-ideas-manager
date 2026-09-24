/**
 * Per-column kanban width persistence (idea #53): the user's individual column
 * widths survive reloads through a storage pair (localStorage on the page, an
 * injectable seam in tests). The map is keyed by idea status and holds pixel
 * widths; anything wrong on the way back — unknown key, non-numeric value,
 * out-of-range number — is dropped so a corrupt entry can never break layout.
 * The board clamps each width against the current [min, max] bounds at render
 * time, so this module only needs to keep the stored values sane.
 */
import { type IdeaStatus } from '../core/ideas.ts';
/** Storage key of the persisted per-column widths. */
export declare const COLUMN_WIDTHS_STORAGE_KEY = "dsh.ideas.columnWidths";
/** Per-column pixel widths keyed by idea status (absent = default flex share). */
export type ColumnWidths = Partial<Record<IdeaStatus, number>>;
/** The storage seam the persistence helpers read (localStorage-compatible). */
export interface ColumnWidthStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
/** Inclusive sanity bounds for a stored pixel width (the render clamps tighter). */
export declare const COLUMN_WIDTH_STORE_MIN = 80;
export declare const COLUMN_WIDTH_STORE_MAX = 2000;
/** Read + validate the persisted widths; any hiccup falls back to an empty map. */
export declare function readColumnWidths(storage: ColumnWidthStorage | undefined): ColumnWidths;
/** Persist the widths; storage failures are ignored (never throw). */
export declare function writeColumnWidths(storage: ColumnWidthStorage | undefined, widths: ColumnWidths): void;
/** Clamp a pixel width into [lo, hi]; unordered bounds are normalized here. */
export declare function clampColumnWidth(width: number, lo: number, hi: number): number;
