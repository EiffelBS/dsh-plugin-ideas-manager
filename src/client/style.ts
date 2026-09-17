/**
 * Ideas board stylesheet (plain CSS, injected once per page) and the class
 * map consumed by the sidebar core and the React board. Scoped by the
 * plugin's own data attributes so nothing leaks into the rest of the GUI;
 * colors ride the dsh --dsw-* tokens so the board follows the active theme
 * (light/dark and skins).
 */

/** Stable style-tag identity (one tag per page, idempotent). */
const STYLE_TAG_ID = 'dsh-plugin-ideas-manager/style'

const CSS_TEXT = `/* --- center-column takeover (global rules, attribute-scoped) --- */

[data-pane='conversation'],
[class*='centerCol'] {
  position: relative;
}

/*
 * Theme fallback palette. The shell always provides the --dsw-alias-* tokens,
 * but a skin-center skin may only redefine a subset — and a background-enabled
 * skin defines them as semi-transparent rgba that resolves to see-through
 * (alpha 0 when --dsw-skin-scrim is 0), which a var() fallback never fixes
 * because the token exists. These hard values mirror the shell's own boot
 * palette (light/dark switched the same way the shell does) and live on body
 * — not on the plugin container — so the sidebar entry, the board takeover and
 * the fixed modals all inherit them regardless of where they are mounted.
 */
body {
  --dsh-ideas-fb-bg: #ffffff;
  --dsh-ideas-fb-layer1: #f2f3f5;
  --dsh-ideas-fb-layer2: #e9eaed;
  --dsh-ideas-fb-layer3: #e0e2e5;
  --dsh-ideas-fb-border: #d3d6da;
  --dsh-ideas-fb-fg: #0f1115;
  --dsh-ideas-fb-fg-soft: #61666b;
  --dsh-ideas-fb-accent: #0f6fbe;
  --dsh-ideas-fb-accent-fg: #ffffff;
  --dsh-ideas-fb-danger: #d04a4a;
}

body[data-ds-dark-theme] {
  --dsh-ideas-fb-bg: #151517;
  --dsh-ideas-fb-layer1: #1c1c1f;
  --dsh-ideas-fb-layer2: #232327;
  --dsh-ideas-fb-layer3: #2a2a2f;
  --dsh-ideas-fb-border: #3a3a40;
  --dsh-ideas-fb-fg: #f9fafb;
  --dsh-ideas-fb-fg-soft: #cfd3d6;
  --dsh-ideas-fb-accent: #3b82f6;
  --dsh-ideas-fb-accent-fg: #0f1115;
  --dsh-ideas-fb-danger: #e5484d;
}

/* The board container rides inside the conversation grid item as an extra
   trailing child; hidden unless the ideas panel is active. */
[data-dsh-ideas-view] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  /* The skin token on top (a background-enabled skin defines every
     --dsw-alias-bg-* token as semi-transparent rgba, so the var() fallback
     never fires), the fixed fallback base underneath. The base stays
     translucent (70 %) so a wallpaper-owning skin keeps its look through
     the panel while the opaque fallback palette keeps text readable. The
     board child is transparent — this container alone carries the surface. */
  background:
    linear-gradient(var(--dsw-alias-bg-base, transparent), var(--dsw-alias-bg-base, transparent)),
    color-mix(in srgb, var(--dsh-ideas-fb-bg) 70%, transparent);
}

/* The center column is single-occupant; the :not() guard keeps the ideas and
   task-board panels from fighting over visibility. */
html[data-dsh-ideas-active]:not([data-dsh-taskboard-active]) [data-dsh-ideas-view] {
  display: block;
}

/* While the ideas board is active, the conversation content underneath stays
   mounted but hidden. The !important is required: the dsh shell wraps the
   conversation view in a node with an inline \`display: contents\`, and inline
   styles beat a plain stylesheet rule. */
html[data-dsh-ideas-active]:not([data-dsh-taskboard-active]) [data-pane='conversation'] > :not([data-dsh-ideas-view]),
html[data-dsh-ideas-active]:not([data-dsh-taskboard-active]) [class*='centerCol'] > :not([data-dsh-ideas-view]) {
  display: none !important;
}

/* --- sidebar entry row --- */

.dsh-ideas-entry {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.dsh-ideas-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-entry[data-active] {
  background: var(--dsw-alias-interactive-bg-active, var(--dsh-ideas-fb-layer2));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-weight: 600;
}

.dsh-ideas-entry-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
}

.dsh-ideas-entry-icon svg {
  display: block;
  width: 18px;
  height: 18px;
}

.dsh-ideas-entry-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Collapsed rail: icon-only, centered, matching the shell's 56px rail. */
[data-dsh-frame][data-sidebar-collapsed] .dsh-ideas-entry,
[data-sidebar-collapsed] .dsh-ideas-entry {
  justify-content: center;
  padding: 0;
  width: 36px;
  height: 36px;
  margin: 0 auto 12px;
  border-radius: 50%;
}

[data-dsh-frame][data-sidebar-collapsed] .dsh-ideas-entry-label,
[data-sidebar-collapsed] .dsh-ideas-entry-label {
  display: none;
}

/* --- board frame --- */

.dsh-ideas-board-view {
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-family: var(--dsw-font-family);
}

.dsh-ideas-board {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 14px 16px 16px;
  gap: 12px;
  /* The container [data-dsh-ideas-view] already carries the surface; the
     board itself stays transparent so its background cannot stack an extra
     opaque layer on top (which would kill the panel translucency). */
  background: transparent;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-family: var(--dsw-font-family);
}

.dsh-ideas-board-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.dsh-ideas-board-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  white-space: nowrap;
}

/* Rest-state surface for the "back to chat" button. The compound selector
   outranks the plain .dsh-ideas-ghost-button rule below it, so the button
   never looks like bare text under a skin (same issue the "New idea"
   button had). */
.dsh-ideas-ghost-button.dsh-ideas-back-button {
  /* Skin voile over the opaque base (same pattern as the card action
     pills), so the button follows the active skin yet always has a
     visible surface. */
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer2);
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  border-radius: 8px;
}

.dsh-ideas-ghost-button.dsh-ideas-back-button:hover {
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer3);
}

.dsh-ideas-detail-meta {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
  white-space: nowrap;
}

.dsh-ideas-search {
  margin-left: auto;
  width: 200px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
}

.dsh-ideas-primary-button,
.dsh-ideas-ghost-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: none;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.dsh-ideas-primary-button {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  color: var(--dsw-alias-label-primary-foreground, var(--dsh-ideas-fb-accent-fg));
  font-weight: 600;
}

.dsh-ideas-primary-button:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-ghost-button {
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-ghost-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-error {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-danger-bg, color-mix(in srgb, var(--dsw-alias-state-error-primary, var(--dsh-ideas-fb-danger)) 12%, transparent));
  color: var(--dsw-alias-danger-fg, var(--dsw-alias-state-error-primary, var(--dsh-ideas-fb-danger)));
  font-size: 12px;
}

/* --- columns --- */

.dsh-ideas-columns {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}

.dsh-ideas-column {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 240px;
  max-width: 420px;
  min-height: 0;
  border-radius: 10px;
  background: var(--dsw-alias-bg-subtle, var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1)));
  padding: 10px;
  gap: 8px;
}

.dsh-ideas-column-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 0 4px;
}

.dsh-ideas-column-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-column-count {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-column-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}

.dsh-ideas-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

/* --- cards --- */

.dsh-ideas-card {
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, var(--dsh-ideas-fb-border));
  /* Card surface: the skin card token over the opaque fallback layer. The
     base is stepped one tone DARKER than the column surface so cards read
     as raised slots (light shell shades the layer, dark shell pulls toward
     the darker page base — see the theme rules below). */
  background:
    linear-gradient(var(--dsw-alias-card-bg, var(--dsw-alias-bg-layer-2, transparent)), var(--dsw-alias-card-bg, var(--dsw-alias-bg-layer-2, transparent))),
    var(--dsh-ideas-fb-layer2);
  box-shadow: 0 1px 2px var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
}

/* Light shell: shade layer2 toward the (dark) foreground, roughly one step
   below layer1, so the card is a touch darker than its column. */
body:not([data-ds-dark-theme]) .dsh-ideas-card {
  background-color: color-mix(in srgb, var(--dsh-ideas-fb-layer2) 96%, var(--dsh-ideas-fb-fg));
}

/* Dark shell: elevation normally lightens upward, so pull the card DOWN
   toward the page base to make it darker than the column instead. */
body[data-ds-dark-theme] .dsh-ideas-card {
  background-color: color-mix(in srgb, var(--dsh-ideas-fb-layer2) 35%, var(--dsh-ideas-fb-bg));
}

/* Title row: the title grows, the drag grip stays put at the far right. */
.dsh-ideas-card-header {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.dsh-ideas-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  overflow-wrap: anywhere;
  flex: 1 1 0;
  min-width: 0;
}

/* Explicit drag grip: the only draggable zone of a card. The body stays
   selectable, so without a dedicated handle HTML5 drag would fight the text
   selection on mousedown. grab/grabbing follow the OS drag convention. */
.dsh-ideas-card-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}

.dsh-ideas-card-grip:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
}

.dsh-ideas-card-grip:active {
  cursor: grabbing;
}

.dsh-ideas-card-body {
  margin-top: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.dsh-ideas-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-tag {
  /* Per-name hue arrives inline as --dsh-ideas-tag-hue; mixing it with the
     surface keeps the pill visible on the card in both light and dark
     shells, unlike the old interactive-bg-active token (often transparent). */
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 16%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 75% 48%) 75%, var(--dsh-ideas-fb-fg));
  border: 1px solid color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 75% 52%) 38%, transparent);
  font-size: 11px;
}

.dsh-ideas-score {
  white-space: nowrap;
}

/* --- new-idea modal --- */

.dsh-ideas-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
}

.dsh-ideas-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(520px, 90vw);
  max-height: 85vh;
  overflow-y: auto;
  padding: 18px;
  border-radius: 12px;
  /* Fixed overlay over the whole page: same opaque-base treatment, so a
     translucent skin token never makes the form see-through. */
  background:
    linear-gradient(var(--dsw-alias-bg-layer-2, transparent), var(--dsw-alias-bg-layer-2, transparent)),
    var(--dsh-ideas-fb-layer2);
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.dsh-ideas-modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dsh-ideas-field-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-input,
.dsh-ideas-textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  font-family: inherit;
}

.dsh-ideas-textarea {
  min-height: 90px;
  resize: vertical;
}

.dsh-ideas-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dsh-ideas-field-row {
  display: flex;
  gap: 10px;
}

.dsh-ideas-field-row > .dsh-ideas-field {
  flex: 1 1 0;
}

/* --- P1 CRUD: filter chips, card actions, drag affordance --- */

.dsh-ideas-tag-filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: none;
}

.dsh-ideas-tag-filter-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-filter-chip,
.dsh-ideas-filter-chip-active {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
  cursor: pointer;
  /* Each chip carries the hue of its tag (--dsh-ideas-tag-hue, injected per
     chip like on the cards): soft tinted rest state, matching the tag color
     family. The border is the activation indicator — see -active below. */
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 12%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 75% 48%) 78%, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-filter-chip:hover {
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 18%, var(--dsh-ideas-fb-layer2));
}

.dsh-ideas-filter-chip-active {
  /* Active filter: full hue outline + stronger tint so the state reads
     at a glance, same hue as the chip's tag on the cards. */
  border-color: hsl(var(--dsh-ideas-tag-hue, 210) 78% 55%);
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 26%, var(--dsh-ideas-fb-layer2));
  color: hsl(var(--dsh-ideas-tag-hue, 210) 60% 30%);
  font-weight: 600;
}

body[data-ds-dark-theme] .dsh-ideas-filter-chip-active {
  color: hsl(var(--dsh-ideas-tag-hue, 210) 75% 72%);
}

.dsh-ideas-drag-hint {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-card-wrapper {
  /* Cards are drop targets (intra-column reorder); the drag source is the
     dedicated grip, which carries its own grab cursor. */
  cursor: default;
}

.dsh-ideas-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.dsh-ideas-action-button,
.dsh-ideas-danger-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: none;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
  /* Surface = the skin's interactive voile over the opaque fallback base.
     The --dsw-alias-interactive-bg-* tokens are translucent by design
     (shell + skins define them as rgba overlays), so on their own they are
     near-invisible; laid over the solid layer they tint the pill with the
     active skin/theme while keeping it readable. */
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer2);
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-action-button:hover {
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer3);
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-danger-button {
  color: var(--dsw-alias-state-error-primary, var(--dsh-ideas-fb-danger));
}

.dsh-ideas-danger-button:hover {
  /* The danger voile (also translucent) over the same opaque base. */
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-hover-danger, transparent), var(--dsw-alias-interactive-bg-hover-danger, transparent)),
    var(--dsh-ideas-fb-layer2);
}

/* Action icons: fixed size, never squeezed by the label. */
.dsh-ideas-action-button svg,
.dsh-ideas-danger-button svg {
  flex: none;
}

.dsh-ideas-confirm-label {
  font-size: 11px;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-weight: 600;
}
`

/** Class map consumed by the sidebar core and the board JSX. */
export const classes = {
  entry: 'dsh-ideas-entry',
  entryIcon: 'dsh-ideas-entry-icon',
  entryLabel: 'dsh-ideas-entry-label',
  boardView: 'dsh-ideas-board-view',
  board: 'dsh-ideas-board',
  boardHeader: 'dsh-ideas-board-header',
  boardTitle: 'dsh-ideas-board-title',
  backButton: 'dsh-ideas-back-button',
  detailMeta: 'dsh-ideas-detail-meta',
  search: 'dsh-ideas-search',
  primaryButton: 'dsh-ideas-primary-button',
  ghostButton: 'dsh-ideas-ghost-button',
  error: 'dsh-ideas-error',
  columns: 'dsh-ideas-columns',
  column: 'dsh-ideas-column',
  columnHeader: 'dsh-ideas-column-header',
  columnTitle: 'dsh-ideas-column-title',
  columnCount: 'dsh-ideas-column-count',
  columnBody: 'dsh-ideas-column-body',
  empty: 'dsh-ideas-empty',
  card: 'dsh-ideas-card',
  cardHeader: 'dsh-ideas-card-header',
  cardTitle: 'dsh-ideas-card-title',
  cardGrip: 'dsh-ideas-card-grip',
  cardBody: 'dsh-ideas-card-body',
  cardMeta: 'dsh-ideas-card-meta',
  tag: 'dsh-ideas-tag',
  score: 'dsh-ideas-score',
  overlay: 'dsh-ideas-overlay',
  modal: 'dsh-ideas-modal',
  modalTitle: 'dsh-ideas-modal-title',
  field: 'dsh-ideas-field',
  fieldRow: 'dsh-ideas-field-row',
  fieldLabel: 'dsh-ideas-field-label',
  input: 'dsh-ideas-input',
  textarea: 'dsh-ideas-textarea',
  modalActions: 'dsh-ideas-modal-actions',
  tagFilterRow: 'dsh-ideas-tag-filter-row',
  tagFilterLabel: 'dsh-ideas-tag-filter-label',
  filterChip: 'dsh-ideas-filter-chip',
  filterChipActive: 'dsh-ideas-filter-chip-active',
  dragHint: 'dsh-ideas-drag-hint',
  cardWrapper: 'dsh-ideas-card-wrapper',
  cardActions: 'dsh-ideas-card-actions',
  actionButton: 'dsh-ideas-action-button',
  dangerButton: 'dsh-ideas-danger-button',
  confirmLabel: 'dsh-ideas-confirm-label',
} as const

/** Inject the stylesheet once per page (idempotent, plugin-owned tag). */
export function ensureIdeasStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-ideas-manager'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS_TEXT
  document.head.appendChild(tag)
}
