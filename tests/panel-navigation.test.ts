// @vitest-environment jsdom
/**
 * Panel navigation face tests.
 *
 * The whole point of resolving `ctx.layout` defensively is that a deployment
 * may not have it, and that `selectPanel` THROWS on an unregistered main key.
 * Both are the difference between "the button did nothing" and "the plugin
 * threw inside a click handler", so both are pinned here.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolvePanelNavigator, IDEAS_PANEL_ID, TASK_BOARD_PANEL_ID } from '../src/client/panel-navigation.ts'

describe('panel ids', () => {
  it('are the ones the shell and the task-board register', () => {
    // A renamed id silently produces a panel that never opens: the shell keys
    // the main slot by it, and the task-board 0.4.x const is 'task-board'.
    expect(IDEAS_PANEL_ID).toBe('ideas')
    expect(TASK_BOARD_PANEL_ID).toBe('task-board')
  })
})

describe('resolvePanelNavigator', () => {
  it('wraps a layout face and passes the selection through', () => {
    const selectPanel = vi.fn()
    const navigator = resolvePanelNavigator({ layout: { selectPanel } })
    expect(navigator).toBeDefined()
    navigator?.select(IDEAS_PANEL_ID)
    navigator?.select(null)
    expect(selectPanel.mock.calls).toEqual([['ideas'], [null]])
  })

  it('is undefined when the property read throws (cordis undeclared access)', () => {
    const ctx = {}
    Object.defineProperty(ctx, 'layout', {
      get() { throw new Error('cannot get property without inject') },
    })
    expect(resolvePanelNavigator(ctx)).toBeUndefined()
  })

  it('is undefined when layout is absent or is not a layout', () => {
    expect(resolvePanelNavigator({})).toBeUndefined()
    expect(resolvePanelNavigator({ layout: undefined })).toBeUndefined()
    expect(resolvePanelNavigator({ layout: {} })).toBeUndefined()
    expect(resolvePanelNavigator({ layout: 'nope' })).toBeUndefined()
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
})
