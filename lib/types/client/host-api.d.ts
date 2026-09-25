/**
 * Browser transport for the /api/ideas Host API. Same-origin fetch with the
 * loopback guards (the Host fence requires browser same-origin markers, which
 * plain fetch sends automatically), plus a short-poll subscription standing
 * in for the former SSE stream (see `subscribe` for the connection-pool
 * rationale). Mirrors the dsh-task-board host-api discipline.
 */
import { type IdeasAction, type IdeasEventPayload, type IdeasListSnapshot, type IdeasReadQuery, type IdeasReadSnapshot, type IdeasSnapshot, type IdeasSettingsPatch, type IdeasSettingsView } from '../protocol.ts';
import type { IdeaRecord } from '../core/ideas.ts';
export interface IdeasHostTransport {
    /**
     * Board state as the LIST projection (idea #34): list fields + a short
     * body excerpt, voluminous analyses deferred to `idea()` / `stateFull()`.
     */
    state(): Promise<IdeasListSnapshot>;
    /**
     * Apply one action. The wire response stays the FULL snapshot (the
     * POST /api/ideas/action contract is frozen); the transport projects it
     * to the list view at the edge so the client only ever holds list rows.
     */
    action(action: IdeasAction, initiator?: string): Promise<IdeasListSnapshot>;
    /**
     * Bounded filtered read (idea #65). Optional so older hosts and lightweight
     * test transports keep the pre-existing board controller contract intact.
     */
    read?(query?: IdeasReadQuery): Promise<IdeasReadSnapshot>;
    /**
     * Full-body snapshot (no projection): the deep-search index and parity
     * with pre-idea#34 consumers. Optional - a transport without it keeps
     * excerpt-level search (see IdeasClient.ensureSearchIndex).
     */
    stateFull?(): Promise<IdeasSnapshot>;
    /**
     * One full record (body + analysisAudit included): the deferred-body read
     * behind edit / follow-up / re-analyze. Optional like `config`.
     */
    idea?(id: string): Promise<IdeaRecord>;
    /**
     * Subscribe to refresh opportunities. No SSE stream is opened: the browser
     * HTTP/1.1 connection pool is shared across tabs and capped (~6 per
     * origin), and each long-lived EventSource per tab (ideas, task-board, the
     * shell HMR /plugins/events) permanently occupies one slot. A second tab
     * then exhausts the pool and page reloads starve every fetch — the board
     * surfaces this as "Host request timed out after 15s". So the transport
     * polls `state` on a short timer instead, and only while the page is
     * visible and (when given) `isActive` reports the board open; each poll is
     * an ordinary short fetch that returns its connection to the pool.
     * @param listener - invoked on each refresh opportunity (no payload).
     * @param isActive - optional gate; when provided, polls only while it
     *   returns true (e.g. the board is open).
     * @returns a disposer stopping the polling.
     */
    subscribe(listener: (event?: IdeasEventPayload) => void, isActive?: () => boolean): () => void;
    /**
     * Read the plugin display settings (tagRows...). Optional capability: a
     * transport without it — an older Host, a test fake — leaves the client on
     * the spelled defaults (see IdeasClient.loadConfig).
     */
    config?(): Promise<IdeasSettingsView>;
    /** Persist a settings patch (revision-fenced); rejects with 'settings-conflict'. */
    saveConfig?(patch: IdeasSettingsPatch, expectedRevision?: number): Promise<IdeasSettingsView>;
}
export declare class HttpIdeasHostTransport implements IdeasHostTransport {
    state(): Promise<IdeasListSnapshot>;
    stateFull(): Promise<IdeasSnapshot>;
    read(query?: IdeasReadQuery): Promise<IdeasReadSnapshot>;
    idea(id: string): Promise<IdeaRecord>;
    /**
     * The action wire is untouched (full snapshot, frozen contract); the
     * projection to list rows happens HERE so every client consumer - board,
     * priorities, delivered - works from the same deferred-body shape as the
     * lean `state()` poll.
     */
    action(action: IdeasAction, initiator?: string): Promise<IdeasListSnapshot>;
    config(): Promise<IdeasSettingsView>;
    saveConfig(patch: IdeasSettingsPatch, expectedRevision?: number): Promise<IdeasSettingsView>;
    private post;
    private request;
    /**
     * Poll `state` instead of holding an EventSource. Rationale: the browser
     * caps HTTP/1.1 connections per origin (~6) across ALL tabs; each ongoing
     * SSE (ours, task-board's, the shell HMR's) pins one slot forever, so two
     * tabs exhaust the pool and a page reload starves every fetch — surfacing
     * as "Host request timed out after 15s" in a refresh loop. Polling keeps
     * every request short-lived and returns its slot to the pool.
     * @param listener - called whenever a refresh opportunity arrives.
     * @param isActive - when given, polls only while it returns true (board
     *   open); a closed board consumes no connections and no traffic.
     */
    subscribe(listener: (event?: IdeasEventPayload) => void, isActive?: () => boolean): () => void;
}
