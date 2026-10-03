// @vitest-environment jsdom
/**
 * A Host that does NOT serve the backup routes (idea #95 follow-up).
 *
 * The failure this pins is a live one: DSH re-resolves the BROWSER half per
 * request but registers the host half at boot, so a plugin folder updated while
 * the instance runs serves the new `client.js` — the Backup tab is right there —
 * while the old host half still answers a plain-text `404 not found` on
 * `/api/ideas/backup`.
 *
 * Two things had to be true, and neither was:
 *  1. the transport must never leak a `SyntaxError` from `response.json()` when
 *     the answer is not JSON (the user saw the raw parser message);
 *  2. the panel must DEGRADE to its explicit "this deployment serves no backup
 *     surface" note, not show a raw parse error and leave three dead buttons —
 *     the static `transport.backups !== undefined` check can only ever see a
 *     missing METHOD, never a missing ROUTE.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasClient } from '../src/client/ideas-client.ts'
import { HttpIdeasHostTransport } from '../src/client/host-api.ts'
import { BackupPanel } from '../src/client/backup-panel.tsx'
import { classes } from '../src/client/style.ts'
import { en } from '../src/client/locales.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalFetch = globalThis.fetch
let host: HTMLDivElement
let root: Root | undefined

afterEach(() => {
  globalThis.fetch = originalFetch
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  host?.remove()
  host = document.createElement('div')
})

/** A Host whose web server answers an unknown route the way DSH does: 404 + `not found`. */
function oldHostFetch(): typeof globalThis.fetch {
  return (async () => new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })) as typeof globalThis.fetch
}

describe('a Host that predates the backup routes', () => {
  it('never surfaces a JSON parser error, and names the missing route', async () => {
    globalThis.fetch = oldHostFetch()
    const client = new IdeasClient(new HttpIdeasHostTransport(), undefined)

    await client.loadBackups()

    // The user must read a sentence about the deployment, never
    // `Unexpected token 'o', "not found" is not valid JSON`.
    expect(client.backupError).toBeUndefined()
    expect(client.backupUnavailable).toBe(true)
    expect(client.backups).toBeUndefined()
  })

  it('leaves a real failure visible as a failure (a 500 is not "no route")', async () => {
    globalThis.fetch = (async () => new Response('boom', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })) as typeof globalThis.fetch
    const client = new IdeasClient(new HttpIdeasHostTransport(), undefined)

    await client.loadBackups()

    expect(client.backupUnavailable).toBe(false)
    expect(client.backupError).toContain('500')
    expect(client.backupError).not.toContain('Unexpected token')
  })

  it('keeps parsing a real JSON refusal as before', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: false,
      error: 'restore-run-in-flight',
      message: 'an execution is still running on #1 "First idea"',
    }), { status: 409, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch
    const client = new IdeasClient(new HttpIdeasHostTransport(), undefined)

    await client.restoreSnapshot({ name: 'snapshot-1.json' })

    expect(client.backupUnavailable).toBe(false)
    expect(client.backupError).toBe('an execution is still running on #1 "First idea"')
  })

  it('renders the unavailable note instead of three dead buttons', async () => {
    globalThis.fetch = oldHostFetch()
    const client = new IdeasClient(new HttpIdeasHostTransport(), undefined)
    host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<BackupPanel client={client} />)
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })

    expect(host.querySelector(`.${classes.settingsNote}`)?.textContent).toBe(en['backup.unavailable'])
    // No error line, and nothing to click that cannot work.
    expect(host.querySelector(`.${classes.settingsError}`)).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(host.textContent).not.toContain('Unexpected token')
  })
})