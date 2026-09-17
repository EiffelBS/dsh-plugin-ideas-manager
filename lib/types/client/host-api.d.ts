/**
 * Browser transport for the /api/ideas Host API. Same-origin fetch with the
 * loopback guards (the Host fence requires browser same-origin markers, which
 * plain fetch sends automatically), plus an SSE subscription for revision
 * pushes. Mirrors the dsh-task-board host-api discipline.
 */
import { type IdeasAction, type IdeasEventPayload, type IdeasSnapshot } from '../protocol.ts';
export interface IdeasHostTransport {
    state(): Promise<IdeasSnapshot>;
    action(action: IdeasAction, initiator?: string): Promise<IdeasSnapshot>;
    subscribe(listener: (event?: IdeasEventPayload) => void): () => void;
}
export declare class HttpIdeasHostTransport implements IdeasHostTransport {
    state(): Promise<IdeasSnapshot>;
    action(action: IdeasAction, initiator?: string): Promise<IdeasSnapshot>;
    private post;
    private request;
    subscribe(listener: (event?: IdeasEventPayload) => void): () => void;
}
