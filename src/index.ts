/**
 * Host loader entry for the dsh-plugin-ideas-manager plugin.
 *
 * The Host owns the (P0 in-memory) ideas ledger, the /api/ideas routes, and
 * the discrete system-prompt announcement. The browser is a same-origin
 * asynchronous view over that service, mounted through the ./client entry.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { IdeasHostService } from './host-service.ts'
import { HttpTaskBoardTransport, TaskBoardMirror } from './taskboard-bridge.ts'
import { makeIdeasRoutes } from './host-routes.ts'
import { mountOnce } from './mount-once.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210

export const inject = ['webServer', 'systemPrompt']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const IDEAS_GUIDANCE = `dsh-plugin-ideas-manager is installed (generic idea manager, "Ideas" board in the sidebar under New Session): a Host-authoritative /api/ideas ledger, one idea record per workspace (workspaceId; absent = generic), rendered as a 3-column kanban (open / archived / declined) with an Overview tab and a ranked Priorities tab. The ledger is the SOURCE OF TRUTH for ideas — it replaces any IDEAS.md / IDEAS-ARCHIVE.md file convention; the markdown export is a generated view only (ledger -> IDEAS.md / IDEAS-ARCHIVE.md), never parsed back. When the user mentions ideas / backlog / idees / notes, collaborate through this board.

Workflow: (1) CAPTURE into the ledger, never into a markdown file: title + a body holding the analysis as markdown (context, value, effort, first-step sketch / execution info, risks). (2) On capture, record a PRIORITY OPINION: set value + effort levels and suggest a rank. (3) RE-RANK the whole open backlog against the current project state on every material change (new idea, delivery, scope change): the Priorities ranking stays the current best ordering, never a plain append; re-rank only on material change and ranks stay advisory (scheduling is the author's call). (4) LIFECYCLE: delivered ideas leave the open backlog with a record of the delivery; declined ideas leave with a decision note. (5) TaskBoard mirror (when the task-board plugin is present; one-way, best-effort): capture -> backlog card, updates -> card update, decline -> archive; delivered cards are closed by the author's closure run (done is runner-owned — never automate idea -> done from here). The board is autonomous without the task-board plugin.`

/**
 * Settings namespace of the ideas announcement capability — the section the
 * web settings surface will edit (P1). Spelled here rather than imported: the
 * browser half spells the same value and must not depend on a Host package.
 */
export const IDEAS_SETTINGS_NAMESPACE = 'ideas' as const

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (browser half + host routes). */
  enabled?: boolean
  /**
   * When true, a system-prompt section announces the board to every agent.
   * Set false (default) to keep the board silent in prompts.
   */
  announceToAgent?: boolean
  /** Whether the TaskBoard mirror is attempted when the bridge is detected (P2). */
  autoMirror?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(false),
  autoMirror: z.boolean().default(true),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = false

/**
 * Register the ideas host: ledger + routes, plus the announcement section
 * gated on the composition entry's `announceToAgent`.
 * @param ctx - the plugin context (webServer + systemPrompt injected).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('dsh-plugin-ideas-manager', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  // P2: the optional TaskBoard mirror. Feature-detected at runtime against the
  // Host's own origin over loopback — no hard import of the task-board plugin.
  const mirror = new TaskBoardMirror({
    transport: new HttpTaskBoardTransport(() => `http://127.0.0.1:${ctx.webServer.port}`),
  })
  const host = new IdeasHostService({ mirror, autoMirror: config?.autoMirror ?? true })
  host.setActive(config?.enabled ?? true)
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const route of makeIdeasRoutes(host)) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers) dispose()
      host.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      host.dispose()
    }
  }, 'ideas: host ledger and routes')

  // P0: the announcement reads the composition entry only. The settings
  // namespace surface (P1) swaps `current` when the web settings are served,
  // exactly like the task-board plugin's installSection hook.
  let current: () => Config = () => config ?? {}
  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const active = current().enabled ?? true
    host.setActive(active)
    if (!active) return
    if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === false) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:ideas',
      order: SECTION_ORDER,
      text: IDEAS_GUIDANCE,
    })
  }
  sync()
}
