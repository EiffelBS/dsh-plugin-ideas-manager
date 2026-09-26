#!/usr/bin/env node
/**
 * Extract one release's section from CHANGELOG.md, for the GitHub Release body.
 *
 * Why a script instead of a shell one-liner in the workflow: the release job
 * used `gh release create --generate-notes`, which renders the raw commit log.
 * That is written for maintainers, not for the people installing the plugin —
 * it is exactly the internal vocabulary the README does not carry. The
 * changelog is the curated, user-facing text, so the release body should be it.
 *
 * The logic lives here (and is unit-tested) rather than as untestable shell
 * inside a YAML block; the workflow only calls it and falls back to generated
 * notes when a tag has no section, so a release can never fail because of it.
 *
 * Usage:  node scripts/changelog-notes.mjs v0.7.0 > release-notes.md
 * Output: the section body on stdout (the `## [x.y.z]` heading is dropped; the
 *         release already carries the title). Exit 0 with notes, exit 3 when
 *         the tag has no section.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A release heading: `## [0.7.0] - 2026-09-26`, `## 0.7.0`, `## v0.7.0`. */
const HEADING = /^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+[^\]\s]*)\]?/

/**
 * The body of the section belonging to `tag`, or undefined when the changelog
 * has no such section.
 */
export function extractSection(markdown, tag) {
  const wanted = String(tag).replace(/^v/, '')
  const lines = markdown.split(/\r?\n/)

  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index])
    if (match !== null && match[1] === wanted) {
      start = index + 1
      break
    }
  }
  if (start === -1) return undefined

  let end = lines.length
  for (let index = start; index < lines.length; index += 1) {
    // A `## ` heading closes the section; `### ` is its own subsection.
    if (lines[index].startsWith('## ')) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

/** Read the changelog sitting next to this script's repository root. */
export function readChangelog(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  return readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
}

function main(argv) {
  const tag = argv[0]
  if (tag === undefined || tag === '') {
    process.stderr.write('usage: changelog-notes.mjs <tag>\n')
    return 2
  }
  const section = extractSection(readChangelog(), tag)
  if (section === undefined || section === '') {
    process.stderr.write(`changelog-notes: no CHANGELOG.md section for ${tag}\n`)
    return 3
  }
  process.stdout.write(`${section}\n`)
  return 0
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('changelog-notes.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
