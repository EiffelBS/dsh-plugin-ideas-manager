/**
 * Backlog health — the ONE definition of every number the health
 * dashboard prints.
 *
 * Framework-free and pure, exactly like `core/ideas.ts`: the Host route, the
 * browser transport and every future surface read this module, so an aggregate
 * can never be computed two different ways in two places.
 *
 * The dashboard is deliberately made of signals rather than one opaque score:
 * workflow volume, delivery flow, triage work, age, activity and data quality.
 * Every array is hard-capped, so the response stays small whatever the ledger
 * weighs.
 */
import type { IdeaRecord } from './ideas.ts';
/** Wire version of the health aggregate (independent of the snapshot schema). */
export declare const IDEAS_STATS_SCHEMA_VERSION: 3;
/** Minimum real deliveries before a median is printed. */
export declare const IDEAS_STATS_MEDIAN_MIN_SAMPLES = 5;
/** Hard caps keep the aggregate bounded. */
export declare const IDEAS_STATS_MAX_WORKSPACES = 8;
export declare const IDEAS_STATS_MAX_TAGS = 8;
export declare const IDEAS_STATS_DELIVERY_BUCKETS = 8;
export declare const IDEAS_STATS_ACTIVITY_DAYS = 84;
export declare const IDEAS_STATS_MAX_QUALITY_SAMPLES = 5;
/** Maximum length of the optional exact tag selector. */
export declare const IDEAS_STATS_TAG_MAX_LENGTH = 128;
/** One day in milliseconds. */
export declare const IDEAS_STATS_DAY_MS = 86400000;
/** Period selected by the dashboard. */
export type IdeasStatsRange = 'month' | '30d' | '90d' | 'all';
/** Which workspace population the numbers cover. */
export type IdeasStatsScopeKind = 'all' | 'generic' | 'workspace';
/** One row of the per-workspace breakdown. */
export interface IdeasStatsWorkspaceRow {
    /** Absent for the workspace-less (generic) group. */
    workspaceId?: string;
    open: number;
    total: number;
    /** Usable deliveries inside the selected window. */
    deliveredInWindow: number;
    /** Median lead time inside the selected window, or null below the floor. */
    medianMs: number | null;
    /** Number of usable deliveries behind this row's median. */
    sample: number;
}
/** One bounded example behind a data-quality count. */
export interface IdeasStatsQualitySample {
    id: string;
    title: string;
    /** Absent for the workspace-less (generic) group. */
    workspaceId?: string;
}
/** Flow in the immediately preceding window of equal duration. */
export interface IdeasStatsComparison {
    created: number;
    delivered: number;
    medianMs: number | null;
}
/** One row of the top-tags list. */
export interface IdeasStatsTagRow {
    name: string;
    count: number;
}
/** Active workflow signals. Running and blocked overlap the status columns. */
export interface IdeasStatsWorkflow {
    open: number;
    underReview: number;
    running: number;
    blocked: number;
}
/** Age buckets for OPEN ideas only. */
export interface IdeasStatsAging {
    upTo7: number;
    upTo30: number;
    upTo90: number;
    over90: number;
    oldestMs: number | null;
}
/** One local calendar day in the fixed activity heatmap. */
export interface IdeasStatsActivityDay {
    /** Local Host date, `YYYY-MM-DD`. */
    date: string;
    created: number;
    delivered: number;
}
/** Fixed 12-week activity heatmap. */
export interface IdeasStatsActivity {
    days: IdeasStatsActivityDay[];
    created: number;
    delivered: number;
    activeDays: number;
}
/** One delivery bar in the selected period. */
export interface IdeasStatsDeliveryBucket {
    start: number;
    end: number;
    count: number;
}
/** Delivery honesty and the selected-period distribution. */
export interface IdeasStatsDelivery {
    /** Usable deliveries inside the selected window. */
    sample: number;
    /** Archived ideas with no delivery stamp, all time. */
    withoutStamp: number;
    /** Stamps that precede their own creation, all time. */
    inconsistent: number;
    /** Median lead time inside the selected window, or null below the floor. */
    medianMs: number | null;
    minSamples: number;
    /** Eight bounded bars covering the selected period. */
    buckets: IdeasStatsDeliveryBucket[];
}
/** Triage work among OPEN ideas. `unique` never double-counts a row. */
export interface IdeasStatsTriage {
    open: number;
    missingRank: number;
    missingValue: number;
    unique: number;
}
/** Data-quality facts kept separate from workflow judgements. */
export interface IdeasStatsQuality {
    withoutStamp: number;
    inconsistent: number;
    withoutWorkspace: number;
    /** Up to five examples per category, in ledger order. */
    withoutStampSamples: IdeasStatsQualitySample[];
    inconsistentSamples: IdeasStatsQualitySample[];
    withoutWorkspaceSamples: IdeasStatsQualitySample[];
}
/** The measured window, spelled so the UI can label it honestly. */
export interface IdeasStatsWindow {
    kind: 'calendarMonth' | 'rollingDays' | 'allTime';
    start: number;
    end: number;
    /** Present only for a rolling window. */
    days?: 30 | 90;
}
/** Which scope the numbers cover, plus how many ideas it holds. */
export interface IdeasStatsScope {
    kind: IdeasStatsScopeKind;
    workspaceId?: string;
    /** Exact, case-sensitive tag name; absent = every tag. */
    tag?: string;
    ideas: number;
}
/** Whole bounded health aggregate served by `GET /api/ideas/state?view=stats`. */
export interface IdeasStats {
    schemaVersion: typeof IDEAS_STATS_SCHEMA_VERSION;
    revision: number;
    computedAt: number;
    range: IdeasStatsRange;
    scope: IdeasStatsScope;
    window: IdeasStatsWindow;
    openTotal: number;
    workflow: IdeasStatsWorkflow;
    aging: IdeasStatsAging;
    openByWorkspace: IdeasStatsWorkspaceRow[];
    workspacesTotal: number;
    /** Ideas created inside the selected window. */
    createdInWindow: number;
    deliveredInWindow: number;
    /** Created minus delivered inside the selected window. */
    netBacklog: number;
    /** The immediately preceding window of equal duration; all-time has none. */
    comparison: IdeasStatsComparison;
    delivery: IdeasStatsDelivery;
    activity: IdeasStatsActivity;
    topTags: IdeasStatsTagRow[];
    tagsTotal: number;
    triage: IdeasStatsTriage;
    quality: IdeasStatsQuality;
}
/** Read-only seam the Host hands to the pure aggregate. */
export interface IdeasStatsSource {
    revision: number;
    ideas: readonly IdeaRecord[];
}
/** Scope, period and clock of one aggregate. */
export interface IdeasStatsOptions {
    /** Omitted = all, `''` = workspace-less, real id = one workspace. */
    workspaceId?: string;
    /** Exact, case-sensitive tag name; omitted = every tag. */
    tag?: string;
    /** Selected dashboard period; defaults to the current calendar month. */
    range?: IdeasStatsRange;
    /** Instant the window is measured at (defaults to the Host clock). */
    now?: number;
}
/** Unit the median is rendered in. */
export type IdeasDurationUnit = 'minutes' | 'hours' | 'days';
/** First instant of the Host's LOCAL calendar month containing `at`. */
export declare function calendarMonthStart(at: number): number;
/** First instant of the Host's LOCAL calendar day containing `at`. */
export declare function calendarDayStart(at: number): number;
/** Split a duration into a value and a unit the panel can label. */
export declare function durationParts(ms: number): {
    value: number;
    unit: IdeasDurationUnit;
};
/** Build the bounded health aggregate for one scope and period. */
export declare function buildIdeasStats(source: IdeasStatsSource, options?: IdeasStatsOptions): IdeasStats;
