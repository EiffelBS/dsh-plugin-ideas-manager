/**
 * One option row of the settings section: a title and its description on the
 * left, the control on the right (or on the title line, for the boolean rows
 * whose switch belongs to the heading).
 *
 * Extracted rather than duplicated because the Display tab and the Backup tab
 * render the same row shape with the same copy discipline — an
 * option always states what it changes, its range and its default — and a second
 * copy of that markup would drift exactly where the discipline lives.
 */
import type { ReactNode } from 'react';
export declare function SettingsRow({ title, desc, control, controlOnTitle }: {
    title: string;
    desc: string;
    control: ReactNode;
    controlOnTitle?: boolean;
}): import("react").JSX.Element;
