/**
 * Ideas client plugin: wires the framework-free ideas client to the real
 * client runtime and mounts the two DOM surfaces — the sidebar entry row and
 * the board view in the center column.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IdeasClient } from './ideas-client.ts'
import { HttpIdeasHostTransport } from './host-api.ts'
import { mountBoard } from './board-mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { ensureIdeasStyle } from './style.ts'
import { resolveWorkspacesSource, WORKSPACES_SERVICE } from './workspaces.ts'
import { resolveActiveWorkspaceSource, SESSIONS_SERVICE } from './session-context.ts'
import { resolveSessionLauncher } from './session-queue.ts'

/**
 * Cordis services this plugin consumes. Declared so apply runs once the DSH
 * shell Workspace registry (dsh-api-workspace-controller) and the session
 * list are up; the board still works without them (ledger-derived workspace
 * ids only, scope-or-generic capture default).
 */
export const inject = [WORKSPACES_SERVICE, SESSIONS_SERVICE] as const

// A duplicated client injection (module factory executed twice in one page
// lifetime) would otherwise mount a second sidebar entry and board view.
// First application wins; later calls become no-ops until the fiber unloads
// (hot-reload), when the claim is released so a rebuilt bundle can mount.
let claimed = false
const releaseClaim = (): void => { claimed = false }

export function apply(ctx: ClientContext): void {
  if (claimed) return
  claimed = true
  ctx.effect(() => releaseClaim, 'ideas: apply claim')

  ctx.effect(() => {
    ensureIdeasStyle()
    const workspaces = resolveWorkspacesSource(ctx)
    // T3: read-only session-context hint (current session's workspace); when
    // either the session service or the registry is absent this is undefined
    // and the capture default stays the board scope (else generic).
    const activeWorkspace = resolveActiveWorkspaceSource(ctx)
    const client = new IdeasClient(new HttpIdeasHostTransport(), workspaces, activeWorkspace)
    // Phase 3: the AI-capture launcher rides the same "sessions" service;
    // absent/malformed degrades to the plain manual Create.
    client.sessionLauncher = resolveSessionLauncher(ctx)
    client.start()
    const disposers: Array<() => void> = []
    try {
      disposers.push(mountSidebarEntry(client))
      disposers.push(mountBoard(client))
    } catch (error) {
      // DOM failures degrade the board, never the GUI.
      console.error('[dsh-plugin-ideas-manager] mount failed:', error)
    }
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      client.dispose()
    }
  }, 'ideas: sidebar entry and board view')
}
