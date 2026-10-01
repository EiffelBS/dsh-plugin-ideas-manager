// @vitest-environment jsdom
/**
 * Settings gear navigation.
 *
 * The web shell paints a dialog trigger. The Desktop shell replaces that
 * button with an account menu whose Settings item opens the same dialog.
 * Both must land on this plugin's nav row; a shell that matches neither
 * hook must warn and leave the document alone.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { t } from '../src/client/locales.ts'
import { openIdeasSettingsSection } from '../src/client/settings-navigation.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

/** An open settings dialog whose nav rail has one Ideas row. */
function mountIdeasDialog(): { row: HTMLButtonElement; clicks: () => number } {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const nav = document.createElement('nav')
  const row = document.createElement('button')
  row.type = 'button'
  row.textContent = t('settings.nav')
  let clicks = 0
  row.addEventListener('click', () => { clicks += 1 })
  nav.appendChild(row)
  dialog.appendChild(nav)
  document.body.appendChild(dialog)
  return { row, clicks: () => clicks }
}

describe('openIdeasSettingsSection', () => {
  it('clicks the Ideas row of a dialog that is already open', () => {
    const dialog = mountIdeasDialog()
    openIdeasSettingsSection()
    expect(dialog.clicks()).toBe(1)
  })

  it('opens the dialog trigger and selects Ideas once the dialog renders', async () => {
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-label', 'Settings')
    let opened = false
    let rowClicks = 0
    trigger.addEventListener('click', () => {
      opened = true
      requestAnimationFrame(() => {
        const mounted = mountIdeasDialog()
        mounted.row.addEventListener('click', () => { rowClicks += 1 })
      })
    })
    document.body.appendChild(trigger)

    openIdeasSettingsSection()
    await new Promise(resolve => { setTimeout(resolve, 100) })

    expect(opened).toBe(true)
    expect(rowClicks).toBe(1)
  })

  it('opens Settings from the Desktop account menu and selects Ideas', async () => {
    const account = document.createElement('button')
    account.type = 'button'
    account.setAttribute('aria-haspopup', 'menu')
    account.setAttribute('aria-label', 'Account menu')
    account.setAttribute('aria-expanded', 'false')
    let menuOpens = 0
    let itemClicks = 0
    let rowClicks = 0
    account.addEventListener('click', () => {
      menuOpens += 1
      account.setAttribute('aria-expanded', 'true')
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.textContent = 'Settings'
      item.addEventListener('click', () => {
        itemClicks += 1
        requestAnimationFrame(() => {
          const mounted = mountIdeasDialog()
          mounted.row.addEventListener('click', () => { rowClicks += 1 })
        })
      })
      menu.appendChild(item)
      document.body.appendChild(menu)
    })
    document.body.appendChild(account)
    // A different menu button must not be the launcher.
    const stray = document.createElement('button')
    stray.type = 'button'
    stray.setAttribute('aria-haspopup', 'menu')
    stray.setAttribute('aria-label', 'Model')
    let strayClicks = 0
    stray.addEventListener('click', () => { strayClicks += 1 })
    document.body.appendChild(stray)

    openIdeasSettingsSection()
    await new Promise(resolve => { setTimeout(resolve, 100) })

    expect(menuOpens).toBe(1)
    expect(itemClicks).toBe(1)
    expect(rowClicks).toBe(1)
    expect(strayClicks).toBe(0)
  })

  it('accepts the Chinese account menu and a shortcut suffix on the Settings item', async () => {
    const account = document.createElement('button')
    account.type = 'button'
    account.setAttribute('aria-haspopup', 'menu')
    account.setAttribute('aria-label', '账号菜单')
    let itemClicks = 0
    account.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.textContent = '设置Ctrl+,'
      item.addEventListener('click', () => {
        itemClicks += 1
        mountIdeasDialog()
      })
      menu.appendChild(item)
      document.body.appendChild(menu)
    })
    document.body.appendChild(account)

    openIdeasSettingsSection()
    await new Promise(resolve => { setTimeout(resolve, 100) })

    expect(itemClicks).toBe(1)
  })

  it('prefers the dialog trigger when both launchers are present', async () => {
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-label', '设置')
    let opened = false
    trigger.addEventListener('click', () => {
      opened = true
      mountIdeasDialog()
    })
    const account = document.createElement('button')
    account.type = 'button'
    account.setAttribute('aria-haspopup', 'menu')
    account.setAttribute('aria-label', 'Account menu')
    let menuOpens = 0
    account.addEventListener('click', () => { menuOpens += 1 })
    document.body.append(trigger, account)

    openIdeasSettingsSection()
    await new Promise(resolve => { setTimeout(resolve, 50) })

    expect(opened).toBe(true)
    expect(menuOpens).toBe(0)
  })

  it('warns and touches nothing when neither launcher exists', async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (message?: unknown) => { warnings.push(String(message)) }
    try {
      openIdeasSettingsSection()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    } finally {
      console.warn = original
    }
    expect(warnings.some(text => text.includes('settings trigger not found'))).toBe(true)
  })
})
