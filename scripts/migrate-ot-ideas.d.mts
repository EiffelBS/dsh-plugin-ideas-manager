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
  createdAt: number
  updatedAt: number
  workspaceId: string
}

export function titleFromHeading(rawHeading: string): string

export function parseOtIdeasDocument(
  text: string,
  options: {
    status: 'open' | 'archived' | 'declined'
    ranks?: ReadonlyMap<number, number>
    now?: number
    workspaceId?: string
  },
): { ideas: IdeaRow[]; sections: number }

export function parseOtPriorityRanks(text: string): ReadonlyMap<number, number>

export function parseOtMigration(
  ideasMd: string,
  archiveMd: string,
  options?: { now?: number },
): { ideas: IdeaRow[]; open: IdeaRow[]; archived: IdeaRow[]; declined: IdeaRow[]; collisions: number }