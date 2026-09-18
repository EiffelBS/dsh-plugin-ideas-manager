/**
 * Markdown renderer tests: the safe subset used for idea descriptions.
 * XSS safety is a first-class concern — every test asserts both the rendered
 * structure and that raw HTML never passes through unescaped.
 */

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/client/markdown.ts'

describe('renderMarkdown', () => {
  it('renders an empty input to an empty string', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('  \n\t ')).toBe('')
  })

  it('escapes raw HTML before any marker parsing', () => {
    const out = renderMarkdown('<script>alert(1)</script> & <b>x</b>')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('<b>x</b>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('&amp;')
  })

  it('escapes HTML inside markdown constructs', () => {
    const out = renderMarkdown('**<img src=x onerror=alert(1)>**')
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('<img')
    expect(out).toContain('<strong>')
  })

  it('renders ATX headings with inline content', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>')
    expect(renderMarkdown('## Sub *em*')).toBe('<h2>Sub <em>em</em></h2>')
  })

  it('renders bold and italic', () => {
    expect(renderMarkdown('**bold** text')).toBe('<p><strong>bold</strong> text</p>')
    expect(renderMarkdown('*italic* and _em_')).toBe('<p><em>italic</em> and <em>em</em></p>')
  })

  it('renders inline code and fenced code blocks verbatim', () => {
    expect(renderMarkdown('use `code()` here')).toContain('<code>code()</code>')
    const fenced = renderMarkdown('```\nconst x = 1 < 2\n```')
    expect(fenced).toContain('<pre><code>const x = 1 &lt; 2</code></pre>')
    // Code inside a fence is not parsed as markdown.
    expect(fenced).not.toContain('<em>')
  })

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- one\n- two\n- three')).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>')
    expect(renderMarkdown('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>')
    // Mixed markers form separate lists.
    expect(renderMarkdown('- a\n1. b')).toContain('<ul>')
    expect(renderMarkdown('- a\n1. b')).toContain('<ol>')
  })

  it('renders links with a safe destination only', () => {
    expect(renderMarkdown('[guide](https://example.com/a?b=1&c=2)')).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer">guide</a>',
    )
    // javascript: / data: destinations must never survive.
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript:')
    expect(renderMarkdown('[x](data:text/html,hi)')).not.toContain('href="data:')
  })

  it('keeps paragraphs and hard line breaks', () => {
    expect(renderMarkdown('line one\nline two')).toBe('<p>line one<br>line two</p>')
    expect(renderMarkdown('para one\n\npara two')).toBe('<p>para one</p>\n<p>para two</p>')
  })

  it('handles CRLF input and mixed real-world content', () => {
    const out = renderMarkdown('# Idea\r\n\r\nContext **bold** with a [link](https://dsh.app).\r\n- a\r\n- b')
    expect(out).toContain('<h1>Idea</h1>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<a href="https://dsh.app"')
    expect(out).toContain('<ul><li>a</li><li>b</li></ul>')
  })
})