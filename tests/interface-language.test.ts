/**
 * Panel interface language (0.4.0): the panel language is plugin-owned and
 * independent of the DSH shell. This suite locks the three moving parts:
 *  - dictionary PARITY: fr / en / zh expose the exact same key set (a missing
 *    or extra key would otherwise render raw key names at runtime);
 *  - RESOLUTION: the override wins over the shell document language, and
 *    `auto` keeps the shell behavior (zh shell -> Chinese panel);
 *  - the settings option itself (sanitize/parse round-trip).
 *
 * jsdom is required: the resolution reads `document.documentElement.lang`.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  en,
  fr,
  interfaceDictionary,
  interfaceLanguage,
  setLanguageOverride,
  t,
  zh,
} from '../src/client/locales.ts'
import {
  IDEAS_LANGUAGES,
  IDEAS_SETTINGS_DEFAULTS,
  parseSettingsBody,
  sanitizeSettings,
} from '../src/protocol.ts'

afterEach(() => {
  setLanguageOverride('auto')
  document.documentElement.lang = 'en'
})

describe('dictionary parity (fr / en / zh)', () => {
  it('every dictionary carries the exact same key set, non-empty', () => {
    const keys = Object.keys(fr).sort()
    expect(keys.length).toBeGreaterThan(100)
    expect(Object.keys(en).sort()).toEqual(keys)
    expect(Object.keys(zh).sort()).toEqual(keys)
    for (const key of keys) {
      expect((fr as Record<string, string>)[key], `fr.${key}`).not.toBe('')
      expect((en as Record<string, string>)[key], `en.${key}`).not.toBe('')
      expect((zh as Record<string, string>)[key], `zh.${key}`).not.toBe('')
    }
  })

  it('the Chinese copy really is Chinese (not an English copy-paste)', () => {
    // A representative panel string: the zh dictionary must differ from en.
    expect(zh['board.title']).not.toBe(en['board.title'])
    expect(zh['board.title']).toBe('想法')
    expect(zh['tab.overview']).toBe('概览')
    // The language picker uses ENDONYMS in every dictionary.
    expect(en['settings.languageZh']).toBe('中文')
    expect(fr['settings.languageZh']).toBe('中文')
    expect(zh['settings.languageFr']).toBe('Français')
  })
})

describe('language resolution (override > shell > en)', () => {
  it('auto follows the DSH shell language', () => {
    document.documentElement.lang = 'zh'
    setLanguageOverride('auto')
    expect(interfaceDictionary()).toBe(zh)
    expect(t('board.title')).toBe('想法')
    expect(interfaceLanguage()).toBe('zh')

    document.documentElement.lang = 'en-US'
    expect(interfaceDictionary()).toBe(en)
    expect(t('board.title')).toBe(en['board.title'])
  })

  it('a pinned language wins over the shell (the plugin switch)', () => {
    document.documentElement.lang = 'en'
    setLanguageOverride('fr')
    expect(interfaceDictionary()).toBe(fr)
    expect(t('board.title')).toBe('Idées')
    expect(interfaceLanguage()).toBe('fr')

    setLanguageOverride('zh')
    expect(t('board.new')).toBe('新建想法')

    setLanguageOverride('en')
    expect(t('board.new')).toBe('New idea')
  })

  it('an unknown shell language falls back to English', () => {
    document.documentElement.lang = 'de'
    setLanguageOverride('auto')
    expect(interfaceDictionary()).toBe(en)
  })
})

describe('language setting (protocol)', () => {
  it('defaults to auto and sanitizes an illegal value to the default', () => {
    expect(IDEAS_SETTINGS_DEFAULTS.language).toBe('auto')
    expect(IDEAS_LANGUAGES).toEqual(['auto', 'en', 'fr', 'zh'])
    expect(sanitizeSettings({}).language).toBe('auto')
    expect(sanitizeSettings({ language: 'zh' }).language).toBe('zh')
    expect(sanitizeSettings({ language: 'klingon' }).language).toBe('auto')
  })

  it('parses a patch with a legal language and sanitizes an illegal one', () => {
    expect(parseSettingsBody({ patch: { language: 'fr' } })?.patch.language).toBe('fr')
    expect(parseSettingsBody({ patch: { language: 'zh-Hans' } })?.patch.language).toBe('auto')
  })
})
