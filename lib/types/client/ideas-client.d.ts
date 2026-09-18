/**
 * Framework-free client controller for the ideas board: holds the open flag
 * and the latest Host snapshot, refreshes through the transport, and notifies
 * subscribers (the sidebar row and the React board). No React, no cordis —
 * the DOM mounts at the edges only.
 */
import type { IdeaStatus } from '../core/ideas.ts';
import type { IdeasSnapshot } from '../protocol.ts';
import type { IdeasHostTransport } from './host-api.ts';
/** Client-side patch accepted by `updateIdea`. */
export interface IdeaClientPatch {
    title?: string;
    body?: string;
    value?: number;
    effort?: number;
    /** Present means "replace the label set"; an empty array clears it. */
    tags?: string[];
}
export declare class IdeasClient {
    private readonly transport;
    boardOpen: boolean;
    snapshot: IdeasSnapshot | undefined;
    error: string | undefined;
    pending: boolean;
    private readonly listeners;
    private unsubscribeEvents;
    constructor(transport: IdeasHostTransport);
    subscribe(listener: () => void): () => void;
    toggleBoard(): void;
    closeBoard(): void;
    /** Initial load + SSE revision push refresh. */
    start(): void;
    dispose(): void;
    refresh(): Promise<void>;
    createIdea(input: {
        title: string;
        body: string;
        tags?: string[];
        value?: number;
        effort?: number;
    }): Promise<void>;
    updateIdea(ideaId: string, patch: IdeaClientPatch): Promise<void>;
    moveIdea(ideaId: string, status: Extract<IdeaStatus, 'open' | 'archived'>): Promise<void>;
    declineIdea(ideaId: string): Promise<void>;
    restoreIdea(ideaId: string): Promise<void>;
    deleteIdea(ideaId: string): Promise<void>;
    reorderIdea(orderedIds: string[]): Promise<void>;
    /** Post one action, adopt the Host snapshot, and expose errors. */
    private run;
    private emit;
}
