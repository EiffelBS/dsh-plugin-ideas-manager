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
import z from 'schemastery';
import type { IdeasConfigPort } from './host-routes.ts';
import { type IdeasSettingsPatch, type IdeasSettingsView } from './protocol.ts';
/**
 * Settings namespace registered with the legacy host settings service. Spelled
 * here rather than imported from the host entry: the browser half spells the
 * same value and must not depend on a Host package.
 */
export declare const IDEAS_SETTINGS_NAMESPACE: "ideas";
/**
 * Name of the plugin-owned settings document (only written on hosts without
 * `settings.register`, i.e. 0.1.7+). It sits next to the other plugin-owned
 * files of the DSH home (pet.json, mcp-manager.json ...).
 */
export declare const IDEAS_SETTINGS_FILE_NAME = "ideas-manager-settings.json";
/**
 * Display-settings schema: permissive types (clamped/sanitized at every
 * boundary — a ranged schema would reject a bad stored section AT
 * REGISTRATION and brick the namespace; see sanitizeSettings).
 */
export declare const IdeasSettingsSchema: z<Schemastery.ObjectS<{
    tagRows: z<number, number>;
    defaultTab: z<string, string>;
    renderMarkdown: z<boolean, boolean>;
    rememberWorkspaceScope: z<boolean, boolean>;
    workspaceScope: z<string, string>;
    confirmLifecycle: z<boolean, boolean>;
    hideDeclinedColumn: z<boolean, boolean>;
    cardDensity: z<string, string>;
    language: z<string, string>;
    openOrdering: z<string, string>;
    runningFirst: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    tagRows: z<number, number>;
    defaultTab: z<string, string>;
    renderMarkdown: z<boolean, boolean>;
    rememberWorkspaceScope: z<boolean, boolean>;
    workspaceScope: z<string, string>;
    confirmLifecycle: z<boolean, boolean>;
    hideDeclinedColumn: z<boolean, boolean>;
    cardDensity: z<string, string>;
    language: z<string, string>;
    openOrdering: z<string, string>;
    runningFirst: z<boolean, boolean>;
}>>;
/**
 * Refusal raised by the plugin-owned store when the caller's revision fence is
 * stale. Carries the same stable `code` the config route maps to
 * 409 `settings-conflict`, mirroring the host's own SettingsConflictError.
 */
export declare class IdeasSettingsConflictError extends Error {
    /** Stable machine code the HTTP layer maps to 409 settings-conflict. */
    readonly code = "SETTINGS_CONFLICT";
    /** Revision the caller expected. */
    readonly expected: number | undefined;
    /** Revision the document actually stands at (undefined = no document yet). */
    readonly actual: number | undefined;
    constructor(expected: number | undefined, actual: number | undefined);
}
/** Options of {@link IdeasSettingsStore}. */
export interface IdeasSettingsStoreOptions {
    /** Absolute document path (default `<DSH_HOME>/ideas-manager-settings.json`). */
    file?: string;
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
export declare class IdeasSettingsStore implements IdeasConfigPort {
    /** Absolute path of the versioned document. */
    readonly file: string;
    /** Whether the corrupt-document report already ran for this instance. */
    private reported;
    constructor(options?: IdeasSettingsStoreOptions);
    read(): IdeasSettingsView;
    write(patch: IdeasSettingsPatch, expectedRevision: number | undefined): Promise<IdeasSettingsView>;
    /** Missing / corrupt / parsed-and-sanitized document. */
    private load;
    /**
     * Move an unreadable document aside (renamed, evidence kept) and report it
     * once per instance; a failed rename is reported, never thrown — the read
     * or write that found the document carries on with the defaults.
     */
    private quarantine;
    /** Atomic tmp+rename commit with a direct-write fallback (Windows EPERM rename flake, host-ledger lesson). */
    private persist;
}
/** Options of {@link createIdeasConfigPort}. */
export interface IdeasConfigPortOptions {
    /** Document path used when the host exposes no legacy `register` (tests inject a scratch path). */
    file?: string;
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
export declare function createIdeasConfigPort(settings: unknown, options?: IdeasConfigPortOptions): IdeasConfigPort | undefined;
