/**
 * Idea #105 — deep-link to an idea: the pure resolver, the client handshake and
 * the published service.
 *
 * Three rules are worth pinning here, because each of them is a way the feature
 * could silently do the wrong thing:
 *
 *  1. **A digit string is a NUMBER, never an id.** Reading `#42` as an id would
 *     miss every idea on the board and report "no such idea" for a reference the
 *     human can plainly read off a card.
 *  2. **Resolution is board-wide.** The number is the stable human reference, so
 *     it has to resolve whatever the current workspace scope happens to be — the
 *     resolver is handed every idea and never filters.
 *  3. **A request is one-shot.** The panel answers it once and the answer is
 *     keyed by sequence, so a stale answer from a previous link can never land
 *     on the card a newer link focused.
 *
 * The cold path is pinned too: a board that has been closed since a capture has
 * no row to resolve, so the client asks the Host through the EXISTING bounded
 * read and adopts a fresh list before answering. Nothing is added to the wire.
 */

import { describe, expect, it, vi } from 'vitest'
import { focusReadQuery, parseIdeaRef, resolveIdeaRef } from '../src/client/deeplink.ts'
import { createIdeasBoardService, IDEAS_BOARD_SERVICE } from '../src/client/deeplink-service.ts'
import { IdeasClient } from '../src/client/ideas-client.ts'
import { IDEAS_PANEL_ID, TASK_BOARD_PANEL_ID } from '../src/client/panel-navigation.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_READ_DEFAULT_LIMIT,
  IDEAS_SCHEMA_VERSION,
  type IdeasListSnapshot,
  type IdeasReadQuery,
  type IdeasReadSnapshot,
} from '../src/protocol.ts'

type Row = IdeasListSnapshot['ideas'][number]

/** A list row carries everything a focus decision reads. */
function row(id: string, ideaNumber: number, workspaceId?: string, status: Row['status'] = 'open'): Row {
  return {
    id,
    title: `Idea ${ideaNumber}`,
    status,
    rank: ideaNumber,
    ideaNumber,
    bodyExcerpt: '',
    createdAt: 1,
    updatedAt: 2,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  }
}

function listOf(ideas: readonly Row[], revision = 1): IdeasListSnapshot {
  return { schemaVersion: IDEAS_SCHEMA_VERSION, revision, ideas: [...ideas] }
}

function readAnswer(ideas: readonly Row[]): IdeasReadSnapshot {
  return {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 2,
    ideas: [...ideas],
    meta: {
      view: 'summary',
      fields: [],
      bodyLimitBytes: 0,
      limit: 1,
      offset: 0,
      matched: ideas.length,
      returned: ideas.length,
      rowTruncated: false,
      nextOffset: null,
      bodyTruncated: false,
      omittedFields: [],
    },
  }
}

describe('parseIdeaRef', () => {
  it('reads a number, with or without its decoration', () => {
    expect(parseIdeaRef('#42')).toEqual({ kind: 'number', number: 42 })
    expect(parseIdeaRef('42')).toEqual({ kind: 'number', number: 42 })
    expect(parseIdeaRef('  #42  ')).toEqual({ kind: 'number', number: 42 })
    // A leading zero is the same number a human read off a card.
    expect(parseIdeaRef('007')).toEqual({ kind: 'number', number: 7 })
  })

  it('reads an id, and the deterministic mirrored card id', () => {
    expect(parseIdeaRef('9f1c-42')).toEqual({ kind: 'id', id: '9f1c-42' })
    // The TaskBoard card id is `idea-<ideaId>`: accepting it means a card id
    // copied out of that board lands on the right idea.
    expect(parseIdeaRef('idea-9f1c-42')).toEqual({ kind: 'id', id: '9f1c-42' })
    expect(parseIdeaRef('IDEA-9f1c-42')).toEqual({ kind: 'id', id: '9f1c-42' })
  })

  it('refuses what is not a reference at all', () => {
    expect(parseIdeaRef('')).toBeUndefined()
    expect(parseIdeaRef('   ')).toBeUndefined()
    expect(parseIdeaRef('#')).toBeUndefined()
    expect(parseIdeaRef('idea-')).toBeUndefined()
    // 0 is not a number an idea can carry: the sequence starts at 1.
    expect(parseIdeaRef('0')).toBeUndefined()
    // A number past the safe integer range cannot name a card either.
    expect(parseIdeaRef('9'.repeat(20))).toBeUndefined()
  })
})

describe('resolveIdeaRef', () => {
  const board = [row('a', 1, 'ws-a'), row('b', 2, 'ws-b'), row('c', 3)]

  it('finds an idea by number from anywhere on the board', () => {
    // No workspace filter anywhere in sight: the reference decides, not the scope.
    const found = resolveIdeaRef({ kind: 'number', number: 2 }, board)
    expect(found?.id).toBe('b')
    expect(found?.workspaceId).toBe('ws-b')
  })

  it('finds an idea by id', () => {
    expect(resolveIdeaRef({ kind: 'id', id: 'c' }, board)?.ideaNumber).toBe(3)
    // `idea-a` is a CARD id shape, not an idea id: it must not half-resolve.
    expect(resolveIdeaRef({ kind: 'id', id: 'idea-a' }, board)).toBeUndefined()
  })

  it('answers undefined rather than guessing', () => {
    expect(resolveIdeaRef({ kind: 'number', number: 99 }, board)).toBeUndefined()
    expect(resolveIdeaRef({ kind: 'id', id: 'nope' }, board)).toBeUndefined()
    // An idea imported without a number must not make a number resolvable.
    const unnumbered = [{ ...row('x', 1), ideaNumber: undefined }]
    expect(resolveIdeaRef({ kind: 'number', number: 1 }, unnumbered)).toBeUndefined()
  })
})

describe('focusReadQuery', () => {
  it('is the EXISTING bounded read, narrowed to one row', () => {
    expect(focusReadQuery({ kind: 'number', number: 42 })).toEqual({ view: 'summary', limit: 1, numbers: [42] })
    expect(focusReadQuery({ kind: 'id', id: 'a' })).toEqual({ view: 'summary', limit: 1, ids: ['a'] })
    // Nothing here may invent a route or a query parameter the Host does not
    // already serve.
    for (const key of Object.keys(focusReadQuery({ kind: 'number', number: 1 }))) {
      expect(['view', 'limit', 'numbers', 'ids']).toContain(key)
    }
  })
})

/* --- the client handshake --- */

/**
 * A transport whose board can move under the client, like a real poll.
 *
 * `state()` serves whatever the HOST currently holds, and a cold client starts
 * behind it: the 2.5 s poll only runs while the panel is open, so a capture
 * that landed since is genuinely invisible until something asks for it.
 */
function transport(options: { ideas?: readonly Row[]; read?: readonly Row[] } = {}): IdeasHostTransport {
  let hosted: Row[] = [...(options.ideas ?? [row('a', 1, 'ws-a')])]
  let revision = 1
  return {
    state: async () => listOf(hosted, revision),
    action: async () => listOf(hosted, revision),
    subscribe: () => () => {},
    ...(options.read === undefined ? {} : {
      read: async (query: IdeasReadQuery): Promise<IdeasReadSnapshot> => {
        // Only the documented selectors may reach the Host.
        expect(query.limit).toBeLessThanOrEqual(IDEAS_READ_DEFAULT_LIMIT)
        // Reading a reference the Host knows brings that row into the list the
        // poll then serves — the same thing a capture does.
        if (options.read !== undefined) hosted = [...options.read]
        revision += 1
        return readAnswer(hosted)
      },
    }),
  }
}

describe('client focus request', () => {
  it('brings the board to the front and waits to be answered', () => {
    const selected: Array<string | null> = []
    const client = new IdeasClient(transport(), undefined)
    client.panelNavigator = { select: (id) => { selected.push(id) } }

    client.requestFocus('#7')
    expect(client.focusRequest).toEqual({ ref: '#7', seq: 1 })
    expect(client.focusedIdeaId).toBeUndefined()
    // Selecting, never toggling: a deep-link to a closed board must open it.
    expect(selected).toEqual([IDEAS_PANEL_ID])
  })

  it('opens the local flag when the deployment has no layout face', () => {
    const client = new IdeasClient(transport(), undefined)
    client.requestFocus('7')
    expect(client.boardOpen).toBe(true)
  })

  it('numbers every request, so two links in a row stay distinguishable', () => {
    const client = new IdeasClient(transport(), undefined)
    client.requestFocus('#1')
    client.requestFocus('#2')
    expect(client.focusRequest).toEqual({ ref: '#2', seq: 2 })
  })

  it('is answered once: the request clears and a repeat cannot re-apply it', () => {
    const client = new IdeasClient(transport(), undefined)
    client.requestFocus('#1')
    client.reportFocus(1, 'focused', 'a')

    expect(client.focusRequest).toBeUndefined()
    expect(client.focusResult).toEqual({ ref: '#1', seq: 1, outcome: 'focused' })
    expect(client.focusedIdeaId).toBe('a')

    // A late answer for the same request must not resurrect it.
    client.reportFocus(1, 'unknown')
    expect(client.focusedIdeaId).toBe('a')
  })

  it('drops the answer of a superseded request', () => {
    const client = new IdeasClient(transport(), undefined)
    client.requestFocus('#1')
    client.requestFocus('#2')
    client.reportFocus(1, 'focused', 'a')
    expect(client.focusedIdeaId).toBeUndefined()
    expect(client.focusResult).toBeUndefined()

    client.reportFocus(2, 'focused', 'b')
    expect(client.focusedIdeaId).toBe('b')
  })

  it('drops the focus marker when the human takes the board over', () => {
    const client = new IdeasClient(transport(), undefined)
    client.requestFocus('#1')
    client.reportFocus(1, 'focused', 'a')
    client.clearFocus()
    expect(client.focusedIdeaId).toBeUndefined()
    // And a clear that has nothing to clear costs no wake-up.
    const seen: number[] = []
    client.subscribe(() => { seen.push(1) })
    client.clearFocus()
    expect(seen).toEqual([])
  })
})

describe('client resolveFocus', () => {
  it('answers from the snapshot it already holds, without a request', async () => {
    const client = new IdeasClient(transport(), undefined)
    client.snapshot = listOf([row('a', 1, 'ws-a'), row('b', 2, 'ws-b')])
    const found = await client.resolveFocus('#2')
    expect(found?.id).toBe('b')
  })

  it('reads once and adopts a fresh list when the board is cold', async () => {
    // The capture landed while the board was closed: the poll never ran, so the
    // snapshot holds nothing and the bounded read is the only way to see it.
    const captured = row('late', 9, 'ws-b')
    const client = new IdeasClient(transport({ ideas: [], read: [captured] }), undefined)
    expect(client.snapshot).toBeUndefined()

    const found = await client.resolveFocus('#9')
    expect(found?.id).toBe('late')
    // The card has to EXIST before anything can focus it.
    expect(client.snapshot?.ideas.map(idea => idea.id)).toEqual(['late'])
  })

  it('answers undefined when nothing on this board matches', async () => {
    const client = new IdeasClient(transport({ read: [] }), undefined)
    expect(await client.resolveFocus('#404')).toBeUndefined()
  })

  it('answers undefined, never throws, on a reference that is not one', async () => {
    const client = new IdeasClient(transport(), undefined)
    expect(await client.resolveFocus('   ')).toBeUndefined()
  })

  it('answers undefined when the Host read fails or is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = new IdeasClient({
      ...transport(),
      read: async () => { throw new Error('offline') },
    }, undefined)
    expect(await failing.resolveFocus('#1')).toBeUndefined()
    // No bounded-read capability at all (an older Host): a downgrade, not a throw.
    expect(await new IdeasClient(transport(), undefined).resolveFocus('#1')).toBeUndefined()
    warn.mockRestore()
  })
})

describe('openTaskBoard', () => {
  it('selects the TaskBoard panel through the layout face, and nothing else', () => {
    const selected: Array<string | null> = []
    const client = new IdeasClient(transport(), undefined)
    client.panelNavigator = { select: (id) => { selected.push(id) } }
    client.openTaskBoard()
    expect(selected).toEqual([TASK_BOARD_PANEL_ID])
    // It is a panel switch: no focus request, no board state, no DOM.
    expect(client.focusRequest).toBeUndefined()
  })

  it('does nothing at all without a layout service', () => {
    const client = new IdeasClient(transport(), undefined)
    client.openTaskBoard()
    expect(client.focusRequest).toBeUndefined()
    expect(client.boardOpen).toBe(false)
  })
})

describe('the published board service', () => {
  it('forwards a focus to the same client the panel renders from', () => {
    const client = new IdeasClient(transport(), undefined)
    client.snapshot = listOf([row('a', 1, 'ws-a'), row('b', 2, 'ws-b')])
    const service = createIdeasBoardService(client)
    expect(IDEAS_BOARD_SERVICE).toBe('ideas-manager.board')

    service.focusIdea('#2')
    expect(client.focusRequest).toEqual({ ref: '#2', seq: 1 })
    client.reportFocus(1, 'focused', 'b')
    expect(service.focusedIdeaId).toBe('b')
    expect(service.lastFocusOutcome).toBe('focused')

    client.clearFocus()
    expect(service.focusedIdeaId).toBeUndefined()
  })

  it('answers "no outcome yet" rather than inventing one', () => {
    const service = createIdeasBoardService(new IdeasClient(transport(), undefined))
    expect(service.focusedIdeaId).toBeUndefined()
    expect(service.lastFocusOutcome).toBeUndefined()
  })
})
