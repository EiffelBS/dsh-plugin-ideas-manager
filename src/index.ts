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
import { sanitizeSettings, IDEAS_SETTINGS_DEFAULTS, type IdeasSettingsView } from './protocol.ts'
import { mountOnce } from './mount-once.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210

export const inject = ['webServer', 'systemPrompt']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const IDEAS_GUIDANCE = `dsh-plugin-ideas-manager is installed (generic idea manager, "Ideas" board in the sidebar under New Session): a Host-authoritative /api/ideas ledger, one idea record per workspace (workspaceId; absent = generic), rendered as a 4-column kanban (open / under review / archived / declined) with an Overview tab and a ranked Priorities tab. The ledger is the SOURCE OF TRUTH for ideas — it replaces any IDEAS.md / IDEAS-ARCHIVE.md file convention; the markdown export is a generated view only (ledger -> IDEAS.md / IDEAS-ARCHIVE.md), never parsed back. When the user mentions ideas / backlog / idees / notes, collaborate through this board.

Workflow: (1) CAPTURE into the ledger, never into a markdown file: title + a body holding the analysis as markdown (context, value, effort, first-step sketch / execution info, risks). (2) On capture, record a PRIORITY OPINION: set value + effort levels and suggest a rank. (3) RE-RANK the whole open backlog against the current project state on every material change (new idea, delivery, scope change): the Priorities ranking stays the current best ordering, never a plain append; re-rank only on material change and ranks stay advisory (scheduling is the author's call). (4) LIFECYCLE: finished work moves to UNDER REVIEW (the recette gate; automatically when its task-board card reaches done); a recette OK delivers the idea (archived, stamped), a recette NOK raises a linked follow-up idea (child, open) and archives the parent, or declines it. (5) TaskBoard mirror (when the task-board plugin is present; one-way, best-effort): capture -> backlog card, updates -> card update, decline -> archive; delivered cards are closed by the author's closure run (done is runner-owned — never automate idea -> done from here). The board is autonomous without the task-board plugin.`

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

  /** Structural face of the host `settings` service (no dsh-settings dependency). */
  interface SettingsFace {
    register(ns: string, schema: unknown, options?: { applies?: 'live' | 'restart' }): unknown
    describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; value: unknown; revision: number }>
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  }
  /** Display-settings schema: permissive types (clamped/sanitized at every
   *  boundary — a ranged schema would reject a bad stored section AT
   *  REGISTRATION and brick the namespace; see sanitizeSettings). */
  const IdeasSettingsSchema = z.object({
    tagRows: z.number().default(IDEAS_SETTINGS_DEFAULTS.tagRows),
    defaultTab: z.string().default(IDEAS_SETTINGS_DEFAULTS.defaultTab),
    renderMarkdown: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.renderMarkdown),
    rememberWorkspaceScope: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.rememberWorkspaceScope),
    workspaceScope: z.string().default(IDEAS_SETTINGS_DEFAULTS.workspaceScope),
    confirmLifecycle: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.confirmLifecycle),
    hideDeclinedColumn: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.hideDeclinedColumn),
    cardDensity: z.string().default(IDEAS_SETTINGS_DEFAULTS.cardDensity),
  })

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

  // User-facing display settings (the DSH Settings modal section). The
  // namespace is registered with the host settings provider here; the browser
  // half reads and writes it through the plugin's own fenced
  // /api/ideas/config route, because the DSH settings RPC domain serves only
  // allowlisted namespaces to configuration clients (the Side card lesson).
  // A deployment without a settings service never fills the face and the
  // client keeps the spelled defaults; a corrupt stored section rejects the
  // registration itself and degrades the same way (settings are a nicety).
  let configPort: IdeasConfigPort | undefined
  ctx.inject(['settings'], (sctx) => {
    const settings = (sctx as unknown as { settings?: SettingsFace }).settings
    if (settings === undefined) return
    const ns = IDEAS_SETTINGS_NAMESPACE
    try {
      settings.register(ns, IdeasSettingsSchema, { applies: 'live' })
    } catch (error) {
      console.error('[dsh-plugin-ideas-manager] settings namespace registration failed', error)
      return
    }
    const viewOf = (): IdeasSettingsView => {
      const descriptor = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
      if (descriptor === undefined) return { available: true, value: IDEAS_SETTINGS_DEFAULTS }
      // Every field through sanitizeSettings: a hand-edited section can never
      // widen what the UI renders.
      return { available: true, value: sanitizeSettings(descriptor.value), revision: descriptor.revision }
    }
    configPort = {
      read: viewOf,
      write: async (patch, expectedRevision) => {
        // The route parser already sanitized every present field (exact keys,
        // clamped numbers, sanitized enums, bounded scope): merge as-is.
        await settings.update(ns, patch, expectedRevision)
        return viewOf()
      },
    }
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
