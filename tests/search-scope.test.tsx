// @vitest-environment jsdom
/**
 * Shared header search across all three tabs (follow-up to idea
 * #34): the "Filter ideas..." input used to render on the Overview tab only
 * ("the search box is kanban-only"). It now narrows the kanban columns, the
 * Priorities ranking and the Delivered log alike, like the tag chips always
 * did. This suite locks that scope: the input exists on every tab and the
 * active text filter reaches every list.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasEventPayload,
  type IdeasListSnapshot,
} from '../src/protocol.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Two open cards + one delivered archive, titles chosen per assertion. */
function fixture(): IdeasListSnapshot {
  const base = { createdAt: 1, updatedAt: 100, workspaceId: 'ws1' }
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { ...base, id: 'open-alpha', title: 'Alpha opener', status: 'open', rank: 1, bodyExcerpt: 'first open card' },
      { ...base, id: 'open-beta', title: 'Beta opener', status: 'open', rank: 2, bodyExcerpt: 'second open card' },
      { ...base, id: 'gamma-log', title: 'Gamma log entry', status: 'archived', rank: 1, archivedAt: 50, deliveredAt: 60, bodyExcerpt: 'archived card' },
    ],
  }
}

/** Static list transport (no optional capabilities: the deep index must
 *  degrade silently while the excerpt-level filter still works). */
class StaticTransport implements IdeasHostTransport {
  constructor(private readonly list: IdeasListSnapshot) {}
  async state(): Promise<IdeasListSnapshot> { return this.list }
  async action(): Promise<IdeasListSnapshot> { return this.list }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
}

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
})
afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  host.remove()
})

async function renderBoard(): Promise<void> {
  const client = new IdeasClient(new StaticTransport(fixture()), undefined)
  client.snapshot = fixture()
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
}

/** Set an input through the prototype setter (bypasses the React value
 *  tracker) and fire the bubbling input event the listener reads. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function searchInput(): HTMLInputElement | null {
  return host.querySelector<HTMLInputElement>('header input[type="search"]')
}

function tabButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')) as HTMLButtonElement[]
}

/** Distinct idea ids currently mounted (kanban cards and Priorities rows
 *  carry the attribute; the Delivered log rows do not - see below). */
function mountedIds(): string[] {
  const ids = new Set<string>()
  for (const el of host.querySelectorAll('[data-dsh-idea-id]')) {
    const id = el.getAttribute('data-dsh-idea-id')
    if (id !== null) ids.add(id)
  }
  return [...ids].sort()
}

/** Titles of the Delivered log rows (its <li> rows carry no idea-id attr). */
function deliveredRowTitles(): string[] {
  return Array.from(host.querySelectorAll('[data-dsh-ideas-delivered] li'))
    .map(row => (row.textContent ?? '').trim())
}

describe('header search across tabs', () => {
  it('renders the filter input on every tab', async () => {
    await renderBoard()
    expect(searchInput()).not.toBeNull()
    await act(async () => { tabButtons()[1]!.click() })
    expect(searchInput(), 'search input missing on Priorities').not.toBeNull()
    await act(async () => { tabButtons()[2]!.click() })
    expect(searchInput(), 'search input missing on Delivered').not.toBeNull()
    await act(async () => { tabButtons()[0]!.click() })
    expect(searchInput(), 'search input missing back on Overview').not.toBeNull()
  })

  it('the active text filter narrows all three lists', async () => {
    await renderBoard()
    // Unfiltered: both columns lists and tabs show their rows.
    expect(mountedIds()).toEqual(['gamma-log', 'open-alpha', 'open-beta'])

    // Overview: the text filter narrows the columns.
    await act(async () => { typeInto(searchInput()!, 'alpha') })
    expect(mountedIds()).toEqual(['open-alpha'])

    // Priorities: same input, same active filter - only the matching open
    // row survives (archived cards were never part of the ranking).
    await act(async () => { tabButtons()[1]!.click() })
    expect(mountedIds()).toEqual(['open-alpha'])

    // Delivered: 'alpha' matches no archive -> empty log; 'gamma' matches it.
    await act(async () => { tabButtons()[2]!.click() })
    expect(deliveredRowTitles()).toEqual([])
    await act(async () => { typeInto(searchInput()!, 'gamma') })
    expect(deliveredRowTitles()).toHaveLength(1)
    expect(deliveredRowTitles()[0]).toContain('Gamma log entry')

    // Clearing restores the full log.
    await act(async () => { typeInto(searchInput()!, '') })
    expect(deliveredRowTitles()).toHaveLength(1)
    expect(deliveredRowTitles()[0]).toContain('Gamma log entry')

    // And Priorities comes back complete once the filter is gone.
    await act(async () => { tabButtons()[1]!.click() })
    expect(mountedIds()).toEqual(['open-alpha', 'open-beta'])
  })
})
