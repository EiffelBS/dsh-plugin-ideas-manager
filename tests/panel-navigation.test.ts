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
  it('reaches the layout the way every shipped panel does: ctx.get("layout")', () => {
    // The live bug: the layout is a cordis SERVICE. A `ctx.layout` property read
    // throws, so a resolver built on it returned undefined and every redirect
    // button silently did nothing. The task-board, skill-explorer and ssh
    // shortcuts all go through the service accessor.
    const selectPanel = vi.fn()
    const get = vi.fn((name: string) => (name === 'layout' ? { selectPanel } : undefined))
    const navigator = resolvePanelNavigator({ get })
    expect(get).toHaveBeenCalledWith('layout')
    navigator?.select(IDEAS_PANEL_ID)
    navigator?.select(null)
    expect(selectPanel.mock.calls).toEqual([['ideas'], [null]])
  })

  it('prefers the service accessor over a property that would throw', () => {
    const selectPanel = vi.fn()
    const ctx = { get: () => ({ selectPanel }) }
    Object.defineProperty(ctx, 'layout', {
      get() { throw new Error('cannot get property without inject') },
    })
    resolvePanelNavigator(ctx)?.select(IDEAS_PANEL_ID)
    expect(selectPanel).toHaveBeenCalledWith('ideas')
  })

  it('still accepts a context whose layout really is a property', () => {
    const selectPanel = vi.fn()
    resolvePanelNavigator({ layout: { selectPanel } })?.select(IDEAS_PANEL_ID)
    expect(selectPanel).toHaveBeenCalledWith('ideas')
  })

  it('is undefined when the layout read throws (cordis undeclared access)', () => {
    const ctx = {}
    Object.defineProperty(ctx, 'layout', {
      get() { throw new Error('cannot get property without inject') },
    })
    expect(resolvePanelNavigator(ctx)).toBeUndefined()
    expect(resolvePanelNavigator({ get: () => { throw new Error('no such service') } })).toBeUndefined()
  })

  it('is undefined when no layout is reachable at all', () => {
    expect(resolvePanelNavigator({})).toBeUndefined()
    expect(resolvePanelNavigator({ layout: undefined })).toBeUndefined()
    expect(resolvePanelNavigator({ layout: 'nope' })).toBeUndefined()
    expect(resolvePanelNavigator({ get: () => undefined })).toBeUndefined()
    expect(resolvePanelNavigator(null)).toBeUndefined()
    expect(resolvePanelNavigator('nope')).toBeUndefined()
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
})
