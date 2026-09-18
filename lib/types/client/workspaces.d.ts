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
    workspaceId: string;
    /** Human label: the DSH title when set, else the path or the raw id. */
    title: string;
}
/** One option of the merged board/modal workspace pickers. */
export interface WorkspaceCatalogEntry {
    workspaceId: string;
    title: string;
    /** False when the id only exists in the ledger (not in the DSH registry). */
    knownToApp: boolean;
}
/** Minimal face of the DSH shell "workspaces" service (see dsh-api-workspace-controller). */
export interface DshWorkspacesService {
    list: {
        getSnapshot(): {
            items: readonly {
                workspaceId: string;
                title: string;
                path?: string;
            }[];
        };
        subscribe(listener: () => void): () => void;
    };
}
/** Live DSH registry adapter; optional so the board never depends on it. */
export interface WorkspacesSource {
    /** Current registry rows (id + resolved label). */
    list(): WorkspaceViewLite[];
    /** React to later registry changes (rename, new workspace, archive). */
    subscribe(listener: () => void): () => void;
    /** Release the follow subscription and listeners. */
    dispose(): void;
}
/** Resolve the display label of one registry row: title, else path, else id. */
export declare function workspaceLabel(item: {
    title: string;
    path?: string;
    workspaceId: string;
}): string;
/**
 * Merge the ledger's idea workspace ids with the DSH registry into one sorted
 * catalog. Registry rows win for a shared id (the app knows the label);
 * ledger-only ids keep the raw id as their label. Pure and unit-testable.
 */
export declare function buildWorkspaceCatalog(ideas: readonly {
    workspaceId?: string;
}[], dshWorkspaces: readonly WorkspaceViewLite[]): WorkspaceCatalogEntry[];
/** Cordis service name exposing the Workspace Controller (dsh-api-workspace-controller). */
export declare const WORKSPACES_SERVICE = "workspaces";
/** Optional DSH registry adapter: listens to the follow stream, degrades on any failure. */
export declare class DshWorkspacesSource implements WorkspacesSource {
    private readonly views;
    private readonly listeners;
    private readonly unsubscribe;
    constructor(service: DshWorkspacesService);
    list(): WorkspaceViewLite[];
    subscribe(listener: () => void): () => void;
    dispose(): void;
    private notify;
}
/**
 * Defensively resolve the cordis "workspaces" service from a client context.
 * Returns undefined when the service is absent or malformed, so callers keep
 * a fully functional ledger-only board.
 */
export declare function resolveWorkspacesSource(ctx: {
    get(name: string): unknown;
}): DshWorkspacesSource | undefined;
