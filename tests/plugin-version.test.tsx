// @vitest-environment jsdom
/**
 * The version the About tab prints must be the version of the package.
 *
 * The section used to carry a hand-written literal that drifted at every
 * release: the published 0.7.6 announced itself as 0.5.0 in the settings panel,
 * and that literal was the only place the number appeared. The version is now
 * injected from package.json at build time, and these tests hold that line — the
 * injected constant, the shipped bundle and the DOM all carry one number, the
 * package's.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AboutPanel } from '../src/client/about-panel.tsx'
import { t } from '../src/client/locales.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fromRepoRoot = (...relative: string[]): string =>
  readFileSync(join(process.cwd(), ...relative), 'utf8')
const pkg = JSON.parse(fromRepoRoot('package.json')) as { version: string }

/**
 * Evaluate the settings section the way a bundle does: the version arrives as
 * the build-time constant __IDEAS_PLUGIN_VERSION__, which tsdown inlines from
 * package.json (tsdown.config.ts). A module registry reset keeps each import a
 * fresh evaluation, so one import sees the constant and the next does not.
 */
async function importSection(version?: string): Promise<typeof import('../src/client/settings-section.tsx')> {
  vi.resetModules()
  if (version === undefined) vi.unstubAllGlobals()
  else vi.stubGlobal('__IDEAS_PLUGIN_VERSION__', version)
  return import('../src/client/settings-section.tsx')
}

let host: HTMLDivElement | undefined
let root: Root | undefined

afterEach(() => {
  const mounted = root
  if (mounted) {
    act(() => { mounted.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  vi.unstubAllGlobals()
})

describe('the About tab version', () => {
  it('takes the version the build stamped into it', async () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
    const section = await importSection(pkg.version)
    expect(section.PLUGIN_METADATA.version).toBe(pkg.version)
  })

  it('stays importable without a bundler, marked as unreleased rather than lying', async () => {
    const section = await importSection()
    expect(section.PLUGIN_METADATA.version).toBe('unreleased')
  })

  it('is spelled out nowhere in the section source', () => {
    // A regex, not a copy of the current number: any hand-written version in
    // the section fails this the day it is added.
    expect(fromRepoRoot('src', 'client', 'settings-section.tsx'))
      .not.toMatch(/version:\s*['"]\d+\.\d+\.\d+['"]/)
  })

  it('is stamped by the bundler from package.json', () => {
    // Guards the other half: the tsdown define can be deleted while the other
    // tests stay green, and the shipped panel then falls back to "unreleased"
    // with nothing failing.
    const config = fromRepoRoot('tsdown.config.ts')
    expect(config).toContain('__IDEAS_PLUGIN_VERSION__')
    expect(config).toContain("new URL('./package.json', import.meta.url)")
  })

  const built = join(process.cwd(), 'lib', 'client.js')
  if (!existsSync(built)) {
    it('skipped: run the build first (lib/client.js is absent)', () => {})
  } else {
    it('is the version the shipped browser bundle carries', () => {
      // The assertion that would have caught the live bug: the published 0.7.6
      // bundle printed 0.5.0 while its own package.json said 0.7.6.
      const stamped = /version:\s*"([^"]+)"/.exec(readFileSync(built, 'utf8'))?.[1]
      expect(stamped, 'lib/client.js carries no stamped version').toBe(pkg.version)
    })
  }

  it('reaches the value span of the version row', async () => {
    const { PLUGIN_METADATA } = await importSection(pkg.version)
    host = document.createElement('div')
    document.body.appendChild(host)
    const mounted = createRoot(host)
    root = mounted
    act(() => {
      mounted.render(
        <AboutPanel
          repositoryUrl={PLUGIN_METADATA.repositoryUrl}
          version={PLUGIN_METADATA.version}
          license={PLUGIN_METADATA.license}
          compatibleVersions={PLUGIN_METADATA.compatibleVersions}
        />,
      )
    })
    const row = Array.from(host.querySelectorAll('.dsh-plugin-about-row')).find((element) =>
      element.querySelector('.dsh-plugin-about-label')?.textContent?.startsWith(t('about.version')),
    )
    expect(row?.querySelector('.dsh-plugin-about-value')?.textContent).toBe(pkg.version)
  })
})