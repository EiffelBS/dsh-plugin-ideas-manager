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
import { registerIdeasSettingsSection } from './settings-section.tsx'
import { resolveWorkspacesSource, WORKSPACES_SERVICE } from './workspaces.ts'
import { resolveActiveWorkspaceSource, SESSIONS_SERVICE } from './session-context.ts'
import { resolveSessionLauncher } from './session-queue.ts'
import { resolveSessionOpener, sessionsServiceOf } from './session-opener.ts'

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
export const inject = ['slots', WORKSPACES_SERVICE, SESSIONS_SERVICE, 'remote', 'remote.session'] as const

// Programmatic client surface (idea #65): the board consumes these classes,
// while agents and integrations can use the same bounded read/query contract
// without reaching into private client modules.
export { HttpIdeasHostTransport } from './host-api.ts'
export type { IdeasHostTransport } from './host-api.ts'
export { IdeasClient } from './ideas-client.ts'
export type { IdeaClientPatch } from './ideas-client.ts'

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
    // Idea #66: the jump back into a run the board started. Same optional
    // "sessions" face as the launcher, so a deployment without it renders no
    // link instead of a broken one.
    client.sessionOpener = resolveSessionOpener(sessionsServiceOf(ctx as unknown as Record<string, unknown>))
    client.start()
    const disposers: Array<() => void> = []
    // The two mounting surfaces FIRST: whatever happens to the settings glue
    // below must never cost the sidebar entry or the board (live regression:
    // an undeclared ctx.slots getter threw inside this try before the mounts
    // ran and the Ideas entry vanished).
    try {
      disposers.push(mountSidebarEntry(client))
      disposers.push(mountBoard(client))
    } catch (error) {
      // DOM failures degrade the board, never the GUI.
      console.error('[dsh-plugin-ideas-manager] mount failed:', error)
    }
    // Settings glue LAST and isolated: push tagRows onto the document on every
    // config change (the CSS default of 3 covers the gap before the first
    // answer) and register the Settings-modal section. The helper swallows its
    // own failures; this belt catches anything it might still throw.
    try {
      disposers.push(registerIdeasSettingsSection(ctx, client))
    } catch (error) {
      console.error('[dsh-plugin-ideas-manager] settings glue failed:', error)
    }
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      client.dispose()
    }
  }, 'ideas: sidebar entry and board view')
}
