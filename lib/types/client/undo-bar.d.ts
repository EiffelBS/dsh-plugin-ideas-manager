/**
 * The board's undo affordance (idea #111): one quiet row that names the action
 * an Undo would reverse, offers the button, states the shortcut, and — after the
 * click — says exactly which ideas went back and which ones were left alone.
 *
 * It is deliberately NOT a toast that disappears on a timer. An undo the reader
 * did not see the result of is an undo they will press twice, and the failure
 * mode of a destructive action needs a receipt that stays until it is dismissed.
 *
 * Kept out of `board-view.tsx` on purpose: the board file is already the largest
 * one in the plugin, and this is one self-contained row with no board state of
 * its own. It reads the client and nothing else.
 */
import type { IdeasClient } from './ideas-client.ts';
/**
 * The undo row. Rendered whenever there is something to undo, or a receipt from
 * the last attempt — and nothing at all otherwise, so an empty stack costs no
 * vertical space on a board that never used it.
 */
export declare function UndoBar({ client }: {
    client: IdeasClient;
}): import("react").JSX.Element | null;
