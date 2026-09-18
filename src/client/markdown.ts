/**
 * Markdown renderer for idea descriptions (safe subset).
 *
 * Idea bodies are stored as plain markdown but displayed inside the board, so
 * this module turns them into HTML. It is deliberately a small, framework-free
 * subset (headings, bold/italic, inline code, fenced code blocks, lists,
 * links, paragraphs with hard line breaks) that matches how ideas are
 * actually written — no full CommonMark dependency is pulled into the client.
 *
 * Safety: HTML is escaped FIRST, then inline markers (backticks, *, _, link
 * brackets) are matched on the escaped text, and only http(s)/mailto link
 * destinations are emitted. The returned string is therefore safe to inject
 * via dangerouslySetInnerHTML. Pure function, unit-tested in Node.
 */

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ESCAPE[ch]!)
}

/** Inline rendering: escape HTML first, then code, links, bold, italic. */
function renderInline(text: string): string {
  let out = escapeHtml(text)
  // Inline code spans first, so backticks inside other markers stay literal.
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`)
  // Links: only http(s) and mailto destinations survive; other [x](y) text
  // stays literal (the URL was escaped with the rest of the text).
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`,
  )
  // Bold **text** before single-asterisk italics, then italic *text* / _text_.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
  return out
}

/**
 * Render markdown (safe subset) to HTML.
 * @param src - the raw markdown description.
 * @returns sanitized HTML; an empty/whitespace-only input yields ''.
 */
export function renderMarkdown(src: string): string {
  if (src.trim() === '') return ''
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i]!.trim()
    if (trimmed === '') {
      i++
      continue
    }
    // Fenced code block: kept verbatim (already escaped), no inline parsing.
    if (trimmed.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length) {
        if (lines[i]!.trim().startsWith('```')) {
          i++
          break
        }
        buf.push(lines[i]!)
        i++
      }
      blocks.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }
    // ATX headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      const level = heading[1]!.length
      blocks.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`)
      i++
      continue
    }
    // Lists: consecutive same-style markers form one list; any other line ends it.
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed)
      const items: string[] = []
      while (i < lines.length) {
        const line = lines[i]!.trim()
        const ul = /^([-*+])\s+(.*)$/.exec(line)
        const ol = /^(\d+)\.\s+(.*)$/.exec(line)
        if (ordered && ol !== null) {
          items.push(renderInline(ol[2]!))
          i++
          continue
        }
        if (!ordered && ul !== null) {
          items.push(renderInline(ul[2]!))
          i++
          continue
        }
        break
      }
      const tag = ordered ? 'ol' : 'ul'
      blocks.push(`<${tag}>${items.map(item => `<li>${item}</li>`).join('')}</${tag}>`)
      continue
    }
    // Paragraph: gather until blank line, heading, list or fence; single
    // newlines become <br> (hard-break convention of idea bodies).
    const buf = [lines[i]!]
    i++
    while (i < lines.length) {
      const line = lines[i]!.trim()
      if (
        line === ''
        || /^(#{1,6})\s+/.test(line)
        || line.startsWith('```')
        || /^([-*+]|\d+\.)\s+/.test(line)
      ) break
      buf.push(lines[i]!)
      i++
    }
    blocks.push(`<p>${buf.map(renderInline).join('<br>')}</p>`)
  }
  return blocks.join('\n')
}