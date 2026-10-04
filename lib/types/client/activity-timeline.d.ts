/**
 * The per-idea activity timeline (part B).
 *
 * `IdeaRecord` keeps only the last state, so an idea that was declined a month
 * ago answers "why?" with whatever survived in its body — usually nothing. This
 * is the other half of the ledger's `events[]`: a compact, read-only list of
 * what happened to this idea, in the editor.
 *
 * Two habits shape it:
 *  - an absence renders as NOTHING, not as an empty frame. An idea captured
 *    before the log existed has no history, and a box saying "no history" would
 *    imply something is missing rather than that nothing was recorded yet;
 *  - the actor is shown as the board knows it (`you`, an agent label, or the
 *    run), because "who did this" is half of the question the timeline exists
 *    to answer.
 *
 * The list is already bounded host-side (the last 50 entries), so the view adds
 * a scroll cap rather than another bound: a fifty-line log stays readable in a
 * modal instead of pushing the verdict buttons off the screen.
 */
import type { IdeaEvent } from '../core/ideas.ts';
export interface ActivityTimelineProps {
    /**
     * The idea to describe. Takes the event log and nothing else: the editor
     * hands it the full record it fetched on demand, and a component that needed
     * more would force the deferred-body read to carry more than it does.
     */
    idea: {
        events?: IdeaEvent[];
    };
}
/**
 * The recorded life of an idea, or nothing at all.
 *
 * Renders only when the ledger actually holds entries: an idea that has never
 * been touched since the log landed simply has none, and silence is the honest
 * reading.
 */
export declare function ActivityTimeline({ idea }: ActivityTimelineProps): import("react").JSX.Element | null;
