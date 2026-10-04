/**
 * The deep-link service the board publishes.
 *
 * The missing entry point the brief describes: the `main` slot is keyed and
 * carries no selection payload, so there was no way for anything to say "show
 * idea #42" to this panel — until the board started publishing a service of its
 * own. `ctx.provide` is the cordis mechanism for exactly this (a face a
 * consumer does not declare in `inject` and may therefore be missing), which is
 * why it is preferred over anything this plugin would have to own end to end.
 *
 * Two rules keep the publication safe:
 *
 * - **It is never declared in `inject`.** A service a deployment does not consume
 *   must not be able to keep the whole plugin from booting; the caller feature-
 *   detects with `ctx.get(…)` and treats undefined as "this build has no
 *   deep-link", never as an error.
 * - **It is a thin facade.** It owns no state of its own: it forwards to the same
 *   `IdeasClient` the panel renders from, so a caller and the board can never
 *   disagree about what is focused.
 */
import type { IdeasClient, IdeaFocusOutcome } from './ideas-client.ts';
/** The cordis service name other plugins reach the ideas board through. */
export declare const IDEAS_BOARD_SERVICE = "ideas-manager.board";
/** What a caller can ask of a published ideas board. */
export interface IdeasBoardService {
    /**
     * Focus one idea, by `#N`, by number, by mirrored-card id (`idea-<id>`) or by
     * idea id. Brings the board panel to the front first; works whether or not the
     * board is currently mounted.
     *
     * @param ref - the reference to focus.
     */
    focusIdea(ref: string): void;
    /** The card a deep-link landed on, or undefined once the human took over. */
    readonly focusedIdeaId: string | undefined;
    /** What the last request achieved, for a caller that wants to report it. */
    readonly lastFocusOutcome: IdeaFocusOutcome | undefined;
}
/**
 * Build the published face over an ideas client.
 *
 * @param client - the client the board panel renders from.
 * @returns the service value to hand to `ctx.provide`.
 */
export declare function createIdeasBoardService(client: IdeasClient): IdeasBoardService;
