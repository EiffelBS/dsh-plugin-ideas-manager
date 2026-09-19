/**
 * Ideas client plugin: wires the framework-free ideas client to the real
 * client runtime and mounts the two DOM surfaces — the sidebar entry row and
 * the board view in the center column.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/**
 * Cordis services this plugin consumes. Declared so apply runs once the DSH
 * shell Workspace registry (dsh-api-workspace-controller) and the session
 * list are up; the board still works without them (ledger-derived workspace
 * ids only, scope-or-generic capture default).
 */
export declare const inject: readonly ["workspaces", "sessions"];
export declare function apply(ctx: ClientContext): void;
