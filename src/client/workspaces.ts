/**
 * Workspace catalog plumbing for the ideas board.
 *
 * The board surfaces `workspaceId` in two places: a board scope selector in
 * the header and a workspace field in the New/Edit modal. The option set is
 * the union of two sources:
 *
 *   - the ledger itself — every `workspaceId` present on an idea, so a scoped
 *     board always works even for ids the running DSH shell does not know
 *     (e.g. an "ot" id landed by a one-shot migration); and
 *   - the DSH app Workspace registry (the cordis "workspaces" service), so a
 *     capture can target a workspace that has no idea yet on day one.
 *
 * The DSH half is consumed defensively (duck-typed and optional): when the
 * service is absent the board degrades to ledger-derived ids only and stays
 * fully functional. This keeps the plugin hard-dependency-free, mirroring the
 * task-board family discipline.
 */

/** One lightweight DSH registry workspace (the identifiers a picker needs). */
export interface WorkspaceViewLite {
  /** Stable workspace id (stored on `IdeaRecord.workspaceId`). */
  workspaceId: string
  /** Human label: the DSH title when set, else the path or the raw id. */
  title: string
}

/** One option of the merged board/modal workspace pickers. */
export interface WorkspaceCatalogEntry {
  workspaceId: string
  title: string
  /** False when the id only exists in the ledger (not in the DSH registry). */
  knownToApp: boolean
}

/** Minimal face of the DSH shell "workspaces" service (see dsh-api-workspace-controller). */
export interface DshWorkspacesService {
  list: {
    getSnapshot(): { items: readonly { workspaceId: string; title: string; path?: string }[] }
    subscribe(listener: () => void): () => void
  }
}

/** Live DSH registry adapter; optional so the board never depends on it. */
export interface WorkspacesSource {
  /** Current registry rows (id + resolved label). */
  list(): WorkspaceViewLite[]
  /** React to later registry changes (rename, new workspace, archive). */
  subscribe(listener: () => void): () => void
  /** Release the follow subscription and listeners. */
  dispose(): void
}

/** Resolve the display label of one registry row: title, else path, else id. */
export function workspaceLabel(item: { title: string; path?: string; workspaceId: string }): string {
  if (item.title !== '') return item.title
  if (item.path !== undefined && item.path !== '') return item.path
  return item.workspaceId
}

/**
 * Merge the ledger's idea workspace ids with the DSH registry into one sorted
 * catalog. Registry rows win for a shared id (the app knows the label);
 * ledger-only ids keep the raw id as their label. Pure and unit-testable.
 */
export function buildWorkspaceCatalog(
  ideas: readonly { workspaceId?: string }[],
  dshWorkspaces: readonly WorkspaceViewLite[],
): WorkspaceCatalogEntry[] {
  const catalog = new Map<string, WorkspaceCatalogEntry>()
  for (const workspace of dshWorkspaces) {
    catalog.set(workspace.workspaceId, { workspaceId: workspace.workspaceId, title: workspace.title, knownToApp: true })
  }
  for (const idea of ideas) {
    const workspaceId = idea.workspaceId
    if (workspaceId === undefined || catalog.has(workspaceId)) continue
    catalog.set(workspaceId, { workspaceId, title: workspaceId, knownToApp: false })
  }
  return [...catalog.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/** Cordis service name exposing the Workspace Controller (dsh-api-workspace-controller). */
export const WORKSPACES_SERVICE = 'workspaces'

/** Optional DSH registry adapter: listens to the follow stream, degrades on any failure. */
export class DshWorkspacesSource implements WorkspacesSource {
  private readonly views: WorkspaceViewLite[] = []
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: (() => void) | undefined

  constructor(service: DshWorkspacesService) {
    const replace = (): void => {
      this.views.splice(0, this.views.length)
      for (const item of service.list.getSnapshot().items) {
        this.views.push({ workspaceId: item.workspaceId, title: workspaceLabel(item) })
      }
      this.notify()
    }
    replace()
    try {
      this.unsubscribe = service.list.subscribe(replace)
    } catch {
      // A failing follow stream degrades to the static snapshot above.
      this.unsubscribe = undefined
    }
  }

  list(): WorkspaceViewLite[] {
    return this.views.map(workspace => ({ ...workspace }))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Defensively resolve the cordis "workspaces" service from a client context.
 * Returns undefined when the service is absent or malformed, so callers keep
 * a fully functional ledger-only board.
 */
export function resolveWorkspacesSource(ctx: { get(name: string): unknown }): DshWorkspacesSource | undefined {
  try {
    const service = ctx.get(WORKSPACES_SERVICE)
    if (typeof service !== 'object' || service === null) return undefined
    const list = (service as { list?: unknown }).list
    if (typeof list !== 'object' || list === null) return undefined
    const face = list as { getSnapshot?: unknown; subscribe?: unknown }
    if (typeof face.getSnapshot !== 'function' || typeof face.subscribe !== 'function') return undefined
    return new DshWorkspacesSource(service as DshWorkspacesService)
  } catch {
    return undefined
  }
}