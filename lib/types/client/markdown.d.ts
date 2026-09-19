/**
 * Markdown renderer for idea descriptions (safe subset).
 *
 * Idea bodies are stored as plain markdown but displayed inside the board, so
 * this module turns them into HTML. It is deliberately a small, framework-free
 * subset (headings, bold/italic, inline code, fenced code blocks, lists,
 * blockquotes, links, paragraphs with hard line breaks) that matches how
 * ideas are actually written — no full CommonMark dependency is pulled into
 * the client.
 *
 * Safety: HTML is escaped FIRST, then inline markers (backticks, *, _, link
 * brackets) are matched on the escaped text, and only http(s)/mailto link
 * destinations are emitted. The returned string is therefore safe to inject
 * via dangerouslySetInnerHTML. Pure function, unit-tested in Node.
 */
/**
 * Render markdown (safe subset) to HTML.
 * @param src - the raw markdown description.
 * @returns sanitized HTML; an empty/whitespace-only input yields ''.
 */
export declare function renderMarkdown(src: string): string;
