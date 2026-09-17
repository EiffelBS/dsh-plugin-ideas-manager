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
    status: Extract<IdeaStatus, 'open' | 'archived'>;
} | {
    kind: 'decline';
    ideaId: string;
} | {
    kind: 'restore';
    ideaId: string;
} | {
    kind: 'delete';
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
    rank?: number;
    value?: number;
    effort?: number;
    tags?: IdeaTagListOrNull;
    workspaceId?: string;
}
type IdeaTagListOrNull = IdeaTag[] | null;
export declare function parseActionEnvelope(value: unknown): IdeasActionEnvelope | undefined;
/** Convenience used by tests: build an idea record exactly as the ledger stores it. */
export declare function ideaFromInput(id: string, input: NewIdeaInput, now: number): IdeaRecord;
export {};
