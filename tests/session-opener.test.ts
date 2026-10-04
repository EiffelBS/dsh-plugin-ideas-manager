/**
 * The session opener (idea #66): the one way back into the conversation a card
 * was worked on.
 *
 * Two lessons are pinned here, both paid for:
 *
 * 1. TWO NAMES. The plugin declares compatibility from DSH 0.1.5-rc.1, and the
 *    way to show a session has moved: `uiWorkspace.openSession(id)` is the
 *    documented face, `sessions.open(id)` is the older one. Probing only the
 *    older name made the link permanently dead, because the host's `sessions`
 *    store has no `open()` at all.
 * 2. SERVICES ARE READ WITH `ctx.get(name)`, never as a property. A cordis
 *    property read of an undeclared service THROWS, and the resolver trusted it
 *    for years. So every fake below is `get`-shaped, like the real context: a
 *    plain-object fake would keep the whole suite green while the feature did
 *    nothing in a browser.
 */

import { describe, expect, it } from 'vitest'
import { resolveSessionOpener } from '../src/client/session-opener.ts'

/** A client root context shaped like cordis: services come from `get`. */
function context(services: Record<string, unknown>, options: { throwOn?: string[] } = {}) {
  return {
    get(name: string): unknown {
      if (options.throwOn?.includes(name)) throw new Error(`undeclared service: ${name}`)
      return services[name]
    },
  }
}

describe('session opener', () => {
  it('resolves the documented navigation face, uiWorkspace.openSession', () => {
    const opened: string[] = []
    const opener = resolveSessionOpener(context({ uiWorkspace: { openSession: (id: string) => { opened.push(id) } } }))
    expect(opener).toBeDefined()
    opener?.open('session-1')
    expect(opened).toEqual(['session-1'])
  })

  it('falls back to a sessions.open() face for an older host', () => {
    const opened: string[] = []
    const opener = resolveSessionOpener(context({ sessions: { open: (id: string) => { opened.push(id) } } }))
    opener?.open('session-2')
    expect(opened).toEqual(['session-2'])
  })

  it('prefers the current face when a host serves both', () => {
    const calls: string[] = []
    const opener = resolveSessionOpener(context({
      uiWorkspace: { openSession: () => { calls.push('openSession') } },
      sessions: { open: () => { calls.push('open') } },
    }))
    opener?.open('session-3')
    expect(calls).toEqual(['openSession'])
  })

  it('survives a context whose accessor throws on a service name', () => {
    // What cordis does for a service the plugin never declared: the read throws,
    // and a resolver that did not catch it took the whole panel down with it.
    let calls = 0
    const opener = resolveSessionOpener(context({ sessions: { open: () => { calls += 1 } } }, { throwOn: ['uiWorkspace'] }))
    expect(opener).toBeDefined()
    opener?.open('session-4')
    expect(calls).toBe(1)
  })

  it('calls the face on its own receiver, not detached from it', () => {
    const face = {
      seen: undefined as unknown,
      openSession(this: { seen: unknown }, id: string) { this.seen = id },
    }
    resolveSessionOpener(context({ uiWorkspace: face }))?.open('session-5')
    expect(face.seen).toBe('session-5')
  })

  it('refuses a blank id without touching the shell', () => {
    let calls = 0
    const opener = resolveSessionOpener(context({ uiWorkspace: { openSession: () => { calls += 1 } } }))
    opener?.open('')
    expect(calls).toBe(0)
  })

  it('degrades to undefined on every unusable shape', () => {
    expect(resolveSessionOpener(undefined)).toBeUndefined()
    expect(resolveSessionOpener(null)).toBeUndefined()
    expect(resolveSessionOpener('sessions')).toBeUndefined()
    expect(resolveSessionOpener(context({}))).toBeUndefined()
    // The host's real `sessions` face: a store with reads and no way to open.
    // This is the exact shape that shipped a permanently dead link.
    expect(resolveSessionOpener(context({ sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } } }))).toBeUndefined()
    expect(resolveSessionOpener(context({ uiWorkspace: null }))).toBeUndefined()
    expect(resolveSessionOpener(context({ uiWorkspace: { openSession: 'nope' } }))).toBeUndefined()
    // A navigation face with neither method falls through to the older name.
    expect(resolveSessionOpener(context({ uiWorkspace: { forkSession: () => {} } }))).toBeUndefined()
  })

  it('still accepts a context that exposes the service as a property', () => {
    // The second chance: a test double, or a shell where the service really is a
    // property. Cheap to keep, and it is what the layout resolver does too.
    const opened: string[] = []
    resolveSessionOpener({ uiWorkspace: { openSession: (id: string) => { opened.push(id) } } })?.open('session-6')
    expect(opened).toEqual(['session-6'])
  })
})
