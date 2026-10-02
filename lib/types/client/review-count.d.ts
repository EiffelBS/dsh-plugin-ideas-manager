/**
 * "How many ideas are waiting for me" (idea #91, part B).
 *
 * The review gate is a column on a tab you have to be looking at, so a settled
 * run is invisible until you happen to open the board. This derives the count
 * the sidebar row wears from data already in memory — the same list snapshot
 * the poll refreshes every 2.5 s while the board is open — so there is no new
 * timer and no extra request: the badge is a projection of a value the client
 * already holds.
 *
 * Pure on purpose: the count, the scope and the label format are unit-tested
 * without a DOM, and the panel row (which lives outside the board React tree)
 * reads them through the client's own subscription.
 */
import type { IdeaListRow } from '../protocol.ts';
import type { IdeasSettingsValue } from '../protocol.ts';
/**
 * The workspace scope the badge counts in.
 *
 * The sidebar row exists whether or not the board is mounted, so it cannot
 * read the board's own transient workspace selector — that state only exists
 * while the panel is open. What DOES exist outside the board is the persisted
 * scope (`rememberWorkspaceScope` + `workspaceScope`), which is by construction
 * "the workspace this reader works in", so:
 *  - remembered scope on -> count that workspace only;
 *  - remembered scope off -> count every workspace.
 *
 * `workspaceScope` is only meaningful with the remember option on: a stale id
 * left over from a previous session would otherwise silently hide every badge.
 */
export declare function panelReviewScope(config: IdeasSettingsValue): string;
/**
 * How many ideas sit in the review gate for one workspace scope. Only
 * `underReview` counts: that is the column whose every row is waiting on a
 * human verdict, and it is the only status a finished run can open.
 *
 * The tag filter and the text search are deliberately NOT applied — this is a
 * "how much is on my plate" signal, and a reviewer who filtered the board to
 * one tag must still learn that two runs finished elsewhere.
 *
 * @param ideas - the list rows already in memory (no request is made).
 * @param scope - '' for every workspace, or one workspace scope id.
 */
export declare function underReviewCountOf(ideas: readonly IdeaListRow[] | undefined, scope: string): number;
