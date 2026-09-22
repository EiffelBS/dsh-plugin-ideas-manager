/**
 * Settings surface for the plugin: a section in the DSH Settings modal,
 * registered through the shell's `settings.section` slot, reading and writing
 * the `ideas` settings namespace through the plugin's OWN fenced
 * /api/ideas/config route (the DSH settings RPC domain serves only
 * allowlisted namespaces to configuration clients - the Side card precedent).
 *
 * Two jobs, one install function:
 *  - applyTagChipRows runs on every IdeasClient config change and pushes the
 *    `tagRows` row budget onto the document (--dsh-ideas-tag-rows), which
 *    the tag-zone rule reads through calc();
 *  - registerIdeasSettingsSection contributes the nav row + page when the
 *    shell exposes the slots contract; a shell without it still gets the
 *    style wiring (never throws - the GUI must survive this plugin).
 *
 * Copy discipline: every option carries an explicit title AND a description
 * stating what it changes, its range/default and when it applies; failures
 * render inline instead of silently reverting. Controls commit immediately
 * (selects and checkboxes), except the number row which stages its draft and
 * commits on blur/Enter so typing never writes per keystroke.
 */

import { useEffect, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import {
  clampTagRows,
  IDEAS_DENSITIES,
  IDEAS_TABS,
  sanitizeSettings,
  TAG_ROWS_MAX,
  TAG_ROWS_MIN,
  type IdeasSettingsPatch,
} from '../protocol.ts'
import { classes } from './style.ts'
import { t } from './locales.ts'

/** Structural face of the shell slot registry (no ui-slots dependency). */
export interface SettingsSlotsFace {
  inject(name: string, factory: () => unknown): () => void
  register(options: unknown, component: unknown): () => void
}

/** Structural face of a cordis client context carrying the slots registry. */
interface SlotsCarrier {
  slots?: SettingsSlotsFace
}

/**
 * Push the tag-filter row budget (settings option `tagRows`, 1..5) onto the
 * document as --dsh-ideas-tag-rows; the tag-zone rule reads it through
 * calc(). Idempotent and clamped, so a corrupt wire can never break layout.
 */
export function applyTagChipRows(rows: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--dsh-ideas-tag-rows', String(clampTagRows(rows)))
}

/** Props injected by the registration (the shell adds its own runtime props). */
export interface IdeasSettingsSectionProps {
  client: IdeasClient
  /** Shell runtime props (ignored - the page renders the plugin's own copy). */
  [key: string]: unknown
}

/** One option row: title + description on the left, the control on the right. */
function SettingsRow({ title, desc, control }: { title: string; desc: string; control: ReactNode }) {
  return (
    <div className={classes.settingsRow}>
      <div className={classes.settingsRowText}>
        <span className={classes.settingsRowTitle}>{title}</span>
        <span className={classes.settingsRowDesc}>{desc}</span>
      </div>
      {control}
    </div>
  )
}

/** The section page: heading, intro, status lines, and the option rows. */
export function IdeasSettingsSection({ client }: IdeasSettingsSectionProps) {
  // Re-render on every client change (config, save state, errors): the shell
  // keeps the section mounted while the modal is open.
  const [, bump] = useState(0)
  useEffect(() => client.subscribe(() => { bump(count => count + 1) }), [client])
  // Number-row draft: typing does not write per keystroke; commit on
  // blur/Enter and clear the draft on every outcome - a failed save then
  // shows the STORED value again (free revert) plus the inline error.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const raw = client.config
  const view = { ...raw, value: sanitizeSettings(raw.value) }
  const value = view.value
  const disabled = !view.available || client.configPending

  const commitRows = (): void => {
    if (draft === undefined) return
    const text = draft.trim()
    setDraft(undefined)
    if (text === '') return
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    const clamped = clampTagRows(parsed)
    if (clamped === value.tagRows) return
    void client.saveConfig({ tagRows: clamped })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitRows()
  }
  const save = (patch: IdeasSettingsPatch): void => { void client.saveConfig(patch) }
  const errorText = (): string | undefined => {
    const code = client.configError
    if (code === undefined) return undefined
    if (code === 'settings-conflict') return t('settings.conflict')
    if (code === 'settings-unavailable') return t('settings.unavailable')
    return `${t('settings.saveFailed')}${code}`
  }
  const error = errorText()
  const tabLabels: Record<(typeof IDEAS_TABS)[number], string> = {
    overview: t('tab.overview'),
    priorities: t('tab.priorities'),
    delivered: t('tab.delivered'),
  }
  const densityLabels: Record<(typeof IDEAS_DENSITIES)[number], string> = {
    comfortable: t('settings.densityComfortable'),
    compact: t('settings.densityCompact'),
  }
  return (
    <section className={classes.settingsSection} data-dsh-ideas-settings="">
      <h3 className={classes.settingsTitle}>{t('settings.title')}</h3>
      <p className={classes.settingsIntro}>{t('settings.intro')}</p>
      {error !== undefined && <span className={classes.settingsError}>{error}</span>}
      {!view.available && <span className={classes.settingsNote}>{t('settings.unavailable')}</span>}
      {view.available && draft === undefined && client.configPending && (
        <span className={classes.settingsNote}>{t('settings.loading')}</span>
      )}

      <div className={classes.settingsCard}>
        <div className={classes.settingsGroup}>{t('settings.group')}</div>
        <SettingsRow
          title={t('settings.tagRows')}
          desc={t('settings.tagRowsDesc')}
          control={(
            <input
              className={classes.settingsNumber}
              type="number"
              inputMode="numeric"
              min={TAG_ROWS_MIN}
              max={TAG_ROWS_MAX}
              step={1}
              value={draft ?? String(value.tagRows)}
              disabled={disabled}
              aria-label={t('settings.tagRows')}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value) }}
              onBlur={commitRows}
              onKeyDown={onKeyDown}
            />
          )}
        />
        <SettingsRow
          title={t('settings.cardDensity')}
          desc={t('settings.cardDensityDesc')}
          control={(
            <select
              className={classes.settingsSelect}
              value={value.cardDensity}
              disabled={disabled}
              aria-label={t('settings.cardDensity')}
              onChange={event => { save({ cardDensity: event.target.value as typeof value.cardDensity }) }}
            >
              {IDEAS_DENSITIES.map(density => (
                <option key={density} value={density}>{densityLabels[density]}</option>
              ))}
            </select>
          )}
        />
        <SettingsRow
          title={t('settings.renderMarkdown')}
          desc={t('settings.renderMarkdownDesc')}
          control={(
            <input
              className={classes.settingsCheck}
              type="checkbox"
              checked={value.renderMarkdown}
              disabled={disabled}
              aria-label={t('settings.renderMarkdown')}
              onChange={event => { save({ renderMarkdown: event.target.checked }) }}
            />
          )}
        />
      </div>

      <div className={classes.settingsCard}>
        <div className={classes.settingsGroup}>{t('settings.groupBehavior')}</div>
        <SettingsRow
          title={t('settings.defaultTab')}
          desc={t('settings.defaultTabDesc')}
          control={(
            <select
              className={classes.settingsSelect}
              value={value.defaultTab}
              disabled={disabled}
              aria-label={t('settings.defaultTab')}
              onChange={event => { save({ defaultTab: event.target.value as typeof value.defaultTab }) }}
            >
              {IDEAS_TABS.map(tab => (
                <option key={tab} value={tab}>{tabLabels[tab]}</option>
              ))}
            </select>
          )}
        />
        <SettingsRow
          title={t('settings.rememberScope')}
          desc={t('settings.rememberScopeDesc')}
          control={(
            <input
              className={classes.settingsCheck}
              type="checkbox"
              checked={value.rememberWorkspaceScope}
              disabled={disabled}
              aria-label={t('settings.rememberScope')}
              onChange={event => { save({ rememberWorkspaceScope: event.target.checked }) }}
            />
          )}
        />
        <SettingsRow
          title={t('settings.confirmLifecycle')}
          desc={t('settings.confirmLifecycleDesc')}
          control={(
            <input
              className={classes.settingsCheck}
              type="checkbox"
              checked={value.confirmLifecycle}
              disabled={disabled}
              aria-label={t('settings.confirmLifecycle')}
              onChange={event => { save({ confirmLifecycle: event.target.checked }) }}
            />
          )}
        />
        <SettingsRow
          title={t('settings.hideDeclined')}
          desc={t('settings.hideDeclinedDesc')}
          control={(
            <input
              className={classes.settingsCheck}
              type="checkbox"
              checked={value.hideDeclinedColumn}
              disabled={disabled}
              aria-label={t('settings.hideDeclined')}
              onChange={event => { save({ hideDeclinedColumn: event.target.checked }) }}
            />
          )}
        />
      </div>
    </section>
  )
}

/**
 * Install the settings glue: wire `tagRows` from the client's config onto the
 * document (a settings write updates the open board live) and register the
 * Settings-modal section when the shell exposes the slots contract. A context
 * without slots still gets the style wiring. Returns the combined disposer.
 */
export function registerIdeasSettingsSection(ctx: unknown, client: IdeasClient): () => void {
  const applyStyle = (): void => { applyTagChipRows(client.config.value.tagRows) }
  applyStyle()
  const offStyle = client.subscribe(applyStyle)
  let offSection: (() => void) | undefined
  try {
    // The extraction itself is inside the try: an undeclared cordis service
    // getter THROWS ("cannot get property without inject") instead of
    // returning undefined, and this helper must never propagate.
    const slots = (ctx as SlotsCarrier | null | undefined)?.slots
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
      return offStyle
    }
    offSection = slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'ideas',
      // 60, not 200: the Settings nav rail has no overflow while the panel is
      // capped at 800px (~16 fully visible 44px rows), so a last-in-order row
      // lands below the fold once the roster reaches ~18 sections (reproduced
      // live: Ideas was the only hidden row). 60 sits in the free band between
      // mcp-manager (50) and better-sidebar (100) -> row ~11, always visible.
      order: 60,
      label: () => t('settings.nav'),
      inject: () => ({ client }),
    }, IdeasSettingsSection))
  } catch (error) {
    // A shell whose contract moved must not take the GUI down.
    console.error('[dsh-plugin-ideas-manager] settings section registration failed', error)
  }
  return () => {
    offStyle()
    offSection?.()
  }
}
