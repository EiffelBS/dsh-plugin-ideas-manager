/**
 * Card/row description preview (idea #34): every list surface - kanban card,
 * Priorities row, Delivered row - renders the SAME deferred-body teaser (the
 * list snapshot's body excerpt) through the shared markdown/raw toggle. The
 * full analysis is not part of the board snapshot anymore; it loads on
 * demand in the edit modal, the follow-up composer and the re-analyze flow.
 */

import { renderMarkdown } from './markdown.ts'
import { t } from './locales.ts'
import { classes } from './style.ts'

export interface IdeaPreviewProps {
  /** The list-view teaser (body excerpt); blank renders nothing. */
  excerpt: string
  /** Render as markdown (true) or raw text (false), like the rest of the board. */
  mdMode: boolean
  /** Open the shared edit modal (a link inside the rendered preview opens normally). */
  onEdit: () => void
}

/** One description preview block (null when there is nothing to show). */
export function IdeaPreview({ excerpt, mdMode, onEdit }: IdeaPreviewProps) {
  if (excerpt.trim() === '') return null
  if (mdMode) {
    return (
      <div
        className={`${classes.markdownBody} ${classes.bodyClickable}`}
        tabIndex={0}
        title={t('card.clickToEdit')}
        data-dsh-ideas-md=""
        dangerouslySetInnerHTML={{ __html: renderMarkdown(excerpt) }}
        onClick={event => {
          // A link inside the rendered preview opens the target; anything
          // else edits (kanban parity with the former full-body block).
          if ((event.target as HTMLElement).closest('a') !== null) return
          onEdit()
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onEdit()
          }
        }}
      />
    )
  }
  return (
    <div
      className={`${classes.cardBody} ${classes.bodyClickable}`}
      role="button"
      tabIndex={0}
      title={t('card.clickToEdit')}
      onClick={onEdit}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit()
        }
      }}
    >
      {excerpt}
    </div>
  )
}
