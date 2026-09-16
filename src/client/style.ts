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

/* The board container rides inside the conversation grid item as an extra
   trailing child; hidden unless the ideas panel is active. */
[data-dsh-ideas-view] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base);
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
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.dsh-ideas-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.dsh-ideas-entry[data-active] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
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
  color: var(--dsw-alias-label-primary);
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
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
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
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}

.dsh-ideas-back-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
}

.dsh-ideas-detail-meta {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}

.dsh-ideas-search {
  margin-left: auto;
  width: 200px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-strong);
  background: var(--dsw-alias-input-bg);
  color: var(--dsw-alias-label-primary);
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
  background: var(--dsw-alias-accent-bg);
  color: var(--dsw-alias-accent-fg, #fff);
  font-weight: 600;
}

.dsh-ideas-ghost-button {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}

.dsh-ideas-ghost-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.dsh-ideas-error {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-danger-bg, rgba(220, 60, 60, 0.12));
  color: var(--dsw-alias-danger-fg, #d04a4a);
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
  background: var(--dsw-alias-bg-subtle, var(--dsw-alias-bg-base));
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
  color: var(--dsw-alias-label-primary);
}

.dsh-ideas-column-count {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
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
  color: var(--dsw-alias-label-tertiary);
}

/* --- cards --- */

.dsh-ideas-card {
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-weak);
  background: var(--dsw-alias-card-bg, var(--dsw-alias-bg-base));
  cursor: default;
}

.dsh-ideas-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.dsh-ideas-card-body {
  margin-top: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
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
  color: var(--dsw-alias-label-tertiary);
}

.dsh-ideas-tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-secondary);
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
  background: rgba(0, 0, 0, 0.45);
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
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-strong);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.dsh-ideas-modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary);
}

.dsh-ideas-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dsh-ideas-field-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-ideas-input,
.dsh-ideas-textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-strong);
  background: var(--dsw-alias-input-bg);
  color: var(--dsw-alias-label-primary);
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
  cardTitle: 'dsh-ideas-card-title',
  cardBody: 'dsh-ideas-card-body',
  cardMeta: 'dsh-ideas-card-meta',
  tag: 'dsh-ideas-tag',
  score: 'dsh-ideas-score',
  overlay: 'dsh-ideas-overlay',
  modal: 'dsh-ideas-modal',
  modalTitle: 'dsh-ideas-modal-title',
  field: 'dsh-ideas-field',
  fieldLabel: 'dsh-ideas-field-label',
  input: 'dsh-ideas-input',
  textarea: 'dsh-ideas-textarea',
  modalActions: 'dsh-ideas-modal-actions',
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
