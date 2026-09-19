/**
 * Unidirectional ledger -> markdown export for the /api/ideas `export` verb.
 *
 * The markdown is a *view* of the Host ledger: it is generated on demand and
 * never parsed back (the ledger is the source of truth; P3's one-shot
 * migration imports *into* the ledger, never from a markdown file). The
 * format below is pinned by the golden tests — change consciously.
 */
import type { IdeaRecord } from './core/ideas.ts';
/** Render one idea as a markdown section. */
export declare function ideaToMarkdown(idea: IdeaRecord): string;
/**
 * Generate the two export documents.
 * @param ideas - the full ledger ideas (filtered by the caller when a
 *   workspace is requested).
 * @param title - document heading (e.g. "IDEAS" / "IDEAS-ARCHIVE").
 * @param noun - singular labelling used in the empty state.
 */
export declare function ideasToMarkdown(ideas: readonly IdeaRecord[], title: string, noun: string): string;
/** Export payload returned by the `export` action. */
export interface IdeasExport {
    ideasMd: string;
    archiveMd: string;
}
/**
 * Build the export for a ledger (optionally filtered to one workspace).
 * Open + under-review ideas go to the main document (under review = task
 * done, human acceptance pending — still active work, not delivered);
 * archived/declined ideas go to the archive document.
 */
export declare function buildIdeasExport(ideas: readonly IdeaRecord[], workspaceId: string | undefined): IdeasExport;
