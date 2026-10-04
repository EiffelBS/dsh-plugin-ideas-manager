// @vitest-environment jsdom
/**
 * Deep-link to an idea: the board as the consumer.
 *
 * The client test pins the handshake; this one pins what the panel actually
 * DOES with it, because that is where a deep-link is either a link or a no-op:
 *
 *  - the card is FOCUSED (painted with the focus affordance and scrolled into
 *    view), not merely mentioned;
 *  - it is reachable ACROSS WORKSPACES and through an active search, because
 *    the number is the stable human reference and a card the filters hide is not
 *    a destination;
 *  - an archived or declined idea lands too, and a declined one under the
 *    "hide Declined column" setting says exactly where it is instead of doing
 *    nothing;
 *  - a reference the board cannot disprove yet is left PENDING, never refused;
 *  - the marker is the reader's to drop: narrowing the board clears it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasListSnapshot,
  type IdeasReadQuery,
  type IdeasReadSnapshot,
} from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Row = IdeasListSnapshot['ideas'][number]

function row(id: string, ideaNumber: number, workspaceId: string | undefined, status: Row['status']): Row {
  return {
    id,
    title: `Idea ${ideaNumber}`,
    status,
    rank: ideaNumber,
    ideaNumber,
    bodyExcerpt: `Body of idea ${ideaNumber}`,
    createdAt: 1,
    updatedAt: 2,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  }
}

const BOARD: Row[] = [
  row('open-a', 1, 'ws-a', 'open'),
  row('open-b', 2, 'ws-b', 'open'),
  row('review', 3, 'ws-a', 'underReview'),
  row('archived', 4, 'ws-a', 'archived'),
  row('declined', 5, 'ws-b', 'declined'),
  row('generic', 6, undefined, 'open'),
]

function listOf(ideas: readonly Row[], revision = 1): IdeasListSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision, ideas: [...ideas] }
}

/**
 * A transport whose board can move under the client: `state` can be made to
 * fail (a board that cannot answer yet) and `read` adopts whatever the Host
 * holds, exactly like a capture landing while the panel was closed.
 */
class FakeTransport implements IdeasHostTransport {
  hosted: Row[]
  revision = 1
  offline = false
  /** The queries the cold path issued, in order. */
  readQueries: IdeasReadQuery[] = []

  constructor(hosted: Row[] = BOARD) {
    this.hosted = hosted
  }

  async state(): Promise<IdeasListSnapshot> {
    if (this.offline) throw new Error('offline')
    return listOf(this.hosted, this.revision)
  }

  async action(): Promise<IdeasListSnapshot> { return listOf(this.hosted, this.revision) }

  async read(query: IdeasReadQuery): Promise<IdeasReadSnapshot> {
    this.readQueries.push(query)
    this.revision += 1
    // The Host really FILTERS: a bounded read answers the question it was asked,
    // it does not hand the whole board back.
    const matched = this.hosted.filter(idea =>
      (query.numbers === undefined || (idea.ideaNumber !== undefined && query.numbers.includes(idea.ideaNumber)))
      && (query.ids === undefined || query.ids.includes(idea.id)))
    return {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: this.revision,
      ideas: matched.slice(0, query.limit ?? matched.length),
      meta: {
        view: 'summary', fields: [], bodyLimitBytes: 0, limit: 1, offset: 0,
        matched: matched.length, returned: matched.length, rowTruncated: false, nextOffset: null,
        bodyTruncated: false, omittedFields: [],
      },
    }
  }

  subscribe(): () => void { return () => {} }
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient
/** Every element the board asked to scroll, in order. */
let scrolled: Element[]

/**
 * Type into a React-controlled input.
 *
 * The native prototype setter, then a bubbling `input` event: a plain
 * `element.value = …` is swallowed by React's value tracker, which is exactly
 * why the TaskBoard redirect had to reach for the setter.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter !== undefined) setter.call(input, value)
  else input.value = value
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function selectIn(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
  scrolled = []
  // jsdom has no layout and no scrollIntoView; the board guards the call, and a
  // stub is what lets the test assert the card was actually brought into view.
  ;(Element.prototype as unknown as { scrollIntoView?: (options?: unknown) => void }).scrollIntoView =
    function scrollIntoView(this: Element): void { scrolled.push(this) }
})

afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  host.remove()
  document.body.innerHTML = ''
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
})

/** Mount the board over a client that already holds `snapshot`. */
async function mount(clientToMount: IdeasClient): Promise<void> {
  client = clientToMount
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
}

async function renderBoard(hosted: Row[] = BOARD): Promise<FakeTransport> {
  const transport = new FakeTransport(hosted)
  const created = new IdeasClient(transport, undefined)
  created.snapshot = listOf(hosted)
  await mount(created)
  return transport
}

/** Ask for a card and let the board answer. */
async function focus(ref: string): Promise<void> {
  act(() => { client.requestFocus(ref) })
  // The client resolves through a promise; the panel answers in its wake.
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const focusedCard = (): Element | null => host.querySelector('[data-dsh-ideas-focused]')
const focusedId = (): string | null => focusedCard()?.getAttribute('data-dsh-idea-id') ?? null
const scope = (): HTMLSelectElement => host.querySelector('.dsh-ideas-workspace-select') as HTMLSelectElement
const search = (): HTMLInputElement => host.querySelector('.dsh-ideas-search') as HTMLInputElement
const note = (): string | null => host.querySelector('[data-dsh-ideas-focus-note]')?.textContent ?? null

describe('the jump box', () => {
  it('focuses the card a number names, and scrolls it into view', async () => {
    await renderBoard()
    typeInto(host.querySelector('[data-dsh-ideas-jump-input]') as HTMLInputElement, '#1')
    click(host.querySelector('[data-dsh-ideas-jump]') as HTMLButtonElement)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(focusedId()).toBe('open-a')
    expect(client.focusResult?.outcome).toBe('focused')
    // "In view" is part of the contract, not a nicety: a card forty rows down an
    // unscrolled column is not where the link landed.
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0]?.getAttribute('data-dsh-idea-id')).toBe('open-a')
  })

  it('is disabled while the reference is empty', async () => {
    await renderBoard()
    const go = host.querySelector('[data-dsh-ideas-jump]') as HTMLButtonElement
    expect(go.disabled).toBe(true)
    typeInto(host.querySelector('[data-dsh-ideas-jump-input]') as HTMLInputElement, '  ')
    expect((host.querySelector('[data-dsh-ideas-jump]') as HTMLButtonElement).disabled).toBe(true)
    typeInto(host.querySelector('[data-dsh-ideas-jump-input]') as HTMLInputElement, '#1')
    expect((host.querySelector('[data-dsh-ideas-jump]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('accepts a bare id too, and names a reference nothing matches', async () => {
    await renderBoard()
    await focus('open-b')
    expect(focusedId()).toBe('open-b')

    await focus('#404')
    expect(focusedId()).toBeNull()
    expect(note()).toContain('#404')
  })
})

describe('focusing across the board', () => {
  it('lands on a card in ANOTHER workspace than the current scope', async () => {
    await renderBoard()
    selectIn(scope(), 'ws-a')
    expect(scope().value).toBe('ws-a')

    await focus('#2')
    // The card is there, focused, and the scope followed it: "all the places
    // this number could be" is never the reader's problem.
    expect(focusedId()).toBe('open-b')
    expect(scope().value).toBe('ws-b')
  })

  it('clears an active search that would hide the card', async () => {
    await renderBoard()
    typeInto(search(), 'nothing matches this')
    expect(host.textContent).toContain('No ideas match the filter')

    await focus('#1')
    expect(search().value).toBe('')
    expect(focusedId()).toBe('open-a')
    expect(note()).toBeNull()
  })

  it('scopes to the "no workspace" group for an idea that has none', async () => {
    await renderBoard()
    await focus('#6')
    expect(focusedId()).toBe('generic')
    expect(scope().value).toBe('__no-workspace__')
  })

  it('lands on an archived card, a review-gate card and a declined one', async () => {
    await renderBoard()
    for (const [ref, id] of [['#4', 'archived'], ['#3', 'review'], ['#5', 'declined']] as const) {
      await focus(ref)
      expect(focusedId()).toBe(id)
      expect(note()).toBeNull()
    }
  })

  it('switches back to the Overview tab, where every status has a column', async () => {
    await renderBoard()
    const tabs = host.querySelectorAll('[role="tab"]')
    click(tabs[1] as HTMLElement)
    expect(host.textContent).toContain('Priorities')

    await focus('#1')
    expect(host.textContent).toContain('Open')
    expect(focusedId()).toBe('open-a')
  })

  it('focuses from the Priorities tab, not only from the Overview', async () => {
    await renderBoard()
    click(host.querySelectorAll('[role="tab"]')[1] as HTMLElement)
    await focus('#1')
    // Priorities ranks the OPEN backlog of the current scope; the deep-link
    // brings back the tab that can actually show the card it found.
    expect(host.querySelector('.dsh-ideas-kanban-placeholder')).toBeNull()
    expect(focusedId()).toBe('open-a')
  })
})

describe('the focus is the reader\'s to drop', () => {
  it('clears as soon as the human narrows the board', async () => {
    await renderBoard()
    await focus('#1')
    expect(focusedId()).toBe('open-a')

    typeInto(search(), 'Idea 2')
    expect(focusedId()).toBeNull()
  })

  it('clears when the human scopes or switches tab', async () => {
    await renderBoard()
    await focus('#1')
    selectIn(scope(), '')
    expect(focusedId()).toBeNull()

    await focus('#1')
    click(host.querySelectorAll('[role="tab"]')[1] as HTMLElement)
    expect(focusedId()).toBeNull()
  })

  it('survives the 2.5 s poll tick that redraws the board', async () => {
    await renderBoard()
    await focus('#1')
    await act(async () => { await client.refresh() })
    expect(focusedId()).toBe('open-a')
  })
})

describe('a cold panel load', () => {
  it('answers nothing until the board has a list, then focuses', async () => {
    const transport = new FakeTransport()
    await mount(new IdeasClient(transport, undefined))
    // No snapshot at all: this is the panel's first paint, before the poll.
    expect(client.snapshot).toBeUndefined()

    act(() => { client.requestFocus('#1') })
    // Pending, not refused: the reference has not been disproved yet.
    expect(client.focusRequest).toEqual({ ref: '#1', seq: 1 })
    expect(client.focusResult).toBeUndefined()

    await act(async () => { await client.refresh() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(client.focusResult?.outcome).toBe('focused')
    expect(focusedId()).toBe('open-a')
  })

  it('leaves a reference pending while the Host cannot answer, and lands it later', async () => {
    const transport = new FakeTransport()
    transport.offline = true
    await mount(new IdeasClient(transport, undefined))

    act(() => { client.requestFocus('#1') })
    await act(async () => { await client.refresh() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // A board that cannot see the Host cannot say "no such idea" either.
    expect(client.focusResult).toBeUndefined()
    expect(client.focusRequest).not.toBeUndefined()
    expect(note()).toBeNull()

    transport.offline = false
    await act(async () => { await client.refresh() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(client.focusResult?.outcome).toBe('focused')
    expect(focusedId()).toBe('open-a')
  })

  it('reads once through the bounded query when the board missed the capture', async () => {
    const transport = new FakeTransport([row('late', 9, 'ws-b', 'open')])
    const cold = new IdeasClient(transport, undefined)
    await act(async () => {
      expect(await cold.resolveFocus('#9')).toMatchObject({ id: 'late' })
    })
    expect(transport.readQueries).toEqual([{ view: 'summary', limit: 1, numbers: [9] }])
  })

  it('answers "not found" rather than hanging when nothing matches', async () => {
    await renderBoard([])
    await focus('#9')
    expect(client.focusResult?.outcome).toBe('unknown')
    expect(note()).toContain('#9')
  })
})

describe('a reference the board cannot land', () => {
  it('says where a declined idea is while its column is hidden', async () => {
    await renderBoard()
    // The setting is read from the client config, the same path the settings
    // section writes through.
    client.config = { ...client.config, value: { ...client.config.value, hideDeclinedColumn: true } }
    act(() => { root?.render(<IdeasBoard client={client} />) })

    await focus('#5')
    // An absent card is never reported as a focus.
    expect(client.focusResult?.outcome).toBe('hidden')
    expect(focusedId()).toBeNull()
    expect(note()).toContain('#5')

    // And the rest of the board keeps working: one unlandable link is not a
    // broken deep-link surface.
    await focus('#1')
    expect(focusedId()).toBe('open-a')
    expect(note()).toBeNull()
  })

  it('never throws on a reference that is not one', async () => {
    await renderBoard()
    await focus('   ')
    expect(client.focusResult?.outcome).toBe('unknown')
    expect(focusedId()).toBeNull()
  })
})

describe('scrolling', () => {
  it('is not re-run on every poll tick (it would fight the reader)', async () => {
    await renderBoard()
    await focus('#1')
    expect(scrolled).toHaveLength(1)
    await act(async () => { await client.refresh() })
    await act(async () => { await client.refresh() })
    expect(scrolled).toHaveLength(1)
  })

  it('survives a DOM with no scrollIntoView at all', async () => {
    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    await renderBoard()
    await focus('#1')
    expect(focusedId()).toBe('open-a')
  })
})

describe('no route, no URL', () => {
  it('focuses without ever touching the location', async () => {
    const before = `${window.location.href}${window.location.search}${window.location.hash}`
    await renderBoard()
    await focus('#1')
    expect(`${window.location.href}${window.location.search}${window.location.hash}`).toBe(before)
  })
})
