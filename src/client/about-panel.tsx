/**
 * Reusable About panel component for plugin settings.
 * Accepts metadata and an optional update-check callback.
 *
 * Intended to be promoted to the shared eiffelbs-ui library and used
 * by all DSH plugins that expose an options panel, providing a
 * standardized "About" tab.
 *
 * Props:
 * - repositoryUrl: link to the plugin's GitHub repository
 * - version: plugin version string
 * - license: license identifier (e.g. "AGPL-3.0")
 * - compatibleVersions: compatible DSH version range / list
 * - onCheckUpdate: optional callback invoked when the user clicks
 *   "Check for updates"
 */
import { t } from './locales.ts'

export interface AboutPanelProps {
  repositoryUrl: string
  version: string
  license: string
  compatibleVersions: string
  onCheckUpdate?: () => void
  starUrl?: string
}

export function AboutPanel({ repositoryUrl, version, license, compatibleVersions, onCheckUpdate, starUrl }: AboutPanelProps) {
  return (
    <div className="dsh-plugin-about-panel" role="region" aria-label={t('about.panelLabel')}>
      <div className="dsh-plugin-about-header">
        <a
          className="dsh-plugin-about-repo-link"
          href={repositoryUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('about.repository')} {repositoryUrl}
        </a>
      </div>

      <div className="dsh-plugin-about-details">
        <div className="dsh-plugin-about-row">
          <span className="dsh-plugin-about-label">{t('about.version')}:</span>
          <span className="dsh-plugin-about-value">{version}</span>
        </div>
        <div className="dsh-plugin-about-row">
          <span className="dsh-plugin-about-label">{t('about.license')}:</span>
          <span className="dsh-plugin-about-value">{license}</span>
        </div>
        <div className="dsh-plugin-about-row">
          <span className="dsh-plugin-about-label">{t('about.compatibleVersions')}:</span>
          <span className="dsh-plugin-about-value">{compatibleVersions}</span>
        </div>
      </div>

      {starUrl !== undefined && (
        <p className="dsh-plugin-about-support">
          {t('about.support')}{' '}
          <a href={starUrl} target="_blank" rel="noopener noreferrer">
            {t('about.star')}
          </a>{' '}
          <svg className="dsh-plugin-about-star-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m12 2.7 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.3l6.3-.9L12 2.7Z" />
          </svg>
        </p>
      )}

      {onCheckUpdate && (
        <button
          className="dsh-plugin-about-check-update"
          onClick={onCheckUpdate}
        >
          {t('about.checkUpdate')}
        </button>
      )}
    </div>
  )
}