/**
 * Relations on the board (idea #106): the React half.
 *
 * The pure rules live in `./relations.ts`; this file only paints. Two surfaces,
 * one module:
 *  - {@link RelationChips} is the compact, READ-ONLY line a card prints, under
 *    its description. It renders nothing at all for an idea that carries no
 *    relation — an absence is not a box — and it caps itself so a heavily
 *    linked card cannot push the board's DOM budget around.
 *  - {@link RelationsEditor} is the editor's Relations section: the two kinds a
 *    human states (`relates to`, `blocks`) are editable, and the third line
 *    (`blocked by`) is READ-ONLY on purpose.
 *
 * Why `blocked by` is not editable here: it is the derived inverse of an edge
 * stored on the OTHER idea, so "removing" it would mean editing a different
 * card. The editor says so instead of silently writing to a row the human never
 * opened — the same honesty the launch gate and the permission refusal use.
 */
import { type RelationRow, type RelationView } from './relations.ts';
/**
 * The read-only relation line of a card: up to {@link CARD_RELATION_CHIP_LIMIT}
 * chips, then a counter. Returns null when there is nothing to say, so a card
 * without relations pays zero DOM nodes.
 *
 * The views are DERIVED ONCE per paint by the board (`relationIndexOf`) and
 * handed down: computing them per card would rebuild the row map and rescan the
 * whole board for every one of them.
 */
export declare function RelationChips({ views }: {
    views: readonly RelationView[] | undefined;
}): import("react").JSX.Element | null;
/**
 * The editor's Relations section. State is owned by the caller (the idea modal)
 * and only the CHANGED lists are posted, so opening an editor and saving an
 * unrelated field never rewrites an edge.
 */
export declare function RelationsEditor({ ideas, ideaId, relatesTo, blocks, disabled, onRelatesTo, onBlocks }: {
    ideas: readonly RelationRow[];
    ideaId: string;
    relatesTo: readonly string[];
    blocks: readonly string[];
    disabled: boolean;
    onRelatesTo: (next: string[]) => void;
    onBlocks: (next: string[]) => void;
}): import("react").JSX.Element;
