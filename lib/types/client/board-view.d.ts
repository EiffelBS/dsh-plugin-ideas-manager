/**
 * Board view: the 4-column kanban (open / under review / archived / declined)
 * that replaces the center column while active. P1 scope: full CRUD — capture
 * and edit modals, per-card archive/restore/decline/delete, manual drag
 * between the move-verb columns (+ intra-column reorder), search and a
 * conjunctive tag filter. The under-review column is the recette gate: Recette
 * OK delivers, Follow-up raises a linked child idea and archives the parent,
 * Decline rejects.
 *
 * UI polish: markdown-rendered descriptions with a raw/MD toggle, value/effort
 * as named-level comboboxes, and a single click on a card title or body
 * opening the edit modal.
 */
import type { IdeasClient } from './ideas-client.ts';
/**
 * Shared tag-filter row (idea #36): ONE scrollable zone holding the
 * ALWAYS-visible header — the "Filter:" label, the tag search box and the
 * clear button — as a STICKY first line (opaque bar, tags scroll beneath it)
 * with every tag below, capped at the tagRows budget (~3 tag rows by default)
 * plus its own scrollbar. Because the header lives inside the zone but never
 * scrolls out, the clear button is reachable at any scroll position.
 *
 * The search narrows the TAGS only (the board-header search narrows the
 * CARDS: two controls, two behaviours, two labels) and never hides a
 * SELECTED tag — even a stale one whose label left the ledger — so the board
 * is never filtered by an invisible label. Clear resets both halves of the
 * filter (selection + query) and shows whenever either half is active.
 * Rendered above all three tabs (shared row).
 */
export declare function TagFilterRow({ knownTags, selected, onToggle, onClear }: {
    knownTags: readonly string[];
    selected: readonly string[];
    onToggle: (name: string) => void;
    onClear: () => void;
}): import("react").JSX.Element;
/** Board component; subscribes to the client snapshot. */
export declare function IdeasBoard({ client }: {
    client: IdeasClient;
}): import("react").JSX.Element;
