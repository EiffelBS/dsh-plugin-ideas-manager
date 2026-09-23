/** Shared card-title rendering for the persistent idea number. */
/**
 * Format an idea title with its persistent ledger number when available.
 * Missing numbers remain silent for historical records.
 */
export declare function formatIdeaTitle(ideaNumber: number | undefined, title: string): string;
export interface IdeaTitleProps {
    ideaNumber?: number;
    title: string;
}
/** Shared title fragment used by Overview, Priorities and Delivered cards. */
export declare function IdeaTitle({ ideaNumber, title }: IdeaTitleProps): import("react").JSX.Element;
