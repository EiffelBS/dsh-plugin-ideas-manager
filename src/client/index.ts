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

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IdeasClient } from './ideas-client.ts'
import { HttpIdeasHostTransport } from './host-api.ts'
import { registerIdeasPanel } from './panel-registration.tsx'
import { resolvePanelNavigator } from './panel-navigation.ts'
import { ensureIdeasStyle } from './style.ts'
import { registerIdeasSettingsSection } from './settings-section.tsx'
import { resolveWorkspacesSource, WORKSPACES_SERVICE } from './workspaces.ts'
import { resolveActiveWorkspaceSource, SESSIONS_SERVICE } from './session-context.ts'
import { resolveSessionLauncher } from './session-queue.ts'
import { resolveSessionOpener } from './session-opener.ts'
import { createIdeasBoardService, IDEAS_BOARD_SERVICE } from './deeplink-service.ts'

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

// Deep-link to an idea (idea #105): the reference grammar and the published
// service name are part of the plugin's client surface, so a caller can feature-
// detect the board without importing a private module.
export { IDEAS_BOARD_SERVICE, createIdeasBoardService } from './deeplink-service.ts'
export type { IdeasBoardService } from './deeplink-service.ts'
export { parseIdeaRef, resolveIdeaRef, focusReadQuery } from './deeplink.ts'
export type { IdeaRef, FocusableIdea } from './deeplink.ts'
export type { IdeaFocusOutcome } from './ideas-client.ts'

// A duplicated client injection (module factory executed twice in one page
// lifetime) would otherwise register a second sidebar row and board page.
// First application wins; later calls become no-ops until the fiber unloads
// (hot-reload), when the claim is released so a rebuilt bundle can register.
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
    // Idea #66: the jump back into the run a card was worked on. The navigation
    // face is optional, so the resolver degrades to undefined — and a missing
    // face is WARNED, never swallowed: a link that is absent because the name is
    // wrong looks exactly like a link that is absent because the deployment does
    // not support it, and only one of those is a bug.
    client.sessionOpener = resolveSessionOpener(ctx)
    if (client.sessionOpener === undefined) {
      console.warn('[dsh-plugin-ideas-manager] no session navigation face on this page (uiWorkspace.openSession): the "Open session" link will not be shown')
    }
    // Panel navigation is read DEFENSIVELY, not declared in `inject`: cordis
    // refuses an undeclared property, and declaring a service a deployment may
    // not have would keep this whole plugin from booting.
    client.panelNavigator = resolvePanelNavigator(ctx)
    client.start()
    const disposers: Array<() => void> = []
    // The panel registration FIRST: whatever happens to the settings glue
    // below must never cost the sidebar row or the board (live regression: an
    // undeclared ctx.slots getter threw inside this try before the mounts
    // ran and the Ideas entry vanished).
    try {
      disposers.push(registerIdeasPanel(ctx, client))
    } catch (error) {
      // Registration failures degrade the board, never the GUI.
      console.error('[dsh-plugin-ideas-manager] panel registration failed:', error)
    }
    // Deep-link surface (idea #105): the one entry point another plugin can
    // reach this board through. Provided AFTER the panel so a consumer that
    // focuses immediately already finds the seats registered. The name is ours,
    // so a collision is a real error — logged, never thrown, because the web
    // shell fails the whole boot when a plugin apply throws.
    try {
      disposers.push(ctx.provide(IDEAS_BOARD_SERVICE, createIdeasBoardService(client)))
    } catch (error) {
      console.error('[dsh-plugin-ideas-manager] deep-link service registration failed:', error)
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
  }, 'ideas: panel registration and settings section')
}
