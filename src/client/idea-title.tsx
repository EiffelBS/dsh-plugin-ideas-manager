/** Shared card-title rendering for the persistent idea number. */

import { classes } from './style.ts'

/** Return true only for a finite persistent ledger number. */
function hasIdeaNumber(ideaNumber: number | undefined): ideaNumber is number {
  return typeof ideaNumber === 'number' && Number.isFinite(ideaNumber)
}

/** Avoid adding the same persistent prefix twice to legacy/imported titles. */
function alreadyPrefixed(title: string, ideaNumber: number): boolean {
  return new RegExp(`^#${ideaNumber}(?:\\s|$)`).test(title)
}

/**
 * Format an idea title with its persistent ledger number when available.
 * Missing numbers remain silent for historical records.
 */
export function formatIdeaTitle(ideaNumber: number | undefined, title: string): string {
  if (!hasIdeaNumber(ideaNumber) || alreadyPrefixed(title, ideaNumber)) return title
  return `#${ideaNumber} ${title}`
}

export interface IdeaTitleProps {
  ideaNumber?: number
  title: string
}

/** Shared title fragment used by Overview, Priorities and Delivered cards. */
export function IdeaTitle({ ideaNumber, title }: IdeaTitleProps) {
  if (!hasIdeaNumber(ideaNumber) || alreadyPrefixed(title, ideaNumber)) return <>{title}</>
  return (
    <>
      <span className={classes.cardNumber}>#{ideaNumber}</span>
      {title}
    </>
  )
}
