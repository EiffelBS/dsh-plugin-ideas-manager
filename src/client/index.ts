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
    const client = new IdeasClient(new HttpIdeasHostTransport())
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
