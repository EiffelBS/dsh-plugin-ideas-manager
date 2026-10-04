/** Shared card-title projection tests for persistent idea numbers. */

import { describe, expect, it } from 'vitest'
import { formatIdeaTitle } from '../src/client/idea-title.tsx'

describe('formatIdeaTitle', () => {
  it('prefixes a persistent number exactly once', () => {
    expect(formatIdeaTitle(38, 'Afficher l’identifiant')).toBe('#38 Afficher l’identifiant')
    expect(formatIdeaTitle(38, '#38 Afficher l’identifiant')).toBe('#38 Afficher l’identifiant')
  })

  it('leaves historical records without a number unchanged', () => {
    expect(formatIdeaTitle(undefined, 'Legacy idea')).toBe('Legacy idea')
    expect(formatIdeaTitle(null as unknown as number, 'Legacy idea')).toBe('Legacy idea')
    expect(formatIdeaTitle(Number.NaN, 'Legacy idea')).toBe('Legacy idea')
  })

  it('keeps long titles intact after the prefix', () => {
    const title = 'A long title that remains the source text for ellipsis in the card layout'
    expect(formatIdeaTitle(7, title)).toBe(`#7 ${title}`)
  })
})
