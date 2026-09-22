// @vitest-environment jsdom
/**
 * Idea #36: bounded, searchable shared tag filter.
 *
 * Pins the whole contract of the reworked row:
 *  - the chip zone is CSS-capped at ~3 rows with its own scrollbar, while the
 *    header (label + search + clear) stays outside the scroll container;
 *  - the chip search narrows the CHIPS only, case-insensitively, and never
 *    hides a SELECTED chip (an active filter must stay visible);
 *  - the clear button shows whenever either half of the filter is active
 *    (selection OR query) and resets BOTH halves;
 *  - the card search (board.search) and the tag search stay two distinct
 *    controls;
 *  - the row is shared by all three tabs, including the filtered-empty copy
 *    (board.emptyFiltered), and the chip set follows the workspace scope.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { filterKnownTags } from '../src/client/tags.ts'
import { classes, ensureIdeasStyle } from '../src/client/style.ts'
import { fr, en, t } from '../src/client/locales.ts'
import { IdeasBoard, TagFilterRow } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import type { IdeasSnapshot } from '../src/protocol.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'

// React 18 requires the act-environment flag in a plain jsdom setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* --- mount helpers -------------------------------------------------- */

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  // The active tab persists in localStorage; every test starts on Overview.
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

function mount(element: ReactElement): void {
  act(() => {
    root = createRoot(host)
    root.render(element)
  })
}

function click(target: Element): void {
  act(() => { (target as HTMLElement).click() })
}

/** Type into a controlled input (bypasses React's value tracker, the usual
 *  jsdom recipe: set through the prototype accessor, then fire `input`). */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Same recipe for a controlled select (`change` event). */
function selectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/* --- query helpers -------------------------------------------------- */

const row = (): Element | null => host.querySelector(`.${classes.tagFilterRow}`)
const header = (): Element | null => host.querySelector(`.${classes.tagFilterHeader}`)
const chipZone = (): Element | null => host.querySelector(`.${classes.tagFilterChips}`)
const tagSearch = (): HTMLInputElement => host.querySelector(`.${classes.tagFilterSearch}`) as HTMLInputElement
const chips = (): HTMLButtonElement[] => Array.from(chipZone()?.querySelectorAll('button') ?? [])
const chipNames = (): string[] => chips().map(button => button.textContent ?? '')
const noMatchHint = (): Element | null => host.querySelector(`.${classes.tagFilterNoMatch}`)
const clearButton = (): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find(button => button.textContent === t('board.tagFilterClear'))
const text = (): string => host.textContent ?? ''
const tabButton = (key: 'tab.overview' | 'tab.priorities' | 'tab.delivered'): HTMLButtonElement =>
  Array.from(host.querySelectorAll('[role="tab"]'))
    .find(button => (button.textContent ?? '').includes(t(key))) as HTMLButtonElement

/** Click one filter chip by its label; fails loudly when it is absent. */
function clickChip(name: string): void {
  const chip = chips().find(button => button.textContent === name)
  if (chip === undefined) throw new Error(`chip not rendered: ${name} (have: ${chipNames().join(', ')})`)
  click(chip)
}

/* --- fixtures ------------------------------------------------------- */

/** Row harness: the board's tagFilter state, simulated around the row. */
function RowHarness({ known, initial = [] }: { known: string[]; initial?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial)
  return (
    <TagFilterRow
      knownTags={known}
      selected={selected}
      onToggle={name => setSelected(current => current.includes(name)
        ? current.filter(entry => entry !== name)
        : [...current, name])}
      onClear={() => { setSelected([]) }}
    />
  )
}

function idea(partial: Partial<IdeaRecord> & { id: string; status: IdeaRecord['status'] }): IdeaRecord {
  return {
    title: partial.id,
    body: '',
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

/** Two open cards (alpha / beta tags) + one archived card (gamma tag):
 *  NO card carries both alpha and beta, so selecting both empties the board
 *  through the conjunctive filter — the board.emptyFiltered path. */
function boardSnapshot(): IdeasSnapshot {
  return {
    schemaVersion: 1,
    revision: 7,
    ideas: [
      idea({ id: 'i1', title: 'Alpha idea', status: 'open', rank: 1, tags: [{ name: 'alpha' }, { name: 'cadence' }] }),
      idea({ id: 'i2', title: 'Beta idea', status: 'open', rank: 1, tags: [{ name: 'beta' }] }),
      idea({ id: 'i3', title: 'Gamma idea', status: 'archived', archivedAt: 10, tags: [{ name: 'gamma' }] }),
    ],
  }
}

/** Client over a static snapshot (no polling, no workspace registry). */
function makeClient(snapshot: IdeasSnapshot): IdeasClient {
  const transport: IdeasHostTransport = {
    state: async () => snapshot,
    action: async () => snapshot,
    subscribe: () => () => {},
  }
  const client = new IdeasClient(transport, undefined)
  client.snapshot = snapshot
  return client
}

/* --- tests ---------------------------------------------------------- */

describe('filterKnownTags (pure chip search)', () => {
  it('returns every label for a blank query, in order', () => {
    expect(filterKnownTags(['drone', 'reaper'], [], '')).toEqual(['drone', 'reaper'])
    expect(filterKnownTags(['drone', 'reaper'], [], '   ')).toEqual(['drone', 'reaper'])
  })

  it('narrows case-insensitively on either side', () => {
    const known = ['Cadence', 'drone', 'REAPER']
    expect(filterKnownTags(known, [], 'cad')).toEqual(['Cadence'])
    expect(filterKnownTags(known, [], 'REAP')).toEqual(['REAPER'])
    expect(filterKnownTags(known, [], 'e')).toEqual(['Cadence', 'drone', 'REAPER'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterKnownTags(['drone', 'reaper'], [], 'zzz')).toEqual([])
  })

  it('keeps a selected chip visible when the query hides it', () => {
    expect(filterKnownTags(['drone', 'reaper'], ['drone'], 'reap')).toEqual(['reaper', 'drone'])
  })

  it('keeps a stale selected chip whose label left the ledger', () => {
    expect(filterKnownTags(['reaper'], ['ghost'], 'zzz')).toEqual(['ghost'])
    expect(filterKnownTags(['reaper'], ['ghost'], '')).toEqual(['reaper', 'ghost'])
  })

  it('never duplicates a selected chip that already matches', () => {
    expect(filterKnownTags(['drone'], ['drone'], 'dro')).toEqual(['drone'])
  })
})

describe('tag filter zone CSS bound', () => {
  it('caps the chip zone at ~3 rows with its own scrollbar', () => {
    ensureIdeasStyle()
    const style = document.querySelector('style[data-plugin-css="dsh-plugin-ideas-manager/style"]')
    expect(style).not.toBeNull()
    const css = style?.textContent ?? ''
    const zone = css.match(/\.dsh-ideas-tag-filter-chips\s*\{[^}]*\}/)?.[0] ?? ''
    expect(zone).toContain('calc(var(--dsh-ideas-tag-chip-rows, 3)')
    expect(zone).toContain('max-height:')
    expect(zone).toContain('!important')
    expect(zone).toContain('overflow-y: auto')
    expect(zone).toContain('flex-wrap: wrap')
    // Compact layout: the zone takes the rest of the header line (first chip
    // row shares it) and packs its lines at the top of the capped height.
    expect(zone).toContain('flex: 1 1 260px')
    expect(zone).toContain('min-width: 0')
    expect(zone).toContain('align-content: flex-start')
  })

  it('keeps the header as its own non-scrolling column left of the chips', () => {
    ensureIdeasStyle()
    const css = document.querySelector('style[data-plugin-css="dsh-plugin-ideas-manager/style"]')?.textContent ?? ''
    const shell = css.match(/\.dsh-ideas-tag-filter-row\s*\{[^}]*\}/)?.[0] ?? ''
    const head = css.match(/\.dsh-ideas-tag-filter-header\s*\{[^}]*\}/)?.[0] ?? ''
    // Inline two-column row (wraps under narrow panels), header never shrinks.
    expect(shell).toContain('flex-direction: row')
    expect(shell).toContain('flex-wrap: wrap')
    expect(shell).toContain('align-items: flex-start')
    expect(head).toContain('flex: none')
    // The scroll container is the chips zone only: no overflow on the shell
    // or the header, so the clear button can never scroll out of view.
    expect(shell).not.toContain('overflow')
    expect(head).not.toContain('overflow')
  })
})

describe('TagFilterRow behaviour', () => {
  it('renders the always-visible header (label + search) with all chips and no clear yet', () => {
    mount(<RowHarness known={['Cadence', 'drone', 'Reaper']} />)
    expect(row()).not.toBeNull()
    expect(header()).not.toBeNull()
    expect(header()?.textContent).toContain(t('board.tagFilter'))
    expect(tagSearch().placeholder).toBe(t('board.tagFilterSearch'))
    expect(tagSearch().getAttribute('aria-label')).toBe(t('board.tagFilterSearch'))
    expect(chipNames()).toEqual(['Cadence', 'drone', 'Reaper'])
    expect(clearButton()).toBeUndefined()
    expect(noMatchHint()).toBeNull()
  })

  it('narrows the chips case-insensitively and offers the clear for the query alone', () => {
    mount(<RowHarness known={['Cadence', 'drone', 'Reaper']} />)
    type(tagSearch(), 'CAD')
    expect(chipNames()).toEqual(['Cadence'])
    expect(clearButton()).toBeDefined()
    type(tagSearch(), 'reap')
    expect(chipNames()).toEqual(['Reaper'])
  })

  it('explains a zero-match query with the no-match hint instead of a blank zone', () => {
    mount(<RowHarness known={['Cadence', 'drone']} />)
    type(tagSearch(), 'zzz')
    expect(chipNames()).toEqual([])
    expect(noMatchHint()?.textContent).toBe(t('board.tagFilterNoMatch'))
    // The reset stays reachable even with nothing selected.
    expect(clearButton()).toBeDefined()
  })

  it('keeps a selected chip visible (and pressed) when the query hides it', () => {
    mount(<RowHarness known={['Cadence', 'drone', 'Reaper']} />)
    clickChip('drone')
    expect(chips().find(button => button.textContent === 'drone')?.getAttribute('aria-pressed')).toBe('true')
    type(tagSearch(), 'reap')
    expect(chipNames()).toEqual(['Reaper', 'drone'])
    const active = chips().find(button => button.textContent === 'drone')
    expect(active?.getAttribute('aria-pressed')).toBe('true')
    expect(noMatchHint()).toBeNull()
    expect(clearButton()).toBeDefined()
  })

  it('clear resets BOTH halves: the query and the selection', () => {
    mount(<RowHarness known={['Cadence', 'drone', 'Reaper']} />)
    clickChip('Cadence')
    type(tagSearch(), 'zzz')
    // Selection-only view: the query matched nothing, the active chip stays.
    expect(chipNames()).toEqual(['Cadence'])
    click(clearButton() as HTMLButtonElement)
    expect(tagSearch().value).toBe('')
    expect(chipNames()).toEqual(['Cadence', 'drone', 'Reaper'])
    expect(chips().every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(clearButton()).toBeUndefined()
  })

  it('ships the new copy keys in both locales', () => {
    for (const key of ['board.tagFilterSearch', 'board.tagFilterNoMatch'] as const) {
      expect(typeof fr[key]).toBe('string')
      expect(typeof en[key]).toBe('string')
      expect(fr[key]).not.toBe('')
      expect(en[key]).not.toBe('')
    }
  })
})

describe('shared row across the three tabs (board integration)', () => {
  it('keeps the row + reset on every tab and shows the filtered-empty copy', () => {
    mount(<IdeasBoard client={makeClient(boardSnapshot())} />)
    expect(row()).not.toBeNull()
    // Distinct controls: the card search (Overview) vs the tag search.
    const cardSearch = host.querySelector(`.${classes.search}`) as HTMLInputElement
    expect(cardSearch).not.toBeNull()
    expect(cardSearch.getAttribute('aria-label')).toBe(t('board.search'))
    expect(tagSearch().getAttribute('aria-label')).toBe(t('board.tagFilterSearch'))
    expect(cardSearch.getAttribute('aria-label')).not.toBe(tagSearch().getAttribute('aria-label'))

    // Conjunctive filter with no matching card: every column explains itself.
    clickChip('alpha')
    clickChip('beta')
    expect(text()).toContain(t('board.emptyFiltered'))
    expect(text()).not.toContain(t('board.empty'))

    // Priorities: same shared row (query included), filtered-empty ranking.
    type(tagSearch(), 'cad')
    click(tabButton('tab.priorities'))
    expect(row()).not.toBeNull()
    expect(tagSearch().value).toBe('cad')
    expect(chipNames()).toEqual(['cadence', 'alpha', 'beta'])
    expect(text()).toContain(t('priorities.empty'))

    // Delivered: same row again; the reset works from here.
    click(tabButton('tab.delivered'))
    expect(row()).not.toBeNull()
    expect(chipNames()).toEqual(['cadence', 'alpha', 'beta'])
    expect(text()).toContain(t('delivered.empty'))
    click(clearButton() as HTMLButtonElement)
    expect(tagSearch().value).toBe('')
    expect(chipNames()).toEqual(['alpha', 'beta', 'cadence', 'gamma'])
    expect(text()).toContain('Gamma idea')

    // Back to Overview with the filter cleared: cards render, plain empties.
    click(tabButton('tab.overview'))
    expect(row()).not.toBeNull()
    expect(text()).toContain('Alpha idea')
    expect(text()).toContain('Beta idea')
    expect(text()).not.toContain(t('board.emptyFiltered'))
    expect(text()).toContain(t('board.empty'))
  })

  it('scopes the chip set to the workspace scope, keeping an out-of-scope selection visible', () => {
    const snapshot: IdeasSnapshot = {
      schemaVersion: 1,
      revision: 1,
      ideas: [
        idea({ id: 'i1', status: 'open', workspaceId: 'ws1', tags: [{ name: 'alpha' }] }),
        idea({ id: 'i2', status: 'open', workspaceId: 'ws2', tags: [{ name: 'beta' }, { name: 'zeta' }] }),
      ],
    }
    mount(<IdeasBoard client={makeClient(snapshot)} />)
    // Scope '': the full ledger union.
    expect(chipNames()).toEqual(['alpha', 'beta', 'zeta'])

    // Select beta, then scope the board to ws1: only ws1 labels remain
    // offerable, but the selected out-of-scope chip stays visible.
    clickChip('beta')
    const scope = host.querySelector(`.${classes.workspaceSelect}`) as HTMLSelectElement
    selectValue(scope, 'ws1')
    expect(chipNames()).toEqual(['alpha', 'beta'])
    expect(chips().find(button => button.textContent === 'beta')?.getAttribute('aria-pressed')).toBe('true')
    expect(clearButton()).toBeDefined()
  })
})
