/**
 * Native panel registration for the Ideas board.
 *
 * The board is an official-style center-column panel, not a DOM takeover: it
 * contributes a row into the sidebar shell's own global panel list
 * (`sidebar.panellist`) and its page into the layout's keyed `main` slot. The
 * shell then owns the row box, the label, the font, the active highlight, the
 * collapsed rail and the panel switch, exactly as it does for Plugins, Task
 * Board and Skill Center.
 *
 * This replaces a raw injected `<button>` plus a self-owned visibility flag.
 * That arrangement is why Ideas behaved like a toggle — selecting another panel
 * never closed it, because the shell did not know the row existed — and why its
 * label and glyph did not match the shipped rows. With the seats, the shell is
 * the single source of panel truth, so the eviction broadcasts the old path
 * needed (ideas <-> taskboard <-> ssh) are gone with it.
 *
 * Both registrations go through `ctx.slots.inject`, which fires only once the
 * owning shell entry has declared the seat: load order between this plugin and
 * ui-layout / ui-sidebar does not matter, and a shell that cannot serve the
 * seats simply leaves Ideas absent instead of failing the boot.
 */

import { useEffect } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { IdeasClient } from './ideas-client.ts'
import { IdeasBoard } from './board-view.tsx'
import { classes } from './style.ts'
import { IDEAS_PANEL_ID } from './panel-navigation.ts'
import { t } from './locales.ts'

/** Row order among the shell's global panel rows (Plugins 0, Schedule 10, Task Board 20). */
const PANEL_ORDER = 30

/**
 * How long to wait before calling a shell that never declared the seats
 * abnormal. Seat declaration is immediate in a healthy shell, so a longer
 * silence means the board will simply not appear.
 */
const SEAT_WAIT_MS = 10_000

/**
 * The sidebar row glyph the shell asks for, at its own size and active state.
 * The shell owns the button, the label, the tooltip and the rail geometry;
 * this component draws only the glyph, like every other panel row.
 *
 * The glyph carries `data-dsh-panel-entry` because it is the only DOM this
 * plugin owns inside that shell-owned row: the L2 contract (skins) resolves
 * which row belongs to which plugin through it, the shell stamping no
 * per-entry hook of its own.
 * @param props - the shell's icon share: square edge and selection state.
 * @returns the decorative ideas glyph.
 */
export function IdeasPanelIcon({ size }: { size: number; active: boolean }) {
  return (
    <svg
      data-dsh-panel-entry={IDEAS_PANEL_ID}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5a4.3 4.3 0 0 0-2.1 8c.5.3.8.8.8 1.4v.6h2.6v-.6c0-.6.3-1.1.8-1.4A4.3 4.3 0 0 0 8 1.5Z" />
      <path d="M6.6 13h2.8M6.9 14.5h2.2" />
    </svg>
  )
}

/**
 * The main-slot page. The layout mounts it only while the board is the
 * selected panel, so the conversation keeps the center column untouched the
 * rest of the time, and the wrapper carries the pinned `data-dsh-ideas-view`
 * semantic anchor the stylesheet and the L2 skin contract key on.
 *
 * Mount/unmount is also how the client learns the panel is shown or hidden:
 * `panelShown` / `panelHidden` mirror it onto `boardOpen`, which gates the
 * background poll (a closed board holds no connections and no traffic).
 * @param props - this entry's injected face: the ideas client.
 * @returns the board page.
 */
export function IdeasPanel({ client }: { client: IdeasClient }) {
  useEffect(() => {
    client.panelShown()
    return () => { client.panelHidden() }
  }, [client])
  return (
    <div className={classes.boardView} data-dsh-ideas-view="" data-dsh-plugin="ideas">
      <IdeasBoard client={client} />
    </div>
  )
}

/**
 * Register the board's sidebar row and center-column page.
 *
 * A shell that declares neither seat leaves Ideas simply absent, which is the
 * documented degradation — but silence is a bad diagnostic, so an unclaimed
 * seat is logged once rather than leaving the board to "just not be there".
 * @param ctx - client root context (services: slots).
 * @param client - the ideas client the panel renders.
 * @returns a disposer releasing both registrations and the watchdog.
 */
export function registerIdeasPanel(ctx: ClientContext, client: IdeasClient): () => void {
  const slots = (ctx as unknown as Record<string, unknown>).slots as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  let declared = 0
  /** Claim one seat, counting the ones the shell actually declares. */
  const seat = (key: string, contribute: () => () => void): (() => void) =>
    slots.inject(key, () => {
      declared += 1
      return contribute()
    })

  const disposers = [
    seat('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist',
      id: IDEAS_PANEL_ID,
      order: PANEL_ORDER,
      // The shell resolves this through its own label lookup on every locale
      // change, so the thunk is read at call time, never captured.
      label: () => t('entry.label'),
    }, IdeasPanelIcon)),
    seat('main', () => slots.register({
      name: 'main',
      key: IDEAS_PANEL_ID,
      inject: () => ({ client }),
    }, IdeasPanel)),
  ]

  const watchdog = setTimeout(() => {
    if (declared === 0) {
      console.warn(
        '[dsh-plugin-ideas-manager] no shell panel seat was declared ' +
        '(sidebar.panellist / main): the Ideas board will not appear.',
      )
    }
  }, SEAT_WAIT_MS)

  return () => {
    clearTimeout(watchdog)
    for (const dispose of disposers) dispose()
  }
}
