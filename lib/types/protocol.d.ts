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
 * Input of the `followUp` verb: the child idea raised when the recette of an
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
/** Resolved display-settings value served by the config routes. */
export interface IdeasSettingsValue {
    /** Visible tag-filter chip rows on the board (clamped to 1..5). */
    tagRows: number;
}
/** Patch accepted by POST /api/ideas/config (exact keys, numbers clamped). */
export interface IdeasSettingsPatch {
    tagRows?: number;
}
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
 * Strict parser for the config write body ({ patch, expectedRevision? }).
 * Unknown keys and a non-number tagRows reject; a present number is clamped
 * before it ever reaches the settings service. An absent tagRows yields an
 * empty patch (a no-op merge that still carries the revision fence).
 */
export declare function parseSettingsBody(value: unknown): {
    patch: IdeasSettingsPatch;
    expectedRevision: number | undefined;
} | undefined;
export {};
