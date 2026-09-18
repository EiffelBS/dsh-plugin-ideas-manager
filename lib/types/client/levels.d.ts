/**
 * Named value/effort levels for the board UI.
 *
 * Ideas store value and effort as bare numbers, which is meaningless to a
 * user. The board instead presents three named levels (low / medium / high),
 * each mapped to a stored numeric value. Picking a level persists its number;
 * a stored number that does not exactly match a level snaps to the nearest
 * one when the idea is displayed or edited.
 */
import type { IdeasKey } from './locales.ts';
/** A named level and the numeric value it maps to in the ledger. */
export interface IdeaLevel {
    value: number;
    labelKey: IdeasKey;
}
/** Shared value/effort denominations (same scale for both axes). */
export declare const IDEA_LEVELS: readonly IdeaLevel[];
/** Snap a stored number to the nearest defined level; undefined stays undefined. */
export declare function levelForValue(value: number | undefined): number | undefined;
/** Translation key of the level a number belongs to (display on cards). */
export declare function levelLabelKey(value: number | undefined): IdeasKey | undefined;
