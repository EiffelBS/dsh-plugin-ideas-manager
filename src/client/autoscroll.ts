/**
 * Auto-scroll while dragging (vertical AND horizontal).
 *
 * Standard HTML5 drag & drop does not scroll a container when the pointer
 * reaches the edge of a scrollable element whose drop target is off-screen —
 * the user must fight the scrollbar, which is exactly the complaint that
 * motivated this helper. A drag toward an off-screen drop target scrolls the
 * container by itself while the pointer hovers the edge band, so:
 *   • dragging a card to the bottom/top of a long open column scrolls it.
 *   • on a narrow window, dragging an Open card toward the Declined column
 *     (which is off-screen to the right) scrolls the columns left/right.
 *
 * Each axis (vertical top/bottom, horizontal left/right) is armed only when
 * that axis can actually scroll (content overflows). The band is 44 px, and
 * the scroll step grows with how deep the pointer reaches into the band.
 *
 * API: call `dragAutoscrollBegin()` when a drag starts, feed
 * `dragAutoscrollTrack(event, container)` from the container's onDragOver
 * (a scrollable surface or an ancestor), and `dragAutoscrollEnd()` on drag
 * end or drop. A single module-level timer drives the scroll so it updates
 * real-time even between two dragover dispatch bursts, which some browsers
 * fire coarsely.
 */

import type { DragEvent } from 'react'

/** Height/width of the scroll-trigger band at each edge, in px. */
const EDGE_PX = 44
/** Max scroll distance per timer tick, in px. */
const MAX_STEP = 16
/** Timer cadence while hovering an edge band, in ms. */
const INTERVAL_MS = 16

interface DragPointer {
  x: number
  y: number
}

let active = false
/** Scrollable surfaces under the pointer. Usually one, but the kanban drag
 *  hovers two: the columns wrapper (horizontal) and a column body (vertical).
 *  The tick scrolls each axis through the first candidate able to do it. */
let containers: HTMLElement[] = []
let pointer: DragPointer | undefined
let timer: ReturnType<typeof setInterval> | undefined

function stopTimer(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

/** Scroll a candidate that can actually scroll on the given axis. */
function axisStep(
  el: HTMLElement,
  axis: 'x' | 'y',
): number {
  const rect = el.getBoundingClientRect()
  if (axis === 'y') {
    if (el.scrollHeight <= el.clientHeight || pointer === undefined) return 0
    const topIn = pointer.y - rect.top
    const bottomIn = rect.bottom - pointer.y
    if (topIn <= EDGE_PX) return -Math.min(MAX_STEP, Math.ceil((EDGE_PX - topIn) / 3))
    if (bottomIn <= EDGE_PX) return Math.min(MAX_STEP, Math.ceil((EDGE_PX - bottomIn) / 3))
    return 0
  }
  if (el.scrollWidth <= el.clientWidth || pointer === undefined) return 0
  const leftIn = pointer.x - rect.left
  const rightIn = rect.right - pointer.x
  if (leftIn <= EDGE_PX) return -Math.min(MAX_STEP, Math.ceil((EDGE_PX - leftIn) / 3))
  if (rightIn <= EDGE_PX) return Math.min(MAX_STEP, Math.ceil((EDGE_PX - rightIn) / 3))
  return 0
}

/** How much to scroll now, per axis; cancels the timer when idle. */
function tick(): void {
  if (!active || containers.length === 0 || pointer === undefined) return
  // First container able to scroll on each axis drives that axis' step.
  let top = 0
  let left = 0
  let topEl: HTMLElement | undefined
  let leftEl: HTMLElement | undefined
  for (const el of containers) {
    const step = axisStep(el, 'y')
    if (step !== 0) { top = step; topEl = el; break }
  }
  for (const el of containers) {
    const step = axisStep(el, 'x')
    if (step !== 0) { left = step; leftEl = el; break }
  }
  if (top === 0 && left === 0) {
    stopTimer()
    return
  }
  if (topEl !== undefined) topEl.scrollBy({ top, left: 0, behavior: 'auto' })
  if (leftEl !== undefined) leftEl.scrollBy({ top: 0, left, behavior: 'auto' })
}

/** Call when a drag starts to arm the auto-scroll state. */
export function dragAutoscrollBegin(): void {
  active = true
}

/** Feed the latest pointer/containers state from an onDragOver handler. The
 *  containers are the scrollable surfaces under the pointer; whatever can
 *  scroll is scrolled (vertical bodies, horizontal columns wrapper, ...). */
export function dragAutoscrollTrack(event: DragEvent, ...els: HTMLElement[]): void {
  if (!active) return
  containers = els.filter(el => el !== null)
  pointer = { x: event.clientX, y: event.clientY }
  const inBand = els.some(el => {
    const rect = el.getBoundingClientRect()
    return event.clientY - rect.top <= EDGE_PX
      || rect.bottom - event.clientY <= EDGE_PX
      || event.clientX - rect.left <= EDGE_PX
      || rect.right - event.clientX <= EDGE_PX
  })
  if (inBand && timer === undefined) {
    timer = setInterval(tick, INTERVAL_MS)
  } else if (!inBand) {
    stopTimer()
  }
}

/** Call on drag end or drop to disarm and stop any running scroll. */
export function dragAutoscrollEnd(): void {
  active = false
  containers = []
  pointer = undefined
  stopTimer()
}