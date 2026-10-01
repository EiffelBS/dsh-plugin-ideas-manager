// @vitest-environment jsdom
/**
 * TaskBoard redirect tests.
 *
 * The redirect is the only recovery a launch refusal has (the permission gate
 * is lifted by a human, in the board, by hand), so the two halves are pinned:
 * the panel IS selected, and the board's own filter ends up holding the idea
 * title - through the native value setter and a bubbling input event, because
 * a plain assignment is invisible to React and the next re-render wipes it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBoardFilter, openTaskBoardFiltered } from '../src/client/taskboard-focus.ts'
import { type PanelNavigator } from '../src/client/panel-navigation.ts'

/** The board's own panel wrapper, with the filter field it renders inside. */
function mountBoardPanel(): HTMLInputElement {
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-taskboard-view', '')
  const input = document.createElement('input')
  input.type = 'search'
  panel.appendChild(input)
  document.body.appendChild(panel)
  return input
}

function navigator(): { face: PanelNavigator; selected: Array<string | null> } {
  const selected: Array<string | null> = []
  return { face: { select: (id) => { selected.push(id) } }, selected }
}

beforeEach(() => {
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.useRealTimers()
})

describe('applyBoardFilter', () => {
  it('writes the title and fires a bubbling input event', () => {
    const input = mountBoardPanel()
    const seen: string[] = []
    document.addEventListener('input', (event) => { seen.push((event.target as HTMLInputElement).value) })

    expect(applyBoardFilter('Idea #51 - Karaoke')).toBe(true)
    expect(input.value).toBe('Idea #51 - Karaoke')
    // React's onChange is driven by this event; without it the field would only
    // look filled until the next board re-render.
    expect(seen).toEqual(['Idea #51 - Karaoke'])
  })

  it('reports false when the board is not mounted', () => {
    expect(applyBoardFilter('Idea #51')).toBe(false)
    // A search field outside the board panel is NOT the board's: the lookup is
    // scoped, so an unrelated input is never hijacked.
    const stray = document.createElement('input')
    stray.type = 'search'
    document.body.appendChild(stray)
    expect(applyBoardFilter('Idea #51')).toBe(false)
    expect(stray.value).toBe('')
  })
})

describe('openTaskBoardFiltered', () => {
  it('selects the board panel and filters it straight away when it is open', () => {
    const input = mountBoardPanel()
    const { face, selected } = navigator()
    expect(openTaskBoardFiltered(face, 'Idea #51 - Karaoke')).toBe(true)
    expect(selected).toEqual(['task-board'])
    expect(input.value).toBe('Idea #51 - Karaoke')
  })

  it('retries until the panel has mounted, then writes once', () => {
    vi.useFakeTimers()
    const { face, selected } = navigator()
    openTaskBoardFiltered(face, 'Idea #51', { attempts: 5, delayMs: 10 })
    // The panel is selected but React has not committed it yet.
    expect(selected).toEqual(['task-board'])
    const input = mountBoardPanel()
    vi.advanceTimersByTime(10)
    expect(input.value).toBe('Idea #51')
    // One write, not one per tick: the loop stops on the first success.
    vi.advanceTimersByTime(100)
    expect(input.value).toBe('Idea #51')
  })

  it('gives up quietly when the panel never appears', () => {
    vi.useFakeTimers()
    const { face, selected } = navigator()
    expect(openTaskBoardFiltered(face, 'Idea #51', { attempts: 3, delayMs: 10 })).toBe(true)
    vi.advanceTimersByTime(200)
    // The board is open and the message carries the title: the human types it.
    expect(selected).toEqual(['task-board'])
  })

  it('does nothing at all without a layout service or a sidebar row', () => {
    expect(openTaskBoardFiltered(undefined, 'Idea #51')).toBe(false)
  })

  it('clicks the sidebar row instead of the layout face when the row is mounted', () => {
    const input = mountBoardPanel()
    const { face, selected } = navigator()
    const row = document.createElement('button')
    row.type = 'button'
    let clicked = 0
    row.addEventListener('click', () => { clicked += 1 })
    const glyph = document.createElement('svg')
    glyph.setAttribute('data-dsh-panel-entry', 'task-board')
    row.appendChild(glyph)
    document.body.appendChild(row)

    expect(openTaskBoardFiltered(face, 'Idea #51 - Karaoke')).toBe(true)
    // The row is the shell's own selectPanel. A face that would refuse the id
    // must not be the path that runs.
    expect(clicked).toBe(1)
    expect(selected).toEqual([])
    expect(input.value).toBe('Idea #51 - Karaoke')
  })

  it('opens the board from the sidebar row when no layout service is reachable', () => {
    const row = document.createElement('button')
    row.type = 'button'
    let clicked = 0
    row.addEventListener('click', () => { clicked += 1 })
    const glyph = document.createElement('span')
    glyph.setAttribute('data-dsh-panel-entry', 'task-board')
    row.appendChild(glyph)
    document.body.appendChild(row)

    expect(openTaskBoardFiltered(undefined, 'Idea #51')).toBe(true)
    expect(clicked).toBe(1)
  })

  it('trims an empty filter into a plain panel switch', () => {
    const { face, selected } = navigator()
    expect(openTaskBoardFiltered(face, '   ')).toBe(true)
    expect(selected).toEqual(['task-board'])
  })
})
