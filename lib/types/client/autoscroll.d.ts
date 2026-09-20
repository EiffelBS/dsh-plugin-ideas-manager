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
import type { DragEvent } from 'react';
/** Call when a drag starts to arm the auto-scroll state. */
export declare function dragAutoscrollBegin(): void;
/** Feed the latest pointer/containers state from an onDragOver handler. The
 *  containers are the scrollable surfaces under the pointer; whatever can
 *  scroll is scrolled (vertical bodies, horizontal columns wrapper, ...). */
export declare function dragAutoscrollTrack(event: DragEvent, ...els: HTMLElement[]): void;
/** Call on drag end or drop to disarm and stop any running scroll. */
export declare function dragAutoscrollEnd(): void;
