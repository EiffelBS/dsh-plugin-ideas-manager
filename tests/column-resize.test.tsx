// @vitest-environment jsdom
/**
 * Per-column kanban width resize tests (idea #53): a resizer renders on every
 * visible column, a pointer drag resizes THAT column within the [min, max]
 * settings bounds and persists it to localStorage, and a double-click resets
 * the column to its default share. Stored widths render as pinned flex-basis;
 * an absent width keeps the pre-#53 equal-share layout (the defaults change
 * nothing).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { classes } from '../src/client/style.ts'
import { COLUMN_WIDTHS_STORAGE_KEY, readColumnWidths } from '../src/client/column-widths.ts'
import {
  IDEAS_SCHEMA_VERSION,
  IDEAS_SETTINGS_DEFAULTS,
  toListSnapshot,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSettingsView,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function idea(partial: Partial<IdeaRecord> & { id: string; status: IdeaRecord['status'] }): IdeaRecord {
  return { title: partial.id, body: '', createdAt: 1, updatedAt: 1, ...partial }
}

function testSnapshot(): IdeasSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      idea({ id: 'open-1', title: 'Open one', status: 'open', workspaceId: 'ws1' }),
      idea({ id: 'arch-1', title: 'Archived one', status: 'archived', workspaceId: 'ws1' }),
    ],
  }
}

class ConfigTransport implements IdeasHostTransport {
  loaded: IdeasSettingsView = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS }, revision: 1 }
  async state(): Promise<IdeasListSnapshot> { return toListSnapshot(testSnapshot()) }
  async action(_action: IdeasAction): Promise<IdeasListSnapshot> { return toListSnapshot(testSnapshot()) }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
  async config(): Promise<IdeasSettingsView> { return this.loaded }
  async saveConfig(patch: Record<string, unknown>): Promise<IdeasSettingsView> {
    this.loaded = { available: true, value: { ...this.loaded.value, ...patch } as IdeasSettingsView['value'], revision: (this.loaded.revision ?? 0) + 1 }
    return this.loaded
  }
}

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
})
afterEach(() => {
  const r = root // capture so the narrowing survives into the act() closure
  if (r !== undefined) act(() => { r.unmount() })
  root = undefined
  host.remove()
})

/** Mount the board with a snapshot, then settle the config load. */
async function renderBoard(transport: ConfigTransport): Promise<IdeasClient> {
  const client = new IdeasClient(transport, undefined)
  client.snapshot = toListSnapshot(testSnapshot())
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => {
    await client.loadConfig()
  })
  return client
}

const resizers = (): HTMLElement[] => Array.from(host.querySelectorAll(`.${classes.columnResizer}`)) as HTMLElement[]
/** The <section> column that owns a resizer (the resizer is its direct child). */
const columnOf = (resizer: HTMLElement): HTMLElement => resizer.parentElement as HTMLElement

/** jsdom has no global PointerEvent; a plain Event carrying clientX is enough. */
function pointerEvent(type: string, x: number): Event {
  const event = new Event(type, { bubbles: true })
  Object.assign(event, { clientX: x })
  return event
}

/** Drag a resizer from one X to another, flushing the rAF-scheduled width update. */
async function dragResizer(resizer: HTMLElement, fromX: number, toX: number): Promise<void> {
  await act(async () => {
    resizer.dispatchEvent(pointerEvent('pointerdown', fromX))
  })
  await act(async () => {
    window.dispatchEvent(pointerEvent('pointermove', toX))
    await new Promise(resolve => { requestAnimationFrame(() => resolve(undefined)) })
  })
  await act(async () => {
    window.dispatchEvent(pointerEvent('pointerup', toX))
  })
}

describe('per-column kanban width resize (idea #53)', () => {
  it('renders one resizer per visible column and pins nothing by default', async () => {
    await renderBoard(new ConfigTransport())
    // Four columns (open / under review / archived / declined) -> four resizers.
    expect(resizers()).toHaveLength(4)
    // No stored width yet: every column keeps the default flex share (no inline width).
    for (const column of host.querySelectorAll(`section.${classes.column}`)) {
      expect((column as HTMLElement).style.width).toBe('')
    }
  })

  it('resizes a column within the bounds and persists it to localStorage', async () => {
    await renderBoard(new ConfigTransport())
    const resizer = resizers()[0]! // the open column
    const column = columnOf(resizer)
    // jsdom has no layout: give the column a realistic starting width (300px).
    column.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 500, width: 300, height: 500 } as DOMRect)
    // Drag right by 100px -> 400px (inside the default [200, 922] bounds).
    await dragResizer(resizer, 300, 400)
    expect(column.style.width).toBe('400px')
    // A resized column overrides the CSS default max-width cap so it can honour
    // the wider columnMaxWidth setting (the default layout stays capped).
    expect(column.style.maxWidth).toBe('none')
    expect(readColumnWidths(localStorage)).toEqual({ open: 400 })
  })

  it('clamps a drag at the max bound', async () => {
    await renderBoard(new ConfigTransport())
    const resizer = resizers()[1]! // the under-review column
    const column = columnOf(resizer)
    column.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 500, width: 300, height: 500 } as DOMRect)
    // Drag far right -> would be 1000px, clamped to the 922 max.
    await dragResizer(resizer, 300, 1000)
    expect(column.style.width).toBe('922px')
    expect(readColumnWidths(localStorage)).toEqual({ underReview: 922 })
  })

  it('clamps a drag at the min bound', async () => {
    await renderBoard(new ConfigTransport())
    const resizer = resizers()[0]! // the open column
    const column = columnOf(resizer)
    column.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 500, width: 300, height: 500 } as DOMRect)
    // Drag far left -> would be 100px, clamped to the 200 min.
    await dragResizer(resizer, 300, 100)
    expect(column.style.width).toBe('200px')
    expect(readColumnWidths(localStorage)).toEqual({ open: 200 })
  })

  it('freezes the card container during a drag and releases it once on release', async () => {
    await renderBoard(new ConfigTransport())
    const resizer = resizers()[0]! // the open column
    const column = columnOf(resizer)
    const body = column.querySelector<HTMLElement>('[data-dsh-column-scroll]')!
    column.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 500, width: 300, height: 500 } as DOMRect)
    body.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 280, bottom: 500, width: 280, height: 500 } as DOMRect)
    // pointerdown freezes the body so its cards do not reflow while dragging.
    await act(async () => { resizer.dispatchEvent(pointerEvent('pointerdown', 300)) })
    expect(body.style.width).toBe('280px')
    // Completing the drag releases the freeze (one final reflow) and applies the width.
    await act(async () => { window.dispatchEvent(pointerEvent('pointermove', 400)); await new Promise(resolve => { requestAnimationFrame(() => resolve(undefined)) }) })
    await act(async () => { window.dispatchEvent(pointerEvent('pointerup', 400)) })
    expect(body.style.width).toBe('')
    expect(column.style.width).toBe('400px')
  })

  it('resets a column to the default share on double-click', async () => {
    await renderBoard(new ConfigTransport())
    const resizer = resizers()[0]! // the open column
    const column = columnOf(resizer)
    column.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 500, width: 300, height: 500 } as DOMRect)
    await dragResizer(resizer, 300, 400)
    expect(column.style.width).toBe('400px')
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(column.style.width).toBe('')
    expect(readColumnWidths(localStorage)).toEqual({})
  })

  it('re-applies a persisted width on mount (survives reload)', async () => {
    // Seed the persisted width as if a previous session had resized the column;
    // the board reads it from localStorage at mount and pins the flex-basis.
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify({ open: 480 }))
    await renderBoard(new ConfigTransport())
    const column = columnOf(resizers()[0]!)
    expect(column.style.width).toBe('480px')
  })

  it('hides the Declined resizer when that column is hidden', async () => {
    const transport = new ConfigTransport()
    transport.loaded = { available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, hideDeclinedColumn: true }, revision: 1 }
    await renderBoard(transport)
    // Three visible columns (open / under review / archived) -> three resizers.
    expect(resizers()).toHaveLength(3)
  })
})
