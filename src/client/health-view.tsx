/** Graphical backlog-health dashboard, rendered from one bounded Host aggregate. */

import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import { durationParts, type IdeasDurationUnit, type IdeasStats, type IdeasStatsRange } from '../core/ideas-stats.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'
import { tagHue } from './tags.ts'
import { NO_WORKSPACE_FILTER } from './ordering.ts'

export interface HealthViewProps {
  client: IdeasClient
  /** `''` = all, NO_WORKSPACE_FILTER = workspace-less, or a real id. */
  scopeWorkspaceId: string
  workspaceTitle: (workspaceId: string) => string
  boardRevision: number | undefined
  range: IdeasStatsRange
  tag?: string
  knownTags: readonly string[]
  onRangeChange: (range: IdeasStatsRange) => void
  onTagChange: (tag: string | undefined) => void
  onOpenIdea: (ideaId: string) => void
  onOpenIdeas: () => void
  onWorkspace: (workspaceId: string | undefined) => void
  onTag: (name: string) => void
  onTriage: () => void
}

function wireScopeOf(scopeWorkspaceId: string): string | undefined {
  return scopeWorkspaceId === '' ? undefined : scopeWorkspaceId === NO_WORKSPACE_FILTER ? '' : scopeWorkspaceId
}

function monthLabelOf(at: number): string {
  const formatted = new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  return formatted === '' ? String(new Date(at).getMonth() + 1) : formatted
}

function timeLabelOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function shortDateLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function durationUnitLabel(unit: IdeasDurationUnit): string {
  return unit === 'days' ? t('health.unitDays') : unit === 'hours' ? t('health.unitHours') : t('health.unitMinutes')
}

function toneStyle(tone: string): CSSProperties {
  return { '--dsh-ideas-health-tone': `var(${tone})` } as CSSProperties
}

function HealthIcon({ name }: { name: 'backlog' | 'review' | 'delivered' | 'clock' | 'refresh' | 'warning' | 'check' | 'info' | 'chevron' }) {
  const paths = {
    backlog: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5"/></>,
    review: <><path d="M4 5h16v14H4zM8 9h8M8 13h5"/></>,
    delivered: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>,
    refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>,
    warning: <path d="M12 9v4M12 17h.01M10.3 4.3 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
    chevron: <path d="m9 5 7 7-7 7"/>,
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function Kpi({ label, value, hint, icon, tone }: {
  label: string
  value: string
  hint: string
  icon: 'backlog' | 'review' | 'delivered' | 'clock'
  tone: string
}) {
  return (
    <article className={classes.healthKpi} style={toneStyle(tone)}>
      <div className={classes.healthKpiTop}>
        <span className={classes.healthKpiLabel}>{label}</span>
        <span className={classes.healthKpiIcon}><HealthIcon name={icon} /></span>
      </div>
      <div className={classes.healthKpiValue}>{value}</div>
      <div className={classes.healthKpiHint}>{hint}</div>
    </article>
  )
}

function CardHead({ title, sub, action }: { title: string; sub?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className={classes.healthCardHead}>
      <div>
        <h2 className={classes.healthCardTitle}>{title}</h2>
        {sub !== undefined && <p className={classes.healthCardSub}>{sub}</p>}
      </div>
      {action !== undefined && <button type="button" className={classes.healthCardAction} onClick={action.onClick}>{action.label}</button>}
    </div>
  )
}

function FlowDonut({ stats }: { stats: IdeasStats }) {
  const [hovered, setHovered] = useState<'open' | 'review' | undefined>()
  const total = stats.workflow.open + stats.workflow.underReview
  const radius = 46
  const circumference = 2 * Math.PI * radius
  const openLength = total === 0 ? 0 : circumference * stats.workflow.open / total
  const reviewLength = total === 0 ? 0 : circumference * stats.workflow.underReview / total
  const centerValue = hovered === 'open' ? stats.workflow.open : hovered === 'review' ? stats.workflow.underReview : total
  const centerLabel = hovered === 'open' ? t('health.workflowOpen') : hovered === 'review' ? t('health.workflowReview') : t('health.activeIdeas')
  return (
    <div className={classes.healthFlowLayout}>
      <div className={classes.healthDonut} aria-label={t('health.flowAria', { total })}>
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={radius} className={classes.healthDonutTrack}/>
          <circle
            cx="60" cy="60" r={radius}
            className={`${classes.healthDonutOpen}${hovered === 'open' ? ` ${classes.healthDonutOpenActive}` : ''}`}
            strokeDasharray={`${openLength} ${circumference - openLength}`}
            tabIndex={0}
            role="img"
            aria-label={`${t('health.workflowOpen')}: ${stats.workflow.open}`}
            onMouseEnter={() => { setHovered('open') }}
            onMouseLeave={() => { setHovered(undefined) }}
            onFocus={() => { setHovered('open') }}
            onBlur={() => { setHovered(undefined) }}
          ><title>{`${t('health.workflowOpen')}: ${stats.workflow.open}`}</title></circle>
          <circle
            cx="60" cy="60" r={radius}
            className={`${classes.healthDonutReview}${hovered === 'review' ? ` ${classes.healthDonutReviewActive}` : ''}`}
            strokeDasharray={`${reviewLength} ${circumference - reviewLength}`}
            strokeDashoffset={-openLength}
            tabIndex={0}
            role="img"
            aria-label={`${t('health.workflowReview')}: ${stats.workflow.underReview}`}
            onMouseEnter={() => { setHovered('review') }}
            onMouseLeave={() => { setHovered(undefined) }}
            onFocus={() => { setHovered('review') }}
            onBlur={() => { setHovered(undefined) }}
          ><title>{`${t('health.workflowReview')}: ${stats.workflow.underReview}`}</title></circle>
        </svg>
        <div className={classes.healthDonutCenter}>
          <div className={classes.healthDonutValue}>{centerValue}</div>
          <div className={classes.healthDonutLabel}>{centerLabel}</div>
        </div>
      </div>
      <div className={classes.healthLegend}>
        <Legend color="--dsh-ideas-chart-blue" label={t('health.workflowOpen')} value={stats.workflow.open} active={hovered === 'open'} onHover={setHovered}/>
        <Legend color="--dsh-ideas-chart-purple" label={t('health.workflowReview')} value={stats.workflow.underReview} active={hovered === 'review'} onHover={setHovered}/>
        <Legend color="--dsh-ideas-chart-green" label={t('health.workflowRunning')} value={stats.workflow.running}/>
        <Legend color="--dsh-ideas-chart-amber" label={t('health.workflowBlocked')} value={stats.workflow.blocked}/>
      </div>
    </div>
  )
}

function Legend({ color, label, value, active, onHover }: { color: string; label: string; value: number; active?: boolean; onHover?: (value: 'open' | 'review' | undefined) => void }) {
  const kind = label === t('health.workflowOpen') ? 'open' : 'review'
  return (
    <div
      className={`${classes.healthLegendRow}${active ? ` ${classes.healthLegendRowActive}` : ''}`}
      tabIndex={onHover === undefined ? undefined : 0}
      onMouseEnter={() => { onHover?.(kind) }}
      onMouseLeave={() => { onHover?.(undefined) }}
      onFocus={() => { onHover?.(kind) }}
      onBlur={() => { onHover?.(undefined) }}
    >
      <span className={classes.healthLegendDot} style={{ background: `var(${color})` }}/>
      <span className={classes.healthLegendName}>{label}</span>
      <span className={classes.healthLegendValue}>{value}</span>
    </div>
  )
}

function TriageRing({ stats, onTriage }: { stats: IdeasStats; onTriage: () => void }) {
  const radius = 49
  const circumference = 2 * Math.PI * radius
  const ratio = stats.triage.open === 0 ? 0 : stats.triage.unique / stats.triage.open
  return (
    <>
      <div className={classes.healthTriageLayout}>
        <div className={classes.healthProgressRing} aria-label={t('health.triageAria', { unique: stats.triage.unique, open: stats.triage.open })}>
          <svg viewBox="0 0 120 120">
            <circle cx="60" cy="60" r={radius} className={classes.healthRingTrack}/>
            <circle cx="60" cy="60" r={radius} className={classes.healthRingProgress} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)}/>
          </svg>
          <div className={classes.healthRingCenter}>
            <div className={classes.healthRingValue}>{stats.triage.unique}</div>
            <div className={classes.healthRingLabel}>{t('health.triageOf', { open: stats.triage.open })}</div>
          </div>
        </div>
        <div className={classes.healthTriageDetails}>
          <MiniStat label={t('health.missingRank')} value={stats.triage.missingRank} max={stats.triage.open} color="--dsh-ideas-chart-amber"/>
          <MiniStat label={t('health.missingValue')} value={stats.triage.missingValue} max={stats.triage.open} color="--dsh-ideas-chart-purple"/>
          <div className={classes.healthMiniStat}>
            <span className={classes.healthMiniStatLabel}>{t('health.triageUnique')}</span>
            <span className={classes.healthMiniStatValue}>{stats.triage.unique}</span>
          </div>
        </div>
      </div>
      <button type="button" className={classes.healthTriageCta} onClick={onTriage}>
        {t('health.triageCta')}
      </button>
    </>
  )
}

function MiniStat({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div>
      <div className={classes.healthMiniStat}>
        <span className={classes.healthMiniStatLabel}>{label}</span>
        <span className={classes.healthMiniStatValue}>{value}</span>
      </div>
      <div className={classes.healthMiniBar}><span style={{ width: `${max === 0 ? 0 : value / max * 100}%`, background: `var(${color})` }}/></div>
    </div>
  )
}

function DeliveryChart({ stats }: { stats: IdeasStats }) {
  const max = Math.max(1, ...stats.delivery.buckets.map(bucket => bucket.count))
  return (
    <>
      <div className={classes.healthFlowStats}>
        <div className={classes.healthFlowStat}><span>{t('health.created')}</span><b>{stats.createdInWindow}</b></div>
        <div className={classes.healthFlowStat}><span>{t('health.delivered')}</span><b>{stats.deliveredInWindow}</b></div>
        <div className={`${classes.healthFlowStat} ${stats.netBacklog > 0 ? classes.healthFlowStatWarn : classes.healthFlowStatOk}`}>
          <span>{t('health.netBacklog')}</span><b>{stats.netBacklog > 0 ? '+' : ''}{stats.netBacklog}</b>
        </div>
      </div>
      {stats.deliveredInWindow === 0 && stats.comparison.delivered > 0 && (
        <div className={classes.healthContextNote}>{t('health.noDeliveriesPrevious', { count: stats.comparison.delivered })}</div>
      )}
      <div className={classes.healthBarChart} role="img" aria-label={t('health.deliveryChartAria')}>
        {stats.delivery.buckets.map((bucket, index) => (
          <div className={classes.healthBarCol} key={`${bucket.start}-${index}`}>
            <div
              className={classes.healthBar}
              style={{ height: `${bucket.count === 0 ? 0 : Math.max(8, bucket.count / max * 100)}%` }}
              title={`${shortDateLabel(bucket.start)} : ${bucket.count}`}
              data-value={bucket.count}
              data-tooltip={`${shortDateLabel(bucket.start)} · ${bucket.count}`}
              tabIndex={0}
              role="img"
              aria-label={`${shortDateLabel(bucket.start)} : ${bucket.count}`}
            />
            <span className={classes.healthBarLabel}>{shortDateLabel(bucket.start)}</span>
          </div>
        ))}
      </div>
      <table className={classes.healthSrOnly}>
        <caption>{t('health.deliveryChartAria')}</caption>
        <thead><tr><th>{t('health.chartDate')}</th><th>{t('health.chartCount')}</th></tr></thead>
        <tbody>{stats.delivery.buckets.map(bucket => <tr key={bucket.start}><td>{shortDateLabel(bucket.start)}</td><td>{bucket.count}</td></tr>)}</tbody>
      </table>
      <div className={classes.healthChartFoot}>
        <span className={classes.healthChartKey}><i/>{t('health.timestampedDeliveries')}</span>
        <span>{stats.delivery.medianMs === null
          ? t('health.medianThin', { count: stats.delivery.sample, min: stats.delivery.minSamples })
          : t('health.chartMedian', { value: durationParts(stats.delivery.medianMs).value, unit: durationUnitLabel(durationParts(stats.delivery.medianMs).unit) })}</span>
      </div>
    </>
  )
}

function Aging({ stats }: { stats: IdeasStats }) {
  const total = stats.aging.upTo7 + stats.aging.upTo30 + stats.aging.upTo90 + stats.aging.over90
  const rows = [
    { label: t('health.age7'), value: stats.aging.upTo7, color: '--dsh-ideas-chart-green' },
    { label: t('health.age30'), value: stats.aging.upTo30, color: '--dsh-ideas-chart-blue' },
    { label: t('health.age90'), value: stats.aging.upTo90, color: '--dsh-ideas-chart-amber' },
    { label: t('health.age90Plus'), value: stats.aging.over90, color: '--dsh-ideas-chart-red' },
  ]
  return (
    <>
      <div className={classes.healthAgeSummary}>
        <strong>{stats.aging.oldestMs === null ? '—' : durationParts(stats.aging.oldestMs).value}</strong>
        <span>{stats.aging.oldestMs === null ? t('health.noOpenIdeas') : `${durationUnitLabel(durationParts(stats.aging.oldestMs!).unit)} · ${t('health.oldestIdea')}`}</span>
      </div>
      <div className={classes.healthSegmented} aria-label={t('health.agingAria')}>
        {rows.map(row => <span key={row.label} className={classes.healthSegment} style={{ width: `${total === 0 ? 0 : row.value / total * 100}%`, background: `var(${row.color})` }} title={`${row.label} : ${row.value}`} data-tooltip={`${row.label} · ${row.value}`}/>)}
      </div>
      <div className={classes.healthAgeLegend}>
        {rows.map(row => (
          <div className={classes.healthAgeRow} key={row.label}>
            <span className={classes.healthAgeRowLabel}>{row.label}</span>
            <div className={classes.healthRankTrack}><div className={classes.healthRankFill} style={{ width: `${total === 0 ? 0 : row.value / total * 100}%`, background: `var(${row.color})` }}/></div>
            <span className={classes.healthRankValue}>{row.value}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function Workspaces({ stats, workspaceTitle, onWorkspace }: { stats: IdeasStats; workspaceTitle: (id: string) => string; onWorkspace: (id: string | undefined) => void }) {
  const max = Math.max(1, ...stats.openByWorkspace.map(row => row.open))
  const medianLabel = (row: IdeasStats['openByWorkspace'][number]): string => {
    if (row.medianMs === null) return `${row.sample} / ${stats.delivery.minSamples}`
    const median = durationParts(row.medianMs)
    return `${median.value} ${durationUnitLabel(median.unit)}`
  }
  return (
    <>
      <div className={classes.healthWorkspaceScroll}>
        <table className={classes.healthWorkspaceTable}>
        <thead><tr><th>{t('health.workspaceColumn')}</th><th>{t('health.openTitle')}</th><th>{t('health.deliveredTitle')}</th><th>{t('health.medianTitle')}</th></tr></thead>
        <tbody>
          {stats.openByWorkspace.map(row => (
            <tr key={row.workspaceId ?? ''}>
              <td>
                <button type="button" className={classes.healthWorkspaceName} onClick={() => { onWorkspace(row.workspaceId) }}>
                  {row.workspaceId === undefined ? t('board.noWorkspace') : workspaceTitle(row.workspaceId)}
                </button>
              </td>
              <td><span className={classes.healthWorkspaceOpen}><i><span style={{ width: `${row.open / max * 100}%` }}/></i><b>{row.open}</b></span></td>
              <td className={classes.healthWorkspaceMetric}>{row.deliveredInWindow}</td>
              <td className={classes.healthWorkspaceMetric}>{medianLabel(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {stats.workspacesTotal > stats.openByWorkspace.length && <div className={classes.healthMore}>{t('health.moreWorkspaces', { count: stats.workspacesTotal - stats.openByWorkspace.length })}</div>}
    </>
  )
}

function Tags({ stats, onTag }: { stats: IdeasStats; onTag: (name: string) => void }) {
  const max = Math.max(1, ...stats.topTags.map(tag => tag.count))
  return (
    <>
      <div className={classes.healthRankList}>
        {stats.topTags.map(tag => (
          <button type="button" className={classes.healthRankRow} key={tag.name} title={`${tag.name} · ${tag.count}`} onClick={() => { onTag(tag.name) }}>
            <span className={classes.healthTagLabel}><i style={{ background: `hsl(${tagHue(tag.name)} 70% 55%)` }}/>{tag.name}</span>
            <span className={classes.healthRankTrack}><span className={classes.healthRankFill} style={{ width: `${tag.count / max * 100}%`, background: `hsl(${tagHue(tag.name)} 70% 55%)` }}/></span>
            <span className={classes.healthRankValue}>{tag.count}</span>
          </button>
        ))}
      </div>
      {stats.tagsTotal > stats.topTags.length && <div className={classes.healthMore}>{t('health.moreTags', { count: stats.tagsTotal - stats.topTags.length })}</div>}
    </>
  )
}

function Activity({ stats }: { stats: IdeasStats }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const days = stats.activity.days
  const activeDay = days[activeIndex] ?? days[0]
  const max = Math.max(1, ...days.map(day => day.created + day.delivered))
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let next = activeIndex
    if (event.key === 'ArrowLeft') next -= 1
    else if (event.key === 'ArrowRight') next += 1
    else if (event.key === 'ArrowUp') next -= 7
    else if (event.key === 'ArrowDown') next += 7
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = days.length - 1
    else return
    event.preventDefault()
    next = Math.max(0, Math.min(days.length - 1, next))
    setActiveIndex(next)
    requestAnimationFrame(() => {
      document.getElementById(`health-heat-${days[next]?.date ?? ''}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
  return (
    <>
      {stats.activity.created + stats.activity.delivered === 0 && (
        <div className={classes.healthContextNote}>{t('health.activityEmpty')}</div>
      )}
      <div className={classes.healthActivityLayout}>
        <div className={classes.healthActivityHeat}>
          <div className={classes.healthHeatmapHead}>
            <span>{days[0]?.date ?? ''}</span>
            <span>{t('health.activityWeeks')}</span>
            <span>{days.at(-1)?.date ?? ''}</span>
          </div>
          <div
            className={classes.healthHeatmap}
            role="listbox"
            tabIndex={0}
            aria-label={t('health.activityAria')}
            aria-activedescendant={activeDay === undefined ? undefined : `health-heat-${activeDay.date}`}
            onKeyDown={onKeyDown}
          >
            {days.map((day, index) => {
              const value = day.created + day.delivered
              const level = value === 0 ? 0 : Math.max(1, Math.ceil(value / max * 4))
              return (
                <span
                  key={day.date}
                  id={`health-heat-${day.date}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`${classes.healthHeatCell}${index === activeIndex ? ` ${classes.healthHeatCellActive}` : ''}`}
                  data-level={level}
                  title={`${day.date} : +${day.created} · ✓${day.delivered}`}
                  data-tooltip={`${day.date} · +${day.created} · ✓${day.delivered}`}
                  style={{ '--health-index': index } as CSSProperties}
                  onMouseEnter={() => { setActiveIndex(index) }}
                />
              )
            })}
          </div>
          {activeDay !== undefined && (
            <div className={classes.healthHeatReadout} role="status" aria-live="polite">
              <b>{activeDay.date}</b>
              {' · '}+{activeDay.created} {t('health.created')}
              {' · '}✓{activeDay.delivered} {t('health.delivered')}
            </div>
          )}
        </div>
        <div className={classes.healthActivityPanel}>
          <div className={classes.healthHeatLegend}>
            <span>{t('health.lessActivity')}</span><i/><i/><i/><i/><i/><span>{t('health.moreActivity')}</span>
          </div>
          <div className={classes.healthActivityStats}>
            <div className={classes.healthActivityStat}><b>{stats.activity.created}</b><span>{t('health.created')}</span></div>
            <div className={classes.healthActivityStat}><b>{stats.activity.delivered}</b><span>{t('health.delivered')}</span></div>
            <div className={classes.healthActivityStat}><b>{stats.activity.activeDays}</b><span>{t('health.activeDays')}</span></div>
          </div>
        </div>
      </div>
      <table className={classes.healthSrOnly}>
        <caption>{t('health.activityAria')}</caption>
        <thead><tr><th>{t('health.chartDate')}</th><th>{t('health.created')}</th><th>{t('health.delivered')}</th></tr></thead>
        <tbody>{days.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.created}</td><td>{day.delivered}</td></tr>)}</tbody>
      </table>
    </>
  )
}

type QualityKey = 'withoutStamp' | 'inconsistent' | 'withoutWorkspace'

function Quality({ stats, onOpenIdea }: { stats: IdeasStats; onOpenIdea: (ideaId: string) => void }) {
  const [selected, setSelected] = useState<QualityKey | undefined>()
  const rows: Array<{
    key: QualityKey
    label: string
    icon: 'warning' | 'check' | 'info'
    tone: 'warn' | 'ok' | 'info'
    samples: IdeasStats['quality']['withoutStampSamples']
  }> = [
    { key: 'withoutStamp', label: t('health.qualityWithoutStamp'), icon: 'warning' as const, tone: stats.quality.withoutStamp > 0 ? 'warn' : 'ok', samples: stats.quality.withoutStampSamples },
    { key: 'inconsistent', label: t('health.qualityInconsistent'), icon: stats.quality.inconsistent > 0 ? 'warning' : 'check' as const, tone: stats.quality.inconsistent > 0 ? 'warn' : 'ok', samples: stats.quality.inconsistentSamples },
    { key: 'withoutWorkspace', label: t('health.qualityWithoutWorkspace'), icon: 'info' as const, tone: 'info', samples: stats.quality.withoutWorkspaceSamples },
  ]
  const active = rows.find(row => row.key === selected)
  return (
    <>
      <div className={classes.healthQualityList}>
        {rows.map(row => (
          <button
            type="button"
            className={`${classes.healthQualityRow} ${row.tone === 'warn' ? classes.healthQualityWarn : row.tone === 'ok' ? classes.healthQualityOk : classes.healthQualityInfo}`}
            key={row.key}
            disabled={row.samples.length === 0}
            aria-expanded={selected === row.key}
            onClick={() => { setSelected(current => current === row.key ? undefined : row.key) }}
          >
            <span className={classes.healthQualityIcon}><HealthIcon name={row.icon}/></span>
            <span className={classes.healthQualityName}>{row.label}</span>
            <span className={classes.healthQualityValue}>{stats.quality[row.key]}</span>
            <span className={classes.healthQualityChevron}><HealthIcon name="chevron"/></span>
          </button>
        ))}
      </div>
      {active !== undefined && (
        <div className={classes.healthQualitySamples}>
          {active.samples.map(sample => (
            <button type="button" key={sample.id} className={classes.healthQualitySample} onClick={() => { onOpenIdea(sample.id) }}>
              {sample.title || sample.id}
            </button>
          ))}
          {stats.quality[active.key] > active.samples.length && <div className={classes.healthMore}>{t('health.moreQuality', { count: stats.quality[active.key] - active.samples.length })}</div>}
        </div>
      )}
      <div className={classes.healthQualityFoot}>{t('health.qualityFoot')}</div>
    </>
  )
}

export function HealthView({ client, scopeWorkspaceId, workspaceTitle, boardRevision, range, tag, knownTags, onRangeChange, onTagChange, onOpenIdea, onOpenIdeas, onWorkspace, onTag, onTriage }: HealthViewProps) {
  const stats: IdeasStats | undefined = client.stats
  const scope = wireScopeOf(scopeWorkspaceId)
  const current = stats !== undefined && client.statsScope === scope && client.statsRange === range && client.statsTag === tag ? stats : undefined
  const runningRef = useRef<Animation[]>([])
  const observerRef = useRef<IntersectionObserver | null>(null)
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const healthRef = useCallback((node: HTMLDivElement | null): void => {
    for (const animation of runningRef.current) animation.cancel()
    runningRef.current = []
    observerRef.current?.disconnect()
    observerRef.current = null
    if (fallbackRef.current !== null) {
      globalThis.clearTimeout(fallbackRef.current)
      fallbackRef.current = null
    }
    if (node === null || current === undefined) return
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) {
      node.dataset.dshIdeasHealthMotion = 'reduced'
      return
    }
    node.dataset.dshIdeasHealthMotion = 'waiting'
    const play = (): void => {
      const running: Animation[] = []
      const animate = (
        selector: string,
        keyframes: Keyframe[],
        duration: number,
        stagger = 0,
        baseDelay = 0,
      ): void => {
        node.querySelectorAll(selector).forEach((element, index) => {
          if (typeof element.animate !== 'function') return
          running.push(element.animate(keyframes, {
            duration,
            delay: baseDelay + index * stagger,
            easing: 'cubic-bezier(.2, .8, .2, 1)',
            fill: 'backwards',
          }))
        })
      }
      animate(`.${classes.healthKpi}`, [
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], 650, 70)
      animate(`.${classes.healthCard}`, [
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], 750, 80)
      animate(`.${classes.healthDonut}, .${classes.healthProgressRing}`, [
        { opacity: 0, transform: 'scale(.88)' },
        { opacity: 1, transform: 'scale(1)' },
      ], 900)
      animate(`.${classes.healthBar}`, [
        { transform: 'scaleY(0)' },
        { transform: 'scaleY(1)' },
      ], 750, 65)
      animate(`.${classes.healthRankFill}, .${classes.healthMiniBar} span, .${classes.healthSegment}`, [
        { transform: 'scaleX(0)' },
        { transform: 'scaleX(1)' },
      ], 750)
      animate(`.${classes.healthHeatCell}`, [
        { opacity: 0, transform: 'scale(.55)' },
        { opacity: 1, transform: 'scale(1)' },
      ], 380, 7)
      runningRef.current = running
      node.dataset.dshIdeasHealthMotion = 'played'
    }
    let played = false
    const playOnce = (): void => {
      if (played) return
      played = true
      observerRef.current?.disconnect()
      observerRef.current = null
      if (fallbackRef.current !== null) {
        globalThis.clearTimeout(fallbackRef.current)
        fallbackRef.current = null
      }
      play()
    }
    if (typeof globalThis.IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        playOnce()
      }, { threshold: 0.01 })
      observerRef.current = observer
      observer.observe(node)
    }
    fallbackRef.current = globalThis.setTimeout(playOnce, 500)
  }, [current?.computedAt])

  if (!client.statsAvailable) {
    return <div className={classes.health} data-dsh-ideas-health=""><div className={classes.healthNote} role="status">{t('health.unavailable')}</div></div>
  }

  const scopeLabel = scopeWorkspaceId === ''
    ? t('health.scopeAll')
    : scopeWorkspaceId === NO_WORKSPACE_FILTER ? t('health.scopeGeneric') : workspaceTitle(scopeWorkspaceId)
  const scopeWithTag = tag === undefined ? scopeLabel : `${scopeLabel} · ${tag}`
  const rangeLabel = range === 'month' ? t('health.rangeMonth') : range === '30d' ? t('health.range30d') : range === '90d' ? t('health.range90d') : t('health.rangeAll')
  const tagOptions = tag === undefined ? knownTags : [...new Set([tag, ...knownTags])]
  const header = (
    <header className={classes.healthHeader}>
      <div>
        <div className={classes.healthEyebrow}>{t('health.eyebrow')}</div>
        <h1 className={classes.healthTitle}>{t('health.title')}</h1>
        <p className={classes.healthDesc}>{t('health.desc')}</p>
      </div>
      <div className={classes.healthScope}><span className={classes.healthScopeDot}/>{scopeWithTag}</div>
    </header>
  )
  const toolbar = (
    <div className={classes.healthToolbar}>
      <select
        className={classes.healthTagFilter}
        aria-label={t('health.tagFilter')}
        value={tag ?? ''}
        onChange={event => { onTagChange(event.target.value === '' ? undefined : event.target.value) }}
      >
        <option value="">{t('health.allTags')}</option>
        {tagOptions.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <div className={classes.healthRangeTabs} role="group" aria-label={t('health.rangeAria')}>
        {(['month', '30d', '90d', 'all'] as const).map(item => (
          <button
            key={item}
            type="button"
            className={classes.healthRangeTab}
            aria-pressed={range === item}
            onClick={() => { onRangeChange(item) }}
          >
            {item === 'month' ? t('health.rangeMonth') : item === '30d' ? t('health.range30d') : item === '90d' ? t('health.range90d') : t('health.rangeAll')}
          </button>
        ))}
      </div>
      <div className={classes.healthRefresh}>
        {current !== undefined && <span>{t('health.updatedAt', { time: timeLabelOf(current.computedAt) })}</span>}
        <button type="button" className={classes.healthRefreshButton} onClick={() => { void client.loadStats(scope, range, tag) }}>
          <HealthIcon name="refresh"/>{t('health.refresh')}
        </button>
      </div>
    </div>
  )
  const guide = (
    <details className={classes.healthGuide}>
      <summary><HealthIcon name="info"/>{t('health.guideTitle')}</summary>
      <div className={classes.healthGuideBody}>
        <p>{t('health.guideScope')}</p>
        <p>{t('health.guideTriage')}</p>
        <p>{t('health.guideQuality')}</p>
      </div>
    </details>
  )

  if (current === undefined) {
    return (
      <div ref={healthRef} className={classes.health} data-dsh-ideas-health="">
        {header}
        {toolbar}
        {guide}
        {client.statsError !== undefined
          ? <div className={classes.healthNote} role="status">{t('health.error', { error: client.statsError })} <button type="button" className={classes.ghostButton} onClick={() => { void client.loadStats(scope, range, tag) }}>{t('health.retry')}</button></div>
          : <div className={classes.healthNote} role="status">{t('health.loading')}</div>}
      </div>
    )
  }

  const median = current.delivery.medianMs === null ? null : durationParts(current.delivery.medianMs)
  const stale = boardRevision !== undefined && current.revision !== boardRevision

  return (
    <div ref={healthRef} className={classes.health} data-dsh-ideas-health="">
      {header}
      {toolbar}
      {guide}

      <section className={classes.healthFigures} aria-label={t('health.kpiAria')} data-dsh-ideas-health-figures="">
        <Kpi label={t('health.openTitle')} value={`${current.workflow.open} / ${current.scope.ideas}`} hint={t('health.openHint', { review: current.workflow.underReview })} icon="backlog" tone="--dsh-ideas-chart-blue"/>
        <Kpi label={t('health.reviewTitle')} value={String(current.workflow.underReview)} hint={t('health.reviewHint', { running: current.workflow.running })} icon="review" tone="--dsh-ideas-chart-purple"/>
        <Kpi label={t('health.deliveredTitle')} value={String(current.deliveredInWindow)} hint={range === 'month' ? monthLabelOf(current.window.start) : rangeLabel} icon="delivered" tone="--dsh-ideas-chart-green"/>
        <Kpi
          label={t('health.medianTitle')}
          value={median === null ? `${current.delivery.sample} / ${current.delivery.minSamples}` : `${median.value} ${durationUnitLabel(median.unit)}`}
          hint={median === null ? t('health.medianThinHint', { min: current.delivery.minSamples }) : t('health.medianHint', { count: current.delivery.sample })}
          icon="clock"
          tone="--dsh-ideas-chart-amber"
        />
      </section>

      {stale && (
        <div className={classes.healthStale} role="status" data-dsh-ideas-health-stale={client.statsError !== undefined ? 'failed' : ''}>
          {client.statsError !== undefined
            ? t('health.staleError', { revision: current.revision, error: client.statsError })
            : t(client.statsPending ? 'health.refreshing' : 'health.stale', { revision: current.revision })}
        </div>
      )}

      <section className={classes.healthGrid}>
        <article className={`${classes.healthCard} ${classes.healthSpan7}`}>
          <CardHead title={t('health.flowTitle')} sub={t('health.flowSub')} action={{ label: t('health.openIdeas'), onClick: onOpenIdeas }}/>
          <FlowDonut stats={current}/>
          <div className={classes.healthFlowNote}>{t('health.flowNote')}</div>
        </article>

        <article className={`${classes.healthCard} ${classes.healthSpan5}`}>
          <CardHead title={t('health.triageTitle')} sub={t('health.triageSub')} action={{ label: t('health.triageAction'), onClick: onTriage }}/>
          <TriageRing stats={current} onTriage={onTriage}/>
        </article>

        <article className={`${classes.healthCard} ${classes.healthSpan7}`}>
          <CardHead title={t('health.deliveryTitle')} sub={t('health.deliverySub', { range: rangeLabel })}/>
          <DeliveryChart stats={current}/>
        </article>

        <article className={`${classes.healthCard} ${classes.healthSpan5}`}>
          <CardHead title={t('health.agingTitle')} sub={t('health.agingSub')}/>
          <Aging stats={current}/>
        </article>

        <article className={`${classes.healthCard} ${classes.healthSpan7}`}>
          <CardHead title={t('health.workspacesTitle')} sub={t('health.workspacesSub')}/>
          {current.openByWorkspace.length === 0 ? <div className={classes.empty}>{current.scope.ideas === 0 ? t('health.emptyScope') : t('health.workspacesEmpty')}</div> : <Workspaces stats={current} workspaceTitle={workspaceTitle} onWorkspace={onWorkspace}/>}
        </article>

        <article className={`${classes.healthCard} ${classes.healthSpan5}`}>
          <CardHead title={t('health.tagsTitle')} sub={t('health.tagsSub')}/>
          {current.topTags.length === 0 ? <div className={classes.empty}>{current.scope.ideas === 0 ? t('health.emptyScope') : t('health.tagsEmpty')}</div> : <Tags stats={current} onTag={onTag}/>}
        </article>

        <article className={`${classes.healthCard} ${classes.healthSpan8}`}>
          <CardHead title={t('health.activityTitle')} sub={t('health.activitySub')}/>
          <Activity stats={current}/>
        </article>

        <article className={`${classes.healthCard} ${classes.healthSpan4}`}>
          <CardHead title={t('health.qualityTitle')} sub={t('health.qualitySub')}/>
          <Quality stats={current} onOpenIdea={onOpenIdea}/>
        </article>
      </section>
    </div>
  )
}
