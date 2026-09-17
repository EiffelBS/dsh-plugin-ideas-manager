/**
 * Ideas host routes: GET /api/ideas/state, POST /api/ideas/action, and the
 * SSE /api/ideas/events stream, all behind the loopback + browser same-origin
 * fence. Follows the dsh-task-board route discipline (same error ids, same
 * body limits, same guard semantics) without importing any of its code.
 */
import type { IncomingMessage } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { IdeasHostService } from './host-service.ts';
/**
 * Ideas route fence. Direct desktop access uses the loopback socket + Host
 * guard and additionally requires a browser same-origin marker: a bare local
 * curl without any browser signal cannot exercise the agent control plane.
 */
export declare function isTrustedIdeasRequest(req: IncomingMessage): boolean;
export declare function makeIdeasRoutes(service: IdeasHostService): WebRoute[];
