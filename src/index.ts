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
import { installIdeasAnalystSkill } from './skill-install.ts'
import { HttpTaskBoardTransport, TaskBoardMirror } from './taskboard-bridge.ts'
import { makeIdeasRoutes, type IdeasConfigPort } from './host-routes.ts'
import { createIdeasConfigPort } from './host-settings.ts'
import { mountOnce } from './mount-once.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210

export const inject = ['webServer', 'systemPrompt']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const IDEAS_GUIDANCE = `dsh-plugin-ideas-manager is installed (generic idea manager, "Ideas" board in the sidebar under New Session): a Host-authoritative /api/ideas ledger, one idea record per workspace (workspaceId; absent = generic), rendered as a 4-column kanban (open / under review / archived / declined) with an Overview tab and a ranked Priorities tab. The ledger is the SOURCE OF TRUTH for ideas — it replaces any IDEAS.md / IDEAS-ARCHIVE.md file convention; the markdown export is a generated view only (ledger -> IDEAS.md / IDEAS-ARCHIVE.md), never parsed back. When the user mentions ideas / backlog / idees / notes, collaborate through this board.

Workflow: (1) CAPTURE into the ledger, never into a markdown file: title + a body holding the analysis as markdown (context, value, effort, first-step sketch / execution info, risks). (2) On capture, record a PRIORITY OPINION: set value + effort levels and suggest a rank. (3) RE-RANK the whole open backlog against the current project state on every material change (new idea, delivery, scope change): the Priorities ranking stays the current best ordering, never a plain append; re-rank only on material change and ranks stay advisory (scheduling is the author's call). (4) LIFECYCLE: finished work moves to UNDER REVIEW (the recette gate; automatically when its task-board card reaches done); a recette OK delivers the idea (archived, stamped), a recette NOK raises a linked follow-up idea (child, open) and archives the parent, or declines it. (5) TaskBoard mirror (when the task-board plugin is present; one-way, best-effort): capture -> backlog card, updates -> card update, decline -> archive; delivered cards are closed by the author's closure run (done is runner-owned — never automate idea -> done from here). The board is autonomous without the task-board plugin.`

/**
 * Settings namespace of the ideas announcement capability — the section the
 * web settings surface edits (P1). Owned by the host-settings wiring (both
 * host contracts) and re-exported here so the public entry surface of the
 * plugin stays put.
 */
export { IDEAS_SETTINGS_NAMESPACE } from './host-settings.ts'

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
  // P3 refinement: install the ideas-analyst skill into the user-dsh skill
  // root so any analysing session loads it from the catalog (best-effort and
  // first-wins — a hand-edited file is kept; see src/skill-install.ts).
  installIdeasAnalystSkill()

  // P2: the optional TaskBoard mirror. Feature-detected at runtime against the
  // Host's own origin over loopback — no hard import of the task-board plugin.
  const mirror = new TaskBoardMirror({
    transport: new HttpTaskBoardTransport(() => `http://127.0.0.1:${ctx.webServer.port}`),
  })
  const host = new IdeasHostService({ mirror, autoMirror: config?.autoMirror ?? true })
  host.setActive(config?.enabled ?? true)
  // The recette gate: watch mirrored cards passing `done` and move the linked
  // idea to underReview automatically (light poll, best-effort, no-op without
  // the mirror / autoMirror).
  if (config?.autoMirror ?? true) host.startUnderReviewPoll()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      // The config port getter is late-bound: the routes mount before (or
      // without) the settings service and answer `available: false` until
      // ctx.inject(['settings']) fills the face further down.
      for (const route of makeIdeasRoutes(host, () => configPort)) disposers.push(ctx.webServer.register(route))
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

  // User-facing display settings (the DSH Settings modal section). The port
  // the /api/ideas/config route serves is chosen by CONTRACT DETECTION at
  // injection time (see src/host-settings.ts):
  //  - host <= 0.1.5 (`settings.register` present): the legacy namespace port,
  //    byte-identical to 0.3.3;
  //  - host >= 0.1.7 (SettingsForms refactor, no `register`): the plugin-owned
  //    versioned document under DSH_HOME — no call into the refactored
  //    service, so boot logs stay clean on 0.1.7.
  // The browser half keeps reading and writing through its own fenced
  // /api/ideas/config route either way (the DSH settings RPC domain serves
  // only allowlisted namespaces to configuration clients — the Side card
  // lesson). A deployment without a settings service never fills the face and
  // the client keeps the spelled defaults.
  let configPort: IdeasConfigPort | undefined
  ctx.inject(['settings'], (sctx) => {
    const settings = (sctx as unknown as { settings?: unknown }).settings
    configPort = createIdeasConfigPort(settings)
    return () => { configPort = undefined }
  })

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
