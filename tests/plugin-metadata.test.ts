/**
 * Plugin display metadata contract (DSH >= 0.2.2).
 *
 * The Plugins page reads a package's display text from `locale/<language>.json`
 * (title, description, and a `meta.detail` Markdown document) and its artwork
 * from the manifest `icon` field or an exported `<package>/icon`. Three
 * properties of that contract are invisible at runtime and therefore pinned
 * here:
 *
 * 1. **The locale files must be exported.** The Host resolves
 *    `<package>/locale/en.json` through Node's exports map; without an
 *    `./locale/*.json` entry the metadata reads as absent, the card falls back
 *    to the package name, and nothing logs a failure.
 * 2. **Every referenced file must be published.** `files` decides what an
 *    installed copy contains; a detail document or icon outside it exists in
 *    the repository and 404s on the plugin page.
 * 3. **The paths must satisfy the reader.** `meta.detail` is a relative
 *    `/`-separated `.md` path with no `..`, and the icon is a relative image
 *    path no larger than 256 KiB — a malformed value suppresses the document
 *    instead of falling back to the README.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>
}

const pkg = readJson('package.json')
const LOCALES = ['en', 'fr', 'zh']
const ICON_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_ICON_BYTES = 256 * 1024

/** The entry list npm applies to the tarball. */
function publishedEntries(): string[] {
  return Array.isArray(pkg.files) ? (pkg.files as string[]) : []
}

/** Whether `files` publishes the top directory of a package-relative path. */
function published(relativePath: string): boolean {
  const top = relativePath.replace(/^\.\//, '').split('/')[0] ?? ''
  return publishedEntries().some(entry => {
    const clean = entry.replace(/^\.\//, '').replace(/\/\*\*.*$/, '').replace(/\/$/, '')
    return clean === top || clean.startsWith(`${top}/`)
  })
}

describe('plugin display metadata', () => {
  it('exports the locale directory the Host resolves locale files through', () => {
    // Node's exports map gates `<package>/locale/en.json`; a missing wildcard
    // entry makes every display field read as absent without an error.
    expect(pkg.exports).toMatchObject({ './locale/*.json': './locale/*.json' })
  })

  it('publishes the locale, docs and asset directories', () => {
    for (const dir of ['locale', 'docs', 'assets']) {
      expect(publishedEntries(), `package.json files must publish ${dir}`).toContain(dir)
    }
  })

  it('declares a relative, packaged icon that the reader accepts', () => {
    const icon = pkg.icon
    expect(typeof icon).toBe('string')
    if (typeof icon !== 'string') return
    // A URL scheme or an absolute path is refused by the manifest reader.
    expect(icon).not.toMatch(/^[A-Za-z][A-Za-z\d+.-]*:/)
    expect(isAbsolute(icon)).toBe(false)
    expect(ICON_TYPES).toContain(extname(icon).toLowerCase())
    const absolute = join(root, icon)
    expect(existsSync(absolute)).toBe(true)
    expect(statSync(absolute).size).toBeLessThanOrEqual(MAX_ICON_BYTES)
    expect(published(icon), `package.json files must publish ${icon}`).toBe(true)
  })

  it('keeps the English anchor locale that every other language falls back to', () => {
    expect(existsSync(join(root, 'locale/en.json'))).toBe(true)
  })

  it.each(LOCALES)('locale/%s.json carries a complete, resolvable meta block', language => {
    const file = `locale/${language}.json`
    const parsed = readJson(file)
    const meta = parsed.meta as Record<string, unknown> | undefined
    expect(meta, `${file}: meta`).toBeTypeOf('object')
    if (meta === undefined) return

    for (const field of ['title', 'description'] as const) {
      const value = meta[field]
      expect(typeof value, `${file}: meta.${field}`).toBe('string')
      expect((value as string).trim().length, `${file}: meta.${field}`).toBeGreaterThan(0)
    }

    const detail = meta.detail
    expect(typeof detail, `${file}: meta.detail`).toBe('string')
    if (typeof detail !== 'string') return
    // The reader refuses these; a refusal suppresses the document entirely
    // instead of falling back to README.md.
    expect(detail).toMatch(/\.md$/)
    expect(detail).not.toMatch(/^[/\\]/)
    expect(detail).not.toMatch(/\\/)
    expect(detail).not.toMatch(/^[A-Za-z][A-Za-z\d+.-]*:/)
    expect(detail.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')).toBe(true)
    expect(existsSync(join(root, detail)), `${file}: meta.detail target`).toBe(true)
    expect(published(detail), `package.json files must publish ${detail}`).toBe(true)
  })

  it('publishes every image the README renders', () => {
    // README.md is the fallback plugin detail document; a relative image it
    // shows is resolved beside the installed package, so an unpublished asset
    // renders as a broken image on the plugin page.
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)]
      .map(match => match[1] ?? '')
      .filter(target => !/^https?:/i.test(target) && !target.startsWith('#'))
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) {
      expect(existsSync(join(root, image)), `README image ${image}`).toBe(true)
      expect(published(image), `package.json files must publish ${image}`).toBe(true)
    }
  })
})
