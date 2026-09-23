// @vitest-environment jsdom
/**
 * Deferred-body board behaviour (idea #34) in jsdom:
 *  - list surfaces render the EXCERPT only (full analyses never mount);
 *  - opening the edit modal fetches the whole record first (and a failed
 *    fetch surfaces in the error bar instead of editing a truncated body);
 *  - an active search loads the deep index once and matches whole bodies;
 *  - a rank reorder REUSES the card DOM nodes (keyed reconciliation) - the
 *    spec's "reuse DOM nodes/views during sorting, no full rebuild".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  toListSnapshot,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type IdeasSnapshot,
} from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEEP_NEEDLE = 'zdeepz'
/** Body filler long enough that the excerpt window (280 chars) ends BEFORE
 *  the deep marker - so a marker match can only come from the whole body. */
const FILLER = 'Filler words about the ledger kanban render payload. '.repeat(9)

/** Three open cards whose FULL bodies carry a marker the excerpts do not. */
function fullFixture(): IdeasSnapshot {
  const base = {
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 100,
    workspaceId: 'ws1',
  }
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { ...base, id: 'a', title: 'Alpha card', body: `${FILLER}${DEEP_NEEDLE} tail`, rank: 1 },
      { ...base, id: 'b', title: 'Beta card', body: `${FILLER}beta tail`, rank: 2 },
      { ...base, id: 'c', title: 'Gamma card', body: `${FILLER}gamma tail`, rank: 3 },
    ] as IdeaRecord[],
  }
}

class BoardTransport implements IdeasHostTransport {
  revision = 1
  failIdea = false
  stateFullCalls = 0
  ideaCalls = 0
  ranks: Record<string, number> | undefined

  constructor(private readonly data: IdeasSnapshot) {}

  async state(): Promise<IdeasListSnapshot> {
    const projected = toListSnapshot(this.data)
    const rows = this.ranks === undefined
      ? projected.ideas
      : projected.ideas.map(idea => ({ ...idea, rank: this.ranks![idea.id] ?? idea.rank }))
    return { ...projected, revision: this.revision, ideas: rows }
  }

  async stateFull(): Promise<IdeasSnapshot> {
    this.stateFullCalls += 1
    return this.data
  }

  async action(): Promise<IdeasListSnapshot> {
    this.revision += 1
    return await this.state()
  }

  async idea(id: string): Promise<IdeaRecord> {
    this.ideaCalls += 1
    if (this.failIdea) throw new Error('boom')
    const found = this.data.ideas.find(record => record.id === id)
    if (found === undefined) throw new Error('not-found')
    return found
  }

  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void {
    return () => {}
  }
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient | undefined
let transport: BoardTransport

async function renderBoard(): Promise<void> {
  transport = new BoardTransport(fullFixture())
  client = new IdeasClient(transport, undefined)
  client.snapshot = await transport.state()
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client!} />)
  })
  await act(async () => {
    await client!.loadConfig()
  })
}

/** Flush promise chains + React effects (transport answers are microtasks). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function mountedIds(): string[] {
  const ids = new Set<string>()
  for (const el of host.querySelectorAll('[data-dsh-idea-id]')) {
    const id = el.getAttribute('data-dsh-idea-id')
    if (id !== null) ids.add(id)
  }
  return [...ids].sort()
}

/** Card wrappers of the first (open) column, in DOM order. The quick-add
 *  button sits above them, so filter on the idea attribute. */
function openColumnWrappers(): HTMLElement[] {
  const column = host.querySelectorAll('[data-dsh-column-scroll]')[0]!
  return Array.from(column.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-dsh-idea-id'),
  )
}

/** Set an input through the prototype setter (bypasses the React value
 *  tracker) and fire the bubbling input event the listener reads. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

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
  client?.dispose()
  client = undefined
  host.remove()
})

describe('list surfaces render the excerpt, never the full body', () => {
  it('mounts every card from the excerpt and keeps deep text off the board', async () => {
    // Sanity: the projection really does cut the marker out of the excerpt.
    const rows = toListSnapshot(fullFixture()).ideas
    expect(rows[0]!.bodyExcerpt).not.toContain(DEEP_NEEDLE)

    await renderBoard()
    expect(mountedIds()).toEqual(['a', 'b', 'c'])
    const text = host.textContent ?? ''
    expect(text).toContain('Filler words about the ledger')
    // The deep marker lives only in the FULL bodies - it must not mount.
    expect(text).not.toContain(DEEP_NEEDLE)
  })
})

describe('deferred body load', () => {
  it('fetches the whole record before opening the edit modal', async () => {
    await renderBoard()
    const title = host.querySelector('[data-dsh-idea-id="a"] [role="button"]') as HTMLElement
    expect(title).not.toBeNull()
    title.click()
    await flush()

    expect(transport.ideaCalls).toBe(1)
    // The edit modal opens on the rendered preview of the WHOLE body (not
    // the excerpt, not an empty textarea).
    const preview = host.querySelector('[data-dsh-ideas-preview]')
    expect(preview).not.toBeNull()
    expect(preview?.textContent ?? '').toContain(DEEP_NEEDLE)
    expect(preview?.textContent ?? '').toContain('Filler words about the ledger')
  })

  it('surfaces a failed fetch in the error bar and opens NO modal', async () => {
    await renderBoard()
    transport.failIdea = true
    const title = host.querySelector('[data-dsh-idea-id="a"] [role="button"]') as HTMLElement
    title.click()
    await flush()

    expect(host.querySelector('[data-dsh-ideas-preview]')).toBeNull()
    const errorText = Array.from(host.querySelectorAll('div'))
      .map(el => el.textContent ?? '')
      .find(text => text.includes('boom'))
    expect(errorText).toBeDefined()
  })
})

describe('deep search over whole bodies', () => {
  it('loads the index once on the first keystroke and matches deep text', async () => {
    await renderBoard()
    const search = host.querySelector<HTMLInputElement>('header input[type="search"]')
    expect(search).not.toBeNull()

    // The index loads on the first active keystroke (effects flushed) ...
    await act(async () => { typeInto(search!, DEEP_NEEDLE) })
    await flush()
    expect(transport.stateFullCalls).toBe(1)
    // ... and only card A's WHOLE body contains the marker.
    expect(mountedIds()).toEqual(['a'])

    // A second keystroke at the same revision reuses the loaded index.
    await act(async () => { typeInto(search!, `${DEEP_NEEDLE} tail`) })
    await flush()
    expect(transport.stateFullCalls).toBe(1)
    expect(mountedIds()).toEqual(['a'])

    // Clearing restores the full board.
    await act(async () => { typeInto(search!, '') })
    await flush()
    expect(mountedIds()).toEqual(['a', 'b', 'c'])
  })
})

describe('DOM reuse during sorting (keyed reconciliation)', () => {
  it('keeps the same card nodes across a rank reorder (move, not rebuild)', async () => {
    await renderBoard()
    const before = openColumnWrappers()
    expect(before.map(el => el.getAttribute('data-dsh-idea-id'))).toEqual(['a', 'b', 'c'])
    const wrapperA = before[0]!

    // Reorder: reverse the ranks (the board re-sorts by rank on emit).
    transport.ranks = { a: 3, b: 2, c: 1 }
    transport.revision = 2
    await act(async () => { await client!.refresh() })
    await flush()

    const after = openColumnWrappers()
    expect(after.map(el => el.getAttribute('data-dsh-idea-id'))).toEqual(['c', 'b', 'a'])
    // SAME DOM instance (React moved it) - no unmount/remount, no rebuild.
    expect(after[2]!.isSameNode(wrapperA)).toBe(true)
    expect(mountedIds()).toEqual(['a', 'b', 'c'])
  })
})
