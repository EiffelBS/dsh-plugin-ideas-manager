/**
 * Browser transport for the /api/ideas Host API. Same-origin fetch with the
 * loopback guards (the Host fence requires browser same-origin markers, which
 * plain fetch sends automatically), plus a short-poll subscription standing
 * in for the former SSE stream (see `subscribe` for the connection-pool
 * rationale). Mirrors the dsh-task-board host-api discipline.
 */
import { type IdeasAction, type IdeasEventPayload, type IdeasSnapshot } from '../protocol.ts';
export interface IdeasHostTransport {
    state(): Promise<IdeasSnapshot>;
    action(action: IdeasAction, initiator?: string): Promise<IdeasSnapshot>;
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
}
export declare class HttpIdeasHostTransport implements IdeasHostTransport {
    state(): Promise<IdeasSnapshot>;
    action(action: IdeasAction, initiator?: string): Promise<IdeasSnapshot>;
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
