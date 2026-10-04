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
import { en, fr, t, zh } from '../src/client/locales.ts'

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
  /** Ids whose FULL record was fetched (the deferred-body path). */
  ideaReads: string[] = []
  constructor(readonly rows: readonly IdeaRecord[]) {}
  async state(): Promise<IdeasListSnapshot> { return listSnapshot(this.rows) }
  async action(action: IdeasAction): Promise<IdeasListSnapshot> {
    this.actions.push(action)
    return listSnapshot(this.rows)
  }
  async idea(id: string): Promise<IdeaRecord> {
    this.ideaReads.push(id)
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
 * fresh mount rather than a reassignment. The settings read is settled before
 * the test continues, exactly like the other board suites: a tab click lands on
 * a tree whose effects have already run.
 */
async function mount(rowsIn: readonly IdeaRecord[] = rows()): Promise<void> {
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
  await act(async () => { await client.loadConfig() })
}

beforeEach(async () => {
  localStorage.clear()
  await mount()
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

  it('renders no node at all for an idea that carries no relation', async () => {
    // `b` still names `a`, but `a` is not on this board: the chip is dropped
    // from the VIEW rather than printed as a bare id nobody can open.
    await mount([rows()[1]])
    expect(cardChips('b')).toEqual([])
    expect(host.querySelector('[data-dsh-ideas-relations]')).toBeNull()
  })

  it('folds the overflow into a counter instead of painting a wall of chips', async () => {
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
    await mount(many)
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

describe('the relation line on the list tabs', () => {
  /** Three open ideas plus one delivered, so both list tabs have a row to draw. */
  function listRows(): IdeaRecord[] {
    return [
      ...rows().map((row, index) => index === 0 ? { ...row, tags: [{ name: 'core' }] } : row),
      {
        id: 'd',
        title: 'Delta',
        body: 'body d',
        status: 'archived',
        ideaNumber: 4,
        createdAt: 4,
        updatedAt: 100,
        deliveredAt: 90,
        tags: [{ name: 'shipped' }],
      },
    ]
  }

  /** Switch to a tab by its position in the fixed tab set. */
  async function openTab(index: number): Promise<void> {
    click(Array.from(host.querySelectorAll('[role="tab"]'))[index] as HTMLElement)
    await settle()
  }

  /** The relation chips inside one view container, as `kind:glyph:#N`. */
  function chipsIn(container: string): string[] {
    const root = host.querySelector(container)
    if (root === null) return []
    return [...root.querySelectorAll('[data-dsh-ideas-relation]')].map(node => [
      node.getAttribute('data-dsh-ideas-relation'),
      node.querySelector('.dsh-ideas-relation-glyph')?.textContent,
      node.lastChild?.textContent,
    ].join(':'))
  }

  it('draws them on a Priorities row, which shows labels beside them', async () => {
    await mount(listRows())
    await openTab(1)
    expect(host.querySelector('[data-dsh-ideas-priorities]')).not.toBeNull()
    // The ranked row prints tags AND its relations: a list that shows one
    // without the other is the inconsistency this closes. Every row carries its
    // OWN line — Alpha's two, Beta's adjacency, Gamma's derived blocker — in
    // rank order, so a reader never has to open a card to learn what waits on it.
    expect(host.querySelector('[data-dsh-ideas-priorities] .dsh-ideas-tag')).not.toBeNull()
    expect(chipsIn('[data-dsh-ideas-priorities]')).toEqual([
      'relatesTo:↔:#2', 'blocks:→:#3',
      'relatesTo:↔:#1',
      'blockedBy:←:#1',
    ])
  })

  it('draws them on a Delivered row too', async () => {
    // `d` waits for nothing and nothing waits for it, so its row is quiet…
    await mount(listRows())
    await openTab(2)
    expect(host.querySelector('[data-dsh-ideas-delivered]')).not.toBeNull()
    expect(chipsIn('[data-dsh-ideas-delivered]')).toEqual([])

    // …and an archived row that DOES declare a relation prints it, exactly like
    // the Overview card would.
    const linked = listRows()
    linked[3] = { ...linked[3]!, blocks: ['a'] }
    await mount(linked)
    await openTab(2)
    expect(chipsIn('[data-dsh-ideas-delivered]')).toEqual(['blocks:→:#1'])
  })

  it('resolves a link to an idea OUTSIDE the current scope, never a bare id', async () => {
    // The Delivered tab shows only archived rows, so an edge from `d` to the
    // OPEN idea `a` can only be resolved from the board's whole snapshot. A
    // view that resolved from its own rows would print a bare id here.
    const linked = listRows()
    linked[3] = { ...linked[3]!, relatesTo: ['a'] }
    await mount(linked)
    await openTab(2)
    expect(chipsIn('[data-dsh-ideas-delivered]')).toEqual(['relatesTo:↔:#1'])
  })
})

describe('the relation copy is in the STORAGE voice', () => {
  /** The three shipped dictionaries, widened so a key can be named as a string. */
  const dictionaries: ReadonlyArray<Record<string, string>> = [fr, en, zh]

  it('says one sentence about one edge, whichever card you read it from', () => {
    // `A.blocks = [B]` means A blocks B. Read on A the chip names B, read on B
    // the locked chip names A — and both sentences must place the OTHER card as
    // the subject of "cannot land before this one". The shipped copy put the
    // editor row in the opposite voice ("Waits for" / "Doit attendre"), so a card
    // that blocked #48 read "Waits for: #48 — Cannot land before #48": the
    // inverse of the edge, in every language, on the very row that writes it.
    for (const dictionary of dictionaries) {
      expect(dictionary['relations.blocksHint']).toBe(dictionary['relations.blockedByHint'])
      expect(dictionary['relations.blocksHint'].startsWith('{target}')).toBe(true)
      // The two rows must not collapse into one label either: `Blocks` names
      // what this card does, `Waiting for this idea` what others await from it.
      expect(dictionary['relations.blocks']).not.toBe(dictionary['relations.blockedBy'])
    }
  })

  it('pins the row label to the direction it writes', () => {
    // The hints above prove the SENTENCE; this proves the LABEL. There is no
    // language-independent way to test "is this word the blocker or the
    // waiting one", so the three shipped labels are pinned as they stand: the
    // label is the only thing a reader sees without hovering, and swapping it
    // back to "Waits for" / "Doit attendre" / 等待 is exactly the defect this
    // suite was written for.
    expect([
      fr['relations.blocks'],
      en['relations.blocks'],
      zh['relations.blocks'],
    ]).toEqual(['Bloque', 'Blocks', '阻塞'])
    // And the waiting voice stays on the read-only row, for the other readers.
    expect(fr['relations.blockedBy']).not.toBe(fr['relations.blocks'])
    expect(en['relations.blockedBy']).not.toBe(en['relations.blocks'])
    expect(zh['relations.blockedBy']).not.toBe(zh['relations.blocks'])
  })

  it('never renders an uninterpolated placeholder in a relation string', () => {
    const substituted = [
      'relations.removeRelated', 'relations.removeBlocked',
      'relations.relatesToHint', 'relations.blocksHint', 'relations.blockedByHint',
    ]
    for (const dictionary of dictionaries) {
      for (const key of substituted) {
        expect(dictionary[key].replace('{target}', '#3 Gamma'), `${key}`).not.toMatch(/\{/)
      }
      // Rendered with NO params under the locked row, so asking for one prints a
      // literal `{target}` in the interface — which is what it used to do.
      expect(dictionary['relations.blockedByExplained']).not.toMatch(/\{/)
    }
  })

  it('labels the editable row with the direction it actually writes', async () => {
    await openEditor('a')
    // The row whose picker writes `blocks` must carry the `blocks` label. Finding
    // it BY its placeholder is what makes this test fail loudly if the two rows
    // are ever swapped.
    const picker = host.querySelector(`[aria-label="${t('relations.addBlocked')}"]`)
    expect(picker).not.toBeNull()
    const row = picker!.closest('.dsh-ideas-relation-row')!
    expect(row.firstElementChild!.textContent).toBe(t('relations.blocks'))
  })

  it('tells the reader the same thing on both cards of the edge', async () => {
    // The arrow chip on `a` (which blocks `c`) and the locked chip on `c`.
    const arrow = host.querySelector('[data-dsh-ideas-relation="blocks"]')!.getAttribute('title')
    expect(arrow).toBe(t('relations.blocksHint', { target: '#3 Gamma' }))
    await openEditor('c')
    const locked = host.querySelector('[data-dsh-ideas-relation-locked="a"]')!.getAttribute('title')
    expect(locked).toBe(t('relations.blockedByHint', { target: '#1 Alpha' }))
  })
})

describe('a dependency the ranking contradicts', () => {
  /** The same edge as `rows()`, with the two ranks swapped: `c` now sits above
   *  the `a` that blocks it. That is the whole defect: a stated dependency the
   *  backlog schedules the wrong way round. */
  function contradicted(): IdeaRecord[] {
    return rows().map(row => {
      if (row.id === 'a') return { ...row, rank: 3 }
      if (row.id === 'c') return { ...row, rank: 1 }
      return row
    })
  }

  it('flags the BLOCKED card, and only that one, with the reason in its tooltip', async () => {
    await mount(contradicted())

    // `c` waits for `a` and is scheduled above it: its locked chip is marked and
    // its sentence says so.
    const flagged = host.querySelector('[data-dsh-ideas-relation-conflict="a"]')
    expect(flagged).not.toBeNull()
    expect(flagged!.getAttribute('data-dsh-ideas-relation')).toBe('blockedBy')
    expect(flagged!.getAttribute('title')).toBe(t('relations.blockedByRankConflict', { target: '#1 Alpha' }))
    expect(flagged!.className).toContain('dsh-ideas-relation-chip-conflict')

    // `a`'s own `blocks` chip is NOT marked: the relation is fine, the ORDER is
    // what is being reported, and marking both cards would double the alarm for
    // one contradiction.
    expect(host.querySelector('[data-dsh-ideas-relation-conflict="c"]')).toBeNull()
    const arrow = host.querySelector('[data-dsh-ideas-relation="blocks"]')!
    expect(arrow.getAttribute('title')).toBe(t('relations.blocksHint', { target: '#3 Gamma' }))
  })

  it('says nothing when the dependency is scheduled the right way round', async () => {
    // The default fixture ranks the blocker ABOVE the blocked card, which is the
    // order the edge asks for. Silence is the healthy state — a flag that is on
    // permanently teaches the reader to ignore it.
    await mount()
    expect(host.querySelector('[data-dsh-ideas-relation-conflict]')).toBeNull()
    expect(host.querySelector('[data-dsh-ideas-relation="blockedBy"]')!.getAttribute('title'))
      .toBe(t('relations.blockedByHint', { target: '#1 Alpha' }))
  })

  it('marks the same contradiction in the card editor', async () => {
    await mount(contradicted())
    await openEditor('c')
    const locked = host.querySelector('[data-dsh-ideas-relation-locked="a"]')!
    expect(locked.getAttribute('title')).toBe(t('relations.blockedByRankConflict', { target: '#1 Alpha' }))
    expect(locked.className).toContain('dsh-ideas-relation-chip-conflict')
  })

  it('gives each kind its own hue, so a busy card separates at a glance', async () => {
    // Colour is a SECOND channel: the glyphs (↔ / → / ←) and the editor's
    // labels already carry the meaning, which is what keeps the board readable
    // for a reader who cannot separate these hues at all.
    await mount()
    const hueOf = (kind: string): string | undefined =>
      host.querySelector(`[data-dsh-ideas-relation="${kind}"]`)?.className
    expect(hueOf('relatesTo')).toContain('dsh-ideas-relation-chip-relates-to')
    expect(hueOf('blocks')).toContain('dsh-ideas-relation-chip-blocks')
    expect(hueOf('blockedBy')).toContain('dsh-ideas-relation-chip-blocked-by')
    // The three are genuinely different classes, not one default hue.
    const classes = ['relates-to', 'blocks', 'blocked-by'].map(suffix => `dsh-ideas-relation-chip-${suffix}`)
    expect(new Set(classes).size).toBe(3)

    // The contradiction is a RING, not a recolour: the chip's hue already says
    // which edge this is, and what is being reported is the order.
    await mount(contradicted())
    const flagged = host.querySelector('[data-dsh-ideas-relation-conflict]')!
    expect(flagged.className).toContain('dsh-ideas-relation-chip-conflict')
    expect(flagged.className).toContain('dsh-ideas-relation-chip-blocked-by')
  })

  it('opens the idea a chip names, not the card the chip sits on', async () => {
    await openEditor('c')
    // `c` waits for `a`. Clicking that chip must open A's editor: the chip is the
    // only way out of a number the board prints, and it must point away from the
    // card being read. Queried AFTER the modal opened — a node captured before a
    // re-render is detached, and a detached node proves nothing when clicked.
    const chip = host.querySelector('[data-dsh-idea-id="c"] [data-dsh-ideas-relation-open="a"]')
    expect(chip).not.toBeNull()
    expect(chip!.tagName).toBe('BUTTON')
    await act(async () => { click(chip as HTMLElement); await settle() })

    const title = (host.querySelector('#dsh-ideas-title') as HTMLInputElement | null)?.value
    expect(title).toBe('Alpha')
    // And it is a real fetch, not a half record: the editor's fields are the
    // full ones (transport.idea answers a per-id record).
    expect(transport.ideaReads).toContain('a')
  })

  it('leaves the editor\'s own chips inert', async () => {
    // Inside the editor the chips belong to a form: a click there that opened
    // another modal would throw away the edits in progress. Scoped to the editor
    // on purpose — the board keeps painting behind the overlay, so an unscoped
    // query would find the CARDS' chips and prove nothing.
    await openEditor('a')
    expect(host.querySelector('[data-dsh-ideas-relations-editor] [data-dsh-ideas-relation-open]')).toBeNull()
  })

  it('says the same thing in the three shipped languages', () => {
    const dictionaries: ReadonlyArray<Record<string, string>> = [fr, en, zh]
    for (const dictionary of dictionaries) {
      const sentence = dictionary['relations.blockedByRankConflict'].replace('{target}', '#1 Alpha')
      // The conflict sentence must keep the plain one intact inside it, or the
      // reader loses the edge itself and is left with a bare warning.
      expect(sentence, dictionary['relations.blockedByRankConflict']).toContain(dictionary['relations.blockedByHint'].replace('{target}', '#1 Alpha'))
      expect(sentence).not.toMatch(/\{/)
      expect(sentence).not.toBe(dictionary['relations.blockedByHint'].replace('{target}', '#1 Alpha'))
    }
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
