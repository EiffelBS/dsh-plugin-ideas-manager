/**
 * Tag helpers shared by the kanban and the Priorities/Delivered list views.
 * The tag pills on every card and row carry a stable per-name hue and toggle
 * the same conjunctive filter (see board-view.tsx for the state).
 */
import type { IdeaRecord } from '../core/ideas.ts';
/** Conjunctive tag filter: adding a label narrows the board. */
export declare function matchesTags(idea: IdeaRecord, selected: readonly string[]): boolean;
/** Every label in use across the ledger, sorted (for the filter chips). */
export declare function collectKnownTags(ideas: readonly IdeaRecord[]): string[];
/**
 * Deterministic per-name hue (0–359) so every tag keeps a stable,
 * distinct color on the cards. FNV-1a then maps onto 15 well-spaced hues.
 */
export declare function tagHue(name: string): number;
