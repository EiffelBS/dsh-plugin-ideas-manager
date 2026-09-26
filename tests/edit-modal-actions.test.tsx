// @vitest-environment jsdom
/**
 * The editor is the one surface reachable from EVERY tab, so it is the only
 * place a launch can start from the Priorities or Delivered views, where the
 * card layout carrying the button is not on screen. It also names the card it
 * is editing, so a modal opened from a list does not orphan its subject.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasBoard } from '../src/client/board-view.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import type { IdeaRecord } from '../src/core/ideas.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasEventPayload,
  type IdeasListSnapshot,
  type LaunchResponse,
} from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = { createdAt: 1, updatedAt: 100, workspaceId: 'ws1' }

function fixture(): IdeasListSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 1,
    ideas: [
      { ...base, id: 'six', title: 'Numbered idea', status: 'open', rank: 1, ideaNumber: 6, bodyExcerpt: 'a', taskBoardId: 'task-6', taskBoardStatus: 'backlog' },
      // No workspace: a launch has no directory to work in, from any surface.
      { id: 'generic', title: 'Generic idea', status: 'open', rank: 2, bodyExcerpt: 'b', createdAt: 1, updatedAt: 100, taskBoardId: 'task-7', taskBoardStatus: 'backlog' },
      // Already running: its run is the one on record, never a second one.
      { ...base, id: 'busy', title: 'Busy idea', status: 'open', rank: 3, ideaNumber: 8, bodyExcerpt: 'c', runStatus: 'running' },
    ],
  }
}

class FakeTransport implements IdeasHostTransport {
  launches: Array<{ ideaId: string; model: string | undefined }> = []
  async state(): Promise<IdeasListSnapshot> { return fixture() }
  async action(): Promise<IdeasListSnapshot> { return fixture() }
  // The editor edits the WHOLE body, so opening it first fetches the full
  // record; a transport that cannot answer leaves the modal closed on purpose.
  async idea(id: string): Promise<IdeaRecord> {
    const found = fixture().ideas.find(record => record.id === id)
    if (found === undefined) throw new Error('not-found')
    return { ...found, body: found.bodyExcerpt }
  }
  async launch(ideaId: string, model?: string): Promise<LaunchResponse> {
    this.launches.push({ ideaId, model })
    return { ok: true, runId: `card-${ideaId}`, taskId: `card-${ideaId}`, runStatus: 'running' }
  }
  subscribe(_listener: (event?: IdeasEventPayload) => void): () => void { return () => {} }
}

let host: HTMLDivElement
let root: Root | undefined
let client: IdeasClient
let transport: FakeTransport

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
  transport = new FakeTransport()
  client = new IdeasClient(transport, undefined)
  client.snapshot = fixture()
  act(() => {
    root = createRoot(host)
    root.render(<IdeasBoard client={client} />)
  })
  await act(async () => { await client.loadConfig() })
}

function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function modalTitle(): string {
  return host.querySelector('h3')?.textContent ?? ''
}

function launchButtonInEdit(): HTMLElement | null {
  return host.querySelector('[data-dsh-ideas-launch-edit]')
}

/** Open the editor of a card, the way clicking its title does. */
async function openEditor(ideaId: string): Promise<void> {
  const title = host.querySelector(`[data-dsh-idea-id="${ideaId}"] .dsh-ideas-card-title`) as HTMLElement
  expect(title).not.toBeNull()
  click(title)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('editor actions', () => {
  it('names the card it edits', async () => {
    await renderBoard()
    await openEditor('six')
    expect(modalTitle()).toBe('Edit idea #6')
  })

  it('offers the launch from the editor, and only when a launch can start', async () => {
    await renderBoard()

    await openEditor('six')
    expect(launchButtonInEdit()).not.toBeNull()

    await openEditor('generic')
    expect(launchButtonInEdit()).toBeNull()

    await openEditor('busy')
    expect(launchButtonInEdit()).toBeNull()
  })

  it('launches from the editor: the editor hands over to the model picker', async () => {
    await renderBoard()
    await openEditor('six')

    click(launchButtonInEdit() as HTMLElement)
    await act(async () => { await Promise.resolve() })

    // The editor is gone; the launch modal took over, exactly as from a card.
    expect(launchButtonInEdit()).toBeNull()
    const submit = host.querySelector('[data-dsh-ideas-launch-submit]')
    expect(submit).not.toBeNull()

    click(submit as HTMLElement)
    await act(async () => { await Promise.resolve() })
    expect(transport.launches).toEqual([{ ideaId: 'six', model: undefined }])
  })

  it('reaches the launch from the Priorities tab, where no card is drawn', async () => {
    await renderBoard()
    const tab = host.querySelector('[role="tab"][aria-selected="false"]') as HTMLElement
    expect(tab).not.toBeNull()
    expect(tab.textContent).toContain('Priorities')
    click(tab)
    await act(async () => { await Promise.resolve() })

    // The priorities list, not the kanban: the card's own launch button does
    // not exist here at all, which is why the editor needs one.
    expect(host.querySelector('[data-dsh-idea-id="six"] [data-dsh-ideas-launch]')).toBeNull()

    const row = host.querySelector('[data-dsh-idea-id="six"] .dsh-ideas-priorities-title') as HTMLElement
    expect(row).not.toBeNull()
    click(row)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(launchButtonInEdit()).not.toBeNull()
  })
})
