/**
 * Ideas domain model: idea lifecycle statuses, the idea record shape, and the
 * pure validation helpers the protocol gate, the host ledger, and the tests
 * share. Framework-free (no cordis, no runtime imports) so the model is
 * unit-testable in isolation.
 */
/**
 * Idea lifecycle status, one per kanban column. `underReview` is the recette
 * gate: an idea whose work is done but whose acceptance by a human is still
 * pending (entered automatically when the mirrored task card passes `done`).
 * Recette OK → `deliver`; recette NOK → a `followUp` request (child idea) or
 * `decline`.
 */
export type IdeaStatus = 'open' | 'underReview' | 'archived' | 'declined';
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
/**
 * Maximum length of the compact card summary: the abstract the ideas-analyst
 * produces and the TaskBoard mirror ships as the card description.
 */
export declare const IDEA_SUMMARY_MAX_LENGTH = 300;
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
/** The kanban columns in display order (underReview sits between open and archived). */
export declare const IDEA_COLUMNS: readonly IdeaStatus[];
/** Brand an unknown string as an idea status; undefined when it is not one. */
export declare function isIdeaStatus(value: unknown): value is IdeaStatus;
/** Normalize one optional target string: trim; blank collapses to undefined. */
export declare function normalizeOptionalId(value: string | undefined): string | undefined;
/**
 * Normalize a stored card summary: trim, blank collapses to undefined, hard
 * cap at IDEA_SUMMARY_MAX_LENGTH. The wire gate accepts any string; this is
 * the single place that enforces the size contract on persisted values.
 */
export declare function normalizeSummary(value: string | undefined): string | undefined;
/**
 * Rank group of an idea: its manual rank is a position RELATIVE to the other
 * ideas of the same (status, workspace) pair — the "rank by workspace" model.
 * The workspace-less ideas (workspaceId undefined) share one generic group, so
 * the board and the Priorities view rank them against each other only. Used by
 * both the host (triage/reorder re-rank) and the client (order rebuilds).
 */
export declare function rankGroupKey(status: IdeaStatus, workspaceId: string | undefined): string;
/** Prior analysis preserved by a re-analyze run (one level deep). */
export interface AnalysisAudit {
    /** When the re-analyze cycle was started (ms epoch). */
    at: number;
    /** The idea title BEFORE the re-analysis replaced it. */
    title: string;
    /** The idea body BEFORE the re-analysis replaced it. */
    body: string;
    /** The card summary BEFORE the re-analysis replaced it. */
    summary?: string;
    /** The label set BEFORE the re-analysis replaced it. */
    tags?: IdeaTag[];
    /** The priority scores BEFORE the re-triage replaced them. */
    value?: number;
    effort?: number;
    rationale?: string;
}
/** One idea on the board. */
export interface IdeaRecord {
    /** Stable idea id (uuid or import identifier). */
    id: string;
    /** Short display title (<= 200 chars). */
    title: string;
    /** Longer body shown in the detail view (<= 32 KiB). */
    body: string;
    /**
     * Compact card abstract (<= 300 chars) produced by the ideas-analyst: the
     * TaskBoard mirror ships it as the card DESCRIPTION, so the snapshot never
     * carries the full analysis twice (it already rides the card prompt + this
     * ledger). Optional: the mirror derives a body excerpt when absent.
     */
    summary?: string;
    /** Current column. */
    status: IdeaStatus;
    /** Manual rank used by the board ordering (1..n after a reorder). */
    rank?: number;
    /** Optional value score (0..10-ish; pure number, no scale enforced). */
    value?: number;
    /** Optional effort estimate (pure number). */
    effort?: number;
    /**
     * Triage justification for the current rank (who/when/why). Written by the
     * T1 triage flow; the Priorities view renders it when present.
     */
    rationale?: string;
    /** Idea labels. */
    tags?: IdeaTag[];
    /** Workspace this idea belongs to (absent = generic). */
    workspaceId?: string;
    /** Mirror link to the TaskBoard card id when the bridge is active (P2). */
    taskBoardId?: string;
    /**
     * Recette NOK: id of the parent idea this idea is a follow-up of (set by
     * the `followUp` verb; the child carries the summary + justification and
     * stays open while the parent is archived).
     */
    followUpOfId?: string;
    /**
     * Stable capture sequence (1-based) assigned by the ledger at create — the
     * "#N" human reference of the old IDEAS.md process. Absent on imported
     * rows without a sequence.
     */
    ideaNumber?: number;
    /** When the idea was delivered (archived + deliveredAt by the deliver verb). */
    deliveredAt?: number;
    /** Decision note recorded when an idea is declined. */
    decision?: string;
    /** Creation instant (ms epoch). */
    createdAt: number;
    /** Last mutation instant (ms epoch). */
    updatedAt: number;
    /** When the idea was archived or declined (ms epoch). */
    archivedAt?: number;
    /**
     * Re-analyze cycle stamp (ms epoch): set by the `reanalyze` verb when a
     * human-triggered analyst re-run starts. The analyst's own update+triage
     * writes the new content; the stamp stays as the audit marker.
     */
    reanalyzeAt?: number;
    /**
     * Prior analysis preserved by the latest re-analyze cycle: the title/body/
     * tags/priority opinion the card carried BEFORE the analyst overwrote them.
     * One level deep (the latest prior analysis only) so the ledger stays
     * bounded — re-analyze replaces deliberately, never destroys history.
     */
    analysisAudit?: AnalysisAudit;
}
/** Input for creating an idea. */
export interface NewIdeaInput {
    /** Short display title. */
    title: string;
    /** Longer body. */
    body: string;
    /** Optional compact abstract (<= 300 chars); the mirror's card description. */
    summary?: string;
    /** Workspace the idea belongs to; empty/absent = generic. */
    workspaceId?: string;
    /** Manual rank (optional). */
    rank?: number;
    /** Optional value score. */
    value?: number;
    /** Optional effort estimate. */
    effort?: number;
    /** Optional triage justification for the rank (recorded at capture). */
    rationale?: string;
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
