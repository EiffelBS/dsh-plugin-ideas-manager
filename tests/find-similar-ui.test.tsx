/**
 * the Find similar AFFORDANCE, rendered for real.
 *
 * The pure gate (`canFindSimilar`), the launch input and the prompt already
 * have unit coverage. What no suite proved is the wiring between them and the
 * board: that the button appears on exactly the cards it should, that opening
 * it asks the Host for the OPT-IN report (never the default snapshot), that the
 * candidates reach the analyst, and that the whole thing collapses quietly on
 * an older Host that answers without a report.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import { IDEAS_SCHEMA_VERSION, type IdeasListSnapshot, type IdeasReadQuery, type IdeasReadSnapshot } from '../src/protocol.ts'
import type { IdeaSimilarReport } from '../src/core/ideas.ts'
import type { FindSimilarInput, SessionLauncher } from '../src/client/session-queue.ts'
import type { WorkspacesSource, WorkspaceViewLite } from '../src/client/workspaces.ts'

function snapshot(): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { id: 'eligible', title: 'Add tag filter', status: 'open', rank: 1, bodyExcerpt: 'a', createdAt: 1, updatedAt: 100, workspaceId: 'ws-known' },
      // Same card, but its workspace only exists in the ledger: no session can
      // run there, so the action must stay hidden.
      { id: 'ledger-only', title: 'Unknown workspace', status: 'open', rank: 2, bodyExcerpt: 'b', createdAt: 1, updatedAt: 100, workspaceId: 'ws-unknown' },
      { id: 'no-workspace', title: 'Generic', status: 'open', rank: 3, bodyExcerpt: 'c', createdAt: 1, updatedAt: 100 },
      { id: 'archived', title: 'Archived', status: 'archived', rank: 4, bodyExcerpt: 'd', createdAt: 1, updatedAt: 100, workspaceId: 'ws-known' },
    ],
  }
}

const REPORT: IdeaSimilarReport = {
  ideaId: 'eligible',
  found: true,
  scanned: 2,
  flagged: true,
  candidates: [
    { id: 'c1', title: 'Add a tag filter', score: 0.81, signals: ['title', 'tags'] },
    { id: 'c2', title: 'Tag filter in the board', score: 0.4, signals: ['tags'] },
  ],
}

class SimilarTransport implements IdeasHostTransport {
  reads: IdeasReadQuery[] = []
  /** When set, the Host answers the bounded read WITHOUT a report. */
  omitReport = false
  async state(): Promise<IdeasListSnapshot> { return snapshot() }
  async action(): Promise<IdeasListSnapshot> { return snapshot() }
  async read(query: IdeasReadQuery = {}): Promise<IdeasReadSnapshot> {
    this.reads.push(query)
    const base = snapshot() as unknown as IdeasReadSnapshot
    if (this.omitReport || query.similar === undefined) return base
    return { ...base, similar: { ...REPORT, ideaId: query.similar } }
  }
  subscribe(): () => void { return () => {} }
}

const REGISTRY: WorkspaceViewLite[] = [
  { workspaceId: 'ws-known', title: 'Alpha' },
  { workspaceId: 'ws-other', title: 'Beta' },
]

class StaticWorkspaces implements WorkspacesSource {
  list(): WorkspaceViewLite[] { return REGISTRY }
  subscribe(): () => void { return () => {} }
  dispose(): void {}
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient
const launched: FindSimilarInput[] = []

const LAUNCHER: SessionLauncher = {
  launch: async () => ({ accepted: true }),
  launchReanalyze: async () => ({ accepted: true }),
  launchFindSimilar: async (input: FindSimilarInput) => { launched.push(input); return { accepted: true } },
  listModels: async () => [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek' }],
  currentModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  localStorage.clear()
  launched.length = 0
})
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host.remove()
})

async function renderBoard(transport: SimilarTransport): Promise<void> {
  client = new IdeasClient(transport, new StaticWorkspaces())
  client.snapshot = snapshot()
  client.sessionLauncher = LAUNCHER
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
}

function buttonIn(ideaId: string): HTMLElement | null {
  return host.querySelector(`[data-dsh-idea-id="${ideaId}"] [data-dsh-ideas-find-similar]`)
}
function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
/** Let the effect chain and the fetch promise settle. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

describe('the Find similar affordance on a card', () => {
  it('appears exactly where a session could actually be opened', async () => {
    await renderBoard(new SimilarTransport())
    expect(buttonIn('eligible')).not.toBeNull()
    // The gate the brief demands: same rule as Re-analyze. A workspace only the
    // ledger knows cannot host a session, so the action stays hidden.
    expect(buttonIn('ledger-only')).toBeNull()
    expect(buttonIn('no-workspace')).toBeNull()
    // A closed idea is not a backlog question.
    expect(buttonIn('archived')).toBeNull()
  })

  it('disappears without a session launcher, and comes back with one', async () => {
    const transport = new SimilarTransport()
    client = new IdeasClient(transport, new StaticWorkspaces())
    client.snapshot = snapshot()
    client.sessionLauncher = undefined
    act(() => {
      root = createRoot(host)
      root.render(<IdeasBoard client={client} />)
    })
    await act(async () => { await client.loadConfig() })
    expect(buttonIn('eligible')).toBeNull()

    client.sessionLauncher = LAUNCHER
    await act(async () => { root?.render(<IdeasBoard client={client} />) })
    await settle()
    expect(buttonIn('eligible')).not.toBeNull()
  })
})

describe('the Find similar modal', () => {
  it('asks the Host for the OPT-IN report, never the default snapshot', async () => {
    const transport = new SimilarTransport()
    await renderBoard(transport)

    click(buttonIn('eligible') as HTMLElement)
    await settle()

    const similarReads = transport.reads.filter(read => read.similar !== undefined)
    expect(similarReads).toHaveLength(1)
    expect(similarReads[0]!.similar).toBe('eligible')
    expect(similarReads[0]!.view).toBe('summary')
    // Opening the modal asks for the bounded read ONLY: it never falls back to
    // the default full snapshot, and it never asks for the poll projection.
    expect(transport.reads.every(read => read.view === 'summary')).toBe(true)
    expect(transport.reads.every(read => read.similar !== undefined)).toBe(true)
  })

  it('lists the candidates with their score and the signal legend', async () => {
    await renderBoard(new SimilarTransport())
    click(buttonIn('eligible') as HTMLElement)
    await settle()

    const list = host.querySelector('[data-dsh-ideas-similar-candidates]')
    expect(list).not.toBeNull()
    expect(list!.textContent).toContain('Add a tag filter')
    expect(list!.textContent).toContain('Tag filter in the board')
    // A score is shown together with the signals that produced it and a legend
    // explaining them: a bare number would read as a verdict.
    expect(list!.textContent).toMatch(/0\.81/)
    expect(list!.textContent).toMatch(/0\.40|0\.4/)
    expect(host.textContent).toContain('score')
  })

  it('carries the same model picker as Re-analyze, preselected from the host session', async () => {
    await renderBoard(new SimilarTransport())
    click(buttonIn('eligible') as HTMLElement)
    await settle()

    // The very picker the launch and re-analyze modals use: one session model
    // to confirm, and the host session's own model preselected.
    const modelSelect = host.querySelector('#dsh-ideas-model') as HTMLSelectElement
    expect(modelSelect).not.toBeNull()
    expect(modelSelect.value).toBe('DeepSeek')

    click(host.querySelector('[data-dsh-ideas-find-similar-submit]') as HTMLElement)
    await settle()
    // The picked model rides the launch input, so the analyst session is pinned.
    expect(launched[0]!.model?.model).toBe('deepseek-chat')
  })
})

describe('launching the comparison', () => {
  it('hands the bounded candidate set to the analyst and writes nothing', async () => {
    const transport = new SimilarTransport()
    await renderBoard(transport)

    click(buttonIn('eligible') as HTMLElement)
    await settle()
    click(host.querySelector('[data-dsh-ideas-find-similar-submit]') as HTMLElement)
    await settle()

    expect(launched).toHaveLength(1)
    const input = launched[0]!
    expect(input.ideaId).toBe('eligible')
    expect(input.workspaceId).toBe('ws-known')
    expect(input.candidates.map(candidate => candidate.id)).toEqual(['c1', 'c2'])
    expect(input.scanned).toBe(2)
    // The submit re-reads the report, so the launch never runs on a candidate
    // set fetched when the modal opened.
    expect(transport.reads.filter(read => read.similar === 'eligible')).toHaveLength(2)
    // Crucially: no write verb was issued at any point.
    expect(transport.action).toBeDefined()
  })

  it('never launches a comparison over an empty candidate set', async () => {
    const transport = new SimilarTransport()
    transport.omitReport = true
    await renderBoard(transport)

    click(buttonIn('eligible') as HTMLElement)
    await settle()

    // An older Host answers the bounded read without a report: the modal says
    // so IN PLACE, and the confirm button stays disabled, so the action cannot
    // fire over a candidate set it never received.
    expect(host.querySelector('[data-dsh-ideas-similar-candidates]')).toBeNull()
    const submit = host.querySelector('[data-dsh-ideas-find-similar-submit]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    click(submit)
    await settle()
    expect(launched).toHaveLength(0)
    // Cancel is still the way out.
    expect(host.textContent).toContain('similar-report-unavailable')
  })
})