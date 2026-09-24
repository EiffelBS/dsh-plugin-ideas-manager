// @vitest-environment jsdom
/**
 * Unit tests for the reusable AboutPanel component.
 * Covers rendering of the standardized About section (repository URL,
 * version, license, DSH compatibility) and the update-button callback.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AboutPanel, type AboutPanelProps } from '../src/client/about-panel.tsx'
import { t } from '../src/client/locales.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function makeHost(): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return host
}

function makeProps(overrides: Partial<AboutPanelProps> = {}): AboutPanelProps {
  return {
    repositoryUrl: 'https://github.com/EiffelBS/dsh-plugin-ideas-manager',
    version: '0.5.0',
    license: 'MIT',
    compatibleVersions: '>=0.1.5-rc.1',
    onCheckUpdate: vi.fn(),
    ...overrides,
  }
}

function clickButton(): void {
  const button = host.querySelector('button')
  if (!button) throw new Error('no button found')
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

afterEach(() => {
  if (root) {
    act(() => { root.unmount() })
    root = undefined as unknown as Root
  }
  if (host) host.remove()
})

describe('AboutPanel', () => {
  it('renders all metadata fields and the repository link', () => {
    makeHost()
    act(() => { root.render(<AboutPanel {...makeProps()} />) })

    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(t('about.panelLabel'))
    expect(host.querySelector('.dsh-plugin-about-repo-link')?.textContent).toContain('Repository')
    expect(host.querySelector('.dsh-plugin-about-repo-link')?.textContent).toContain('https://github.com/EiffelBS/dsh-plugin-ideas-manager')
    expect(host.querySelector('.dsh-plugin-about-repo-link')?.getAttribute('href')).toBe('https://github.com/EiffelBS/dsh-plugin-ideas-manager')
    expect(host.querySelector('.dsh-plugin-about-repo-link')?.getAttribute('target')).toBe('_blank')
    expect(host.querySelector('.dsh-plugin-about-repo-link')?.getAttribute('rel')).toContain('noopener')
    expect(host.textContent).toContain(t('about.version'))
    expect(host.textContent).toContain('0.5.0')
    expect(host.textContent).toContain(t('about.license'))
    expect(host.textContent).toContain('MIT')
    expect(host.textContent).toContain(t('about.compatibleVersions'))
    expect(host.textContent).toContain('>=0.1.5-rc.1')
  })

  it('calls onCheckUpdate when the check-update button is clicked', () => {
    makeHost()
    const onCheckUpdate = vi.fn()
    act(() => { root.render(<AboutPanel {...makeProps({ onCheckUpdate })} />) })
    clickButton()
    expect(onCheckUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not render the update button when onCheckUpdate is omitted', () => {
    makeHost()
    act(() => { root.render(<AboutPanel {...makeProps({ onCheckUpdate: undefined })} />) })
    expect(host.querySelector('button')).toBeNull()
  })
})
