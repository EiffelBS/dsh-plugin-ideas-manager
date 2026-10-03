/**
 * Shell contract: the host facts this plugin's cross-panel navigation reads.
 *
 * The gear does NOT use a sanctioned API — the shell exposes none — so it reads
 * the host's own DOM. That makes it hostage to upstream markup: both
 * regressions in this area (the Desktop account menu replacing the Settings
 * button, a renamed aria-label) are silent, because a selector that stops
 * matching only logs a `console.warn` at click time, in production, on one
 * profile.
 *
 * This suite pins the contract to the REAL installed artifacts rather than to
 * hand-written fixtures, so an upstream release that moves any of it fails
 * here instead of in a click. Each fact is deliberately narrow and each
 * failure message names the profile and the remedy.
 *
 * Sources, in the order they are trusted:
 *  - `<DSH_HOME>/profiles/<profile>/node_modules/<pkg>/lib/client.js` — the shell
 *    and plugin bundles a profile actually runs. `web` carries the whole set;
 *    `desktop` carries the task-board plugin but resolves the settings shell
 *    from the bundled runtime instead.
 *  - the Desktop `app.asar` (`dsh\node_modules\...`) — the REAL bytes the
 *    Desktop shell runs, read through the `asar` module when it is installed.
 *
 * A source that is absent (CI, a machine without that profile, no asar) is
 * SKIPPED, never failed: the point is to pin what this machine runs.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** One host fact, and the exact substrings that prove it. */
interface Fact {
  /** Stable id, used in the failure message. */
  id: string
  /** Package whose client bundle carries the fact. */
  pkg: string
  /** Substrings that must all be present. */
  needles: readonly string[]
  /** What to do when it is gone. */
  remedy: string
}

const SETTINGS_GENERAL = '@deepseek-ai/dsh-client-ui-settings-general'
const SETTINGS_ACCOUNT = '@deepseek-ai/dsh-client-ui-settings-account'
const TASK_BOARD = '@linxin666/dsh-client-ui-task-board'

const FACTS: readonly Fact[] = [
  {
    id: 'the Settings dialog trigger: our primary (web) path',
    pkg: SETTINGS_GENERAL,
    needles: ['"aria-haspopup": "dialog"', '"aria-label": t("trigger")', '"trigger": "Settings"', '"trigger": "设置"'],
    remedy: 'settings-navigation.ts must learn the shell\'s new settings launcher',
  },
  {
    id: 'the settings nav rows are buttons inside a nav rail: our section click',
    pkg: SETTINGS_GENERAL,
    // Pinned on CSS-module class names, not on the emitted call shape: the
    // bundler rewrites `jsx` to `(0, react_jsx_runtime.jsx)`, so a call-form
    // needle would fail on a rebuild that changed nothing observable.
    needles: [
      'className: SettingsRoot_module_css_default.nav,',
      'className: SettingsRoot_module_css_default.navList',
      'SettingsRoot_module_css_default.navCell',
    ],
    remedy: 'findIdeasSettingsNavRow() queries "nav button" and will no longer match',
  },
  {
    id: 'the account menu that replaces that trigger: our Desktop path',
    pkg: SETTINGS_ACCOUNT,
    needles: [
      'ctx.slots.inject("settings.launcher"',
      '"aria-haspopup": "menu"',
      'menu: "Account menu"',
      'menu: "账号菜单"',
      'settings: "Settings"',
      'settings: "设置"',
    ],
    remedy: 'the gear must be taught the new launcher labels/shape',
  },
  {
    // Idea #105 removed the only DOM dependency this plugin had on the
    // task-board: the permission-gate redirect is a deep-link to OUR card, and
    // the TaskBoard panel is selected through the shell's own layout face. The
    // one assumption left is the panel id that face selects — nothing else of
    // that package's markup is read.
    id: 'the TaskBoard panel id our "Open the TaskBoard" selects',
    pkg: TASK_BOARD,
    needles: ['TASK_BOARD_PANEL_ID = "task-board"'],
    remedy: 'IdeasClient.openTaskBoard() selects a panel id the TaskBoard no longer registers',
  },
]

/** Read a client bundle from a profile, or undefined when it is not installed. */
function readFromProfile(profile: string, pkg: string): string | undefined {
  const file = join(DSH_HOME, 'profiles', profile, 'node_modules', ...pkg.split('/'), 'lib', 'client.js')
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8')
}

/** The Desktop app.asar, when this machine has it. */
function desktopAsar(): string | undefined {
  const candidates = [
    process.env.DSH_DESKTOP_ASAR,
    'E:/DeepSeek Harness Desktop/resources/app.asar',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness Desktop', 'resources', 'app.asar'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((file) => existsSync(file))
}

/**
 * Read a client bundle from the Desktop runtime inside app.asar, or undefined.
 * The path form matters: on Windows `asar.extractFile` needs BACKSLASHES and NO
 * leading slash; the forward-slash form throws on the path split.
 */
function readFromAsar(pkg: string): string | undefined {
  const archive = desktopAsar()
  if (archive === undefined) return undefined
  const require = createRequire(import.meta.url)
  let asar: { extractFile(archive: string, file: string): Buffer }
  try {
    // Installed globally next to the `dsh` CLI; absent in CI, hence the skip.
    asar = require(join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'asar'))
  } catch {
    return undefined
  }
  const scoped = pkg.includes('/') ? pkg.replace('/', '\\') : pkg
  try {
    return asar.extractFile(archive, `dsh\\node_modules\\${scoped}\\lib\\client.js`).toString('utf8')
  } catch {
    return undefined
  }
}

/** Assert every fact against one bundle, naming the source in any failure. */
function checkFacts(source: string, text: string | undefined, facts: readonly Fact[]): void {
  for (const fact of facts) {
    if (text === undefined) {
      it.skip(`${fact.id} [${source}: ${fact.pkg} not installed]`, () => {})
      continue
    }
    it(`${fact.id} [${source}]`, () => {
      const missing = fact.needles.filter((needle) => !text.includes(needle))
      expect(
        missing,
        `${source} / ${fact.pkg}: ${fact.remedy}` +
        (missing.length === 0 ? '' : `\nmissing: ${missing.map((n) => JSON.stringify(n)).join(', ')}`),
      ).toEqual([])
    })
  }
}

describe('shell contract: cross-panel navigation hooks', () => {
  describe('web profile (the 3080 shell bundle set)', () => {
    for (const fact of FACTS) {
      const text = readFromProfile('web', fact.pkg)
      it(`${fact.id} [web]`, () => {
        if (text === undefined) {
          // Not a failure: a machine without that profile simply proves nothing.
          return
        }
        const missing = fact.needles.filter((needle) => !text.includes(needle))
        expect(missing, `web / ${fact.pkg}: ${fact.remedy}`).toEqual([])
      })
    }
  })

  describe('desktop profile (task-board plugin bundle)', () => {
    const fact = FACTS.find((row) => row.pkg === TASK_BOARD)
    if (fact !== undefined) checkFacts('desktop profile', readFromProfile('desktop', fact.pkg), [fact])
  })

  describe('Desktop app.asar (the real bytes the Desktop shell runs)', () => {
    for (const fact of FACTS) {
      // The asar carries the settings shell; the task-board plugin lives in the
      // profile, so its absence here is expected and skipped.
      checkFacts('desktop asar', readFromAsar(fact.pkg), fact.pkg === TASK_BOARD ? [] : [fact])
    }
  })

  describe('our own built client bundle carries the labels we match on', () => {
    const built = join(process.cwd(), 'lib', 'client.js')
    if (!existsSync(built)) {
      it('skipped: run the build first (lib/client.js is absent)', () => {})
    } else {
      const text = readFileSync(built, 'utf8')
      it('keeps every host label this plugin matches on', () => {
        for (const label of ['Settings', '设置', 'Account menu', '账号菜单']) {
          expect(text, `our bundle lost the host label ${JSON.stringify(label)}`).toContain(label)
        }
        expect(text).toContain('data-dsh-panel-entry')
      })
    }
  })
})
