/**
 * /api/ideas wire protocol: prefix, envelope types, and the strict exactKeys
 * action parser. Follows the dsh-task-board discipline (bounded requestId,
 * closed `kind` unions, exactKeys on every object, forbidden executable
 * fields on the import path) so the ideas API behaves identically to the
 * sibling families without importing any of their code.
 */
import { type IdeaRecord, type IdeaStatus, type IdeaTag, type NewIdeaInput } from './core/ideas.ts';
export declare const IDEAS_SCHEMA_VERSION: 1;
export declare const IDEAS_API_PREFIX = "/api/ideas";
/** Snapshot served by GET /api/ideas/state. */
export interface IdeasSnapshot {
    schemaVersion: typeof IDEAS_SCHEMA_VERSION;
    revision: number;
    ideas: IdeaRecord[];
}
/**
 * Hard cap of the list-view body excerpt: enough for a readable card
 * preview and a useful board search, small enough that a 140-card snapshot
 * stays a fraction of the full payload - the voluminous analyses ride
 * GET /api/ideas/idea?id= on demand (edit / follow-up / re-analyze) and the
 * full GET /api/ideas/state (deep search, backups) instead.
 */
export declare const BODY_EXCERPT_MAX_LENGTH = 280;
/**
 * One list-view row: the full record minus the fields the list never shows
 * (`body`, `analysisAudit`) plus a short `bodyExcerpt` teaser. The MISSING
 * `body` field is deliberate: TypeScript then refuses every render/search
 * site that would silently grow back a full-body dependency, and the edit
 * modal can never save a partial body by accident (it always edits a full
 * IdeaRecord fetched through GET /api/ideas/idea).
 */
export type IdeaListRow = Omit<IdeaRecord, 'body' | 'analysisAudit'> & {
    /** Leading, whitespace-collapsed slice of the body (never the analysis). */
    bodyExcerpt: string;
};
/** Snapshot served by GET /api/ideas/state?view=list (and action views). */
export interface IdeasListSnapshot {
    schemaVersion: typeof IDEAS_SCHEMA_VERSION;
    revision: number;
    ideas: IdeaListRow[];
}
/** Read projection selected by `GET /api/ideas/state?view=`. */
export type IdeasReadView = 'summary' | 'detail';
/** Default number of rows in a bounded read. */
export declare const IDEAS_READ_DEFAULT_LIMIT = 100;
/** Hard row cap for one bounded read. */
export declare const IDEAS_READ_MAX_LIMIT = 200;
/** Hard UTF-8 byte cap for one selected idea body. */
export declare const IDEAS_READ_MAX_BODY_BYTES: number;
/** Hard UTF-8 byte cap for one bounded-read JSON response. */
export declare const IDEAS_READ_MAX_RESPONSE_BYTES: number;
/** Hard cap for each repeated selector group. */
export declare const IDEAS_READ_MAX_SELECTORS = 100;
/**
 * Optional top-level fields a bounded read may select. Identity and timestamp
 * fields are always present (revision is top-level); `analysisAudit` is
 * intentionally unavailable in
 * this projection because it can carry a second full body. The frozen raw
 * single-idea route remains the explicit full-detail escape hatch.
 */
export declare const IDEAS_READ_SELECTABLE_FIELDS: readonly ["summary", "rank", "value", "effort", "rationale", "tags", "workspaceId", "taskBoardId", "taskBoardStatus", "followUpOfId", "deliveredAt", "decision", "archivedAt", "reanalyzeAt", "body"];
/** One optional field accepted by the bounded field selector. */
export type IdeasReadField = (typeof IDEAS_READ_SELECTABLE_FIELDS)[number];
/** Fields always present on a bounded row, independent of field selection. */
type IdeasReadCore = Pick<IdeaRecord, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'> & {
    ideaNumber?: number;
    body?: string;
    /** True only on this row when its selected body was shortened. */
    bodyTruncated?: true;
};
/** One projected row. Unselected and absent optional record fields are omitted. */
export type IdeasReadRow = IdeasReadCore & Partial<Omit<IdeaRecord, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'ideaNumber' | 'body' | 'analysisAudit'>>;
/** Caller-facing bounded-read query. Defaults are summary + 100 rows. */
export interface IdeasReadQuery {
    view?: IdeasReadView;
    workspaceId?: string;
    status?: readonly IdeaStatus[];
    ids?: readonly string[];
    numbers?: readonly number[];
    fields?: readonly IdeasReadField[];
    /** Requested body cap in UTF-8 bytes (0 omits content while keeping the key). */
    bodyLimit?: number;
    limit?: number;
    offset?: number;
}
/** Fully defaulted and validated bounded-read query. */
export interface NormalizedIdeasReadQuery {
    view: IdeasReadView;
    workspaceId?: string;
    status: IdeaStatus[];
    ids: string[];
    numbers: number[];
    fields: IdeasReadField[];
    bodyLimit: number;
    limit: number;
    offset: number;
}
/** Explicit row, body, and pagination metadata for a bounded read. */
export interface IdeasReadMetadata {
    view: IdeasReadView;
    fields: readonly IdeasReadField[];
    bodyLimitBytes: number;
    limit: number;
    offset: number;
    matched: number;
    returned: number;
    rowTruncated: boolean;
    nextOffset: number | null;
    bodyTruncated: boolean;
    omittedFields: Array<IdeasReadField | 'analysisAudit'>;
}
/** Response served by `GET /api/ideas/state?view=summary|detail`. */
export interface IdeasReadSnapshot {
    schemaVersion: typeof IDEAS_SCHEMA_VERSION;
    revision: number;
    ideas: IdeasReadRow[];
    meta: IdeasReadMetadata;
}
/**
 * Parse and bound the additive read query. `status`, `id`, `number`, and
 * `fields` are repeatable; `status` and `fields` also accept comma-separated
 * lists. Unknown keys and out-of-range values reject instead of silently
 * broadening a read.
 */
export declare function parseIdeasReadQuery(params: URLSearchParams): NormalizedIdeasReadQuery | undefined;
/** Serialize a bounded-read query for the browser transport. */
export declare function ideasReadSearchParams(query: IdeasReadQuery): URLSearchParams;
/**
 * Project a source-of-truth snapshot into a bounded filtered read. No cache
 * or mutable view state is introduced: every response is derived from the
 * current ledger revision. If selected fields would exceed the hard wire
 * budget, trailing rows are omitted and `nextOffset` makes that explicit.
 */
export declare function buildIdeasReadSnapshot(snapshot: IdeasSnapshot, input?: IdeasReadQuery): IdeasReadSnapshot;
/**
 * Leading slice of a body for previews and search: whitespace collapses to
 * single spaces (this is a teaser, not markdown structure), the cut lands on
 * a word boundary when one is reasonably close, and a truncated excerpt
 * carries an ellipsis.
 */
export declare function bodyExcerptOf(body: string): string;
/** Project one full record to its list row (drops body + analysisAudit). */
export declare function toListRow(idea: IdeaRecord): IdeaListRow;
/**
 * Project a full snapshot to the list view. Shared by the host (the
 * `?view=list` state route) and the client (action responses still carry
 * the FULL snapshot - the POST /api/ideas/action contract is frozen - and
 * are projected here at the transport edge).
 */
export declare function toListSnapshot(snapshot: IdeasSnapshot): IdeasListSnapshot;
/** SSE event frame: revision only, never the idea list. */
export interface IdeasEventPayload {
    revision: number;
}
export type IdeasAction = {
    kind: 'import';
    sourceId: string;
    ideas: IdeaRecord[];
} | {
    kind: 'create';
    id: string;
    input: NewIdeaInput;
} | {
    kind: 'update';
    ideaId: string;
    patch: IdeaUpdatePatch;
} | {
    kind: 'move';
    ideaId: string;
    status: Extract<IdeaStatus, 'open' | 'underReview' | 'archived'>;
} | {
    kind: 'decline';
    ideaId: string;
    decision?: string;
} | {
    kind: 'deliver';
    ideaId: string;
} | {
    kind: 'triage';
    ideaId: string;
    patch: TriagePatch;
} | {
    kind: 'followUp';
    ideaId: string;
    /** The child idea: title/body (the summary + justification, composed by the UI). */
    input: FollowUpInput;
} | {
    kind: 'restore';
    ideaId: string;
} | {
    kind: 'delete';
    ideaId: string;
} | {
    kind: 'reanalyze';
    ideaId: string;
} | {
    kind: 'reorder';
    orderedIds: string[];
} | {
    kind: 'export';
    workspaceId?: string;
};
export interface IdeasActionEnvelope {
    requestId: string;
    action: IdeasAction;
    /**
     * Session id of the DSH session issuing the action, for the audit trail.
     * Client-asserted, not a trust boundary; parsed only as a bounded non-empty
     * string.
     */
    initiator?: string;
}
/** Patch accepted by `update`; a null `tags` clears the label set. */
export interface IdeaUpdatePatch {
    title?: string;
    body?: string;
    /** Compact card summary (<= 300 chars enforced by the ledger); null clears. */
    summary?: string | null;
    rank?: number;
    value?: number;
    effort?: number;
    rationale?: string;
    tags?: IdeaTagListOrNull;
    workspaceId?: string;
}
type IdeaTagListOrNull = IdeaTag[] | null;
/**
 * Triage patch: the priority opinion (value/effort/rationale) plus the
 * suggested 1-based rank where the idea should sit INSIDE the open backlog.
 * The host applies the scores and re-inserts the idea at that rank, shifting
 * the rest — never a plain append (see the guidance protocol).
 */
export interface TriagePatch {
    value?: number;
    effort?: number;
    rationale?: string;
    rank?: number;
}
/**
 * Input of the `followUp` verb: the child idea raised when the review of an
 * under-review idea is NOK. The UI composes `body` as the parent summary +
 * the requested follow-up justification; the host links the child
 * (`followUpOfId`), inherits the parent workspace, and archives the parent —
 * atomically, in one commit.
 */
export interface FollowUpInput {
    title: string;
    body: string;
}
export declare function parseActionEnvelope(value: unknown): IdeasActionEnvelope | undefined;
/** Convenience used by tests: build an idea record exactly as the ledger stores it. */
export declare function ideaFromInput(id: string, input: NewIdeaInput, now: number): IdeaRecord;
/**
 * Panel tabs, mirror of BOARD_TABS (src/client/tabs.ts): spelled here so the
 * host bundle never pulls the client model — same discipline as the defaults.
 */
export declare const IDEAS_TABS: readonly ["overview", "priorities", "delivered"];
/** One panel tab id. */
export type IdeasTab = (typeof IDEAS_TABS)[number];
/** Card densities offered by the settings row. */
export declare const IDEAS_DENSITIES: readonly ["comfortable", "compact"];
/** One card-density mode. */
export type IdeasDensity = (typeof IDEAS_DENSITIES)[number];
/**
 * Interface languages of the panel: `auto` follows the DSH shell language
 * (the shipped default), the others pin the panel to one dictionary
 * independently of the shell. DSH serves en + zh today, so `auto` gives an
 * English panel on an English shell and a Chinese one on a Chinese shell;
 * `fr` exists for a French-reading operator and future-proofs a French shell.
 */
export declare const IDEAS_LANGUAGES: readonly ["auto", "en", "fr", "zh"];
/** One panel language choice. */
export type IdeasLanguage = (typeof IDEAS_LANGUAGES)[number];
/** Bound of the remembered workspace scope (aligned on the envelope ids). */
export declare const WORKSPACE_SCOPE_MAX_LENGTH = 256;
/** Resolved display-settings value served by the config routes. */
export interface IdeasSettingsValue {
    /** Visible tag-filter rows on the board (clamped to 1..5). */
    tagRows: number;
    /** Panel tab opened at board start (mirror of BOARD_TABS). */
    defaultTab: IdeasTab;
    /** Render card descriptions as markdown at open (session toggle stays free). */
    renderMarkdown: boolean;
    /** Reopen on the last selected workspace scope instead of all workspaces. */
    rememberWorkspaceScope: boolean;
    /** Last workspace scope kept while rememberWorkspaceScope is on ('' = all). */
    workspaceScope: string;
    /** Ask for an in-place confirmation before Deliver / Decline. */
    confirmLifecycle: boolean;
    /** Hide the Declined kanban column (declined cards leave the board view). */
    hideDeclinedColumn: boolean;
    /** Kanban card density. */
    cardDensity: IdeasDensity;
    /** Panel interface language: `auto` follows the DSH shell, else pinned. */
    language: IdeasLanguage;
    /** Minimum width (px) a kanban column can be dragged to (idea #53). */
    columnMinWidth: number;
    /** Maximum width (px) a kanban column can be dragged to (idea #53). */
    columnMaxWidth: number;
}
/** Patch accepted by POST /api/ideas/config (exact keys, values sanitized). */
export type IdeasSettingsPatch = Partial<IdeasSettingsValue>;
/**
 * Wire view of the plugin settings. `available` is false when the deployment
 * serves no settings document (no host settings service) — the client keeps
 * the defaults then, exactly like the Side card fallback. `revision` fences
 * the next write (absent while unavailable).
 */
export interface IdeasSettingsView {
    available: boolean;
    value: IdeasSettingsValue;
    revision?: number;
}
/** Default bounds of the resizable kanban columns (idea #53), in pixels. */
export declare const COLUMN_MIN_WIDTH_DEFAULT = 200;
export declare const COLUMN_MAX_WIDTH_DEFAULT = 922;
/** Inclusive bounds of the columnMinWidth option (settings row). */
export declare const COLUMN_MIN_WIDTH_RANGE: {
    readonly min: 120;
    readonly max: 480;
};
/** Inclusive bounds of the columnMaxWidth option (settings row). */
export declare const COLUMN_MAX_WIDTH_RANGE: {
    readonly min: 240;
    readonly max: 1382;
};
/**
 * Defaults the browser half keeps when no settings surface answers. Spelled
 * here rather than imported from the host entry so the client bundle never
 * pulls the Node-side module — same discipline as IDEAS_SETTINGS_NAMESPACE.
 */
export declare const IDEAS_SETTINGS_DEFAULTS: IdeasSettingsValue;
/** Inclusive bounds of the tagRows option (settings row: 1..5). */
export declare const TAG_ROWS_MIN = 1;
export declare const TAG_ROWS_MAX = 5;
/**
 * Clamp an unknown input to a legal tagRows value: finite numbers round to
 * the nearest integer and clamp into 1..5; anything else falls back to the
 * default. Hand-edited settings and hand-crafted wire values can never store
 * or render an illegal row count (the clamp, not the schema, is the guard —
 * a schema range would reject a bad stored section at registration).
 */
export declare function clampTagRows(value: unknown): number;
/**
 * Clamp an unknown input to a legal minimum column width: finite numbers round
 * and clamp into the range; anything else falls back to the default. Same guard
 * discipline as clampTagRows — the clamp, not a schema range, is the boundary.
 */
export declare function clampColumnMinWidth(value: unknown): number;
/** Clamp an unknown input to a legal maximum column width (see the min twin). */
export declare function clampColumnMaxWidth(value: unknown): number;
/**
 * Sanitize a raw section into a COMPLETE legal value: both read paths (host
 * viewOf, client loadConfig) run every field through its guard, so a
 * hand-edited document or a corrupt wire can never widen what the UI renders.
 * Policy on READS: numbers clamp, enums/booleans fall back to the default,
 * strings bound. (Writes are stricter: a non-boolean rejects — see
 * parseSettingsBody.)
 */
export declare function sanitizeSettings(raw: unknown): IdeasSettingsValue;
/**
 * Strict parser for the config write body ({ patch, expectedRevision? }).
 * Unknown keys reject; booleans must be REAL booleans (no meaningful clamp —
 * a non-boolean is a corrupt wire); tagRows clamps and the enums sanitize to
 * their default (the lenient read policy); workspaceScope is a bounded
 * string. An absent field yields an empty patch (a no-op merge that still
 * carries the revision fence).
 */
export declare function parseSettingsBody(value: unknown): {
    patch: IdeasSettingsPatch;
    expectedRevision: number | undefined;
} | undefined;
export {};
