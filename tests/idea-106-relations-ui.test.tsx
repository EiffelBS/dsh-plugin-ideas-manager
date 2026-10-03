/**
 * Idea #106, part 2 — the relations SURFACES, rendered for real.
 *
 * The model, the wire and the reconciliation have their own suite. What is
 * proved here is the two things a reader would call broken if they were wrong:
 * a card draws its edges (and draws NOTHING for an idea that has none), and the
 * editor posts only the relation lists the human actually changed — over the
 * ordinary `update` verb, never a new one.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { IDEAS_SCHEMA_VERSION, type IdeasAction, type IdeasListSnapshot } from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'
import type { WorkspacesSource, WorkspaceViewLite } from '../src/client/workspaces.ts'
import {
  relationCandidates,
  relationIndexOf,
  relationListChanged,
  withRelation,
  withoutRelation,
} from '../src/client/relations.ts'

/** Three ideas; `a` is adjacent to `b` and waits for `c`, so `c` is blocked by `a`. */
function rows(): IdeaRecord[] {
  return [
    { id: 'a', title: 'Alpha', body: 'body a', status: 'open', ideaNumber: 1, rank: 1, createdAt: 1, updatedAt: 100, relatesTo: ['b'], blocks: ['c'] },
    { id: 'b', title: 'Beta', body: 'body b', status: 'open', ideaNumber: 2, rank: 2, createdAt: 2, updatedAt: 100, relatesTo: ['a'] },
    { id: 'c', title: 'Gamma', body: 'body c', status: 'open', ideaNumber: 3, rank: 3, createdAt: 3, updatedAt: 100 },
  ]
}

function listSnapshot(rowsIn: readonly IdeaRecord[]): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 7,
    ideas: rowsIn.map(row => ({
      ...row,
      bodyExcerpt: `${row.title} excerpt`,
    })) as unknown as IdeasListSnapshot['ideas'],
  }
}

class RelationsTransport implements IdeasHostTransport {
  actions: IdeasAction[] = []
  constructor(readonly rows: readonly IdeaRecord[]) {}
  async state(): Promise<IdeasListSnapshot> { return listSnapshot(this.rows) }
  async action(action: IdeasAction): Promise<IdeasListSnapshot> {
    this.actions.push(action)
    return listSnapshot(this.rows)
  }
  async idea(id: string): Promise<IdeaRecord> {
    const found = this.rows.find(row => row.id === id)
    if (found === undefined) throw new Error('not found')
    return found
  }
  subscribe(): () => void { return () => {} }
}

class StaticWorkspaces implements WorkspacesSource {
  list(): WorkspaceViewLite[] { return [{ workspaceId: 'ws-1', title: 'Alpha workspace' }] }
  subscribe(): () => void { return () => {} }
  dispose(): void {}
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient
let transport: RelationsTransport

/**
 * Mount a board over an explicit row set. The board copies the client snapshot
 * into its own state at mount (idea #34's poll), so a different row set means a
 * fresh mount rather than a reassignment.
 */
function mount(rowsIn: readonly IdeaRecord[] = rows()): void {
  act(() => { root?.unmount() })
  host = document.createElement('div')
  document.body.appendChild(host)
  transport = new RelationsTransport(rowsIn)
  client = new IdeasClient(transport, new StaticWorkspaces())
  client.snapshot = listSnapshot(rowsIn)
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
}

beforeEach(() => {
  localStorage.clear()
  mount()
})
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host?.remove()
})

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Pick an option the way a human would: set the value, then fire `change`. */
function select(element: HTMLSelectElement, value: string): void {
  act(() => {
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/**
 * The chips a card prints as `kind:glyph:label`. The arrow is part of the
 * contract — it is how the direction rule is legible without a tooltip — so the
 * assertion reads it rather than hiding it.
 */
function cardChips(ideaId: string): string[] {
  const card = host.querySelector(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-relations]`)
  if (card === null) return []
  return [...card.querySelectorAll('[data-dsh-ideas-relation]')].map(node => [
    node.getAttribute('data-dsh-ideas-relation'),
    node.querySelector('.dsh-ideas-relation-glyph')?.textContent,
    node.lastChild?.textContent,
  ].join(':'))
}

async function openEditor(ideaId: string): Promise<void> {
  const title = host.querySelector(`[data-dsh-idea-id="${ideaId}"] .dsh-ideas-card-title`) as HTMLElement | null
  expect(title).not.toBeNull()
  click(title as HTMLElement)
  await settle()
  expect(host.querySelector('[data-dsh-ideas-relations-editor]')).not.toBeNull()
}

/** The editor's own Save button — the header's "New idea" is a different one. */
function saveButton(): HTMLElement {
  const button = host.querySelector('.dsh-ideas-modal .dsh-ideas-primary-button') as HTMLElement
  expect(button).not.toBeNull()
  return button
}

describe('the card relation line', () => {
  it('draws each edge with its direction', () => {
    // ↔ related, → "waits for", ← "is waited for": the direction rule is
    // legible on the card itself, not only in a tooltip.
    expect(cardChips('a')).toEqual(['relatesTo:↔:#2', 'blocks:→:#3'])
    expect(cardChips('b')).toEqual(['relatesTo:↔:#1'])
    expect(cardChips('c')).toEqual(['blockedBy:←:#1'])
  })

  it('renders no node at all for an idea that carries no relation', () => {
    // `b` still names `a`, but `a` is not on this board: the chip is dropped
    // from the VIEW rather than printed as a bare id nobody can open.
    mount([rows()[1]])
    expect(cardChips('b')).toEqual([])
    expect(host.querySelector('[data-dsh-ideas-relations]')).toBeNull()
  })

  it('folds the overflow into a counter instead of painting a wall of chips', () => {
    const many: IdeaRecord[] = [
      { id: 'hub', title: 'Hub', body: '', status: 'open', ideaNumber: 1, createdAt: 1, updatedAt: 1, relatesTo: ['b', 'c', 'd', 'e', 'f'] },
      ...['b', 'c', 'd', 'e', 'f'].map((id, index) => ({
        id,
        title: id.toUpperCase(),
        body: '',
        status: 'open' as const,
        ideaNumber: index + 2,
        createdAt: index + 2,
        updatedAt: 1,
        relatesTo: ['hub'],
      })),
    ]
    mount(many)
    expect(cardChips('hub')).toHaveLength(3)
    expect(host.querySelector('[data-dsh-ideas-relations]')!.textContent).toContain('+2')
  })
})

describe('the editor relations section', () => {
  it('shows the two stated kinds editable and the derived one locked', async () => {
    await openEditor('c')
    // `c` is blocked by `a`, and that line carries no remove button: the edge
    // lives on the other card, and the editor names it instead of writing to a
    // row the human never opened.
    const locked = host.querySelector('[data-dsh-ideas-blocked-by] [data-dsh-ideas-relation-locked="a"]')
    expect(locked).not.toBeNull()
    expect(locked!.textContent).toContain('#1 Alpha')
    expect(locked!.querySelector('button')).toBeNull()
    const editor = host.querySelector('[data-dsh-ideas-relations-editor]')!
    expect(editor.textContent).toContain('Waiting for this idea')
    expect(editor.textContent).toMatch(/declared on the other card/)
  })

  it('adds a relation through the picker and posts it on the ordinary update', async () => {
    await openEditor('c')
    const pickers = host.querySelectorAll('[data-dsh-ideas-relation-add]')
    // Line 1 is "Related to", line 2 "Waits for"; neither may offer the row
    // itself, and neither may offer what the other line already names.
    expect([...(pickers[0] as HTMLSelectElement).options].map(option => option.value)).toEqual(['', 'a', 'b'])
    select(pickers[0] as HTMLSelectElement, 'b')
    expect(host.querySelectorAll('[data-dsh-ideas-relation-edit="b"]')).toHaveLength(1)
    // ...and it is gone from the OTHER line's picker: one idea, one statement.
    expect([...(pickers[1] as HTMLSelectElement).options].map(option => option.value)).toEqual(['', 'a'])

    click(saveButton())
    await settle()

    const update = transport.actions[0]
    expect(update?.kind).toBe('update')
    if (update?.kind !== 'update') throw new Error('expected an update')
    expect(update.patch.relatesTo).toEqual(['b'])
    // ...and nothing else: `blocks` was not touched, so it is not posted.
    expect('blocks' in update.patch).toBe(false)
  })

  it('removes a relation with the chip and clears the list on the wire', async () => {
    await openEditor('a')
    click(host.querySelector('[data-dsh-ideas-relation-edit="b"] button') as HTMLElement)
    expect(host.querySelector('[data-dsh-ideas-relation-edit="b"]')).toBeNull()

    click(saveButton())
    await settle()

    const update = transport.actions[0]
    if (update?.kind !== 'update') throw new Error('expected an update')
    // An empty list CLEARS (null on the wire), exactly like the label set.
    expect(update.patch.relatesTo).toBeNull()
  })

  it('posts nothing about relations when the human touched none', async () => {
    await openEditor('a')
    click(saveButton())
    await settle()
    const update = transport.actions[0]
    if (update?.kind !== 'update') throw new Error('expected an update')
    // An untouched edge must not spend a revision or an activity-log line.
    expect('relatesTo' in update.patch).toBe(false)
    expect('blocks' in update.patch).toBe(false)
  })
})

describe('the pure relation helpers', () => {
  it('derives both directions from the stored lists, once per paint', () => {
    const index = relationIndexOf(rows())
    expect(index.get('a')!.map(view => view.kind)).toEqual(['relatesTo', 'blocks'])
    expect(index.get('c')!.map(view => view.kind)).toEqual(['blockedBy'])
    // A row with no edge is absent from the index rather than mapped to [].
    const plain = rows().map(row => ({ ...row, relatesTo: undefined, blocks: undefined }))
    expect(relationIndexOf(plain).size).toBe(0)
  })

  it('offers only what a line can still add', () => {
    expect(relationCandidates(rows(), 'a', ['b']).map(candidate => candidate.id)).toEqual(['c'])
    // Self is never offered, even with nothing excluded.
    const offered = relationCandidates(rows(), 'a').map(candidate => candidate.id)
    expect(offered).toEqual(['b', 'c'])
    expect(offered).not.toContain('a')
  })

  it('compares lists by content, not by order', () => {
    expect(relationListChanged(['a'], ['a'])).toBe(false)
    expect(relationListChanged(['b', 'a'], ['a', 'b'])).toBe(false)
    expect(relationListChanged(['a'], ['a', 'b'])).toBe(true)
    expect(relationListChanged([], undefined)).toBe(false)
    expect(relationListChanged(['a'], undefined)).toBe(true)
  })

  it('keeps the ledger cap and refuses a repeat', () => {
    expect(withRelation(['a'], 'a')).toEqual(['a'])
    expect(withRelation(['a'], 'b')).toEqual(['a', 'b'])
    expect(withRelation(['a'], 'b', 1)).toEqual(['a'])
    expect(withoutRelation(['a', 'b'], 'b')).toEqual(['a'])
    expect(withoutRelation(['a'], 'z')).toEqual(['a'])
  })
})
