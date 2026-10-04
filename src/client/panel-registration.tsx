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

import { useEffect, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { IdeasClient } from './ideas-client.ts'
import { IdeasBoard } from './board-view.tsx'
import { classes } from './style.ts'
import { panelReviewScope, underReviewCountOf } from './review-count.ts'
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
 * The client the panel row reads its badge from.
 *
 * Module-scoped because the shell hands the glyph component only its own
 * `{size, active}` props — there is no injection path into a `panellist` icon,
 * and `slots.register` takes the component by value rather than as a factory.
 * One module owns one panel row, so a module-level handle is the same scoping
 * the rest of this file already uses (`IdeasPanel` gets its client the same
 * way, from the registration closure); it is set and cleared with the
 * registration itself, never longer.
 */
let panelClient: IdeasClient | undefined

/**
 * The number of ideas waiting in the review gate, read through the client's own
 * subscription (part B).
 *
 * `useSyncExternalStore` over the client rather than a prop: the sidebar row
 * lives outside the board's React tree, and the shell re-renders this glyph
 * only when the panel list or the selection changes — a number that moved only
 * when a run settled would otherwise stay frozen at whatever it was when the
 * row last drew. The store read is a primitive number derived from the list
 * snapshot the poll already refreshes, so there is no new timer and no extra
 * request. With the board CLOSED that snapshot is as stale as every other part
 * of the panel (the poll is gated on the board being open), which is the
 * accepted trade: a badge that costs one request per open board is not a badge.
 *
 * Returns 0 when nothing is waiting — the badge is drawn by that absence, not
 * by an explicit zero, so an idle board wears no mark at all.
 */
function useReviewCount(): number {
  const client = panelClient
  return useSyncExternalStore(
    onChange => (client === undefined ? () => {} : client.subscribe(onChange)),
    () => (client === undefined ? 0 : underReviewCountOf(client.snapshot?.ideas, panelReviewScope(client.config.value))),
    () => 0,
  )
}

/**
 * The sidebar row glyph the shell asks for, at its own size and active state.
 * The shell owns the button, the label, the tooltip and the rail geometry;
 * this component draws only the glyph, like every other panel row.
 *
 * The glyph carries `data-dsh-panel-entry` because it is the only DOM this
 * plugin owns inside that shell-owned row: the L2 contract (skins) resolves
 * which row belongs to which plugin through it, the shell stamping no
 * per-entry hook of its own.
 *
 * A non-zero review count adds a small pill to the glyph's top-right corner
 * (`overflow: visible` lets it paint outside the 16px box, which is how a
 * badged nav icon is expected to look). The shell's panel-row contract has no
 * badge seat and takes no badge prop, so the glyph is the honest place to put
 * it rather than taking the row's DOM back.
 * @param props - the shell's icon share: square edge and selection state.
 * @returns the decorative ideas glyph.
 */
export function IdeasPanelIcon({ size, active }: { size: number; active: boolean }) {
  const toReview = useReviewCount()
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
      style={toReview > 0 ? { overflow: 'visible' } : undefined}
    >
      <path d="M8 1.5a4.3 4.3 0 0 0-2.1 8c.5.3.8.8.8 1.4v.6h2.6v-.6c0-.6.3-1.1.8-1.4A4.3 4.3 0 0 0 8 1.5Z" />
      <path d="M6.6 13h2.8M6.9 14.5h2.2" />
      {toReview > 0 && (
        <g data-dsh-ideas-review-count={toReview}>
          {/* The pill is drawn in a scaled sub-group so its 8px type reads at
              the 16-18px the shell asks for, and the anchor (9,-1) puts it on
              the corner instead of over the bulb. */}
          <g transform="translate(9.4 -1.2) scale(0.72)">
            <rect
              x="0"
              y="0"
              width={badgeWidth(toReview)}
              height="11"
              rx="5.5"
              fill="hsl(38 92% 45%)"
              stroke="none"
            />
            <text
              x={badgeWidth(toReview) / 2}
              y="8.4"
              textAnchor="middle"
              fill="#fff"
              stroke="none"
              fontSize="9"
              fontWeight="700"
            >
              {toReview > 99 ? '99+' : toReview}
            </text>
          </g>
          <title>{t('entry.reviewCountHint', { count: toReview })}</title>
        </g>
      )}
    </svg>
  )
}

/**
 * Pill width for a count, in the badge's own units: two round end-caps plus
 * roughly half a glyph per digit, so 1 and 12 both fit their pill instead of
 * overflowing it.
 */
function badgeWidth(count: number): number {
  const digits = count > 99 ? 3 : String(count).length
  return 11 + digits * 5.4
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
  // The review badge reads the client through the module handle; set for the
  // lifetime of this registration only (the disposer clears it), so a
  // re-registered panel never renders a badge from a disposed client.
  panelClient = client
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
    if (panelClient === client) panelClient = undefined
  }
}
