/**
 * Ideas domain model: idea lifecycle statuses, the idea record shape, and the
 * pure validation helpers the protocol gate, the host ledger, and the tests
 * share. Framework-free (no cordis, no runtime imports) so the model is
 * unit-testable in isolation.
 */
/** Idea lifecycle status, one per kanban column. */
export type IdeaStatus = 'open' | 'archived' | 'declined';
/** One idea label: the name is the badge and the filter key, the optional prompt line rides the TaskBoard mirror when connected. */
export interface IdeaTag {
    /** Display name; trimmed, non-empty, unique within the idea. */
    name: string;
    /**
     * Prompt line injected ahead of the mirrored TaskBoard card. Absent (or
     * blank after trimming) keeps the tag display-only.
     */
    promptPrefix?: string;
}
/** Maximum number of tags carried by one idea. */
export declare const IDEA_TAG_LIMIT = 8;
/** Maximum length of a tag name. */
export declare const TAG_NAME_MAX_LENGTH = 32;
/** Maximum length of a tag's injected prompt line. */
export declare const TAG_PROMPT_MAX_LENGTH = 200;
/** Maximum length of an idea title. */
export declare const IDEA_TITLE_MAX_LENGTH = 200;
/** Maximum size of an idea body (bytes). */
export declare const IDEA_BODY_MAX_BYTES: number;
/** Whether an unknown value is a well-formed tag (strict: the wire gate). */
export declare function isIdeaTag(value: unknown): value is IdeaTag;
/**
 * Whether an unknown value is a well-formed tag list (strict: the wire gate).
 * An empty list is rejected — clearing tags is expressed by omitting the field
 * (create) or by an explicit null (update), never by an empty array.
 */
export declare function isIdeaTagList(value: unknown): value is IdeaTag[];
/**
 * Repair a persisted tag list: keep the well-formed entries, trim, drop
 * blanks and repeats, cap the count, and collapse a blank prompt line to
 * "display-only". Returns undefined when nothing usable remains, so the caller
 * clears the field instead of storing an empty array.
 */
export declare function normalizeTags(value: unknown): IdeaTag[] | undefined;
/** All valid statuses (closed union guard). */
export declare const ALL_IDEA_STATUSES: readonly IdeaStatus[];
/** The three kanban columns in display order. */
export declare const IDEA_COLUMNS: readonly IdeaStatus[];
/** Brand an unknown string as an idea status; undefined when it is not one. */
export declare function isIdeaStatus(value: unknown): value is IdeaStatus;
/** Normalize one optional target string: trim; blank collapses to undefined. */
export declare function normalizeOptionalId(value: string | undefined): string | undefined;
/** One idea on the board. */
export interface IdeaRecord {
    /** Stable idea id (uuid or import identifier). */
    id: string;
    /** Short display title (<= 200 chars). */
    title: string;
    /** Longer body shown in the detail view (<= 32 KiB). */
    body: string;
    /** Current column. */
    status: IdeaStatus;
    /** Manual rank used by the board ordering (1..n after a reorder). */
    rank?: number;
    /** Optional value score (0..10-ish; pure number, no scale enforced). */
    value?: number;
    /** Optional effort estimate (pure number). */
    effort?: number;
    /** Idea labels. */
    tags?: IdeaTag[];
    /** Workspace this idea belongs to (absent = generic). */
    workspaceId?: string;
    /** Mirror link to the TaskBoard card id when the bridge is active (P2). */
    taskBoardId?: string;
    /** Creation instant (ms epoch). */
    createdAt: number;
    /** Last mutation instant (ms epoch). */
    updatedAt: number;
    /** When the idea was archived or declined (ms epoch). */
    archivedAt?: number;
}
/** Input for creating an idea. */
export interface NewIdeaInput {
    /** Short display title. */
    title: string;
    /** Longer body. */
    body: string;
    /** Workspace the idea belongs to; empty/absent = generic. */
    workspaceId?: string;
    /** Manual rank (optional). */
    rank?: number;
    /** Optional value score. */
    value?: number;
    /** Optional effort estimate. */
    effort?: number;
    /** Optional idea labels. */
    tags?: IdeaTag[];
}
/** Structural shape check of one idea row (status left unvalidated). */
export declare function isIdeaRecordShape(value: unknown): value is Omit<IdeaRecord, 'status'> & {
    status: unknown;
};
/** An idea record is structurally valid if every row round-trips the UI. */
export declare function isIdeaRecord(value: unknown): value is IdeaRecord;
/** Normalize an unknown persisted status back into the closed status union. */
export declare function normalizeStatus(status: unknown): IdeaStatus;
/** Create an idea from user input (starts 'open'). */
export declare function createIdea(input: NewIdeaInput, now: number, id: string): IdeaRecord;
/** Clone an idea with an updated status and a fresh updatedAt. */
export declare function withStatus(idea: IdeaRecord, status: IdeaStatus, now: number): IdeaRecord;
