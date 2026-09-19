/**
 * Shared DOM helpers for the HTML5 drag & drop used by both board surfaces
 * (the kanban columns and the Priorities ranking) so the insertion-point
 * semantics stay identical:
 * - the dragged idea id, read from the transfer payload (the task-board
 *   family contract) or the fallback state for browsers that do not share
 *   the payload with the drop target;
 * - the half of the hovered row/card the pointer is in, which decides
 *   whether the drop inserts before (upper half) or after (lower half) it.
 * Free of React state: each view supplies its own drop-at state.
 */

import type { DragEvent } from 'react'

/** Id of the dragged idea: the transfer payload first, then the fallback. */
export function draggedIdFrom(event: DragEvent<HTMLElement>, fallback: string | undefined): string | undefined {
  const transferId = event.dataTransfer.getData('text/plain')
  return transferId !== undefined && transferId !== '' ? transferId : fallback
}

/** True while the pointer sits in the upper half of `element`. */
export function beforeHalf(event: DragEvent<HTMLElement>, element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return event.clientY - rect.top < rect.height / 2
}