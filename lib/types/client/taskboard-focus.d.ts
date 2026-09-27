/**
 * Bring the human from a refused launch to the exact card that refused it.
 *
 * The TaskBoard plugin exposes no cross-plugin way to preselect a card: the
 * `main` slot is keyed and carries no selection payload, the board publishes no
 * client service, and there is no deeplink. What it does have is a filter field
 * ("Filter tasks...") that matches TITLE, description, tags and freeze — never
 * the task id. So the redirect is: select the board panel through the shell
 * layout (a sanctioned cross-plugin call), then write the idea TITLE into that
 * filter, which is the text the card is actually filed under.
 *
 * Writing the input is deliberate DOM surgery rather than a contract call,
 * because no contract exists. It is therefore defensive end to end: the native
 * value setter is used (a React-controlled input ignores a plain assignment),
 * a bubbling `input` event carries the change into the board's state, the
 * lookup is scoped to the board's own panel, the retries are bounded, and every
 * failure degrades to "the board is open, type the title yourself" — the
 * message shown to the user carries the title either way.
 */
import { type PanelNavigator } from './panel-navigation.ts';
/** Retry budget; `attempts <= 1` tries once and gives up. */
export interface FocusOptions {
    attempts?: number;
    delayMs?: number;
}
/**
 * Open the TaskBoard panel and filter it on `filter` (the idea title).
 *
 * The field usually is not in the DOM yet — selecting a panel mounts it on the
 * next React commit — so the write is retried on a bounded schedule. Exactly one
 * retry loop is ever pending: a second call replaces the first, which keeps a
 * user clicking through several refusals from stacking timers.
 *
 * @param navigator - the shell panel face; undefined means "no layout service".
 * @param filter - text to type into the board's filter field.
 * @param options - retry budget (tests shrink it).
 * @returns true when the panel selection was issued, false when there is no
 *   navigator (nothing to do, and nothing failed either).
 */
export declare function openTaskBoardFiltered(navigator: PanelNavigator | undefined, filter: string, options?: FocusOptions): boolean;
/**
 * Write `text` into the board's filter field, as the board's own React state.
 * @returns true when the field was found and updated.
 */
export declare function applyBoardFilter(text: string): boolean;
