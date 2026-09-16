/**
 * P0 mock ledger: Host-authoritative idea store kept in memory only.
 *
 * This is the P0 scaffold backend: every /api/ideas verb is applied against an
 * in-memory document with a monotonically increasing revision, so the full
 * contract is exercised end-to-end. File persistence
 * (`~/.dsh/ideas/ledger-v2.json`, atomic writes, migration, quarantine) is the
 * P1 step — the class surface (snapshot / summary / applyRequest / subscribe)
 * is designed so the file backend drops in without changing callers.
 */

import { createHash } from 'node:crypto'
import {
  createIdea,
  isIdeaStatus,
  normalizeStatus,
  normalizeTags,
  withStatus,
  type IdeaRecord,
  type NewIdeaInput,
} from './core/ideas.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeaUpdatePatch,
  type IdeasAction,
} from './protocol.ts'

/** Bounded cache of recent request ids, keyed requestId -> action fingerprint. */
const MAX_REQUEST_CACHE = 256

interface LedgerDocument {
  schemaVersion: typeof IDEAS_SCHEMA_VERSION
  revision: number
  ideas: IdeaRecord[]
  /** Import source ids already merged (dedupe for the one-shot OT migration). */
  importedSources: string[]
}

/** Apply result: the post-commit state (and the export payload when asked). */
export interface LedgerApplyResult {
  state: LedgerState
  export?: { ideasMd: string; archiveMd: string }
}

/** Read view of the ledger. */
export interface LedgerState {
  schemaVersion: typeof IDEAS_SCHEMA_VERSION
  revision: number
  ideas: IdeaRecord[]
}

function cloneIdeas(ideas: readonly IdeaRecord[]): IdeaRecord[] {
  return JSON.parse(JSON.stringify(ideas)) as IdeaRecord[]
}

/** Generate a minimal markdown export (ledger -> md, one direction only). */
function markdownOf(ideas: readonly IdeaRecord[], label: string): string {
  const lines: string[] = [`# ${label}`, '']
  if (ideas.length === 0) {
    lines.push('_None yet._', '')
    return lines.join('\n')
  }
  for (const idea of ideas) {
    lines.push(`## ${idea.title}`, '')
    lines.push(`- id: \`${idea.id}\``)
    lines.push(`- status: ${idea.status}`)
    if (idea.tags !== undefined && idea.tags.length > 0) {
      lines.push(`- tags: ${idea.tags.map(tag => `\`${tag.name}\``).join(', ')}`)
    }
    if (idea.body.trim() !== '') {
      lines.push('', idea.body.trim(), '')
    }
    lines.push('')
  }
  return lines.join('\n')
}

export class IdeasHostLedger {
  private document: LedgerDocument = {
    schemaVersion: IDEAS_SCHEMA_VERSION,
    revision: 0,
    ideas: [],
    importedSources: [],
  }
  private readonly listeners = new Set<() => void>()
  private readonly requestCache = new Map<string, string>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(): LedgerState {
    return {
      schemaVersion: this.document.schemaVersion,
      revision: this.document.revision,
      ideas: cloneIdeas(this.document.ideas),
    }
  }

  summary(): { revision: number } {
    return { revision: this.document.revision }
  }

  dispose(): void {
    this.listeners.clear()
  }

  /**
   * Apply one action with request-id dedupe: the same requestId replayed with
   * the same action returns the current state without mutating; a reused id
   * with a different action is rejected. Mirrors the task-board discipline.
   */
  applyRequest(requestId: string, action: IdeasAction): LedgerApplyResult {
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex')
    const cached = this.requestCache.get(requestId)
    if (cached !== undefined) {
      if (cached !== fingerprint) throw new Error('request id was reused with a different action')
      return { state: this.snapshot() }
    }
    this.requestCache.set(requestId, fingerprint)
    while (this.requestCache.size > MAX_REQUEST_CACHE) this.requestCache.delete(this.requestCache.keys().next().value as string)
    try {
      return this.apply(action)
    } catch (error) {
      this.requestCache.delete(requestId)
      throw error
    }
  }

  private apply(action: IdeasAction): LedgerApplyResult {
    const now = this.now()
    switch (action.kind) {
      case 'create': {
        if (this.document.ideas.some(idea => idea.id === action.id)) throw new Error('idea id already exists')
        const idea = createIdea(action.input, now, action.id)
        if (idea.title.trim() === '') throw new Error('title is required')
        this.document.ideas = [...this.document.ideas, idea]
        break
      }
      case 'update': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        const patch = action.patch
        if (patch.title !== undefined && patch.title !== null) {
          const title = patch.title.trim()
          if (title === '') throw new Error('title is required')
        }
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? applyPatch(item, patch, this.now())
          : item)
        break
      }
      case 'move': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (action.status === idea.status) break
        const archivedAt = action.status === 'archived' ? now : undefined
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? { ...withStatus(item, action.status, now), ...(archivedAt === undefined ? {} : { archivedAt }) }
          : item)
        break
      }
      case 'decline': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (idea.status !== 'declined') {
          this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
            ? { ...withStatus(item, 'declined', now), archivedAt: now }
            : item)
        }
        break
      }
      case 'restore': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        if (idea.status === 'open') break
        this.document.ideas = this.document.ideas.map(item => item.id === action.ideaId
          ? { ...withStatus(item, 'open', now), archivedAt: undefined }
          : item)
        break
      }
      case 'delete': {
        const idea = this.document.ideas.find(item => item.id === action.ideaId)
        if (idea === undefined) throw new Error('idea not found')
        this.document.ideas = this.document.ideas.filter(item => item.id !== action.ideaId)
        break
      }
      case 'reorder': {
        const present = new Set(this.document.ideas.map(idea => idea.id))
        const ordered = action.orderedIds.filter(id => present.has(id))
        const rankById = new Map(ordered.map((id, index) => [id, index + 1]))
        this.document.ideas = this.document.ideas.map(idea => ({
          ...idea,
          rank: rankById.get(idea.id) ?? idea.rank,
        }))
        break
      }
      case 'import': {
        if (this.document.importedSources.includes(action.sourceId)) return { state: this.snapshot() }
        const merged = new Map(this.document.ideas.map(idea => [idea.id, idea]))
        for (const idea of parseHostIdeas(action.ideas)) {
          merged.set(idea.id, merged.has(idea.id)
            ? { ...merged.get(idea.id)!, ...idea, updatedAt: now }
            : idea)
        }
        this.document.ideas = [...merged.values()]
        this.document.importedSources = [...this.document.importedSources, action.sourceId]
        break
      }
      case 'export': {
        const filter = action.workspaceId === undefined
          ? undefined
          : (idea: IdeaRecord): boolean => idea.workspaceId === action.workspaceId
        const open = this.document.ideas.filter(idea => idea.status === 'open' && (filter === undefined || filter(idea)))
        const archived = this.document.ideas.filter(idea => idea.status !== 'open' && (filter === undefined || filter(idea)))
        return {
          state: this.snapshot(),
          export: {
            ideasMd: markdownOf(open, 'IDEAS'),
            archiveMd: markdownOf(archived, 'IDEAS-ARCHIVE'),
          },
        }
      }
    }
    this.commit()
    return { state: this.snapshot() }
  }

  private commit(): void {
    this.document.revision += 1
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Apply one update patch to an idea (null `tags` clears the label set). */
function applyPatch(idea: IdeaRecord, patch: IdeaUpdatePatch, now: number): IdeaRecord {
  const next: IdeaRecord = { ...idea, updatedAt: now }
  if (patch.title !== undefined && patch.title !== null) next.title = patch.title.trim()
  if (patch.body !== undefined && patch.body !== null) next.body = patch.body.trim()
  if (patch.workspaceId !== undefined && patch.workspaceId !== null) {
    const workspaceId = patch.workspaceId.trim()
    next.workspaceId = workspaceId === '' ? undefined : workspaceId
  } else if (patch.workspaceId === null) {
    next.workspaceId = undefined
  }
  if (patch.rank !== undefined) next.rank = patch.rank
  if (patch.value !== undefined) next.value = patch.value
  if (patch.effort !== undefined) next.effort = patch.effort
  if (patch.tags !== undefined) {
    next.tags = patch.tags === null ? undefined : normalizeTags(patch.tags)
  }
  return next
}

/** Structural repair of an imported idea list (mirrors the load-time repair). */
function parseHostIdeas(rows: readonly IdeaRecord[]): IdeaRecord[] {
  return rows.flatMap(row => {
    const idea: IdeaRecord = { ...row }
    idea.status = normalizeStatus(idea.status)
    idea.tags = normalizeTags(idea.tags)
    if (idea.title.trim() === '' || typeof idea.id !== 'string' || idea.id === '') return []
    return [idea]
  })
}

/** Re-exported for tests: whether a status is a known idea status. */
export function isValidIdeaStatus(value: unknown): boolean {
  return isIdeaStatus(value)
}
