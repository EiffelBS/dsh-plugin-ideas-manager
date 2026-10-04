/**
 * The session opener (idea #66): the one way back into the conversation a card
 * was worked on. Feature-detected over the faces that have carried this name,
 * and a deployment with none must render no link rather than a broken button.
 *
 * The name matters more than it looks: the host's `sessions` service has no
 * `open()` at all, so probing only that one made the link permanently dead while
 * every test stayed green — the tests handed the resolver a service the real
 * deployment does not have. The probe therefore covers the DOCUMENTED face
 * (`uiWorkspace.openSession`) first, and the cases below build whole contexts
 * rather than bare services for exactly that reason.
 */

import { describe, expect, it } from 'vitest'
import { resolveSessionOpener } from '../src/client/session-opener.ts'

describe('session opener', () => {
  it('resolves the documented navigation face, uiWorkspace.openSession', () => {
    const opened: string[] = []
    const opener = resolveSessionOpener({ uiWorkspace: { openSession: (id: string) => { opened.push(id) } } })
    expect(opener).toBeDefined()
    opener?.open('session-1')
    expect(opened).toEqual(['session-1'])
  })

  it('falls back to a sessions.open() face when the page serves one', () => {
    const opened: string[] = []
    const opener = resolveSessionOpener({ sessions: { open: (id: string) => { opened.push(id) } } })
    opener?.open('session-2')
    expect(opened).toEqual(['session-2'])
  })

  it('prefers the current face when both are present', () => {
    const calls: string[] = []
    const opener = resolveSessionOpener({
      uiWorkspace: { openSession: () => { calls.push('openSession') } },
      sessions: { open: () => { calls.push('open') } },
    })
    opener?.open('session-3')
    expect(calls).toEqual(['openSession'])
  })

  it('calls the face on its own receiver, not detached from it', () => {
    // A navigation face backed by a store reads `this`; a detached call would
    // throw deep inside the shell instead of opening anything.
    const face = {
      seen: undefined as unknown,
      openSession(this: { seen: unknown }, id: string) { this.seen = id },
    }
    resolveSessionOpener({ uiWorkspace: face })?.open('session-4')
    expect(face.seen).toBe('session-4')
  })

  it('refuses a blank id without touching the shell', () => {
    let calls = 0
    const opener = resolveSessionOpener({ uiWorkspace: { openSession: () => { calls += 1 } } })
    opener?.open('')
    expect(calls).toBe(0)
  })

  it('degrades to undefined on every unusable shape', () => {
    expect(resolveSessionOpener(undefined)).toBeUndefined()
    expect(resolveSessionOpener(null)).toBeUndefined()
    expect(resolveSessionOpener('sessions')).toBeUndefined()
    // The host's real `sessions` face: a store with reads and no way to open.
    // This is the shape that shipped a permanently dead link.
    expect(resolveSessionOpener({ sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } } })).toBeUndefined()
    expect(resolveSessionOpener({ uiWorkspace: null })).toBeUndefined()
    expect(resolveSessionOpener({ uiWorkspace: { openSession: 'nope' } })).toBeUndefined()
    // A navigation face with no openSession falls through to the older name.
    expect(resolveSessionOpener({ uiWorkspace: { forkSession: () => {} } })).toBeUndefined()
  })
})
