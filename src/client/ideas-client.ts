/**
 * Framework-free client controller for the ideas board: holds the open flag
 * and the latest Host snapshot, refreshes through the transport, and notifies
 * subscribers (the sidebar row and the React board). No React, no cordis —
 * the DOM mounts at the edges only.
 */

import type { IdeaStatus } from '../core/ideas.ts'
import type { IdeasAction, IdeasSnapshot } from '../protocol.ts'
import type { IdeasHostTransport } from './host-api.ts'
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
  snapshot: IdeasSnapshot | undefined
  error: string | undefined
  pending = false
  private readonly listeners = new Set<() => void>()
  private unsubscribeEvents: (() => void) | undefined
  private workspaces: WorkspaceViewLite[] = []
  private readonly workspacesSource: WorkspacesSource | undefined
  private readonly activeWorkspaceSource: ActiveWorkspaceSource | undefined
  private unsubscribeWorkspaces: (() => void) | undefined
  private unsubscribeActive: (() => void) | undefined

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
    this.boardOpen = !this.boardOpen
    this.emit()
  }

  closeBoard(): void {
    if (!this.boardOpen) return
    this.boardOpen = false
    this.emit()
  }

  /** Initial load + SSE revision push refresh. */
  start(): void {
    void this.refresh()
    try {
      this.unsubscribeEvents = this.transport.subscribe(() => { void this.refresh() })
    } catch (error) {
      // A failed SSE subscription degrades to manual refresh only.
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
    try {
      this.snapshot = await this.transport.state()
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.emit()
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
      this.snapshot = await this.transport.action(action)
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.pending = false
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Trim a comma-separated input into clean tag names. */
function tagNames(raw: string[] | undefined): string[] {
  return (raw ?? [])
    .flatMap(line => line.split(','))
    .map(tag => tag.trim())
    .filter(tag => tag !== '')
}