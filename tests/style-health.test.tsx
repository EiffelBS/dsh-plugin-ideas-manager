// @vitest-environment jsdom
/**
 * Stylesheet health tests (regression guard after a live "everything lost its
 * style" report): tsc CANNOT see inside the CSS template literal, so a
 * missing paren or brace would silently abort rules at parse time while every
 * type check stays green. These tests:
 *  1. balance braces/parens over the whole CSS_TEXT;
 *  2. inject the sheet and let jsdom PARSE it, then assert that every
 *     critical selector of the board (cards, tabs, tags, buttons, columns,
 *     filter row, settings rows) actually SURVIVED the parse — a rule missing
 *     here is a rule the browser would drop too, localizing the corruption.
 */

import { describe, expect, it } from 'vitest'
import { CSS_TEXT, ensureIdeasStyle } from '../src/client/style.ts'

describe('CSS_TEXT structural balance', () => {
  it('has balanced braces', () => {
    const open = (CSS_TEXT.match(/\{/g) ?? []).length
    const close = (CSS_TEXT.match(/\}/g) ?? []).length
    expect({ open, close }).toEqual({ open: close, close: open })
  })

  it('has balanced parentheses (a missing ) aborts the rest of the block)', () => {
    const open = (CSS_TEXT.match(/\(/g) ?? []).length
    const close = (CSS_TEXT.match(/\)/g) ?? []).length
    expect({ open, close }).toEqual({ open: close, close: open })
    // Per-line negative balance would mean a declaration swallowed the next
    // ones until a stray close — track the running balance.
    let balance = 0
    for (const [index, line] of CSS_TEXT.split('\n').entries()) {
      balance += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length
      expect({ line: index + 1, balance }).toEqual({ line: index + 1, balance: Math.max(balance, 0) })
    }
  })
})

describe('injected sheet parse (what the browser keeps)', () => {
  it('every critical board selector survives the CSS parse', () => {
    ensureIdeasStyle()
    const sheet = document.querySelector('style[data-plugin-css="dsh-plugin-ideas-manager/style"]')
    expect(sheet).not.toBeNull()
    // jsdom exposes cssRules and DROPS unparsable rules — mirror of the
    // browser behaviour.
    const rules = Array.from((sheet as HTMLStyleElement & { sheet: CSSStyleSheet }).sheet?.cssRules ?? [])
    const selectors = rules
      .map(rule => ('selectorText' in rule ? rule.selectorText : ''))
      .join('\n')
    for (const critical of [
      '.dsh-ideas-board',
      '.dsh-ideas-column',
      '.dsh-ideas-card',
      '.dsh-ideas-card-body',
      '.dsh-ideas-tabs',
      '.dsh-ideas-tab',
      '.dsh-ideas-tag',
      '.dsh-ideas-ghost-button',
      '.dsh-ideas-primary-button',
      '.dsh-ideas-action-button',
      '.dsh-ideas-tag-filter-row',
      '.dsh-ideas-tag-filter-header',
      '.dsh-ideas-tag-filter-chips',
      '.dsh-ideas-settings-section',
      '.dsh-ideas-settings-check',
      '.dsh-ideas-column-body',
    ]) {
      expect({ critical, present: selectors.includes(critical) })
        .toEqual({ critical, present: true })
    }
    // And the sheet parsed a plausible number of rules (a mass abort would
    // keep this far below the shipped count).
    expect(rules.length).toBeGreaterThan(80)
  })

  it('ships the compact-density hide rules (tags, description, date, workspace — kanban AND rows)', () => {
    for (const hide of [
      // Overview kanban cards.
      "[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-card-body",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-markdown-body",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-tag",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-workspace-chip",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-updated",
      // Priorities / Delivered rows.
      "[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row .dsh-ideas-card-body",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row .dsh-ideas-tag",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row .dsh-ideas-workspace-chip",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-delivered-stamp",
      "[data-dsh-ideas-density='compact'] .dsh-ideas-archived-stamp",
    ]) {
      expect({ hide, present: CSS_TEXT.includes(hide) }).toEqual({ hide, present: true })
    }
  })
})
