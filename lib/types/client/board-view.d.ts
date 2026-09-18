/**
 * Board view: the 3-column kanban (open / archived / declined) that replaces
 * the center column while active. P1 scope: full CRUD — capture and edit
 * modals, per-card archive/restore/decline/delete, manual drag between Open
 * and Archived (+ intra-column reorder), search and a conjunctive tag filter.
 *
 * UI polish: per-column surface tints, markdown-rendered descriptions with a
 * raw/MD toggle, value/effort as named-level comboboxes, and a single click
 * on a card title or body opening the edit modal.
 */
import type { IdeasClient } from './ideas-client.ts';
/** Board component; subscribes to the client snapshot. */
export declare function IdeasBoard({ client }: {
    client: IdeasClient;
}): import("react").JSX.Element;
