/**
 * Plugin-owned settings document (the 0.1.7+ path): versioned JSON with an
 * incrementing revision fence, lenient reads (sanitized), the coded conflict
 * refusal on a stale revision, the legacy `expectedRevision` optionality, the
 * corrupt-document quarantine, and persistence across store instances (two DSH
 * instances sharing one home).
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdeasSettingsConflictError, IdeasSettingsStore } from '../src/host-settings.ts'
import { IDEAS_SETTINGS_DEFAULTS } from '../src/protocol.ts'

let dir = ''

afterEach(() => {
  vi.restoreAllMocks()
  try { rmSync(dir, { recursive: true, force: true }) } catch {
    // Best-effort cleanup.
  }
})

/** Scratch document path for one test. */
function scratch(): string {
  dir = join(tmpdir(), `ideas-settings-store-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'ideas-manager-settings.json')
}

describe('IdeasSettingsStore reads', () => {
  it('serves the spelled defaults with no fence while the document is absent', () => {
    const file = scratch()
    const store = new IdeasSettingsStore({ file })
    const view = store.read()
    expect(view).toEqual({ available: true, value: IDEAS_SETTINGS_DEFAULTS })
    expect('revision' in view).toBe(false)
    // A read never creates anything: the document only appears on a write.
    expect(readdirSync(dir)).toEqual([])
  })

  it('sanitizes a hand-edited document field by field', () => {
    const file = scratch()
    writeFileSync(file, JSON.stringify({
      version: 1,
      revision: 7,
      value: { tagRows: 99, cardDensity: 'huge', renderMarkdown: 'yes', defaultTab: 'nope', workspaceScope: 'x'.repeat(5000) },
    }))
    const view = new IdeasSettingsStore({ file }).read()
    expect(view.available).toBe(true)
    expect(view.revision).toBe(7)
    expect(view.value.tagRows).toBe(5)
    expect(view.value.cardDensity).toBe('comfortable')
    expect(view.value.renderMarkdown).toBe(IDEAS_SETTINGS_DEFAULTS.renderMarkdown)
    expect(view.value.defaultTab).toBe('overview')
    expect(view.value.workspaceScope).toHaveLength(256)
  })
})

describe('IdeasSettingsStore writes', () => {
  it('creates a versioned document on first write and bumps the revision', async () => {
    const file = scratch()
    const store = new IdeasSettingsStore({ file })

    const first = await store.write({ tagRows: 5 }, undefined)
    expect(first).toEqual({ available: true, value: { ...IDEAS_SETTINGS_DEFAULTS, tagRows: 5 }, revision: 1 })

    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number; revision: number }
    expect(document.version).toBe(1)
    expect(document.revision).toBe(1)

    const second = await store.write({ renderMarkdown: false }, 1)
    expect(second.revision).toBe(2)
    expect(second.value).toMatchObject({ tagRows: 5, renderMarkdown: false })
    expect(store.read().revision).toBe(2)
  })

  it('refuses a stale revision with the coded conflict and leaves the document untouched', async () => {
    const file = scratch()
    const store = new IdeasSettingsStore({ file })
    await store.write({ tagRows: 2 }, undefined) // revision 1
    const reader = store.read() // a second reader holding revision 1

    // Another writer commits first: the document moves to revision 2.
    await store.write({ renderMarkdown: false }, 1)
    expect(store.read().revision).toBe(2)

    // The stale reader is refused with the coded conflict, twice in a row.
    const stale = store.write({ tagRows: 4 }, reader.revision)
    await expect(stale).rejects.toBeInstanceOf(IdeasSettingsConflictError)
    await expect(store.write({ tagRows: 4 }, reader.revision)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })

    const view = store.read()
    expect(view.revision).toBe(2)
    expect(view.value.tagRows).toBe(2)
    expect(view.value.renderMarkdown).toBe(false)
  })

  it('keeps the legacy expectedRevision optionality (unfenced write, fenced against nothing)', async () => {
    const file = scratch()
    const store = new IdeasSettingsStore({ file })
    await store.write({ tagRows: 2 }, undefined) // revision 1

    // No fence sent: accepted, mirroring update(ns, patch, expectedRevision?).
    const unfenced = await store.write({ tagRows: 3 }, undefined)
    expect(unfenced.revision).toBe(2)

    // A fence while no document exists anymore cannot be honoured: refused.
    rmSync(file)
    await expect(store.write({ tagRows: 4 }, 9)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  })

  it('quarantines an unreadable document and keeps serving the defaults', async () => {
    const file = scratch()
    writeFileSync(file, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = new IdeasSettingsStore({ file })
    expect(store.read()).toEqual({ available: true, value: IDEAS_SETTINGS_DEFAULTS })
    expect(warn).toHaveBeenCalledTimes(1)
    // Evidence kept beside the document, never deleted.
    expect(readdirSync(dir).some(name => name.includes('.corrupt-'))).toBe(true)

    // The next write starts a fresh document (self-healing).
    const written = await store.write({ tagRows: 1 }, undefined)
    expect(written.revision).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
    // Reported once per instance, not once per read.
    store.read()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects a document format version it does not know (downgrade safety)', async () => {
    const file = scratch()
    writeFileSync(file, JSON.stringify({ version: 2, revision: 3, value: IDEAS_SETTINGS_DEFAULTS }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(new IdeasSettingsStore({ file }).read()).toEqual({ available: true, value: IDEAS_SETTINGS_DEFAULTS })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(readdirSync(dir).some(name => name.includes('.corrupt-'))).toBe(true)
  })

  it('persists across store instances (a second instance sharing the home reads the same state)', async () => {
    const file = scratch()
    await new IdeasSettingsStore({ file }).write({ cardDensity: 'compact', tagRows: 4 }, undefined)

    const second = new IdeasSettingsStore({ file }).read()
    expect(second.revision).toBe(1)
    expect(second.value).toMatchObject({ cardDensity: 'compact', tagRows: 4 })
    // ...and keeps fencing against the revision the first instance produced.
    await expect(new IdeasSettingsStore({ file }).write({ tagRows: 2 }, 5)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  })
})
