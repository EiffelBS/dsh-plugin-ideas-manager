/**
 * Score badge: the value/effort level read as a colored pill with a tiny
 * axis icon — a dollar sign for value, a dumbbell for effort — so the two
 * axes are distinguishable at a glance on cards and list rows. The color
 * always means "best": green = High value / Low effort, amber = Medium,
 * red = Low value / High effort, through a per-badge hue variable.
 */
export declare function ScoreBadge({ axis, value }: {
    /** Which axis the score belongs to (drives the icon). */
    axis: 'value' | 'effort';
    /** Stored score number; snapped to the nearest level for display. */
    value: number;
}): import("react").JSX.Element | null;
