// @vitest-environment jsdom
/**
 * Panel navigation face tests.
 *
 * Two things have to hold at once. The deployment may serve no layout, and
 * `selectPanel` THROWS on an unregistered main key — so the call must degrade to
 * "the button did nothing" rather than take the plugin down. And the layout may
 * arrive LATE: `ctx.get(name)` answers `undefined` until the layout's fiber is
 * active, which it only becomes once the shell's theme, locale and shortcuts are
 * up. A navigator resolved once at `apply` therefore cached "no layout" on a
 * healthy page and the button stayed dead for the whole session — silently, with
 * a green suite, because every fake in this file used to answer on the spot.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolvePanelNavigator, IDEAS_PANEL_ID, TASK_BOARD_PANEL_ID } from '../src/client/panel-navigation.ts'

/** A layout face whose selection is readable, like the shipped one. */
function layoutFace() {
  const state = { activePanelId: null as string | null }
  const selectPanel = vi.fn((panelId: string | null) => { state.activePanelId = panelId })
  return {
    state,
    selectPanel,
    face: { selectPanel, panelInfo: { getSnapshot: () => ({ ...state }) } },
  }
}

describe('panel ids', () => {
  it('are the ones the shell and the task-board register', () => {
    // A renamed id silently produces a panel that never opens: the shell keys
    // the main slot by it, and the task-board 0.4.x const is 'task-board'.
    expect(IDEAS_PANEL_ID).toBe('ideas')
    expect(TASK_BOARD_PANEL_ID).toBe('task-board')
  })
})

describe('resolvePanelNavigator', () => {
  it('reaches the layout the way every shipped panel does: ctx.get("layout")', () => {
    // The live bug: the layout is a cordis SERVICE. A `ctx.layout` property read
    // throws, so a resolver built on it returned undefined and every redirect
    // button silently did nothing. The task-board, skill-explorer and ssh
    // shortcuts all go through the service accessor.
    const { face, selectPanel } = layoutFace()
    const get = vi.fn((name: string) => (name === 'layout' ? face : undefined))
    const navigator = resolvePanelNavigator({ get })
    navigator?.select(IDEAS_PANEL_ID)
    navigator?.select(null)
    expect(get).toHaveBeenCalledWith('layout')
    expect(selectPanel.mock.calls).toEqual([['ideas'], [null]])
  })

  it('prefers the service accessor over a property that would throw', () => {
    const { face, selectPanel } = layoutFace()
    const ctx = { get: () => face }
    Object.defineProperty(ctx, 'layout', {
      get() { throw new Error('cannot get property without inject') },
    })
    resolvePanelNavigator(ctx)?.select(IDEAS_PANEL_ID)
    expect(selectPanel).toHaveBeenCalledWith('ideas')
  })

  it('still accepts a context whose layout really is a property', () => {
    const { face, selectPanel } = layoutFace()
    resolvePanelNavigator({ layout: face })?.select(IDEAS_PANEL_ID)
    expect(selectPanel).toHaveBeenCalledWith('ideas')
  })

  it('picks up a layout that appears AFTER the navigator was built', () => {
    // THE regression. `ctx.get` answers `undefined` until the layout's own fiber
    // is active, and this plugin's `inject` is satisfied long before the shell's
    // theme/locale/shortcuts are — so the layout really does land after mount.
    // Resolving once at `apply` froze the "no layout" verdict for the session and
    // the back button never came back to life.
    const { face, selectPanel } = layoutFace()
    let live: typeof face | undefined
    const navigator = resolvePanelNavigator({ get: () => live })
    expect(navigator).toBeDefined()
    navigator?.select(null)
    expect(selectPanel).not.toHaveBeenCalled()
    live = face
    navigator?.select(null)
    expect(selectPanel).toHaveBeenCalledWith(null)
  })

  it('warns once when no layout is reachable, so the dead click is diagnosable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const navigator = resolvePanelNavigator({ get: () => undefined })
    navigator?.select(null)
    navigator?.select(IDEAS_PANEL_ID)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('no layout service on this page')
    warn.mockRestore()
  })

  it('warns when the layout took the call but the column did not move', () => {
    // The other dead click, which a "did it throw?" check cannot see: the call
    // is accepted and the selection is unchanged. Naming the panel it is still
    // showing is what makes that one actionable.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const selectPanel = vi.fn()
    const navigator = resolvePanelNavigator({
      get: () => ({ selectPanel, panelInfo: { getSnapshot: () => ({ activePanelId: 'ideas' }) } }),
    })
    navigator?.select(null)
    expect(selectPanel).toHaveBeenCalledWith(null)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not change the selected panel')
    warn.mockRestore()
  })

  it('stays silent when the selection did take effect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { face } = layoutFace()
    const navigator = resolvePanelNavigator({ get: () => face })
    navigator?.select(TASK_BOARD_PANEL_ID)
    navigator?.select(null)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('tolerates a face that cannot select, instead of throwing in the click', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A cordis service proxy does not always expose the method as a property.
    expect(() => { resolvePanelNavigator({ layout: {} })?.select('task-board') }).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows a refusal instead of letting it escape into the click', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const navigator = resolvePanelNavigator({
      layout: { selectPanel: () => { throw new Error('unregistered main key') } },
    })
    expect(() => { navigator?.select('does-not-exist') }).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is undefined only for something that is not a context at all', () => {
    expect(resolvePanelNavigator(null)).toBeUndefined()
    expect(resolvePanelNavigator('nope')).toBeUndefined()
    expect(resolvePanelNavigator(42)).toBeUndefined()
    // A context that serves no layout still gets a navigator: the absence is
    // answered at click time, not cached at mount.
    expect(resolvePanelNavigator({})).toBeDefined()
    expect(resolvePanelNavigator({ layout: undefined })).toBeDefined()
    expect(resolvePanelNavigator({ layout: 'nope' })).toBeDefined()
    expect(resolvePanelNavigator({ get: () => { throw new Error('no such service') } })).toBeDefined()
  })
})