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
    siblingActiveAttribute: 'data-dsh-taskboard-active',
    panelName: 'ideas',
    siblingPanelName: 'taskboard',
    isOpen: () => client.boardOpen,
    close: () => client.closeBoard(),
    subscribe: listener => client.subscribe(listener),
  })
}
