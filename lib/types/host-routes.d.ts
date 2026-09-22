/**
 * Ideas host routes: GET /api/ideas/state, POST /api/ideas/action, and the
 * SSE /api/ideas/events stream, all behind the loopback + browser same-origin
 * fence. Follows the dsh-task-board route discipline (same error ids, same
 * body limits, same guard semantics) without importing any of its code.
 */
import type { IncomingMessage } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { IdeasHostService } from './host-service.ts';
import { type IdeasSettingsPatch, type IdeasSettingsView } from './protocol.ts';
/**
 * Ideas route fence. Direct desktop access uses the loopback socket + Host
 * guard and additionally requires a browser same-origin marker: a bare local
 * curl without any browser signal cannot exercise the agent control plane.
 */
export declare function isTrustedIdeasRequest(req: IncomingMessage): boolean;
/**
 * Settings seam the config route calls in-process — the DSH settings RPC
 * domain does not serve third-party namespaces to configuration clients (the
 * Side card lesson), so the plugin exposes its own fenced route instead. The
 * getter form lets the routes mount before `ctx.inject(['settings'])` fills
 * the face, and a deployment without a settings service answers
 * `available: false` forever (the client keeps the spelled defaults).
 */
export interface IdeasConfigPort {
    /** Current resolved view (clamped value + revision fence). */
    read(): IdeasSettingsView;
    /** Merge an already-clamped patch; rejects with code SETTINGS_CONFLICT on a stale revision. */
    write(patch: IdeasSettingsPatch, expectedRevision: number | undefined): Promise<IdeasSettingsView>;
}
export declare function makeIdeasRoutes(service: IdeasHostService, configPort?: () => IdeasConfigPort | undefined): WebRoute[];
