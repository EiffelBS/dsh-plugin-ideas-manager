/**
 * The session opener (idea #66): the one way back into a run the board
 * started. Feature-detected, and a deployment without the shell's sessions
 * service must render no link rather than a broken button.
 */

import { describe, expect, it } from 'vitest'
import { resolveSessionOpener, sessionsServiceOf } from '../src/client/session-opener.ts'
import { SESSIONS_SERVICE } from '../src/client/session-queue.ts'

describe('session opener', () => {
  it('resolves the shell open() face', () => {
    const opened: string[] = []
    const opener = resolveSessionOpener({ open: (id: string) => { opened.push(id) } })
    expect(opener).toBeDefined()
    opener?.open('session-1')
    expect(opened).toEqual(['session-1'])
  })

  it('refuses a blank id without touching the shell', () => {
    let calls = 0
    const opener = resolveSessionOpener({ open: () => { calls += 1 } })
    opener?.open('')
    expect(calls).toBe(0)
  })

  it('degrades to undefined on every unusable shape', () => {
    expect(resolveSessionOpener(undefined)).toBeUndefined()
    expect(resolveSessionOpener(null)).toBeUndefined()
    expect(resolveSessionOpener('sessions')).toBeUndefined()
    // A sessions service that only exposes the read face: the read face cannot
    // open anything, so it is not an opener.
    expect(resolveSessionOpener({ list: { getSnapshot: () => ({}), subscribe: () => () => {} } })).toBeUndefined()
    expect(resolveSessionOpener({ open: 'nope' })).toBeUndefined()
  })

  it('finds the service under the shared key, and tolerates its absence', () => {
    const service = { open: () => {} }
    expect(sessionsServiceOf({ [SESSIONS_SERVICE]: service })).toBe(service)
    expect(sessionsServiceOf({})).toBeUndefined()
  })
})
