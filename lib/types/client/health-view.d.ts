/**
 * Backlog health view: the panel's rendering of ONE bounded
 * aggregate, fetched from `GET /api/ideas/state?view=stats`.
 *
 * The component owns no arithmetic. Every number it prints comes from the
 * Host's response, and the only thing computed here is the unit a duration is
 * spelled in (`durationParts`, the shared helper from the same module the Host
 * used). That is deliberate: an aggregate is the easiest thing in a codebase to
 * compute two different ways in two places, and a panel that recomputed would
 * be exactly that second place.
 *
 * What it will NOT do, and says so on screen instead:
 *  - it never prints a median whose sample is too small — the Host answers
 *    `medianMs: null` and this renders "not enough deliveries yet (n of 5)",
 *    which is a different sentence from a number;
 *  - it never labels a rolling window as "this month" — the label names the
 *    Host's local calendar month the response actually measured;
 *  - it never renders "no rank / no value" as a quality score. It is triage
 *    work to do, and the copy says so.
 */
import type { IdeasClient } from './ideas-client.ts';
export interface HealthViewProps {
    client: IdeasClient;
    /** The scope the board is currently showing; `''` = all, NO_WORKSPACE_FILTER
     *  = the workspace-less group. Mapped to the wire by the panel. */
    scopeWorkspaceId: string;
    /** Resolve a workspace id to its display label (same helper as the columns). */
    workspaceTitle: (workspaceId: string) => string;
    /**
     * Revision of the board snapshot the panel is currently painting. The
     * aggregate carries the revision it was computed at, so a figure that
     * describes a board which has since moved on is labelled rather than shown as
     * if it were current — a dashboard that cannot say when it is out of date is
     * the one failure mode this view exists to avoid.
     */
    boardRevision: number | undefined;
}
export declare function HealthView({ client, scopeWorkspaceId, workspaceTitle, boardRevision }: HealthViewProps): import("react").JSX.Element;
