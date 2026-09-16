/**
 * Sidebar entry injection — package-specific wiring over the shared core.
 *
 * The row is injected between the shell's New Session button (or the
 * task-board row, when that plugin is active) and the workspace browser; see
 * sidebar-entry-core.ts for the self-healing DOM logic. It is plain DOM (no
 * React tree); the board view it toggles is a separate React root mounted in
 * the center column (see board-mount.tsx).
 */

import type { IdeasClient } from './ideas-client.ts'
import { t } from './locales.ts'
import { mountSidebarEntry as mountSharedSidebarEntry } from './sidebar-entry-core.ts'
import { classes } from './style.ts'

/** Stable data attribute identifying the injected entry row. */
export const ENTRY_SELECTOR = '[data-dsh-ideas-entry]'

/** Inline icon normalized to the shell's 18px navigation glyph size. */
const ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5a4.3 4.3 0 0 0-2.1 8c.5.3.8.8.8 1.4v.6h2.6v-.6c0-.6.3-1.1.8-1.4A4.3 4.3 0 0 0 8 1.5Z"/><path d="M6.6 13h2.8M6.9 14.5h2.2"/></svg>'

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param client - the ideas client the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(client: IdeasClient): () => void {
  return mountSharedSidebarEntry({
    rowAttribute: 'data-dsh-ideas-entry',
    rowSelector: ENTRY_SELECTOR,
    plugin: 'ideas',
    icon: ICON,
    css: classes,
    label: () => t('entry.label'),
    tooltip: () => t('entry.tooltip'),
    onToggle: () => { client.toggleBoard() },
    // 'after' orders the ideas row under the task-board / ssh rows when those
    // plugins are active, directly under New Session when they are not.
    position: 'after',
    familySelectors: ['[data-dsh-ideas-entry]', '[data-dsh-taskboard-entry]', '[data-dsh-ssh-entry]'],
    active: {
      subscribe: (listener) => client.subscribe(listener),
      isOpen: () => client.boardOpen,
    },
  })
}
