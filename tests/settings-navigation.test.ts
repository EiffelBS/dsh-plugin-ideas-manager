// @vitest-environment jsdom
/**
 * Settings gear navigation.
 *
 * The web shell paints a dialog trigger. The Desktop shell replaces that
 * button with an account menu whose Settings item opens the same dialog.
 * Host chrome is localized (eight languages since DSH 0.2), so the
 * language-free identities are pinned here too: the live settings shortcut's
 * aria string, the Desktop launcher's structural marker, and our own section
 * icon inside the nav row. A shell that matches nothing must warn and leave
 * the document alone.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { t } from '../src/client/locales.ts'
import {
  configureSettingsShortcut,
  openIdeasSettingsSection,
  readSettingsShortcutAria,
} from '../src/client/settings-navigation.ts'

afterEach(() => {
  document.body.innerHTML = ''
  // The shortcut reader is module scoped: clear it so one scenario cannot
  // decide the next one.
  configureSettingsShortcut(() => undefined)()
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

  it('accepts the French dialog trigger (host label, not ours)', async () => {
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-label', 'Paramètres')
    let rowClicks = 0
    trigger.addEventListener('click', () => {
      const mounted = mountIdeasDialog()
      mounted.row.addEventListener('click', () => { rowClicks += 1 })
    })
    document.body.appendChild(trigger)

    openIdeasSettingsSection()
    await new Promise(resolve => { setTimeout(resolve, 100) })

    expect(rowClicks).toBe(1)
  })

  it('opens Settings from the French account menu and selects Ideas', async () => {
    const account = document.createElement('button')
    account.type = 'button'
    account.setAttribute('aria-haspopup', 'menu')
    account.setAttribute('aria-label', 'Menu du compte')
    let itemClicks = 0
    account.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.textContent = 'ParamètresCtrl+,'
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

  it('identifies the dialog trigger by the live settings shortcut, whatever its label', async () => {
    const dispose = configureSettingsShortcut(() => 'Control+,')
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'dialog')
    // A language this plugin has no copy for: only the structural attribute
    // can identify the button.
    trigger.setAttribute('aria-label', 'Réglages système')
    trigger.setAttribute('aria-keyshortcuts', 'Control+,')
    let rowClicks = 0
    trigger.addEventListener('click', () => {
      const mounted = mountIdeasDialog()
      mounted.row.addEventListener('click', () => { rowClicks += 1 })
    })
    document.body.appendChild(trigger)

    openIdeasSettingsSection()
    await new Promise(resolve => { setTimeout(resolve, 100) })

    expect(rowClicks).toBe(1)
    dispose()
  })

  it('identifies the account-menu Settings item by the shortcut when its text is unknown', async () => {
    const dispose = configureSettingsShortcut(() => 'Control+,')
    const account = document.createElement('button')
    account.type = 'button'
    account.setAttribute('aria-haspopup', 'menu')
    // The Desktop launcher's structural identity: a DOM fact, not copy.
    account.setAttribute('data-signed-out', 'true')
    let contactClicks = 0
    let itemClicks = 0
    account.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      const contact = document.createElement('button')
      contact.type = 'button'
      contact.setAttribute('role', 'menuitem')
      contact.textContent = 'Contact'
      contact.addEventListener('click', () => { contactClicks += 1 })
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute('aria-keyshortcuts', 'Control+,')
      item.textContent = 'Réglages'
      item.addEventListener('click', () => {
        itemClicks += 1
        mountIdeasDialog()
      })
      menu.append(contact, item)
      document.body.appendChild(menu)
    })
    document.body.appendChild(account)

    openIdeasSettingsSection()
    await new Promise(resolve => { setTimeout(resolve, 100) })

    expect(itemClicks).toBe(1)
    expect(contactClicks).toBe(0)
    dispose()
  })

  it('selects our row through the registered settings icon, not its label', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = document.createElement('nav')
    const row = document.createElement('button')
    row.type = 'button'
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('data-dsh-ideas-settings-icon', '')
    row.append(icon, document.createTextNode('Un libellé inconnu'))
    let clicks = 0
    row.addEventListener('click', () => { clicks += 1 })
    nav.appendChild(row)
    dialog.appendChild(nav)
    document.body.appendChild(dialog)

    openIdeasSettingsSection()
    expect(clicks).toBe(1)
  })

  it('reads the settings shortcut aria from a context and survives a refusing one', () => {
    const face = {
      get: () => ({
        catalog: {
          getSnapshot: () => [
            { id: 'some.other', aria: 'Control+K' },
            { id: 'settings.open', aria: 'Control+,' },
          ],
        },
      }),
    }
    expect(readSettingsShortcutAria(face)).toBe('Control+,')
    const throwing = {
      get(): never { throw new Error('cannot get property "shortcuts" without inject') },
    }
    expect(readSettingsShortcutAria(throwing)).toBeUndefined()
    expect(readSettingsShortcutAria(undefined)).toBeUndefined()
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
