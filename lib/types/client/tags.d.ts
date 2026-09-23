/**
 * Tag helpers shared by the kanban and the Priorities/Delivered list views.
 * The tag pills on every card and row carry a stable per-name hue and toggle
 * the same conjunctive filter (see board-view.tsx for the state).
 */
import type { IdeaTag } from '../core/ideas.ts';
/** Structural row face the tag helpers read (full records AND list rows, idea #34). */
export type TaggedIdea = {
    tags?: IdeaTag[];
};
/** Conjunctive tag filter: adding a label narrows the board. */
export declare function matchesTags(idea: TaggedIdea, selected: readonly string[]): boolean;
/** Every label in use across the ledger, sorted (for the filter chips). */
export declare function collectKnownTags(ideas: readonly TaggedIdea[]): string[];
/**
 * Narrow the filter chips with the chip search box (idea #36): a
 * case-insensitive substring match on the label. Matched chips keep their
 * order; SELECTED chips are appended when the query (or nothing at all)
 * hides them, so an active filter never becomes an invisible filter — even
 * for a stale selection whose label left the ledger. A blank query is the
 * full list.
 */
export declare function filterKnownTags(known: readonly string[], selected: readonly string[], query: string): string[];
/**
 * Deterministic per-name hue (0–359) so every tag keeps a stable,
 * distinct color on the cards. FNV-1a then maps onto 15 well-spaced hues.
 */
export declare function tagHue(name: string): number;
