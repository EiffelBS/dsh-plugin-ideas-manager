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
}

export function AboutPanel({ repositoryUrl, version, license, compatibleVersions, onCheckUpdate }: AboutPanelProps) {
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