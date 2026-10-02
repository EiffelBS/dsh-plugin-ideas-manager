/**
 * Ideas domain model: idea lifecycle statuses, the idea record shape, and the
 * pure validation helpers the protocol gate, the host ledger, and the tests
 * share. Framework-free (no cordis, no runtime imports) so the model is
 * unit-testable in isolation.
 */
/**
 * Idea lifecycle status, one per kanban column. `underReview` is the review
 * gate: an idea whose work is done but whose acceptance by a human is still
 * pending (entered automatically when the mirrored task card passes `done`).
 * Review approved → `deliver`; review rejected → a `followUp` request (child idea) or
 * `decline`.
 */
export type IdeaStatus = 'open' | 'underReview' | 'archived' | 'declined';
/**
 * Lifecycle of one launched execution (idea #66), backend-neutral: the
 * TaskBoard card and the planned direct-session launch both settle into one of
 * these three states. `undefined` on the record means "no run observed".
 */
export type IdeaRunStatus = 'running' | 'done' | 'failed';
/** The three run states, as a lookup for normalization. */
export declare const IDEA_RUN_STATUSES: readonly IdeaRunStatus[];
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
/**
 * Hard byte budget of one delivery note (idea #91): the short note a finished
 * run leaves behind so the review gate has something to decide on. Bounded
 * because it is harvested from a model answer — a 40 KB closing message would
 * otherwise land in the ledger, in every snapshot and in the markdown export.
 * Roughly 2 KiB reads as "what was delivered" without becoming a second body.
 */
export declare const DELIVERY_NOTE_MAX_BYTES: number;
/**
 * One line of an idea's own history: what happened, when, and who did it.
 *
 * `IdeaRecord` otherwise keeps only the last state, so "declined because …"
 * survives only as long as somebody wrote it into the body. The log is what
 * makes an idea remember its life, and it is deliberately tiny per entry:
 * a verb, a timestamp, an actor and a one-line summary.
 */
export interface IdeaEvent {
    /** When it happened (ms epoch). */
    at: number;
    /** Short verb label (`create`, `triage`, `review`, `launch`, …). */
    verb: string;
    /**
     * Who acted: `human`, `run` (a Host-written transition such as a launch
     * settle), or `agent:<initiator>` when the caller asserted an initiator
     * label (the analyst sessions, the `ideas_*` tools).
     */
    actor: string;
    /** One line, bounded; never a second body. */
    summary: string;
}
/**
 * Cap of the per-idea activity log. 50 entries is roughly two months of a
 * busy idea; past that the oldest lines fall off and the ledger document stays
 * the size the exports and snapshots were designed for.
 */
export declare const IDEA_EVENT_LIMIT = 50;
/** Maximum length of one activity verb label. */
export declare const IDEA_EVENT_VERB_MAX_LENGTH = 32;
/** Maximum length of an actor label (`agent:` prefix included). */
export declare const IDEA_EVENT_ACTOR_MAX_LENGTH = 128;
/** Maximum length of one activity summary line. */
export declare const IDEA_EVENT_SUMMARY_MAX_LENGTH = 200;
/** Actor label of a caller that asserted no initiator (the board UI, the API). */
export declare const IDEA_ACTOR_HUMAN = "human";
/** Actor label of a Host-written transition (launch settle, review gate). */
export declare const IDEA_ACTOR_RUN = "run";
/**
 * Resolve the actor label of one mutation. The initiator is the envelope field
 * the write channel already carries: absent means "the human in front of the
 * board", present means an agent stamped its own label. A host-only override
 * (`run`) marks the transitions the Host itself writes.
 * @param initiator - asserted envelope initiator, if any.
 * @param override - explicit actor for a Host-written transition.
 * @returns the bounded actor label.
 */
export declare function ideaEventActor(initiator: string | undefined, override?: 'human' | 'run'): string;
/**
 * Whether an unknown value is a well-formed activity entry.
 *
 * Strict on the four keys it owns — every one of them must be present and of
 * the right type, so a truncated or half-written entry is refused — and
 * deliberately tolerant of unknown keys, because this guard runs on PERSISTED
 * logs: an entry a later version wrote with an extra field is still history
 * worth keeping, and {@link normalizeIdeaEvents} rebuilds it from the four keys
 * this returns, dropping whatever else travelled with it.
 */
export declare function isIdeaEvent(value: unknown): value is IdeaEvent;
/** Build one well-formed entry, bounding every free-text field. */
export declare function ideaEvent(at: number, verb: string, actor: string, summary: string): IdeaEvent;
/**
 * Append one entry to a bounded log and drop what falls off the tail. The
 * input list is never mutated: the ledger keeps one immutable record per
 * revision.
 * @param events - the current log (any length; undefined = empty).
 * @param entry - the entry to append.
 * @returns the new log, at most {@link IDEA_EVENT_LIMIT} entries long.
 */
export declare function appendIdeaEvent(events: readonly IdeaEvent[] | undefined, entry: IdeaEvent): IdeaEvent[];
/**
 * Repair a persisted activity log: drop malformed entries, bound every field
 * and keep only the last {@link IDEA_EVENT_LIMIT}. This is also the schema
 * migration for documents written before the log existed — such a row simply
 * has no `events` field, and the first append creates it.
 * @param value - the raw stored value.
 * @returns the repaired log, or undefined when nothing usable remains.
 */
export declare function normalizeIdeaEvents(value: unknown): IdeaEvent[] | undefined;
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
/** Brand an unknown string as a run status; undefined when it is not one. */
export declare function isIdeaRunStatus(value: unknown): value is IdeaRunStatus;
/** Normalize one optional target string: trim; blank collapses to undefined. */
export declare function normalizeOptionalId(value: string | undefined): string | undefined;
/**
 * Normalize a stored card summary: trim, blank collapses to undefined, hard
 * cap at IDEA_SUMMARY_MAX_LENGTH. The wire gate accepts any string; this is
 * the single place that enforces the size contract on persisted values.
 */
export declare function normalizeSummary(value: string | undefined): string | undefined;
/**
 * Normalize a harvested delivery note (idea #91): trim, blank collapses to
 * undefined (an absent note is honest — the review gate says so in the UI), and
 * the text is cut at DELIVERY_NOTE_MAX_BYTES **UTF-8 bytes**, never mid
 * code point, with a trailing ellipsis marking the cut. Same discipline as
 * `normalizeSummary`: the wire accepts any string, this is the one place that
 * enforces the size contract on a persisted value.
 */
export declare function normalizeDeliveryNote(value: string | undefined): string | undefined;
/**
 * Rank group of an idea: its manual rank is a position RELATIVE to the other
 * ideas of the same (status, workspace) pair — the "rank by workspace" model.
 * The workspace-less ideas (workspaceId undefined) share one generic group, so
 * the board and the Priorities view rank them against each other only. Used by
 * both the host (triage/reorder re-rank) and the client (order rebuilds).
 */
export declare function rankGroupKey(status: IdeaStatus, workspaceId: string | undefined): string;
/**
 * Structural subset the ordering helpers read (idea #34): satisfied by both
 * the full IdeaRecord and the deferred-body IdeaListRow, so client sorts and
 * drop rebuilds never need the voluminous `body` field.
 */
export interface RankableIdea {
    /** Stable idea id. */
    id: string;
    /** Current column. */
    status: IdeaStatus;
    /** Workspace peer-set discriminator (absent = generic group). */
    workspaceId?: string;
    /** Manual rank inside the (status, workspace) group (absent = unranked). */
    rank?: number;
}
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
     * LAST OBSERVED status of the linked TaskBoard card (follow-up work):
     * the under-review poll records it on the idea, and a card whose task
     * failed shows a "Task failed" badge while the idea deliberately stays in
     * the backlog (a failed run delivered nothing, so the review gate does
     * not apply and the human decides whether to retry the task or the idea).
     * System field like `taskBoardId`: never written by the idea verbs. Kept
     * as the last observation (not cleared when the card temporarily vanishes
     * from a probe - the mirror self-heals a dangling link on the next write).
     */
    taskBoardStatus?: string;
    /**
     * State of the LATEST LAUNCHED EXECUTION of this idea (idea #66), kept
     * deliberately separate from `taskBoardStatus` (the raw card observation):
     * the launch lifecycle is backend-neutral, so the future direct-session
     * backend can feed the same field without overloading a TaskBoard-shaped
     * mirror status. `undefined` means "never launched (or no observation yet)";
     * `running` is stamped by the launch route, the settle is written by the
     * run poll. A failed run leaves the idea OPEN on purpose: it delivered
     * nothing, so the review gate does not apply.
     * System field like `taskBoardId`: never written by the idea verbs.
     */
    runStatus?: IdeaRunStatus;
    /**
     * Id of the session a direct launch (v2 backend) created for the current
     * run, so a `running` state survives a board reload (idea #66 decision D5).
     * The TaskBoard backend does NOT write it: that session id is owned by the
     * task-board runner. System field, host-written only.
     */
    runSessionId?: string;
    /**
     * DELIVERY NOTE of the latest finished run (idea #91): the last thing the
     * run said, harvested at settle time, bounded to
     * {@link DELIVERY_NOTE_MAX_BYTES}. Its whole job is to give the review gate
     * something to decide on — today a finished run lands in `underReview` and
     * the only way to learn what happened is to open the session.
     *
     * Two rules, both deliberate:
     *  - it is HARVESTED, never authored: the host reads it off the run, so an
     *    absent note is a truth (a card backend that exposes no output, a
     *    session with no assistant answer) and the UI says so instead of
     *    inventing one. Never a model-generated summary either — that would be
     *    the run describing itself rather than what it said;
     *  - it is host-written only, exactly like `runStatus` / `runSessionId` /
     *    `taskBoardId`: the wire gate rejects it on `update`, and `import`
     *    carries it only as already-harvested text.
     */
    deliveryNote?: string;
    /**
     * Review rejected: id of the parent idea this idea is a follow-up of (set by
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
    /**
     * Bounded, append-only activity log (idea #92): the last
     * {@link IDEA_EVENT_LIMIT} things that happened to this idea — who acted,
     * when, and in one line what changed. The record above keeps only the last
     * state, so without this an idea cannot answer "why was this declined?".
     *
     * Never written by an agent: the verbs append their own entry host-side, so
     * an update cannot smuggle an invented history through the wire gate the way
     * it could smuggle a title. `import` carries the log as already-recorded
     * history, exactly like it carries a harvested delivery note.
     */
    events?: IdeaEvent[];
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
