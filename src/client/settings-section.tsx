/**
 * Settings surface for the plugin: a section in the DSH Settings modal,
 * registered through the shell's `settings.section` slot, reading and writing
 * the `ideas` settings namespace through the plugin's OWN fenced
 * /api/ideas/config route (the DSH settings RPC domain serves only
 * allowlisted namespaces to configuration clients - the Side card precedent).
 *
 * Two jobs, one install function:
 *  - applyTagChipRows runs on every IdeasClient config change and pushes the
 *    `tagRows` row budget onto the document (--dsh-ideas-tag-chip-rows), which
 *    the chip-zone rule reads through calc();
 *  - registerIdeasSettingsSection contributes the nav row + page when the
 *    shell exposes the slots contract; a shell without it still gets the
 *    style wiring (never throws - the GUI must survive this plugin).
 *
 * Copy discipline: every option carries an explicit title AND a description
 * stating what it changes, its range and its default; failures render inline
 * instead of silently reverting.
 */

import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { IdeasClient } from './ideas-client.ts'
import { clampTagRows, TAG_ROWS_MAX, TAG_ROWS_MIN } from '../protocol.ts'
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
 * document as --dsh-ideas-tag-chip-rows; the chips rule reads it through
 * calc(). Idempotent and clamped, so a corrupt wire can never break layout.
 */
export function applyTagChipRows(rows: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--dsh-ideas-tag-chip-rows', String(clampTagRows(rows)))
}

/** Props injected by the registration (the shell adds its own runtime props). */
export interface IdeasSettingsSectionProps {
  client: IdeasClient
  /** Shell runtime props (ignored - the page renders the plugin's own copy). */
  [key: string]: unknown
}

/** The section page: heading, intro, and the option rows (settings recipe). */
export function IdeasSettingsSection({ client }: IdeasSettingsSectionProps) {
  // Re-render on every client change (config, save state, errors): the shell
  // keeps the section mounted while the modal is open.
  const [, bump] = useState(0)
  useEffect(() => client.subscribe(() => { bump(count => count + 1) }), [client])
  // Local draft so typing does not write per keystroke: commit on blur/Enter,
  // and clear it on every outcome - a failed save then shows the STORED value
  // again (free revert) plus the inline error below.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const view = client.config
  const tagRows = clampTagRows(view.value.tagRows)
  const disabled = !view.available || client.configPending

  const commit = (): void => {
    if (draft === undefined) return
    const text = draft.trim()
    setDraft(undefined)
    if (text === '') return
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    const clamped = clampTagRows(parsed)
    if (clamped === tagRows) return
    void client.saveConfig({ tagRows: clamped })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commit()
  }
  const errorText = (): string | undefined => {
    const code = client.configError
    if (code === undefined) return undefined
    if (code === 'settings-conflict') return t('settings.conflict')
    if (code === 'settings-unavailable') return t('settings.unavailable')
    return `${t('settings.saveFailed')}${code}`
  }
  const error = errorText()
  return (
    <section className={classes.settingsSection} data-dsh-ideas-settings="">
      <h3 className={classes.settingsTitle}>{t('settings.title')}</h3>
      <p className={classes.settingsIntro}>{t('settings.intro')}</p>
      <div className={classes.settingsCard}>
        <div className={classes.settingsGroup}>{t('settings.group')}</div>
        <div className={classes.settingsRow}>
          <div className={classes.settingsRowText}>
            <span className={classes.settingsRowTitle}>{t('settings.tagRows')}</span>
            <span className={classes.settingsRowDesc}>{t('settings.tagRowsDesc')}</span>
            {error !== undefined && <span className={classes.settingsError}>{error}</span>}
            {!view.available && <span className={classes.settingsNote}>{t('settings.unavailable')}</span>}
            {view.available && draft === undefined && client.configPending && (
              <span className={classes.settingsNote}>{t('settings.loading')}</span>
            )}
          </div>
          <input
            className={classes.settingsNumber}
            type="number"
            inputMode="numeric"
            min={TAG_ROWS_MIN}
            max={TAG_ROWS_MAX}
            step={1}
            value={draft ?? String(tagRows)}
            disabled={disabled}
            aria-label={t('settings.tagRows')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value) }}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
        </div>
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
      order: 200,
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
