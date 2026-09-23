/**
 * Framework-free client controller for the ideas board: holds the open flag
 * and the latest Host snapshot, refreshes through the transport, and notifies
 * subscribers (the sidebar row and the React board). No React, no cordis —
 * the DOM mounts at the edges only.
 */

import type { IdeaRecord, IdeaStatus } from '../core/ideas.ts'
import { IDEAS_SETTINGS_DEFAULTS, sanitizeSettings, type IdeasAction, type IdeasListSnapshot, type IdeasSettingsPatch, type IdeasSettingsView } from '../protocol.ts'
import { setLanguageOverride } from './locales.ts'
import type { IdeasHostTransport } from './host-api.ts'
import type { SessionLauncher } from './session-queue.ts'
import type { ActiveWorkspaceSource } from './session-context.ts'
import type { WorkspacesSource, WorkspaceViewLite } from './workspaces.ts'

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Client-side patch accepted by `updateIdea`. */
export interface IdeaClientPatch {
  title?: string
  body?: string
  value?: number
  effort?: number
  rationale?: string
  /** Present means "replace the label set"; an empty array clears it. */
  tags?: string[]
  /** Present (including an empty string) replaces the workspace; '' = generic. */
  workspaceId?: string
}

export class IdeasClient {
  boardOpen = false
  /** Board state as LIST rows (bodies deferred, idea #34). */
  snapshot: IdeasListSnapshot | undefined
  error: string | undefined
  pending = false
  /** Display settings (tag rows ...); the spelled defaults until the config route answers. */
  config: IdeasSettingsView = { available: false, value: IDEAS_SETTINGS_DEFAULTS }
  /** Last config write failure verbatim ('settings-conflict' | wire message); cleared on success. */
  configError: string | undefined
  /** Whether a config write is in flight (the settings row disables its input). */
  configPending = false
  /** Whether the first config load has SETTLED (available or not) — the board
   *  applies persisted preferences once, guarded on this flag. */
  configLoaded = false
  /**
   * Phase 3: optional "Start AI analysis and create the idea" launcher,
   * resolved from the DSH session controller. Undefined keeps the plain
   * manual Create for workspace-targeted captures.
   */
  sessionLauncher: SessionLauncher | undefined
  private readonly listeners = new Set<() => void>()
  private unsubscribeEvents: (() => void) | undefined
  private workspaces: WorkspaceViewLite[] = []
  private readonly workspacesSource: WorkspacesSource | undefined
  private readonly activeWorkspaceSource: ActiveWorkspaceSource | undefined
  private unsubscribeWorkspaces: (() => void) | undefined
  private unsubscribeActive: (() => void) | undefined
  /** Full records fetched on demand (body + audit), keyed by idea id (idea #34). */
  private readonly fullRecords = new Map<string, IdeaRecord>()
  /** Highest revision whose full snapshot already filled {@link fullRecords}. */
  private searchIndexedAtRevision = -1
  /** In-flight deep-search index load (at most one at a time). */
  private searchIndexLoad: Promise<void> | undefined

  constructor(
    private readonly transport: IdeasHostTransport,
    workspacesSource: WorkspacesSource | undefined,
    activeWorkspaceSource?: ActiveWorkspaceSource,
  ) {
    this.workspacesSource = workspacesSource
    // T3: the current session's workspace, resolved from the shell services.
    // Optional — without it captures keep the pre-T3 default (scope, else generic).
    this.activeWorkspaceSource = activeWorkspaceSource
    // The catalog merge needs the registry rows; the active-workspace default
    // needs the session stream. Either (or both) may be absent — the board
    // degrades gracefully (ledger ids only, scope-or-generic capture default).
    if (this.workspacesSource !== undefined || this.activeWorkspaceSource !== undefined) {
      this.syncWorkspaces()
      this.unsubscribeWorkspaces = this.workspacesSource?.subscribe(() => { this.syncWorkspaces() })
      this.unsubscribeActive = this.activeWorkspaceSource?.subscribe(() => { this.syncWorkspaces() })
    }
  }

  /** The workspace of the current session (undefined when unknown). */
  get activeWorkspace(): WorkspaceViewLite | undefined {
    return this.activeWorkspaceSource?.current()
  }

  /** Current DSH registry rows (id + label); empty when the service is absent. */
  get workspaceOptions(): readonly WorkspaceViewLite[] {
    return this.workspaces
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  toggleBoard(): void {
    const wasOpen = this.boardOpen
    this.boardOpen = !this.boardOpen
    // Opening the board loads a fresh snapshot immediately even though the
    // background poll only runs while the board is open (see host-api
    // subscribe: no SSE slots are held — the pool must stay available).
    if (!wasOpen && this.boardOpen) void this.refresh()
    this.emit()
  }

  closeBoard(): void {
    if (!this.boardOpen) return
    this.boardOpen = false
    this.emit()
  }

  /** Initial load + short-poll refresh while the board is open. */
  start(): void {
    void this.refresh()
    // Display settings ride the same startup: a failure keeps the spelled
    // defaults (see loadConfig) and never blocks the board.
    void this.loadConfig()
    try {
      // Poll only while the board is actually open (isActive), so a closed
      // board holds no connections and no traffic. See host-api subscribe.
      this.unsubscribeEvents = this.transport.subscribe(() => { void this.refresh() }, () => this.boardOpen)
    } catch (error) {
      // A failed subscription degrades to manual refresh only.
      console.error('[dsh-plugin-ideas-manager] event subscription failed', error)
    }
  }

  dispose(): void {
    this.unsubscribeEvents?.()
    this.unsubscribeWorkspaces?.()
    this.unsubscribeActive?.()
    this.workspacesSource?.dispose()
    this.activeWorkspaceSource?.dispose()
    this.listeners.clear()
  }

  async refresh(): Promise<void> {
    const errorBefore = this.error
    let adopted = false
    try {
      adopted = this.adopt(await this.transport.state())
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    // Notify ONLY on observable movement: a snapshot change or an error
    // transition. The idle short-poll (same revision, same error) now costs
    // a fetch and nothing else - no subscriber wake-up, no re-render (the
    // pre-idea#34 board rebuilt every card on every idle tick).
    if (adopted || this.error !== errorBefore) this.emit()
  }

  /**
   * Load the display settings once at start(). A transport without the
   * capability, an older Host (404), or a fence refusal all land on the same
   * graceful outcome: `available: false` and the spelled defaults — the board
   * must never depend on the settings surface.
   */
  async loadConfig(): Promise<void> {
    if (this.transport.config === undefined) {
      this.config = { available: false, value: IDEAS_SETTINGS_DEFAULTS }
      this.applyInterfaceLanguage()
      this.configLoaded = true
      this.emit()
      return
    }
    try {
      const view = await this.transport.config()
      // Sanitize at the arrival: whatever the wire carried, the board and the
      // section only ever read a COMPLETE legal value.
      this.config = { ...view, value: sanitizeSettings(view.value) }
      this.configError = undefined
    } catch (error) {
      console.warn('[dsh-plugin-ideas-manager] settings load failed', error)
      this.config = { available: false, value: IDEAS_SETTINGS_DEFAULTS }
    }
    this.applyInterfaceLanguage()
    this.configLoaded = true
    this.emit()
  }

  /**
   * Push the `language` setting to the i18n lookup (0.4.0): the panel language
   * is plugin-owned and independent of the DSH shell language. Called on every
   * config load and save, so switching the row re-renders the whole panel in
   * the chosen language (and a failed load falls back to `auto` = the shell).
   */
  private applyInterfaceLanguage(): void {
    setLanguageOverride(this.config.value.language)
  }

  /**
   * Persist a settings patch (revision-fenced by the view the client holds).
   * Failures surface verbatim as `configError` ('settings-conflict' and
   * 'settings-unavailable' are wire codes the section localizes); the stored
   * value only moves on success, so the settings row reverts for free.
   */
  async saveConfig(patch: IdeasSettingsPatch): Promise<void> {
    if (this.transport.saveConfig === undefined || !this.config.available) {
      this.configError = 'settings-unavailable'
      this.emit()
      return
    }
    this.configPending = true
    this.configError = undefined
    this.emit()
    try {
      this.config = await this.transport.saveConfig(patch, this.config.revision)
      this.configError = undefined
    } catch (error) {
      this.configError = error instanceof Error ? error.message : String(error)
    } finally {
      this.configPending = false
      this.applyInterfaceLanguage()
      this.emit()
    }
  }

  async createIdea(input: {
    title: string
    body: string
    tags?: string[]
    value?: number
    effort?: number
    rationale?: string
    workspaceId?: string
    /** 1-based position inside the open backlog (capture triage opinion). */
    rank?: number
  }): Promise<void> {
    const tags = tagNames(input.tags).map(name => ({ name }))
    await this.run({
      kind: 'create',
      id: uuid(),
      input: {
        title: input.title,
        body: input.body,
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.rationale === undefined || input.rationale === '' ? {} : { rationale: input.rationale }),
        ...(input.rank === undefined ? {} : { rank: input.rank }),
        // An empty string (the modal's "no workspace" choice) stays generic by
        // omitting the field, matching the ledger's normalizeOptionalId.
        ...(input.workspaceId === undefined || input.workspaceId === '' ? {} : { workspaceId: input.workspaceId }),
        ...(tags.length === 0 ? {} : { tags }),
      },
    })
  }

  async updateIdea(ideaId: string, patch: IdeaClientPatch): Promise<void> {
    const tags = patch.tags === undefined ? undefined : tagNames(patch.tags)
    await this.run({
      kind: 'update',
      ideaId,
      patch: {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.body === undefined ? {} : { body: patch.body }),
        ...(patch.value === undefined ? {} : { value: patch.value }),
        ...(patch.effort === undefined ? {} : { effort: patch.effort }),
        ...(patch.rationale === undefined ? {} : { rationale: patch.rationale }),
        // The modal always sends the workspace: '' moves the idea back to
        // generic (the Host maps a blank trimmed string to undefined).
        ...(patch.workspaceId === undefined ? {} : { workspaceId: patch.workspaceId }),
        // An empty tag set clears the labels (null on the wire); a non-empty
        // set replaces them.
        ...(tags === undefined ? {} : { tags: tags.length === 0 ? null : tags.map(name => ({ name })) }),
      },
    })
  }

  async moveIdea(ideaId: string, status: Extract<IdeaStatus, 'open' | 'underReview' | 'archived'>): Promise<void> {
    await this.run({ kind: 'move', ideaId, status })
  }

  async declineIdea(ideaId: string, decision?: string): Promise<void> {
    const note = decision?.trim()
    await this.run(note === undefined || note === '' ? { kind: 'decline', ideaId } : { kind: 'decline', ideaId, decision: note })
  }

  /** Mark an open idea delivered: archived + deliveredAt, card mirror archived. */
  async deliverIdea(ideaId: string): Promise<void> {
    await this.run({ kind: 'deliver', ideaId })
  }

  /**
   * Record the priority opinion (value/effort/rationale) and re-insert the
   * idea at the suggested rank inside the open backlog (transactional re-rank).
   */
  async triageIdea(ideaId: string, patch: { value?: number; effort?: number; rationale?: string; rank?: number }): Promise<void> {
    await this.run({
      kind: 'triage',
      ideaId,
      patch: {
        ...(patch.value === undefined ? {} : { value: patch.value }),
        ...(patch.effort === undefined ? {} : { effort: patch.effort }),
        // Like updateIdea, an explicit blank rationale clears the recorded one
        // (the Host triage trims '' to undefined).
        ...(patch.rationale === undefined ? {} : { rationale: patch.rationale }),
        ...(patch.rank === undefined ? {} : { rank: patch.rank }),
      },
    })
  }

  /**
   * Recette NOK: create a child follow-up idea (linked to `ideaId` and
   * carrying the summary + justification) and archive the parent — one atomic
   * commit. The parent must currently be under review.
   */
  async followUpIdea(ideaId: string, input: { title: string; body: string }): Promise<void> {
    await this.run({ kind: 'followUp', ideaId, input })
  }

  async restoreIdea(ideaId: string): Promise<void> {
    await this.run({ kind: 'restore', ideaId })
  }

  /**
   * Start an analyst re-run on an existing idea (human-triggered): the Host
   * stamps the cycle and preserves the current content as the prior-analysis
   * audit trail; the caller then launches a fresh analyst session whose
   * update+triage overwrite the card.
   */
  async reanalyzeIdea(ideaId: string): Promise<void> {
    await this.run({ kind: 'reanalyze', ideaId })
  }

  async deleteIdea(ideaId: string): Promise<void> {
    await this.run({ kind: 'delete', ideaId })
  }

  async reorderIdea(orderedIds: string[]): Promise<void> {
    await this.run({ kind: 'reorder', orderedIds })
  }

  /** Republish the DSH registry rows and wake the board (catalog refresh). */
  private syncWorkspaces(): void {
    this.workspaces = this.workspacesSource?.list() ?? []
    this.emit()
  }

  /** Post one action, adopt the Host snapshot, and expose errors. */
  private async run(action: IdeasAction): Promise<void> {
    this.pending = true
    this.emit()
    try {
      this.adopt(await this.transport.action(action))
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.pending = false
      this.emit()
    }
  }

  /**
   * Adopt a fresh snapshot (idea #34): an IDLE refresh - same revision, the
   * Host bumps it on every commit - keeps the SAME reference, so the board's
   * setSnapshot bails out by Object.is and React rebuilds nothing on the
   * 2.5 s short-poll tick that found no change. The revision is the Host's
   * single source of truth: equal revision means identical content (replayed
   * requests and no-op applies return the current state verbatim).
   * @returns whether the snapshot reference actually moved.
   */
  private adopt(fresh: IdeasListSnapshot): boolean {
    if (this.snapshot !== undefined && fresh.revision === this.snapshot.revision) return false
    this.snapshot = fresh
    return true
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Full record behind one list row (idea #34 deferred body): the edit
   * modal, the follow-up composer and the re-analyze input read the WHOLE
   * body here, fetched once per change. Cached until the row's updatedAt
   * moves - every commit stamps updatedAt on changed ideas - so the entry
   * self-invalidates after each action.
   */
  async fetchIdea(row: Pick<IdeaRecord, 'id' | 'updatedAt'>): Promise<IdeaRecord> {
    const hit = this.fullRecords.get(row.id)
    if (hit !== undefined && hit.updatedAt === row.updatedAt) return hit
    if (this.transport.idea === undefined) throw new Error('body-unavailable')
    const full = await this.transport.idea(row.id)
    this.fullRecords.set(full.id, full)
    return full
  }

  /** The whole body when its full record is loaded (deep search), else undefined. */
  cachedBodyOf(id: string): string | undefined {
    return this.fullRecords.get(id)?.body
  }

  /**
   * Deep-search index (idea #34): the list snapshot carries only excerpts,
   * so the FIRST active search loads the full snapshot ONCE per revision and
   * fills the record cache; matchesFilter then scans whole bodies exactly
   * like before the projection. Idle boards and clean filters never pay it.
   * Never rejects (a failed load logs and lets the next keystroke retry), so
   * callers can fire-and-forget; the record cache - not the snapshot - is
   * the deliverable (adopt() stays the only snapshot mutator).
   */
  async ensureSearchIndex(): Promise<void> {
    if (this.snapshot === undefined || this.transport.stateFull === undefined) return
    if (this.searchIndexedAtRevision >= this.snapshot.revision) return
    if (this.searchIndexLoad !== undefined) {
      await this.searchIndexLoad
      return
    }
    this.searchIndexLoad = (async () => {
      try {
        // Bound call on purpose: the transport method must keep its `this`.
        const full = await this.transport.stateFull!()
        for (const idea of full.ideas) this.fullRecords.set(idea.id, idea)
        this.searchIndexedAtRevision = Math.max(this.searchIndexedAtRevision, full.revision)
      } catch (error) {
        console.error('[dsh-plugin-ideas-manager] search index load failed:', error)
      }
    })()
    try {
      await this.searchIndexLoad
    } finally {
      this.searchIndexLoad = undefined
    }
  }

  /** Surface a transport/UI failure through the board's existing error bar. */
  reportError(message: string): void {
    this.error = message
    this.emit()
  }
}

/** Trim a comma-separated input into clean tag names. */
function tagNames(raw: string[] | undefined): string[] {
  return (raw ?? [])
    .flatMap(line => line.split(','))
    .map(tag => tag.trim())
    .filter(tag => tag !== '')
}