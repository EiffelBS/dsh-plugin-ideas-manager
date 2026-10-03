/**
 * Framework-free client controller for the ideas board: holds the open flag
 * and the latest Host snapshot, refreshes through the transport, and notifies
 * subscribers (the board React tree). No React, no cordis — the shell panel
 * registration at the edge owns the DOM.
 */

import type { IdeaRecord, IdeaSimilarReport, IdeaStatus, IdeaTag } from '../core/ideas.ts'
import {
  IDEAS_SETTINGS_DEFAULTS,
  sanitizeSettings,
  type IdeasAction,
  type IdeasBackupView,
  type IdeasListSnapshot,
  type IdeasReadQuery,
  type IdeasReadSnapshot,
  type IdeasRestoreRequest,
  type IdeasRestoreResponse,
  type IdeasSettingsPatch,
  type IdeasSettingsView,
  type IdeasSnapshotInfo,
  type IdeasSnapshotReason,
  type IdeasStats,
} from '../protocol.ts'
import { setLanguageOverride } from './locales.ts'
import { IDEAS_PANEL_ID, TASK_BOARD_PANEL_ID, type PanelNavigator } from './panel-navigation.ts'
import { focusReadQuery, parseIdeaRef, resolveIdeaRef, type FocusableIdea } from './deeplink.ts'
import type { IdeasHostTransport } from './host-api.ts'
import { IdeasRouteMissingError } from './host-api.ts'
import type { SessionLauncher } from './session-queue.ts'
import type { ActiveWorkspaceSource } from './session-context.ts'
import type { SessionOpener } from './session-opener.ts'
import type { WorkspacesSource, WorkspaceViewLite } from './workspaces.ts'

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Client-side patch accepted by `updateIdea`.
 *
 * `tags` takes either the comma-separated names the modals collect as plain
 * strings, or full {@link IdeaTag} rows. The second form exists for the bulk
 * tag action (idea #94): a name-only array would silently DROP the
 * `promptPrefix` line every existing label carries, because the wire patch
 * replaces the whole set. Bulk tagging therefore rebuilds the union from the
 * row's own tags and keeps each one's prompt line.
 */
export interface IdeaClientPatch {
  title?: string
  body?: string
  value?: number
  effort?: number
  rationale?: string
  /** Present means "replace the label set"; an empty array clears it. */
  tags?: string[] | IdeaTag[]
  /** Present (including an empty string) replaces the workspace; '' = generic. */
  workspaceId?: string
  /**
   * Relations (idea #106), one key per stored kind. Present means "replace this
   * list", exactly like `tags`, so an empty array CLEARS it (the client turns
   * that into the wire's `null`). There is deliberately no `blockedBy`: it is
   * the derived inverse of another row's `blocks` and is never written.
   *
   * Callers send only the lists they changed — an untouched relation must not
   * spend a revision or an activity-log line (see `relationListChanged`).
   */
  relatesTo?: string[]
  blocks?: string[]
}

/**
 * What one focus request actually achieved (idea #105).
 *
 * A deep-link has three honest answers, not one: the card was focused, the
 * card exists but the setting that hides its column is on (`hidden`), or
 * nothing on this board carries that reference (`unknown` — which also covers a
 * reference that is not a reference at all, like a lone `#`).
 */
export type IdeaFocusOutcome = 'focused' | 'hidden' | 'unknown'

/** One focus request, with the sequence number that makes it one-shot. */
interface FocusRequest {
  /** The reference exactly as the caller wrote it, for the outcome message. */
  ref: string
  /** Monotonic id: the panel answers a request once, and a repeat is a new one. */
  seq: number
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
  /**
   * Optional jump into a run the board started (idea #66). A run can execute
   * in a session the human never saw open — the direct-session backend always
   * does — so a card carrying a `runSessionId` offers this link. Undefined
   * (no sessions service) simply renders no link.
   */
  sessionOpener: SessionOpener | undefined
  /**
   * Shell panel navigation, resolved from `ctx.layout` by the panel
   * registration. Undefined on a shell with no layout service: the board then
   * keeps the local open/close behavior and simply has no entry row to drive
   * it. This is also the face a launch refusal redirects through.
   */
  panelNavigator: PanelNavigator | undefined
  /**
   * Snapshot folder (idea #95), undefined until the backup panel asks for it.
   * A transport without the capability leaves it undefined forever, which the
   * panel reads as "this deployment has no backup surface" — a downgrade, never
   * an error: the board itself does not depend on it.
   */
  backups: IdeasBackupView | undefined
  /** Last backup failure, verbatim (the Host's own refusal sentence). */
  backupError: string | undefined
  /** Whether a snapshot/restore request is in flight (the panel disables itself). */
  backupPending = false
  /**
   * The running Host serves no backup route (idea #95 follow-up): an instance
   * that has not been restarted since the plugin was updated answers 404 on
   * `/api/ideas/backup` while serving the NEW panel. Set by `loadBackups`, it
   * turns the capability check into a runtime fact and the panel into one
   * explanatory note instead of three dead buttons.
   */
  backupUnavailable = false
  /** The snapshot a fresh export produced, so the panel can offer its download. */
  exported: IdeasSnapshotInfo | undefined
  /**
   * The outcome of the last successful restore, so the panel can name the
   * snapshot the displaced board was kept as: a restore must be loud about what
   * it replaced, and that fact is only true for a moment after the click.
   *
   * `unknownFields` is the other half of that promise: record keys the file
   * carried that this build does not know, and therefore did not restore. It is
   * empty in the normal case and shown as a warning when it is not.
   */
  lastRestore: { source: string; displaced: IdeasSnapshotInfo; ideas: number; unknownFields: string[] } | undefined
  /**
   * Deep-link request awaiting the panel (idea #105). It lives HERE rather than
   * in React state on purpose: a request can arrive while the board is CLOSED
   * (the permission-gate refusal is raised from the board itself, but the
   * published service is reachable from anywhere in the page), and the panel has
   * to find it waiting when it mounts — the cold-load case.
   */
  focusRequest: FocusRequest | undefined
  /** What the last request achieved; the board renders the unhappy answers. */
  focusResult: { ref: string; seq: number; outcome: IdeaFocusOutcome } | undefined
  /** The card a deep-link landed on, or undefined once the human took over. */
  focusedIdeaId: string | undefined
  /**
   * Backlog-health aggregate (idea #110), undefined until the Health tab asks
   * for it. It lives here rather than in React state for the same reason the
   * deep-link request does: the tab is opened by the panel, and the fetch it
   * owns must survive the panel being closed and reopened without re-deciding
   * anything.
   */
  stats: IdeasStats | undefined
  /**
   * The scope {@link stats} was computed for, so the panel can refuse to paint
   * numbers that answer a question the reader is no longer asking. `undefined`
   * = every workspace; `''` = the workspace-less group.
   */
  statsScope: string | undefined
  /** Whether a stats request is in flight (the view shows it is refreshing). */
  statsPending = false
  /** Last stats failure, verbatim; cleared on success. */
  statsError: string | undefined
  /** Sequence of the newest stats request; older answers are dropped on arrival. */
  private statsRequestSeq = 0
  private focusSeq = 0
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

  /**
   * Ask the shell to show the board panel. The row click is owned by the shell
   * (it selects the panel itself), so this is only the programmatic path;
   * without a navigator the flag flips locally, which keeps the board usable
   * on a shell that has no layout service.
   */
  toggleBoard(): void {
    const navigator = this.panelNavigator
    if (navigator === undefined) {
      this.setBoardOpen(!this.boardOpen)
      return
    }
    navigator.select(this.boardOpen ? null : IDEAS_PANEL_ID)
  }

  /** Return to the conversation ("Back to chat" on the board header). */
  closeBoard(): void {
    const navigator = this.panelNavigator
    if (navigator === undefined) {
      this.setBoardOpen(false)
      return
    }
    navigator.select(null)
  }

  /**
   * Bring the board panel to the front WITHOUT toggling it.
   *
   * `toggleBoard` is the wrong verb for a deep-link: the destination is the
   * board, so selecting it again must never close it. Without a layout service
   * the local flag is all there is, and a deep-link to a closed board is exactly
   * when the refresh matters most.
   */
  openBoard(): void {
    const navigator = this.panelNavigator
    if (navigator === undefined) {
      this.setBoardOpen(true)
      return
    }
    navigator.select(IDEAS_PANEL_ID)
  }

  /**
   * Open the TaskBoard panel through the shell's own layout face.
   *
   * Deliberately just that. This used to be `client/taskboard-focus.ts`, which
   * additionally typed the idea title into the TaskBoard's filter field through
   * the native value setter and a bubbling `input` event — DOM surgery on a
   * third-party React tree, because that board published no service and no
   * deeplink to use instead (verified on the installed 0.4.4; see
   * docs/architecture.md). The mirrored card is filed under the idea title, which
   * the caller shows next to the button, so the human can find it by eye.
   */
  openTaskBoard(): void {
    this.panelNavigator?.select(TASK_BOARD_PANEL_ID)
  }

  /* --- deep-link to an idea (idea #105) ------------------------------------ */

  /**
   * Ask the board to focus one idea, by `#N`, by number or by id.
   *
   * The request is stored, the board is brought to the front, and the PANEL
   * applies it (it owns the scope, the tab and the filters). A request that
   * arrives before the panel is mounted simply waits — that is what makes a
   * link work from a cold panel load.
   *
   * Fire and forget by design: the outcome is observable on {@link focusResult},
   * and a caller has no useful way to act on a promise here that the board's own
   * message does not already say better.
   *
   * @param ref - `'#42'`, `'42'`, `'idea-<uuid>'` or an idea id.
   */
  requestFocus(ref: string): void {
    this.focusSeq += 1
    this.focusRequest = { ref: ref.trim(), seq: this.focusSeq }
    // The previous answer describes the previous link; keeping it would leave a
    // stale "not found" on screen under the card the new one just focused.
    this.focusResult = undefined
    this.focusedIdeaId = undefined
    this.emit()
    this.openBoard()
  }

  /**
   * The panel reports what it did with a request.
   *
   * Answering CLEARS the request: it is one-shot, so a re-render can never
   * re-apply it (a second apply would fight the scope the first one set). A
   * report for a stale sequence is dropped — two links in a row must not let the
   * older answer overwrite the newer one.
   *
   * @param seq - the request's sequence number.
   * @param outcome - what the panel could do with it.
   * @param ideaId - the focused card; omitted when nothing could be focused.
   */
  reportFocus(seq: number, outcome: IdeaFocusOutcome, ideaId?: string): void {
    const request = this.focusRequest
    if (request === undefined || request.seq !== seq) return
    this.focusRequest = undefined
    this.focusResult = { ref: request.ref, seq, outcome }
    this.focusedIdeaId = ideaId
    this.emit()
  }

  /**
   * Drop the focus affordance: the human narrowed the scope, searched, toggled a
   * tag or changed tab, so the link's destination is no longer what they are
   * reading. Same discipline as the multi-select (idea #94) — a view marker the
   * reader owns, never something the 2.5 s poll restores.
   */
  clearFocus(): void {
    if (this.focusedIdeaId === undefined) return
    this.focusedIdeaId = undefined
    this.emit()
  }

  /**
   * Resolve a reference to the idea it names, across every workspace.
   *
   * The snapshot is asked first because it is free and holds the whole board.
   * On a MISS the board asks the Host once through the existing bounded read and
   * adopts a fresh list before answering: the poll only runs while the panel is
   * open, so a board closed since a capture genuinely does not know the idea,
   * and a card has to exist in the snapshot before anything can focus it.
   *
   * Never throws: a failed read is logged and answered as "not found", because a
   * deep-link that cannot resolve must degrade to a message, not to a broken
   * panel.
   *
   * @param ref - the caller's reference, unparsed.
   * @returns the idea, or undefined when this board holds no such reference.
   */
  async resolveFocus(ref: string): Promise<FocusableIdea | undefined> {
    const parsed = parseIdeaRef(ref)
    if (parsed === undefined) return undefined
    const local = resolveIdeaRef(parsed, this.snapshot?.ideas ?? [])
    if (local !== undefined) return local
    if (this.transport.read === undefined) return undefined
    try {
      const page = await this.transport.read(focusReadQuery(parsed))
      if (page.ideas.length === 0) return undefined
      await this.refresh()
      return resolveIdeaRef(parsed, this.snapshot?.ideas ?? []) ?? page.ideas[0]
    } catch (error) {
      console.warn('[dsh-plugin-ideas-manager] deep-link lookup failed:', error)
      return undefined
    }
  }

  /**
   * The shell mounted our panel: the board is now visible, so the background
   * poll may run and the state is refreshed immediately (the poll alone would
   * leave an empty board for up to one tick).
   */
  panelShown(): void {
    this.setBoardOpen(true)
  }

  /** The shell unmounted our panel: a closed board holds no traffic. */
  panelHidden(): void {
    this.setBoardOpen(false)
  }

  /** Single writer of the open flag, so every path refreshes identically. */
  private setBoardOpen(open: boolean): void {
    if (this.boardOpen === open) return
    this.boardOpen = open
    if (open) void this.refresh()
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

  /**
   * Run one bounded filtered read without changing board state. This is the
   * common agent/client path: summary-first metadata, explicit fields, and a
   * capped body slice all arrive with revision and truncation metadata. The
   * raw full snapshot and single-idea detail methods remain available for
   * backward compatibility and deep workflows.
   */
  async readIdeas(query: IdeasReadQuery = {}): Promise<IdeasReadSnapshot> {
    if (this.transport.read === undefined) throw new Error('read-view-unavailable')
    return await this.transport.read(query)
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
    const tags = patch.tags === undefined ? undefined : normalizeClientTags(patch.tags)
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
        // set replaces them, prompt lines included (idea #94 bulk tagging
        // rebuilds the union from the row's own tags).
        ...(tags === undefined ? {} : { tags: tags.length === 0 ? null : tags }),
        // Relations (idea #106): same contract as tags — an empty list clears,
        // a non-empty one replaces it. The ledger owns the symmetry of
        // `relatesTo` and the acyclicity of `blocks`; a refusal comes back as
        // the Host's own sentence (a cycle names its chain).
        ...(patch.relatesTo === undefined ? {} : { relatesTo: patch.relatesTo.length === 0 ? null : patch.relatesTo }),
        ...(patch.blocks === undefined ? {} : { blocks: patch.blocks.length === 0 ? null : patch.blocks }),
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
   * Review rejected: create a child follow-up idea (linked to `ideaId` and
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

  /**
   * Read the near-duplicate report for one idea (Find similar). Opt-in by
   * construction: it rides the bounded read query's `similar` key, so the
   * board's 2.5 s poll never runs the scan and the default snapshot never
   * grows a byte because of it. `limit` bounds both the returned rows and the
   * candidate set, so a caller cannot accidentally ask for the whole board.
   *
   * Not a write: it returns a FLAG (which open same-workspace ideas look
   * similar, and on which cheap signals), never an action.
   *
   * @throws when the transport predates the bounded read (`read-view-unavailable`)
   *   or answers without the report the query asked for.
   */
  async findSimilarIdea(ideaId: string, limit = 8): Promise<IdeaSimilarReport> {
    const snapshot = await this.readIdeas({ view: 'summary', similar: ideaId, limit })
    const report = snapshot.similar
    if (report === undefined) throw new Error('similar-report-unavailable')
    return report
  }

  async deleteIdea(ideaId: string): Promise<void> {
    await this.run({ kind: 'delete', ideaId })
  }

  /**
   * Start the idea's execution (idea #66) through the Host, which owns the
   * mirrored card. NOT a ledger mutation: no `pending` banner for the whole
   * board, no revision write here (the host stamps `runStatus` itself) — but a
   * refresh follows so the card status the poll will publish is not the only
   * visible change. A refusal is surfaced on the board's error bar verbatim
   * (`task is already running or missing`, `taskboard-unavailable`, ...) and
   * rethrown for the modal to keep the human in place.
   *
   * `model` is the `provider/model` target id, or undefined to let the run
   * keep the session default.
   *
   * @throws when the transport predates the launch route (`launch-unavailable`).
   */
  async launchIdea(ideaId: string, model?: string): Promise<void> {
    if (this.transport.launch === undefined) throw new Error('launch-unavailable')
    try {
      await this.transport.launch(ideaId, model)
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
      throw error
    }
    await this.refresh()
  }

  async reorderIdea(orderedIds: string[]): Promise<void> {
    await this.run({ kind: 'reorder', orderedIds })
  }

  // --- snapshots, restore and portable transfer (idea #95) -------------------

  /**
   * Load the snapshot folder. Reads only: opening the backup panel never
   * writes, so browsing the list cannot be the thing that fills the folder.
   *
   * A 404 without a body is NOT a failure to show — it means the running Host
   * has no backup route (an instance that has not been restarted since the
   * plugin was updated). That is a capability downgrade, so it clears the
   * error, records {@link backupUnavailable} and lets the panel render its one
   * explanatory note instead of three buttons that cannot work.
   */
  async loadBackups(): Promise<void> {
    if (this.transport.backups === undefined) {
      this.backups = undefined
      this.backupUnavailable = true
      this.emit()
      return
    }
    try {
      this.backups = await this.transport.backups()
      this.backupError = undefined
      this.backupUnavailable = false
    } catch (error) {
      if (error instanceof IdeasRouteMissingError) {
        this.backups = undefined
        this.backupError = undefined
        this.backupUnavailable = true
      } else {
        this.backupError = error instanceof Error ? error.message : String(error)
      }
    }
    this.emit()
  }

  /**
   * Take a snapshot now. `reason: 'export'` is the portable copy: the same
   * write, stamped as the one meant to travel, and remembered in `exported` so
   * the panel can hand the human the download instead of guessing a file name.
   *
   * @returns whether the snapshot was written.
   */
  async takeSnapshot(reason: IdeasSnapshotReason = 'manual'): Promise<boolean> {
    if (this.transport.takeSnapshot === undefined) return false
    this.backupPending = true
    this.backupError = undefined
    this.emit()
    try {
      const taken = await this.transport.takeSnapshot(reason)
      if (reason === 'export') this.exported = taken.snapshot
      await this.loadBackups()
      return true
    } catch (error) {
      this.backupError = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      this.backupPending = false
      this.emit()
    }
  }

  /**
   * Restore the board from a snapshot or from an imported document.
   *
   * A refusal is reported through `backupError` (the Host's own sentence) and
   * answers false — never thrown — because the panel's job is to explain it, not
   * to break. A success re-reads the board: the whole document was replaced, so
   * the open panel must not keep painting the ideas that just went away.
   */
  async restoreSnapshot(request: IdeasRestoreRequest): Promise<boolean> {
    if (this.transport.restoreSnapshot === undefined) {
      this.backupError = 'backup-unavailable'
      this.emit()
      return false
    }
    this.backupPending = true
    this.backupError = undefined
    this.emit()
    try {
      const outcome: IdeasRestoreResponse = await this.transport.restoreSnapshot(request)
      if (!outcome.ok) {
        this.backupError = outcome.message
        return false
      }
      await this.loadBackups()
      await this.refresh()
      this.lastRestore = outcome
      return true
    } catch (error) {
      this.backupError = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      this.backupPending = false
      this.emit()
    }
  }

  /** Download URL of one snapshot (the portable export / a hand-off copy). */
  snapshotContentUrl(name: string): string | undefined {
    return this.transport.snapshotContentUrl?.(name)
  }

  /**
   * Whether this deployment serves the backup surface at all.
   *
   * Both halves matter and only the second one is a runtime fact: a transport
   * can lack the method (a test fake, an older shell build), AND the running
   * Host can lack the route (an instance not restarted since the plugin was
   * updated). A capability check that only looks at the method shows a working
   * panel over a route table that answers 404.
   */
  get backupAvailable(): boolean {
    return this.transport.backups !== undefined && !this.backupUnavailable
  }

  /**
   * Report a backup failure that happened in the BROWSER (a file the page could
   * not open, for instance): same channel as a Host refusal, so the panel has
   * one place where "what went wrong" is rendered.
   */
  reportBackupError(message: string): void {
    this.backupError = message
    this.emit()
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

  // --- backlog health (idea #110) --------------------------------------------

  /** Whether this deployment serves the health aggregate at all. */
  get statsAvailable(): boolean {
    return this.transport.stats !== undefined
  }

  /**
   * Load the bounded health aggregate for one workspace scope.
   *
   * Called by the Health tab when it opens and whenever the ledger revision
   * actually moves while it is open — never on the 2.5 s poll, which keeps its
   * exact pre-existing request and payload. A transport without the capability
   * leaves {@link stats} undefined forever, which the view reads as "this
   * deployment has no health surface" (a downgrade, like the backup one).
   *
   * The result is stored WITH the scope it was asked for, so switching the
   * workspace selector can never paint the previous scope's numbers under the
   * new label: a stale scope reads as "no data yet" until its own fetch lands.
   *
   * @param workspaceId - the scope; undefined = every workspace.
   */
  async loadStats(workspaceId?: string): Promise<void> {
    if (this.transport.stats === undefined) {
      this.stats = undefined
      this.statsError = undefined
      this.emit()
      return
    }
    this.statsPending = true
    this.statsError = undefined
    this.emit()
    // Supersession guard: switching the workspace selector while a request is
    // in flight starts another one, and the two can land in either order. Only
    // the LAST request may write, so a slow answer can never repaint the panel
    // with numbers the reader is no longer asking for.
    const seq = ++this.statsRequestSeq
    try {
      const query = workspaceId === undefined ? {} : { workspaceId }
      const fresh = await this.transport.stats(query)
      if (seq !== this.statsRequestSeq) return
      this.stats = fresh
      this.statsScope = workspaceId
    } catch (error) {
      if (seq === this.statsRequestSeq) {
        this.statsError = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (seq === this.statsRequestSeq) this.statsPending = false
      this.emit()
    }
  }

  /** Forget the aggregate (the Health tab was left): the next open refetches. */
  dropStats(): void {
    if (this.stats === undefined && this.statsScope === undefined) return
    this.stats = undefined
    this.statsScope = undefined
    this.statsRequestSeq += 1
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

/**
 * Client-side tag patch normalization (idea #94): plain strings are the
 * comma-separated modal input and become name-only rows, while {@link IdeaTag}
 * rows travel through untouched so a bulk tag keeps every existing label's
 * `promptPrefix` (the wire patch replaces the whole set, so dropping it would
 * be a silent loss).
 */
function normalizeClientTags(raw: string[] | IdeaTag[]): IdeaTag[] {
  const tags: IdeaTag[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      for (const name of entry.split(',')) {
        const trimmed = name.trim()
        if (trimmed !== '') tags.push({ name: trimmed })
      }
      continue
    }
    if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string') {
      tags.push({ ...entry })
    }
  }
  return tags
}