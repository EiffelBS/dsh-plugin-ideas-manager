/**
 * Ideas client plugin: wires the framework-free ideas client to the real
 * client runtime and registers the board as a native shell panel (a sidebar
 * row in `sidebar.panellist` and a page in the keyed `main` slot), plus the
 * Settings-modal section.
 *
 * Failure policy: registration problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/**
 * Cordis services this plugin consumes. Declared so apply runs once the DSH
 * shell Workspace registry (dsh-api-workspace-controller), the session
 * controller and the typed remote namespaces are up; the board still works
 * without them (ledger-derived workspace ids only, scope-or-generic capture
 * default). `remote` / `remote.session` are required so the model picker can
 * read the Host catalog and select a model; without them the AI capture stays
 * functional but the model selector is hidden. `slots` is the shell slot
 * registry (settings.section...): cordis REFUSES ctx.slots access without the
 * declaration ("cannot get property without inject") — same inject the Side
 * card plugin declares; the web shell bundle provides the service.
 */
export declare const inject: readonly ["slots", "workspaces", "sessions", "remote", "remote.session"];
export { HttpIdeasHostTransport } from './host-api.ts';
export type { IdeasHostTransport } from './host-api.ts';
export { IdeasClient } from './ideas-client.ts';
export type { IdeaClientPatch } from './ideas-client.ts';
export { IDEAS_BOARD_SERVICE, createIdeasBoardService } from './deeplink-service.ts';
export type { IdeasBoardService } from './deeplink-service.ts';
export { parseIdeaRef, resolveIdeaRef, focusReadQuery } from './deeplink.ts';
export type { IdeaRef, FocusableIdea } from './deeplink.ts';
export type { IdeaFocusOutcome } from './ideas-client.ts';
export declare function apply(ctx: ClientContext): void;
