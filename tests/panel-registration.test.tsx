// @vitest-environment jsdom
/**
 * Panel registration tests.
 *
 * The regression these pin: Ideas used to inject a raw <button> into the
 * sidebar and own its own visibility, so it behaved like a toggle (selecting
 * another panel left it open) and did not look like the shipped rows. The
 * board must now be a shell panel - one sidebar row in `sidebar.panellist`,
 * one page in the keyed `main` slot - and the shell must be the only source of
 * panel truth, which is why mount/unmount is what opens and closes the board.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeasPanel, IdeasPanelIcon, registerIdeasPanel } from '../src/client/panel-registration.tsx'
import { IdeasClient } from '../src/client/ideas-client.ts'
import { IDEAS_PANEL_ID } from '../src/client/panel-navigation.ts'
import type { IdeasHostTransport } from '../src/client/host-api.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasListSnapshot,
} from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Registration { options: Record<string, unknown>; component: unknown }

/** A slots service double: seats are declared, then their callbacks fire. */
function slotsDouble() {
  const seats = new Map<string, () => () => void>()
  const registrations: Registration[] = []
  return {
    registrations,
    seats,
    service: {
      inject(key: string, callback: () => () => void): () => void {
        // Faithful to the shell: releasing a seat also releases whatever was
        // registered through it, which is what the disposer under test relies on.
        const contributed: Array<() => void> = []
        seats.set(key, () => {
          const dispose = callback()
          contributed.push(dispose)
          return dispose
        })
        return () => {
          seats.delete(key)
          for (const dispose of contributed.splice(0)) dispose()
        }
      },
      register(options: Record<string, unknown>, component: unknown): () => void {
        registrations.push({ options, component })
        return () => {
          const index = registrations.findIndex(row => row.component === component)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  }
}

const snapshot: IdeasListSnapshot = {
  schemaVersion: IDEAS_SCHEMA_VERSION,
  revision: 1,
  ideas: [],
}

class FakeTransport implements IdeasHostTransport {
  stateCalls = 0
  async state(): Promise<IdeasListSnapshot> { this.stateCalls += 1; return snapshot }
  async action(): Promise<IdeasListSnapshot> { return snapshot }
  subscribe(): () => void { return () => {} }
}

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => {
  if (root !== undefined) {
    const mounted = root
    act(() => { mounted.unmount() })
  }
  root = undefined
  host.remove()
  document.body.innerHTML = ''
})

describe('registerIdeasPanel', () => {
  it('contributes one sidebar row and one main page, both keyed by the panel id', () => {
    const slots = slotsDouble()
    const client = new IdeasClient(new FakeTransport(), undefined)
    const dispose = registerIdeasPanel({ slots: slots.service } as never, client)

    // The seats are declared by shell entries, not by us: nothing registers
    // until they exist, which is what makes load order irrelevant.
    expect(slots.registrations).toEqual([])
    slots.seats.get('sidebar.panellist')?.()
    slots.seats.get('main')?.()
    expect(slots.registrations).toHaveLength(2)

    const [row, page] = slots.registrations
    expect(row.options.name).toBe('sidebar.panellist')
    expect(row.options.id).toBe(IDEAS_PANEL_ID)
    expect(row.component).toBe(IdeasPanelIcon)
    // The label is a thunk: the shell resolves it on every locale change, so a
    // captured string would freeze the row in the boot language.
    expect(typeof row.options.label).toBe('function')
    expect((row.options.label as () => string)()).toMatch(/^(Ideas|Id\u00e9es|\u60f3\u6cd5)$/)

    expect(page.options.name).toBe('main')
    expect(page.options.key).toBe(IDEAS_PANEL_ID)
    expect(page.component).toBe(IdeasPanel)
    // The page receives the client through the slot's inject factory.
    expect((page.options.inject as () => { client: IdeasClient })().client).toBe(client)

    dispose()
    expect(slots.registrations).toEqual([])
  })
})

describe('panel seat watchdog', () => {
  afterEach(() => { vi.useRealTimers() })

  it('says so once when the shell never declares a seat', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slots = slotsDouble()
    const client = new IdeasClient(new FakeTransport(), undefined)
    registerIdeasPanel({ slots: slots.service } as never, client)
    vi.advanceTimersByTime(11_000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('sidebar.panellist')
    warn.mockRestore()
  })

  it('stays quiet in a healthy shell, and after disposal', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slots = slotsDouble()
    const client = new IdeasClient(new FakeTransport(), undefined)
    const dispose = registerIdeasPanel({ slots: slots.service } as never, client)
    slots.seats.get('sidebar.panellist')?.()
    slots.seats.get('main')?.()
    vi.advanceTimersByTime(11_000)
    expect(warn).not.toHaveBeenCalled()

    // A disposed plugin must not log for a seat it no longer waits for.
    vi.useRealTimers()
    vi.useFakeTimers()
    dispose()
    vi.advanceTimersByTime(11_000)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('IdeasPanelIcon', () => {
  it('draws only the glyph, at the size the shell asks for', () => {
    host.innerHTML = ''
    act(() => {
      root = createRoot(host)
      root.render(<IdeasPanelIcon size={20} active />)
    })
    const svg = host.querySelector('svg') as SVGElement
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    // The one hook the L2 skin contract resolves a row's owning plugin by.
    expect(svg.getAttribute('data-dsh-panel-entry')).toBe(IDEAS_PANEL_ID)
  })
})

describe('IdeasPanel', () => {
  it('mirrors the shell mount onto the client open flag', async () => {
    const transport = new FakeTransport()
    const client = new IdeasClient(transport, undefined)
    const before = transport.stateCalls

    act(() => {
      root = createRoot(host)
      root.render(<IdeasPanel client={client} />)
    })
    expect(host.querySelector('[data-dsh-ideas-view]')).not.toBeNull()
    expect(client.boardOpen).toBe(true)
    // Opening refreshes immediately: the board must not sit empty for a tick.
    await act(async () => { await Promise.resolve() })
    expect(transport.stateCalls).toBe(before + 1)

    const mounted = root as Root
    act(() => { mounted.unmount() })
    root = undefined
    // A closed board holds no traffic: this is what gates the background poll.
    expect(client.boardOpen).toBe(false)
  })
})

describe('client panel navigation', () => {
  it('asks the shell to switch panels, and never owns the flag itself', () => {
    const selected: Array<string | null> = []
    const client = new IdeasClient(new FakeTransport(), undefined)
    client.panelNavigator = { select: (id) => { selected.push(id) } }

    client.toggleBoard()
    expect(selected).toEqual([IDEAS_PANEL_ID])
    // The shell is the source of truth: until it mounts us, the flag stays put
    // and the board is not "open" behind the shell's back.
    expect(client.boardOpen).toBe(false)

    client.closeBoard()
    expect(selected).toEqual([IDEAS_PANEL_ID, null])
  })

  it('falls back to the local flag without a navigator', () => {
    const client = new IdeasClient(new FakeTransport(), undefined)
    client.toggleBoard()
    expect(client.boardOpen).toBe(true)
    client.closeBoard()
    expect(client.boardOpen).toBe(false)
  })

  it('is idempotent: a repeated mount/unmount neither re-refreshes nor flips twice', async () => {
    const transport = new FakeTransport()
    const client = new IdeasClient(transport, undefined)
    const before = transport.stateCalls

    client.panelShown()
    expect(client.boardOpen).toBe(true)
    await act(async () => { await Promise.resolve() })
    const afterOpen = transport.stateCalls
    expect(afterOpen).toBe(before + 1)

    // React StrictMode double-invokes effects in dev; a second mount must not
    // turn into a second fetch or a toggled flag.
    client.panelShown()
    expect(client.boardOpen).toBe(true)
    client.panelHidden()
    expect(client.boardOpen).toBe(false)
    client.panelHidden()
    expect(client.boardOpen).toBe(false)
    await act(async () => { await Promise.resolve() })
    expect(transport.stateCalls).toBe(afterOpen)
  })
})
