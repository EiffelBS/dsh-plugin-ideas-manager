// @vitest-environment jsdom
/**
 * Center-column takeover regression tests: the family contract between the
 * ideas board and the task-board / ssh sibling panels.
 *
 * The upstream family is a strict pair (taskboard<->ssh): each member only
 * evicts the OTHER member's html attribute and only closes when it hears the
 * OTHER member's panel name. A third member must therefore evict every
 * sibling attribute, close on every sibling activation, and broadcast every
 * sibling's name on open. These tests pin that whole matrix — a missing edge
 * leaves two active attributes fighting over the column (each family
 * stylesheet hides everything that is not its own view with !important) and
 * ends in a blank center panel.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountCenterPanel } from '../src/client/panel-mount-core.ts'

const TASKBOARD_ACTIVE = 'data-dsh-taskboard-active'
const SSH_ACTIVE = 'data-dsh-ssh-active'
const IDEAS_ACTIVE = 'data-dsh-ideas-active'
const FAMILY_ATTRIBUTES = [TASKBOARD_ACTIVE, SSH_ACTIVE, IDEAS_ACTIVE]

/** Fake controller mirroring the IdeasClient / BoardController open-flag shape. */
class FakeClient {
  open = false
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  toggle(): void {
    this.open = !this.open
    this.emit()
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

interface FamilyOptions {
  active: string
  siblingActives: readonly string[]
  panel: string
  siblingPanels: readonly string[]
  evict?: readonly string[]
}

/** Mount one family panel through the shared takeover core. */
function mount(client: FakeClient, options: FamilyOptions): void {
  disposers.push(mountCenterPanel({
    render: () => {},
    viewDatasetKey: 'dshFamilyView',
    pluginName: 'family',
    viewClassName: 'family-view',
    activeAttribute: options.active,
    siblingActiveAttributes: options.siblingActives,
    panelName: options.panel,
    siblingPanelNames: options.siblingPanels,
    ...(options.evict === undefined ? {} : { evictDetails: options.evict }),
    isOpen: () => client.open,
    close: () => client.close(),
    subscribe: listener => client.subscribe(listener),
  }))
}

/** Upstream pair members behave like dsh-ssh / dsh-client-ui-task-board. */
function mountTaskboard(client: FakeClient): void {
  return mount(client, {
    active: TASKBOARD_ACTIVE,
    siblingActives: [SSH_ACTIVE],
    panel: 'taskboard',
    siblingPanels: ['ssh'],
  })
}

function mountSsh(client: FakeClient): void {
  return mount(client, {
    active: SSH_ACTIVE,
    siblingActives: [TASKBOARD_ACTIVE],
    panel: 'ssh',
    siblingPanels: ['taskboard'],
  })
}

/** The ideas member: full-family eviction instead of the single-sibling pair. */
function mountIdeas(client: FakeClient): void {
  return mount(client, {
    active: IDEAS_ACTIVE,
    siblingActives: [TASKBOARD_ACTIVE, SSH_ACTIVE],
    panel: 'ideas',
    siblingPanels: ['taskboard', 'ssh'],
    evict: ['ssh', 'taskboard'],
  })
}

function activeAttributes(): string[] {
  return FAMILY_ATTRIBUTES.filter(name => document.documentElement.hasAttribute(name))
}

let disposers: Array<() => void> = []

beforeEach(() => {
  disposers = []
  document.querySelectorAll('.centerCol').forEach(el => el.remove())
  for (const name of FAMILY_ATTRIBUTES) document.documentElement.removeAttribute(name)
  const column = document.createElement('div')
  column.className = 'centerCol'
  document.body.appendChild(column)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

/**
 * The single-occupant invariant: exactly `open` (or none) among the family is
 * open, and the html attribute matches exactly that controller.
 */
function expectConsistent(all: FakeClient[], open: FakeClient | null, attribute: string | null): void {
  expect(all.filter(client => client.open)).toEqual(open === null ? [] : [open])
  expect(activeAttributes()).toEqual(attribute === null ? [] : [attribute])
}

describe('family takeover matrix', () => {
  it('SSH open, then Ideas open: evicts the ssh controller and its attribute (reported blank-panel bug)', () => {
    const ssh = new FakeClient()
    const ideas = new FakeClient()
    mountSsh(ssh)
    mountIdeas(ideas)
    ssh.toggle()
    expect(ssh.open).toBe(true)
    expect(activeAttributes()).toEqual([SSH_ACTIVE])

    ideas.toggle()
    expect(ideas.open).toBe(true)
    expect(ssh.open).toBe(false)
    expect(activeAttributes()).toEqual([IDEAS_ACTIVE])
  })

  it('TaskBoard open, then Ideas open: still evicts (preexisting working direction)', () => {
    const taskboard = new FakeClient()
    const ideas = new FakeClient()
    mountTaskboard(taskboard)
    mountIdeas(ideas)
    taskboard.toggle()
    ideas.toggle()
    expect(taskboard.open).toBe(false)
    expect(ideas.open).toBe(true)
    expect(activeAttributes()).toEqual([IDEAS_ACTIVE])
  })

  it('Ideas open, then SSH open: closes ideas (symmetric reverse direction)', () => {
    const ideas = new FakeClient()
    const ssh = new FakeClient()
    mountIdeas(ideas)
    mountSsh(ssh)
    ideas.toggle()
    ssh.toggle()
    expect(ideas.open).toBe(false)
    expect(ssh.open).toBe(true)
    expect(activeAttributes()).toEqual([SSH_ACTIVE])
  })

  it('Ideas open, then TaskBoard open: closes ideas (preexisting working direction)', () => {
    const ideas = new FakeClient()
    const taskboard = new FakeClient()
    mountIdeas(ideas)
    mountTaskboard(taskboard)
    ideas.toggle()
    taskboard.toggle()
    expect(ideas.open).toBe(false)
    expect(taskboard.open).toBe(true)
    expect(activeAttributes()).toEqual([TASKBOARD_ACTIVE])
  })

  it('opening Ideas does not close itself (broadcast self-close guard)', () => {
    const ideas = new FakeClient()
    mountIdeas(ideas)
    ideas.toggle()
    expect(ideas.open).toBe(true)
    expect(activeAttributes()).toEqual([IDEAS_ACTIVE])
  })

  it('mixed walks keep exactly one open controller and one active attribute at every step', () => {
    const taskboard = new FakeClient()
    const ssh = new FakeClient()
    const ideas = new FakeClient()
    mountTaskboard(taskboard)
    mountSsh(ssh)
    mountIdeas(ideas)

    const steps: Array<[FakeClient, string]> = [
      [taskboard, TASKBOARD_ACTIVE],
      [ssh, SSH_ACTIVE],
      [ideas, IDEAS_ACTIVE],
      [taskboard, TASKBOARD_ACTIVE],
      [ideas, IDEAS_ACTIVE],
      [ssh, SSH_ACTIVE],
      [ideas, IDEAS_ACTIVE],
    ]
    for (const [client, attribute] of steps) {
      client.toggle()
      expectConsistent([taskboard, ssh, ideas], client, attribute)
    }
  })

  it('closing the sole open panel clears the html attribute', () => {
    const ideas = new FakeClient()
    mountIdeas(ideas)
    ideas.toggle()
    expect(activeAttributes()).toEqual([IDEAS_ACTIVE])
    ideas.toggle() // close it again
    expect(ideas.open).toBe(false)
    expect(activeAttributes()).toEqual([])
  })
})