/**
 * Run-state badges: the header pills that say where an idea stands with its
 * last execution. Extracted from the Overview card header so the Priorities
 * and Delivered rows can show the same facts - a row without a state tag
 * forces the reader to open the modal, and a missed "Running" row is
 * duplicated work.
 *
 * What the tags read (all host-written system fields, never set by an idea
 * verb - see core/ideas.ts):
 *  - `followUpOfId`: the recipe lineage of a child idea ("follow-up of #N");
 *    the number is resolved by the caller (the row itself carries no parent).
 *  - `status === 'underReview'`: the recipe gate. NOT a run state - it is a
 *    column, and an idea engaged in the recipe has left the open backlog, so
 *    it never shows in Priorities.
 *  - `taskBoardStatus === 'failed'` on an OPEN idea: a failed run delivered
 *    nothing, so the idea deliberately stays in the backlog and the badge only
 *    makes the situation visible.
 *  - `runStatus === 'running'` or `taskBoardStatus === 'running'`: a run is in
 *    flight, whichever backend runs it (a card started from the task board
 *    itself is folded into runStatus by the next poll).
 *  - `runSessionId`: the direct-session run, with the button that opens it.
 *  - `deliveredAt`: the exit stamp.
 *
 * Every tag is a LAST OBSERVATION, never a promise of a live state: the host
 * poll runs every 30 s and keeps the last value it saw. The tooltips keep
 * saying so.
 */
import type { IdeaListRow } from '../protocol.ts';
export interface RunStateBadgesProps {
    /** The row to describe (a list row is enough: every field used is on it). */
    idea: IdeaListRow;
    /**
     * Resolve the parent of a follow-up child into its ledger number. The row
     * carries `followUpOfId` but never the parent's number, so the caller owns
     * the id -> idea map (the Overview already builds one) instead of every
     * call site duplicating it. Absent = the lineage chip is skipped.
     */
    parentNumber?: (ideaId: string) => number | undefined;
    /**
     * Open, in DSH, the session that runs this idea. The button renders only for
     * a direct run (`runStatus === 'running'` + a session id) and only when the
     * shell serves a sessions service, so a host without one degrades to the tag
     * alone.
     */
    onOpenSession?: (sessionId: string) => void;
    /**
     * Render the "Delivered {date}" stamp. On by default (the Overview card
     * header); the Delivered tab passes false because its exit stamp already
     * carries the same fact as the row's leading date.
     */
    showDelivered?: boolean;
}
/**
 * The shared state pills of one idea, in header order. Renders nothing (an
 * empty fragment) for an idea that is simply idle: the callers drop it in
 * unconditionally.
 */
export declare function RunStateBadges({ idea, parentNumber, onOpenSession, showDelivered }: RunStateBadgesProps): import("react").JSX.Element;
