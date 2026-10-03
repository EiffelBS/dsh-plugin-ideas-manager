/**
 * Backlog health view (idea #110): the panel's rendering of ONE bounded
 * aggregate, fetched from `GET /api/ideas/state?view=stats`.
 *
 * The component owns no arithmetic. Every number it prints comes from the
 * Host's response, and the only thing computed here is the unit a duration is
 * spelled in (`durationParts`, the shared helper from the same module the Host
 * used). That is deliberate: an aggregate is the easiest thing in a codebase to
 * compute two different ways in two places, and a panel that recomputed would
 * be exactly that second place.
 *
 * What it will NOT do, and says so on screen instead:
 *  - it never prints a median whose sample is too small — the Host answers
 *    `medianMs: null` and this renders "not enough deliveries yet (n of 5)",
 *    which is a different sentence from a number;
 *  - it never labels a rolling window as "this month" — the label names the
 *    Host's local calendar month the response actually measured;
 *  - it never renders "no rank / no value" as a quality score. It is triage
 *    work to do, and the copy says so.
 */

import type { CSSProperties } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import { durationParts, type IdeasStats, type IdeasDurationUnit } from '../core/ideas-stats.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { tagHue } from './tags.ts'
import { NO_WORKSPACE_FILTER } from './ordering.ts'

export interface HealthViewProps {
  client: IdeasClient
  /** The scope the board is currently showing; `''` = all, NO_WORKSPACE_FILTER
   *  = the workspace-less group. Mapped to the wire by the panel. */
  scopeWorkspaceId: string
  /** Resolve a workspace id to its display label (same helper as the columns). */
  workspaceTitle: (workspaceId: string) => string
  /**
   * Revision of the board snapshot the panel is currently painting. The
   * aggregate carries the revision it was computed at, so a figure that
   * describes a board which has since moved on is labelled rather than shown as
   * if it were current — a dashboard that cannot say when it is out of date is
   * the one failure mode this view exists to avoid.
   */
  boardRevision: number | undefined
}

/** The scope key the panel uses: `''` = all, `''` = generic, or a real id. */
function wireScopeOf(scopeWorkspaceId: string): string | undefined {
  return scopeWorkspaceId === '' ? undefined : scopeWorkspaceId === NO_WORKSPACE_FILTER ? '' : scopeWorkspaceId
}

/** "October 2026" for the month the window actually measured, in the UI locale. */
function monthLabelOf(at: number): string {
  const formatted = new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  return formatted === '' ? String(new Date(at).getMonth() + 1) : formatted
}

function durationUnitLabel(unit: IdeasDurationUnit): string {
  return unit === 'days' ? t('health.unitDays') : unit === 'hours' ? t('health.unitHours') : t('health.unitMinutes')
}

/** The five questions, one figure each. */
function Figure({ label, value, hint, tone }: {
  label: string
  value: string
  hint?: string
  tone?: 'warn'
}) {
  return (
    <div className={`${classes.healthFigure}${tone === 'warn' ? ` ${classes.healthFigureWarn}` : ''}`}>
      <span className={classes.healthFigureLabel}>{label}</span>
      <span className={classes.healthFigureValue}>{value}</span>
      {hint !== undefined && <span className={classes.healthFigureHint}>{hint}</span>}
    </div>
  )
}

export function HealthView({ client, scopeWorkspaceId, workspaceTitle, boardRevision }: HealthViewProps) {
  const stats: IdeasStats | undefined = client.stats
  const scope = wireScopeOf(scopeWorkspaceId)
  // A result computed for another scope is not a degraded answer, it is the
  // wrong answer: render nothing until this scope's own fetch lands.
  const current = stats !== undefined && client.statsScope === scope ? stats : undefined

  if (!client.statsAvailable) {
    // A deployment whose Host predates the route keeps its board; it simply has
    // no health surface. One explicit note beats empty figures that look zero.
    return (
      <div className={classes.health} data-dsh-ideas-health="">
        <div className={classes.healthNote} role="status">{t('health.unavailable')}</div>
      </div>
    )
  }

  if (current === undefined) {
    return (
      <div className={classes.health} data-dsh-ideas-health="">
        {client.statsError !== undefined
          ? (
            <div className={classes.healthNote} role="status">
              {t('health.error', { error: client.statsError })}
              {' '}
              <button type="button" className={classes.ghostButton} onClick={() => { void client.loadStats(scope) }}>
                {t('health.retry')}
              </button>
            </div>
          )
          : <div className={classes.healthNote} role="status">{t('health.loading')}</div>}
      </div>
    )
  }

  const delivery = current.delivery
  const median = delivery.medianMs === null ? null : durationParts(delivery.medianMs)
  const month = monthLabelOf(current.window.start)
  // The board poll moves the moment the ledger does; the aggregate answers for
  // one revision. Between the two there is a window where the figures describe a
  // board that no longer exists, so it is labelled — which revision they came
  // from, whether a refresh is on its way, and whether the last one failed.
  const stale = boardRevision !== undefined && current.revision !== boardRevision

  return (
    <div className={classes.health} data-dsh-ideas-health="">
      <div className={classes.healthHint}>
        {t('health.hint', {
          scope: current.scope.kind === 'workspace'
            ? workspaceTitle(current.scope.workspaceId ?? '')
            : t(current.scope.kind === 'generic' ? 'health.scopeGeneric' : 'health.scopeAll'),
        })}
      </div>

      <div className={classes.healthFigures} data-dsh-ideas-health-figures="">
        {/* 1. How much is open, per workspace. */}
        <Figure
          label={t('health.openTitle')}
          value={t('health.openValue', { open: current.openTotal, total: current.scope.ideas })}
          hint={t('health.openHint')}
        />
        {/* 2. Delivered this month. The label names the calendar month the
            Host measured, not a vague "recently". */}
        <Figure
          label={t('health.deliveredTitle')}
          value={t('health.deliveredValue', { count: current.deliveredInWindow })}
          hint={t('health.deliveredWindow', { month })}
        />
        {/* 3. Median time to deliver — or the explicit absence of one. */}
        {median === null
          ? (
            <Figure
              label={t('health.medianTitle')}
              value={t('health.medianThin', { count: delivery.sample, min: delivery.minSamples })}
              hint={t('health.medianThinHint')}
              tone="warn"
            />
          )
          : (
            <Figure
              label={t('health.medianTitle')}
              value={t('health.medianValue', {
                value: median.value,
                unit: durationUnitLabel(median.unit),
              })}
              hint={t('health.medianHint', { count: delivery.sample })}
            />
          )}
        {/* 4/5. Triage work to do. Named as work, never as a judgement. */}
        <Figure
          label={t('health.triageTitle')}
          value={t('health.triageValue', { count: current.triage.missingRank + current.triage.missingValue })}
          hint={t('health.triageHint')}
        />
      </div>

      {/* The delivery data behind the figure above: how many ideas actually
          carry a delivery stamp, and how many left the backlog without one.
          A backlog closed by dragging cards to Archived has nothing to take a
          median of, and this is where that shows up before the reader wonders
          why the median is missing. */}
      <div className={classes.healthNote} data-dsh-ideas-health-delivery="">
        {delivery.withoutStamp > 0 && (
          <p>{t('health.withoutStamp', { count: delivery.withoutStamp })}</p>
        )}
        {delivery.inconsistent > 0 && (
          <p>{t('health.inconsistent', { count: delivery.inconsistent })}</p>
        )}
        {delivery.withoutStamp === 0 && delivery.inconsistent === 0 && delivery.sample === 0 && (
          <p>{t('health.noDeliveries')}</p>
        )}
      </div>

      {/* Staleness, stated rather than hidden. The figures above stay on screen
          (blanking them would flicker on every commit), but the reader is told
          which revision they describe, that a refresh is under way, and — when
          the refresh FAILED — that what they are looking at is all there is.
          Silently keeping old numbers is how a health view starts lying. */}
      {stale && (
        <div
          className={classes.healthNote}
          role="status"
          data-dsh-ideas-health-stale={client.statsError !== undefined ? 'failed' : ''}
        >
          {client.statsError !== undefined
            ? t('health.staleError', { revision: current.revision, error: client.statsError })
            : t(client.statsPending ? 'health.refreshing' : 'health.stale', { revision: current.revision })}
        </div>
      )}

      <section className={classes.healthSection}>
        <h3 className={classes.healthSectionTitle}>{t('health.workspacesTitle')}</h3>
        {current.openByWorkspace.length === 0
          ? <div className={classes.empty}>{t('health.workspacesEmpty')}</div>
          : (
            <ul className={classes.healthList}>
              {current.openByWorkspace.map(row => (
                <li key={row.workspaceId ?? ''} className={classes.healthRow}>
                  <span className={classes.healthRowName}>
                    {row.workspaceId === undefined ? t('board.noWorkspace') : workspaceTitle(row.workspaceId)}
                  </span>
                  <span className={classes.healthRowValue}>
                    {t('health.workspaceRow', { open: row.open, total: row.total })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        {current.workspacesTotal > current.openByWorkspace.length && (
          <div className={classes.healthMore}>
            {t('health.moreWorkspaces', { count: current.workspacesTotal - current.openByWorkspace.length })}
          </div>
        )}
      </section>

      <section className={classes.healthSection}>
        <h3 className={classes.healthSectionTitle}>{t('health.tagsTitle')}</h3>
        {current.topTags.length === 0
          ? <div className={classes.empty}>{t('health.tagsEmpty')}</div>
          : (
            <ul className={classes.healthTags}>
              {current.topTags.map(tag => (
                <li
                  key={tag.name}
                  className={classes.tag}
                  style={{ '--dsh-ideas-tag-hue': tagHue(tag.name) } as CSSProperties}
                >
                  {tag.name}
                  <span className={classes.healthTagCount}>{tag.count}</span>
                </li>
              ))}
            </ul>
          )}
        {current.tagsTotal > current.topTags.length && (
          <div className={classes.healthMore}>
            {t('health.moreTags', { count: current.tagsTotal - current.topTags.length })}
          </div>
        )}
      </section>

      {/* Triage detail: which of the two gaps is which, so the single figure
          above can be acted on instead of just read. */}
      <section className={classes.healthSection}>
        <h3 className={classes.healthSectionTitle}>{t('health.triageDetailTitle')}</h3>
        <ul className={classes.healthList}>
          <li className={classes.healthRow}>
            <span className={classes.healthRowName}>{t('health.missingRank')}</span>
            <span className={classes.healthRowValue}>{current.triage.missingRank}</span>
          </li>
          <li className={classes.healthRow}>
            <span className={classes.healthRowName}>{t('health.missingValue')}</span>
            <span className={classes.healthRowValue}>{current.triage.missingValue}</span>
          </li>
        </ul>
      </section>
    </div>
  )
}