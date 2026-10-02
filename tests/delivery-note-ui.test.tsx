// @vitest-environment jsdom
/**
 * Delivery note rendering (idea #91) in jsdom.
 *
 * The harvest side is host behaviour (see delivery-note.test.ts); this covers
 * the promise the UI makes about it — a run that left nothing must SAY so, in
 * every review-gate surface, and a run still in flight or failed must show no
 * note block at all rather than an empty one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DeliveryNote } from '../src/client/delivery-note.tsx'
import { classes } from '../src/client/style.ts'
import { t } from '../src/client/locales.ts'

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

/** Render one note block and return its text. */
async function renderNote(idea: { runStatus?: 'running' | 'done' | 'failed'; deliveryNote?: string }): Promise<string> {
  await act(async () => {
    root.render(<DeliveryNote idea={idea} />)
  })
  return container.textContent ?? ''
}

describe('DeliveryNote', () => {
  it('prints the harvested text for a finished run', async () => {
    const text = await renderNote({ runStatus: 'done', deliveryNote: 'Delivered the harvest and its tests.' })
    expect(text).toContain(t('card.deliveryNote'))
    expect(text).toContain('Delivered the harvest and its tests.')
    expect(container.querySelector(`.${classes.deliveryNoteText}`)?.textContent).toBe('Delivered the harvest and its tests.')
    expect(container.querySelector(`.${classes.deliveryNoteEmpty}`)).toBeNull()
  })

  it('says so when a finished run left nothing, instead of rendering an empty box', async () => {
    const text = await renderNote({ runStatus: 'done' })
    expect(text).toContain(t('card.deliveryNoteEmpty'))
    expect(container.querySelector(`.${classes.deliveryNoteText}`)).toBeNull()
    // A blank stored note is an absence too, not an empty paragraph.
    await act(async () => { root.render(<DeliveryNote idea={{ runStatus: 'done', deliveryNote: '   ' }} />) })
    expect(container.querySelector(`.${classes.deliveryNoteEmpty}`)?.textContent).toBe(t('card.deliveryNoteEmpty'))
  })

  it('renders nothing at all for a run in flight, failed, or absent', async () => {
    for (const runStatus of ['running', 'failed', undefined] as const) {
      await act(async () => { root.render(<DeliveryNote idea={{ runStatus, deliveryNote: 'stale text' }} />) })
      expect(container.querySelector(`.${classes.deliveryNote}`)).toBeNull()
    }
  })
})