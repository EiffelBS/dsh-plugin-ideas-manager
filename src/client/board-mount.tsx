/**
 * Board view mounting: injects the ideas board React tree into the center
 * column and binds its visibility to the client's boardOpen state, through
 * the shared single-occupant takeover core (panel-mount-core.ts). The
 * attribute names are pinned by style.ts and the semantic-attributes
 * contract.
 */

import type { IdeasClient } from './ideas-client.ts'
import { mountCenterPanel } from './panel-mount-core.ts'
import { IdeasBoard } from './board-view.tsx'
import { classes } from './style.ts'

/** The injected board container (kept in the DOM, hidden when inactive). */
export const BOARD_VIEW_SELECTOR = '[data-dsh-ideas-view]'

/**
 * Mount the board React tree into the center column and bind its visibility
 * to the client's boardOpen state.
 * @param client - the ideas client driving the view.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountBoard(client: IdeasClient): () => void {
  return mountCenterPanel({
    render: root => root.render(<IdeasBoard client={client} />),
    viewDatasetKey: 'dshIdeasView',
    pluginName: 'ideas',
    viewClassName: classes.boardView,
    activeAttribute: 'data-dsh-ideas-active',
    // Every family sibling's attribute is removed on open, not just the
    // task-board's: the upstream taskboard<->ssh contract only clears that
    // one attribute, so a stale ssh attribute would fight the ideas
    // stylesheet and blank the center column.
    siblingActiveAttributes: ['data-dsh-taskboard-active', 'data-dsh-ssh-active'],
    panelName: 'ideas',
    // Close on every sibling activation, not only the task-board: the ssh
    // broadcast would otherwise leave this controller open on top of the
    // ssh panel.
    siblingPanelNames: ['taskboard', 'ssh'],
    // The upstream pair closes on the OTHER member's panel name ('ssh'
    // closes the task-board, 'taskboard' closes ssh), so broadcast both on
    // open: each currently-open sibling's controller then self-closes and
    // cannot re-assert its active attribute on the next host tick (which
    // would evict this board minutes later).
    evictDetails: ['ssh', 'taskboard'],
    isOpen: () => client.boardOpen,
    close: () => client.closeBoard(),
    subscribe: listener => client.subscribe(listener),
  })
}
