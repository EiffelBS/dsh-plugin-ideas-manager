/**
 * Types for the release-notes extractor. The script itself stays plain `.mjs`
 * because the release workflow runs it with bare `node`, before any build.
 */

/**
 * The body of the `## [tag]` section of a changelog, heading excluded, or
 * undefined when the changelog has no such section.
 */
export declare function extractSection(markdown: string, tag: string): string | undefined

/** Read the `CHANGELOG.md` of a repository root (defaults to this one). */
export declare function readChangelog(root?: string): string
