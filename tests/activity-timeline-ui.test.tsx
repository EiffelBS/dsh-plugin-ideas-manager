// @vitest-environment jsdom
/**
 * The activity timeline in the editor (idea #92, part B) in jsdom.
 *
 * The rule under test is the one that keeps the block honest: an idea with no
 * recorded history renders NOTHING, so a reader never mistakes "nothing has
 * happened yet" for "something is missing". A recorded one shows who acted,
 * chronologically, with the host actor labelled in the reader's language.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ActivityTimeline } from '../src/client/activity-timeline.tsx'
import { classes } from '../src/client/style.ts'
import { t } from '../src/client/locales.ts'
import type { IdeaEvent } from '../src/core/ideas.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const history: IdeaEvent[] = [
  { at: Date.parse('2026-09-16T08:00:00.000Z'), verb: 'create', actor: 'human', summary: 'Captured as #1' },
  {
    at: Date.parse('2026-09-20T10:00:00.000Z'),
    verb: 'decline',
    actor: 'agent:plugin:ideas-manager:ai-capture',
    summary: 'Declined — superseded by the runtime',
  },
  { at: Date.parse('2026-09-21T09:00:00.000Z'), verb: 'launch', actor: 'run', summary: 'Execution started on the task card' },
]

async function renderTimeline(idea: { events?: IdeaEvent[] }): Promise<string> {
  await act(async () => {
    root.render(<ActivityTimeline idea={idea} />)
  })
  return container.textContent ?? ''
}

describe('ActivityTimeline', () => {
  it('prints the recorded history oldest first, with the count in the label', async () => {
    const text = await renderTimeline({ events: history })
    expect(container.querySelector(`.${classes.activity}`)).not.toBeNull()
    expect(text).toContain(t('activity.label', { count: 3 }))
    expect(text).toContain('Captured as #1')
    expect(text).toContain('Declined — superseded by the runtime')
    expect(text).toContain('Execution started on the task card')

    const summaries = [...container.querySelectorAll(`.${classes.activitySummary}`)].map(node => node.textContent)
    expect(summaries).toEqual(history.map(entry => entry.summary))
  })

  it('names the human and the run in the reader language, and an agent by its label', async () => {
    await renderTimeline({ events: history })
    const actors = [...container.querySelectorAll(`.${classes.activityActor}`)].map(node => node.textContent)
    expect(actors[0]).toBe(t('activity.human'))
    expect(actors[1]).toBe('plugin:ideas-manager:ai-capture')
    expect(actors[2]).toBe(t('activity.run'))
  })

  it('renders NOTHING for an idea that has recorded nothing', async () => {
    expect(await renderTimeline({ events: [] })).toBe('')
    expect(await renderTimeline({})).toBe('')
    expect(container.querySelector(`.${classes.activity}`)).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('stamps each entry with a machine-readable time', async () => {
    await renderTimeline({ events: history })
    const times = [...container.querySelectorAll('time')].map(node => node.getAttribute('datetime'))
    expect(times).toEqual(history.map(entry => new Date(entry.at).toISOString()))
  })
})