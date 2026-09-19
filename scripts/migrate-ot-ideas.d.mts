/**
 * Type declarations for the plain-JS OT migration parser/CLI
 * (`scripts/migrate-ot-ideas.mjs`), consumed only by the vitest suite.
 */

export const OT_IMPORT_SOURCE_ID: string

export interface IdeaRow {
  id: string
  title: string
  body: string
  status: 'open' | 'archived' | 'declined'
  rank?: number
  archivedAt?: number
  /** Present when `classify` mapped a DELIVERED section to archived. */
  deliveredAt?: number
  createdAt: number
  updatedAt: number
  workspaceId: string
}

export interface ParseOtOptions {
  status: 'open' | 'archived' | 'declined'
  ranks?: ReadonlyMap<number, number>
  now?: number
  workspaceId?: string
  /** Classify each section by its DELIVERED/DECLINED markers (status lines). */
  classify?: boolean
}

export function titleFromHeading(rawHeading: string): string

export function statusInSection(text: string, fallback: 'open' | 'archived' | 'declined'): 'open' | 'archived' | 'declined'

export function deliveredDateInSection(text: string): number | undefined

export function filterIncremental<Row extends { id: string }>(
  rows: readonly Row[],
  existingIds: readonly string[],
): { missing: Row[]; skipped: number }

export function parseOtIdeasDocument(
  text: string,
  options: ParseOtOptions,
): { ideas: IdeaRow[]; sections: number }

export function parseOtPriorityRanks(text: string): ReadonlyMap<number, number>

export function parseOtMigration(
  ideasMd: string,
  archiveMd: string,
  options?: { now?: number; workspaceId?: string; classify?: boolean },
): { ideas: IdeaRow[]; open: IdeaRow[]; archived: IdeaRow[]; declined: IdeaRow[]; collisions: number }

export function resolveWorkspaceId(options: {
  explicit?: string
  registryPath?: string
  title?: string
}): { workspaceId: string; via: string }