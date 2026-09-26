/**
 * Display-settings wiring across the two host settings contracts.
 *
 * DSH <= 0.1.5 exposes the legacy namespace API:
 *
 *   ctx.settings.register(ns, schema, { applies: 'live' })
 *   ctx.settings.describe({ redactSecrets: true })  // descriptors keyed by .ns
 *   ctx.settings.update(ns, patch, expectedRevision)
 *
 * DSH >= 0.1.7 replaced that service with SettingsForms (@deepseek-ai/
 * dsh-settings): editable forms are derived from the plugin's Config schema,
 * `register` no longer exists, and `describe`/`update` are keyed by profile
 * entry id. The legacy call therefore throws
 * `TypeError: settings.register is not a function` at boot on 0.1.7.
 *
 * v0.3.4 strategy (the dsh-permissions 2.0.0 precedent):
 * - legacy contract detected at runtime (`typeof settings.register ===
 *   'function'`) -> the 0.3.3 code path runs UNCHANGED, so production on
 *   0.1.5 stays byte-identical (including the registration-failure log and
 *   the fact that no plugin file is ever touched on that host);
 * - no `register` (0.1.7+) -> the plugin owns its state in a small versioned
 *   document under DSH_HOME with an incrementing revision fence, so the
 *   /api/ideas/config contract (read / write with expectedRevision, 409 on a
 *   stale revision) is unchanged for the browser half on every host.
 *
 * Neither path touches the refactored contract: the plugin renders its OWN
 * settings section, so it never needs the host's form projection.
 * @module dsh-plugin-ideas-manager/host-settings
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { dshHome } from './dsh-home.ts'
import type { IdeasConfigPort } from './host-routes.ts'
import {
  sanitizeSettings,
  IDEAS_SETTINGS_DEFAULTS,
  type IdeasSettingsPatch,
  type IdeasSettingsValue,
  type IdeasSettingsView,
} from './protocol.ts'

/**
 * Settings namespace registered with the legacy host settings service. Spelled
 * here rather than imported from the host entry: the browser half spells the
 * same value and must not depend on a Host package.
 */
export const IDEAS_SETTINGS_NAMESPACE = 'ideas' as const

/**
 * Name of the plugin-owned settings document (only written on hosts without
 * `settings.register`, i.e. 0.1.7+). It sits next to the other plugin-owned
 * files of the DSH home (pet.json, mcp-manager.json ...).
 */
export const IDEAS_SETTINGS_FILE_NAME = 'ideas-manager-settings.json'

/** Format version of the plugin-owned document. */
const STORE_VERSION = 1

/** Structural face of the pre-0.1.7 settings service. */
interface LegacySettingsFace {
  register(ns: string, schema: unknown, options?: { applies?: 'live' | 'restart' }): unknown
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; value: unknown; revision: number }>
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/**
 * Display-settings schema: permissive types (clamped/sanitized at every
 * boundary — a ranged schema would reject a bad stored section AT
 * REGISTRATION and brick the namespace; see sanitizeSettings).
 */
export const IdeasSettingsSchema = z.object({
  tagRows: z.number().default(IDEAS_SETTINGS_DEFAULTS.tagRows),
  defaultTab: z.string().default(IDEAS_SETTINGS_DEFAULTS.defaultTab),
  renderMarkdown: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.renderMarkdown),
  rememberWorkspaceScope: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.rememberWorkspaceScope),
  workspaceScope: z.string().default(IDEAS_SETTINGS_DEFAULTS.workspaceScope),
  confirmLifecycle: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.confirmLifecycle),
  hideDeclinedColumn: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.hideDeclinedColumn),
  cardDensity: z.string().default(IDEAS_SETTINGS_DEFAULTS.cardDensity),
  language: z.string().default(IDEAS_SETTINGS_DEFAULTS.language),
  openOrdering: z.string().default(IDEAS_SETTINGS_DEFAULTS.openOrdering),
  runningFirst: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.runningFirst),
})

/**
 * Refusal raised by the plugin-owned store when the caller's revision fence is
 * stale. Carries the same stable `code` the config route maps to
 * 409 `settings-conflict`, mirroring the host's own SettingsConflictError.
 */
export class IdeasSettingsConflictError extends Error {
  /** Stable machine code the HTTP layer maps to 409 settings-conflict. */
  readonly code = 'SETTINGS_CONFLICT'
  /** Revision the caller expected. */
  readonly expected: number | undefined
  /** Revision the document actually stands at (undefined = no document yet). */
  readonly actual: number | undefined

  constructor(expected: number | undefined, actual: number | undefined) {
    super(`settings revision moved: expected ${expected ?? 'none'}, actual ${actual ?? 'none'}`)
    this.name = 'IdeasSettingsConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** Shape of the versioned plugin-owned document. */
interface StoreDocument {
  version: number
  revision: number
  value: IdeasSettingsValue
}

/** Options of {@link IdeasSettingsStore}. */
export interface IdeasSettingsStoreOptions {
  /** Absolute document path (default `<DSH_HOME>/ideas-manager-settings.json`). */
  file?: string
}

/**
 * Plugin-owned settings document: a versioned JSON file with an incrementing
 * revision, serving the exact {@link IdeasConfigPort} contract the config
 * route already speaks.
 *
 * Reads always answer (a missing document yields the spelled defaults with no
 * fence — same view the legacy path serves when the namespace holds no
 * descriptor yet), so the section is editable on any host. An unreadable
 * document is quarantined beside itself (renamed, never deleted — the ledger's
 * corrupt-document discipline) and the defaults take over: settings are a
 * nicety and must never brick the board.
 *
 * Every operation is synchronous inside the process, so two writes can never
 * interleave between the revision check and the commit.
 */
export class IdeasSettingsStore implements IdeasConfigPort {
  /** Absolute path of the versioned document. */
  readonly file: string
  /** Whether the corrupt-document report already ran for this instance. */
  private reported = false

  constructor(options: IdeasSettingsStoreOptions = {}) {
    this.file = options.file ?? join(dshHome(), IDEAS_SETTINGS_FILE_NAME)
  }

  read(): IdeasSettingsView {
    const state = this.load()
    if (state.kind === 'valid') return { available: true, value: state.document.value, revision: state.document.revision }
    if (state.kind === 'corrupt') this.quarantine()
    return { available: true, value: IDEAS_SETTINGS_DEFAULTS }
  }

  async write(patch: IdeasSettingsPatch, expectedRevision: number | undefined): Promise<IdeasSettingsView> {
    const state = this.load()
    if (state.kind === 'corrupt') this.quarantine()
    const current = state.kind === 'valid' ? state.document : undefined
    const currentRevision = current?.revision
    // Fence only when the caller sent one, mirroring the legacy
    // `update(ns, patch, expectedRevision?)` optionality: a client that read
    // before the document existed writes unfenced, a client holding a stale
    // revision is refused with the coded error.
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new IdeasSettingsConflictError(expectedRevision, currentRevision)
    }
    // The route parser already clamped every present field; sanitize the merge
    // anyway so a direct caller can never persist an illegal value.
    const value = sanitizeSettings({ ...IDEAS_SETTINGS_DEFAULTS, ...(current?.value ?? {}), ...patch })
    const revision = (currentRevision ?? 0) + 1
    this.persist({ version: STORE_VERSION, revision, value })
    return { available: true, value, revision }
  }

  /** Missing / corrupt / parsed-and-sanitized document. */
  private load(): { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'valid'; document: StoreDocument } {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      // Unreadable (permissions, transient lock): degrade like a corrupt one.
      return { kind: 'corrupt' }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'corrupt' }
      const row = parsed as Record<string, unknown>
      const revision = row.revision
      if (row.version !== STORE_VERSION || typeof revision !== 'number' || !Number.isFinite(revision) || revision < 0) {
        return { kind: 'corrupt' }
      }
      // Every field through sanitizeSettings: a hand-edited document can never
      // widen what the UI renders.
      return { kind: 'valid', document: { version: STORE_VERSION, revision, value: sanitizeSettings(row.value) } }
    } catch {
      return { kind: 'corrupt' }
    }
  }

  /**
   * Move an unreadable document aside (renamed, evidence kept) and report it
   * once per instance; a failed rename is reported, never thrown — the read
   * or write that found the document carries on with the defaults.
   */
  private quarantine(): void {
    if (this.reported) return
    this.reported = true
    const target = `${this.file}.corrupt-${Date.now()}`
    try {
      renameSync(this.file, target)
      console.warn(`[dsh-plugin-ideas-manager] unreadable settings document moved to ${target}; defaults apply`)
    } catch (error) {
      console.warn('[dsh-plugin-ideas-manager] unreadable settings document; defaults apply', error)
    }
  }

  /** Atomic tmp+rename commit with a direct-write fallback (Windows EPERM rename flake, host-ledger lesson). */
  private persist(document: StoreDocument): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmpFile = `${this.file}.tmp-${process.pid}`
    const text = `${JSON.stringify(document, null, 2)}\n`
    try {
      writeFileSync(tmpFile, text)
    } catch (error) {
      try { unlinkSync(tmpFile) } catch { /* best effort */ }
      throw error
    }
    try {
      renameSync(tmpFile, this.file)
    } catch {
      try {
        writeFileSync(this.file, text)
      } catch (error) {
        try { unlinkSync(tmpFile) } catch { /* best effort */ }
        throw error
      }
      try { unlinkSync(tmpFile) } catch { /* best effort */ }
    }
  }
}

/** Options of {@link createIdeasConfigPort}. */
export interface IdeasConfigPortOptions {
  /** Document path used when the host exposes no legacy `register` (tests inject a scratch path). */
  file?: string
}

/**
 * Build the config port GET/POST /api/ideas/config serves, choosing the
 * contract the running host exposes.
 *
 * - `settings` absent -> no port: the route keeps answering `available: false`
 *   and 503 `settings-unavailable`, exactly like a deployment without a
 *   settings service (the client keeps the spelled defaults).
 * - `settings.register` present (host <= 0.1.5) -> the legacy namespace port,
 *   byte-identical to 0.3.3, including the caught-and-logged registration
 *   failure that leaves the port unset.
 * - otherwise (host >= 0.1.7, SettingsForms refactor) -> the plugin-owned
 *   {@link IdeasSettingsStore}; nothing is registered and no refactored method
 *   is called, so boot logs stay clean.
 *
 * @param settings - the injected `settings` service (any shape).
 * @param options - port options (store document path).
 * @returns the port to serve, or undefined when the deployment has none.
 */
export function createIdeasConfigPort(settings: unknown, options: IdeasConfigPortOptions = {}): IdeasConfigPort | undefined {
  const face = settings as Partial<LegacySettingsFace> | null | undefined
  if (face === undefined || face === null) return undefined

  if (typeof face.register !== 'function') {
    return new IdeasSettingsStore(options.file === undefined ? {} : { file: options.file })
  }

  const legacy = face as LegacySettingsFace
  const ns = IDEAS_SETTINGS_NAMESPACE
  try {
    legacy.register(ns, IdeasSettingsSchema, { applies: 'live' })
  } catch (error) {
    console.error('[dsh-plugin-ideas-manager] settings namespace registration failed', error)
    return undefined
  }
  const viewOf = (): IdeasSettingsView => {
    const descriptor = legacy.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
    if (descriptor === undefined) return { available: true, value: IDEAS_SETTINGS_DEFAULTS }
    // Every field through sanitizeSettings: a hand-edited section can never
    // widen what the UI renders.
    return { available: true, value: sanitizeSettings(descriptor.value), revision: descriptor.revision }
  }
  return {
    read: viewOf,
    write: async (patch, expectedRevision) => {
      // The route parser already sanitized every present field (exact keys,
      // clamped numbers, sanitized enums, bounded scope): merge as-is.
      await legacy.update(ns, patch, expectedRevision)
      return viewOf()
    },
  }
}
