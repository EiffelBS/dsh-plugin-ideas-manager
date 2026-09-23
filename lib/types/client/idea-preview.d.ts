/**
 * Card/row description preview (idea #34): every list surface - kanban card,
 * Priorities row, Delivered row - renders the SAME deferred-body teaser (the
 * list snapshot's body excerpt) through the shared markdown/raw toggle. The
 * full analysis is not part of the board snapshot anymore; it loads on
 * demand in the edit modal, the follow-up composer and the re-analyze flow.
 */
export interface IdeaPreviewProps {
    /** The list-view teaser (body excerpt); blank renders nothing. */
    excerpt: string;
    /** Render as markdown (true) or raw text (false), like the rest of the board. */
    mdMode: boolean;
    /** Open the shared edit modal (a link inside the rendered preview opens normally). */
    onEdit: () => void;
}
/** One description preview block (null when there is nothing to show). */
export declare function IdeaPreview({ excerpt, mdMode, onEdit }: IdeaPreviewProps): import("react").JSX.Element | null;
