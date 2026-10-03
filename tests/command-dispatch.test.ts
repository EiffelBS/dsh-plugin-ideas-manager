/**
 * The command-dispatch boundary: the direct-session launch's permission travels
 * as the Host's own `/permission <level>` command, and the call crosses into
 * duck-typed shell faces. This file pins the shape that call MUST have, because
 * the failure is invisible until a human tries to launch an idea.
 */

import { describe, expect, it } from 'vitest'
import { createCommandDispatcher } from '../src/command-dispatch.ts'

describe('direct-session command dispatch', () => {
  /** A shell whose `execute` behaves like the installed one: it reads the signal. */
  function shell(sessionAgent: unknown) {
    const calls: Array<{ agent: unknown; line: string; attachments: unknown; signal: unknown }> = []
    const commands = {
      execute: (agent: unknown, line: string, attachments: unknown, signal: { aborted?: boolean }) => {
        calls.push({ agent, line, attachments, signal })
        // What the host really does first: `if (signal.aborted) ...`. A missing
        // argument here is the exact TypeError the modal used to show.
        if (signal === undefined || typeof signal.aborted !== 'boolean') {
          throw new TypeError("Cannot read properties of undefined (reading 'aborted')")
        }
        return Promise.resolve({ result: `ran:${line}` })
      },
    }
    const agents = { get: () => sessionAgent }
    return { calls, dispatcher: createCommandDispatcher(agents, commands) }
  }

  it('passes the AbortSignal the host requires, as a fourth argument', async () => {
    const { calls, dispatcher } = shell({ id: 'agent-1' })

    const result = await dispatcher!('session-1', '/permission danger-full-access')

    expect(result).toBe('ran:/permission danger-full-access')
    // Four arguments, the fourth a live signal: this is what the host signature
    // became, and a three-argument call is what made the launch fail.
    expect(calls[0]!.line).toBe('/permission danger-full-access')
    expect(calls[0]!.agent).toEqual({ id: 'agent-1' })
    expect(calls[0]!.attachments).toEqual([])
    expect(typeof (calls[0]!.signal as { aborted: boolean }).aborted).toBe('boolean')
    expect((calls[0]!.signal as { aborted: boolean }).aborted).toBe(false)
  })

  it('keeps working against an older three-parameter host that ignores the extra argument', async () => {
    // Compatibility in the other direction: extra arguments are simply ignored,
    // so one call shape serves both host generations.
    const seen: string[] = []
    const dispatcher = createCommandDispatcher(
      { get: () => ({ id: 'agent-1' }) },
      { execute: (_agent: unknown, line: string) => { seen.push(line); return Promise.resolve({ result: 'ok' }) } },
    )
    await expect(dispatcher!('session-1', '/permission workspace-write')).resolves.toBe('ok')
    expect(seen).toEqual(['/permission workspace-write'])
  })

  it('refuses in words when the session has no agent yet', async () => {
    const { dispatcher } = shell(undefined)
    await expect(dispatcher!('session-1', '/permission read-only')).rejects.toThrow('execution session is not available')
  })

  it('is undefined — never a half-dispatcher — when a face is missing or malformed', () => {
    expect(createCommandDispatcher(undefined, { execute: () => Promise.resolve(undefined) })).toBeUndefined()
    expect(createCommandDispatcher({ get: () => ({}) }, undefined)).toBeUndefined()
    expect(createCommandDispatcher({ get: 'not a function' }, { execute: () => Promise.resolve(undefined) })).toBeUndefined()
    expect(createCommandDispatcher({ get: () => ({}) }, { execute: 'not a function' })).toBeUndefined()
  })
})
