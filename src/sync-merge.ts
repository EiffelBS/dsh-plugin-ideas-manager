/**
 * Deterministic, read-only three-way planning for portable idea synchronization.
 *
 * The planner never chooses a winner from a wall-clock timestamp. It compares
 * both sides with a resolved common ancestor, treats rank as workspace-relative
 * order, and emits explicit conflicts instead of dropping data. Application is
 * deliberately elsewhere: the Host ledger reuses its ordinary transitions under
 * its existing single-writer lock and pre-apply snapshot discipline.
 */

import {
  IDEA_RELATION_LIMIT,
  IDEAS_SIMILAR_MIN_SCORE,
  IDEA_TAG_LIMIT,
  ideaSimilarity,
  normalizeRelationIds,
  type IdeaRecord,
  type IdeaTag,
} from './core/ideas.ts'
import {
  portableIdeaOf,
  type IdeasSyncConflictResolution,
  type IdeasSyncIdea,
  type IdeasSyncPackage,
  type IdeasSyncSnapshotCache,
} from './sync.ts'

export type IdeasSyncMergeMode = 'three-way' | 'two-way'
export type IdeasSyncPlanAction = 'create' | 'update' | 'delete' | 'unchanged' | 'conflict'
export type IdeasSyncConflictKind =
  | 'same-field'
  | 'two-way-difference'
  | 'delete-edit'
  | 'tag-definition'
  | 'tag-limit'
  | 'relation-limit'
  | 'order'
  | 'reference-missing'
  | 'self-reference'
  | 'dependency-cycle'
  | 'follow-up-cycle'

export type IdeasSyncMergeField =
  | 'title'
  | 'body'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'summary'
  | 'value'
  | 'effort'
  | 'rationale'
  | 'decision'
  | 'deliveredAt'
  | 'archivedAt'
  | 'deliveryNote'
  | 'reanalyzeAt'
  | 'analysisAudit'
  | 'events'
  | 'tags'
  | 'relatesTo'
  | 'blocks'
  | 'followUpOfId'
  | 'rank'

export interface IdeasSyncConflict {
  conflictId: string
  kind: IdeasSyncConflictKind
  /** Empty for a workspace-level ordering conflict. */
  ideaId: string
  field?: IdeasSyncMergeField
  /** Tag name for a tag-definition conflict. */
  tagName?: string
  local?: unknown
  incoming?: unknown
  base?: unknown
  message: string
  /** A supplied decision was parsed but could not make this conflict valid. */
  resolutionError?: string
}

export interface IdeasSyncPlanOperation {
  ideaId: string
  action: IdeasSyncPlanAction
  local?: IdeasSyncIdea
  incoming?: IdeasSyncIdea
  merged?: IdeasSyncIdea
  changedFields: IdeasSyncMergeField[]
}

export interface IdeasSyncDuplicateCandidate {
  candidateId: string
  localId: string
  incomingId: string
  score: number
  signals: Array<'title' | 'tags'>
  /** Existing per-idea merge semantics, proposed only and never applied by planning. */
  proposedMerge: {
    kind: 'merge'
    sourceId: string
    targetId: string
    mode: 'keepTargetRank'
  }
}

export interface IdeasSyncMergePlan {
  format: 'dsh-ideas-merge-plan'
  version: 1
  mode: IdeasSyncMergeMode
  incomingSnapshotId: string
  baseSnapshotId: string | null
  ancestorSnapshotId: string | null
  workspaceId: string
  syncKey: string
  operations: IdeasSyncPlanOperation[]
  ideas: IdeasSyncIdea[]
  conflicts: IdeasSyncConflict[]
  invalidResolutions: string[]
  duplicateCandidates: IdeasSyncDuplicateCandidate[]
  /** Complete open-backlog order when an unambiguous remote reorder is accepted. */
  reorder: { status: 'open'; orderedIds: string[] } | null
  ready: boolean
}

export interface IdeasSyncMergeInput {
  /** Full destination rows; machine-local fields are ignored by comparison. */
  localIdeas: readonly IdeaRecord[]
  workspaceId: string
  incoming: IdeasSyncPackage
  /** Resolved ancestor rows, or undefined when baseSnapshotId is unavailable. */
  ancestorIdeas?: readonly IdeasSyncIdea[]
  resolutions?: readonly IdeasSyncConflictResolution[]
}

const SCALAR_FIELDS = [
  'title', 'body', 'status', 'createdAt', 'summary', 'value', 'effort',
  'rationale', 'decision', 'deliveredAt', 'archivedAt', 'deliveryNote',
  'reanalyzeAt', 'analysisAudit', 'events',
] as const satisfies readonly IdeasSyncMergeField[]

const RELATION_FIELDS = ['relatesTo', 'blocks'] as const
const REQUIRED_FIELDS = new Set<IdeasSyncMergeField>(['title', 'body', 'status', 'createdAt'])
const DUPLICATE_LIMIT = 100

type RelationField = (typeof RELATION_FIELDS)[number]
type AnyMergeField = IdeasSyncMergeField

function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => equal(value, right[index]))
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  const leftRow = left as Record<string, unknown>
  const rightRow = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRow).sort()
  const rightKeys = Object.keys(rightRow).sort()
  return equal(leftKeys, rightKeys) && leftKeys.every(key => equal(leftRow[key], rightRow[key]))
}

function fieldValue(idea: IdeasSyncIdea | undefined, field: AnyMergeField): unknown {
  if (idea === undefined) return undefined
  return (idea as unknown as Record<string, unknown>)[field]
}

function setField(idea: IdeasSyncIdea, field: AnyMergeField, value: unknown): void {
  const row = idea as unknown as Record<string, unknown>
  if (value === undefined) delete row[field]
  else row[field] = clone(value)
}

function conflictId(ideaId: string, field: AnyMergeField | 'existence', kind: IdeasSyncConflictKind, suffix = ''): string {
  return [ideaId, field, kind, suffix].join('\u0000')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function openOrder(ideas: readonly IdeasSyncIdea[]): string[] {
  return ideas
    .filter(idea => idea.status === 'open')
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
      || compareText(left.id, right.id))
    .map(idea => idea.id)
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function changedFields(local: IdeasSyncIdea | undefined, merged: IdeasSyncIdea | undefined): IdeasSyncMergeField[] {
  if (local === undefined || merged === undefined) return []
  const keys = new Set<string>([...Object.keys(local), ...Object.keys(merged)])
  return [...keys]
    .filter(key => key !== 'rank' && !equal(fieldValue(local, key as AnyMergeField), fieldValue(merged, key as AnyMergeField)))
    .sort() as IdeasSyncMergeField[]
}

function operationFor(
  ideaId: string,
  local: IdeasSyncIdea | undefined,
  incoming: IdeasSyncIdea | undefined,
  merged: IdeasSyncIdea | undefined,
  base: IdeasSyncIdea | undefined,
  conflicted: ReadonlySet<string>,
): IdeasSyncPlanOperation {
  if (conflicted.has(ideaId)) {
    return {
      ideaId,
      action: 'conflict',
      ...(local === undefined ? {} : { local: clone(local) }),
      ...(incoming === undefined ? {} : { incoming: clone(incoming) }),
      ...(merged === undefined ? {} : { merged: clone(merged) }),
      changedFields: changedFields(local, merged),
    }
  }
  if (local === undefined && merged !== undefined) {
    return {
      ideaId,
      action: 'create',
      ...(incoming === undefined ? {} : { incoming: clone(incoming) }),
      merged: clone(merged),
      changedFields: [],
    }
  }
  if (merged === undefined && (local !== undefined || base !== undefined)) {
    return {
      ideaId,
      action: 'delete',
      ...(local === undefined ? {} : { local: clone(local) }),
      ...(incoming === undefined ? {} : { incoming: clone(incoming) }),
      changedFields: [],
    }
  }
  if (local !== undefined && merged !== undefined && !equal(local, merged)) {
    return {
      ideaId,
      action: 'update',
      local: clone(local),
      ...(incoming === undefined ? {} : { incoming: clone(incoming) }),
      merged: clone(merged),
      changedFields: changedFields(local, merged),
    }
  }
  return {
    ideaId,
    action: 'unchanged',
    ...(local === undefined ? {} : { local: clone(local) }),
    ...(incoming === undefined ? {} : { incoming: clone(incoming) }),
    ...(merged === undefined ? {} : { merged: clone(merged) }),
    changedFields: [],
  }
}

function tagMap(idea: IdeasSyncIdea | undefined): Map<string, IdeaTag> {
  return new Map((idea?.tags ?? []).map(tag => [tag.name, tag]))
}

function sameTag(left: IdeaTag | undefined, right: IdeaTag | undefined): boolean {
  return equal(left, right)
}

function mergeTags(options: {
  ideaId: string
  base: IdeasSyncIdea | undefined
  local: IdeasSyncIdea
  incoming: IdeasSyncIdea
  resolutions: ReadonlyMap<string, IdeasSyncConflictResolution>
  conflicts: IdeasSyncConflict[]
  consumed: Set<string>
}): IdeaTag[] | undefined {
  const baseTags = tagMap(options.base)
  const localTags = tagMap(options.local)
  const incomingTags = tagMap(options.incoming)
  const names = new Set([...localTags.keys(), ...incomingTags.keys(), ...baseTags.keys()])
  const merged: IdeaTag[] = []
  for (const name of names) {
    const base = baseTags.get(name)
    const local = localTags.get(name)
    const incoming = incomingTags.get(name)
    let selected: IdeaTag | undefined
    if (sameTag(local, incoming)) selected = local
    else if (sameTag(local, base)) selected = incoming
    else if (sameTag(incoming, base)) selected = local
    else {
      const id = conflictId(options.ideaId, 'tags', 'tag-definition', name)
      options.consumed.add(id)
      const resolution = options.resolutions.get(id)
      if (resolution?.choice === 'local') selected = local
      else if (resolution?.choice === 'remote') selected = incoming
      else if (resolution?.choice === 'clear') selected = undefined
      else {
        selected = local
        options.conflicts.push({
          conflictId: id,
          kind: 'tag-definition',
          ideaId: options.ideaId,
          field: 'tags',
          tagName: name,
          ...(local === undefined ? {} : { local: clone(local) }),
          ...(incoming === undefined ? {} : { incoming: clone(incoming) }),
          ...(base === undefined ? {} : { base: clone(base) }),
          message: `idea ${options.ideaId} defines tag ${JSON.stringify(name)} differently on both machines`,
        })
      }
    }
    if (selected !== undefined) merged.push(clone(selected))
  }
  if (merged.length > IDEA_TAG_LIMIT) {
    const id = conflictId(options.ideaId, 'tags', 'tag-limit')
    options.consumed.add(id)
    const resolution = options.resolutions.get(id)
    if (resolution?.choice === 'local') return options.local.tags === undefined ? undefined : clone(options.local.tags)
    if (resolution?.choice === 'remote') return options.incoming.tags === undefined ? undefined : clone(options.incoming.tags)
    if (resolution?.choice === 'clear') return undefined
    options.conflicts.push({
      conflictId: id,
      kind: 'tag-limit',
      ideaId: options.ideaId,
      field: 'tags',
      local: options.local.tags,
      incoming: options.incoming.tags,
      message: `the additive tag union for idea ${options.ideaId} exceeds the ${IDEA_TAG_LIMIT}-tag limit`,
      ...(resolution === undefined ? {} : { resolutionError: 'choose local, remote, or clear for the complete tag list' }),
    })
    return options.local.tags === undefined ? undefined : clone(options.local.tags)
  }
  return merged.length === 0 ? undefined : merged
}

function mergeField(options: {
  ideaId: string
  field: AnyMergeField
  base: IdeasSyncIdea | undefined
  local: IdeasSyncIdea
  incoming: IdeasSyncIdea
  mode: IdeasSyncMergeMode
  resolutions: ReadonlyMap<string, IdeasSyncConflictResolution>
  conflicts: IdeasSyncConflict[]
  consumed: Set<string>
}): unknown {
  const base = fieldValue(options.base, options.field)
  const local = fieldValue(options.local, options.field)
  const incoming = fieldValue(options.incoming, options.field)
  if (equal(local, incoming)) return clone(local)
  if (options.mode === 'three-way') {
    if (equal(local, base)) return clone(incoming)
    if (equal(incoming, base)) return clone(local)
  }
  const kind: IdeasSyncConflictKind = options.mode === 'three-way' ? 'same-field' : 'two-way-difference'
  const id = conflictId(options.ideaId, options.field, kind)
  options.consumed.add(id)
  const resolution = options.resolutions.get(id)
  if (resolution?.choice === 'local') return clone(local)
  if (resolution?.choice === 'remote') return clone(incoming)
  if (resolution?.choice === 'clear' && !REQUIRED_FIELDS.has(options.field)) return undefined
  options.conflicts.push({
    conflictId: id,
    kind,
    ideaId: options.ideaId,
    field: options.field,
    ...(local === undefined ? {} : { local: clone(local) }),
    ...(incoming === undefined ? {} : { incoming: clone(incoming) }),
    ...(base === undefined ? {} : { base: clone(base) }),
    message: options.mode === 'three-way'
      ? `idea ${options.ideaId} changed ${options.field} differently on both machines`
      : `idea ${options.ideaId} differs in ${options.field}, but no common ancestor is available`,
    ...(resolution === undefined ? {} : {
      resolutionError: resolution.choice === 'clear' && REQUIRED_FIELDS.has(options.field)
        ? `${options.field} is required and cannot be cleared`
        : 'choose local or remote for this field',
    }),
  })
  return clone(local)
}

function createdIdea(idea: IdeasSyncIdea): IdeasSyncIdea {
  const next = clone(idea)
  delete next.rank
  return next
}

function contentWithoutTimestamps(idea: IdeasSyncIdea): Omit<IdeasSyncIdea, 'updatedAt'> {
  const { updatedAt, ...content } = clone(idea)
  void updatedAt
  return content
}

function mergedTimestamp(local: IdeasSyncIdea, incoming: IdeasSyncIdea, merged: IdeasSyncIdea): number {
  if (equal(contentWithoutTimestamps(merged), contentWithoutTimestamps(local))) return local.updatedAt
  if (equal(contentWithoutTimestamps(merged), contentWithoutTimestamps(incoming))) return incoming.updatedAt
  // This is derived metadata, never a content winner: disjoint accepted changes
  // keep the later observation solely so the resulting row is not older than
  // either input.
  return Math.max(local.updatedAt, incoming.updatedAt)
}

function cyclePath(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>()
  const path: string[] = []
  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === 1) {
      const start = path.indexOf(node)
      return [...path.slice(start), node]
    }
    if (state.get(node) === 2) return undefined
    state.set(node, 1)
    path.push(node)
    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (!graph.has(target)) continue
      const found = visit(target)
      if (found !== undefined) return found
    }
    path.pop()
    state.set(node, 2)
    return undefined
  }
  for (const node of [...graph.keys()].sort()) {
    const found = visit(node)
    if (found !== undefined) return found
  }
  return undefined
}

function relationList(value: unknown): string[] | undefined {
  return normalizeRelationIds(value)
}

/**
 * Re-impose relation validity over the whole candidate board. Unlike the boot
 * repair, this never drops an invalid incoming edge: it returns a conflict whose
 * explicit `clear` decision is the only lossy option.
 */
function reconcileCandidate(options: {
  candidate: Map<string, IdeasSyncIdea>
  merged: Map<string, IdeasSyncIdea>
  workspaceIds: ReadonlySet<string>
  deletedIds: ReadonlySet<string>
  localRows: ReadonlyMap<string, IdeasSyncIdea>
  incoming: ReadonlyMap<string, IdeasSyncIdea>
  resolutions: ReadonlyMap<string, IdeasSyncConflictResolution>
  conflicts: IdeasSyncConflict[]
  consumed: Set<string>
  attemptedStructural: Set<string>
}): void {
  const live = new Set(options.candidate.keys())
  const orderedWorkspaceIds = [...options.workspaceIds].sort()

  // Deletion is an existing transition that sweeps relation edges. Make that
  // consequence explicit in the candidate instead of reporting a dangling edge.
  for (const [id, idea] of options.candidate) {
    for (const field of RELATION_FIELDS) {
      const current = relationList(idea[field])
      if (current === undefined) continue
      const kept = current.filter(target => !options.deletedIds.has(target))
      if (kept.length === current.length) continue
      setField(idea, field, kept)
      if (options.merged.has(id)) setField(options.merged.get(id)!, field, kept)
    }
  }

  for (let pass = 0; pass < 64; pass += 1) {
    let issue: IdeasSyncConflict | undefined
    for (const id of orderedWorkspaceIds) {
      const idea = options.merged.get(id)
      if (idea === undefined) continue
      for (const field of RELATION_FIELDS) {
        for (const target of idea[field] ?? []) {
          if (target === id) {
            issue = {
              conflictId: conflictId(id, field, 'self-reference'),
              kind: 'self-reference',
              ideaId: id,
              field,
              message: `idea ${id} cannot ${field === 'relatesTo' ? 'relate to' : 'block'} itself`,
            }
          } else if (!live.has(target)) {
            issue = {
              conflictId: conflictId(id, field, 'reference-missing'),
              kind: 'reference-missing',
              ideaId: id,
              field,
              message: `idea ${id} refers to ${target}, which is absent from the merged board`,
            }
          }
          if (issue !== undefined) break
        }
        if (issue !== undefined) break
      }
      if (issue !== undefined) break
      const parent = idea.followUpOfId
      if (parent !== undefined && (parent === id || !live.has(parent))) {
        issue = {
          conflictId: conflictId(id, 'followUpOfId', parent === id ? 'self-reference' : 'reference-missing'),
          kind: parent === id ? 'self-reference' : 'reference-missing',
          ideaId: id,
          field: 'followUpOfId',
          message: parent === id
            ? `idea ${id} cannot be its own follow-up parent`
            : `idea ${id} follows ${parent}, which is absent from the merged board`,
        }
      }
      if (issue !== undefined) break
    }

    if (issue === undefined) {
      const followUpGraph = new Map([...options.candidate].flatMap(([id, idea]) =>
        idea.followUpOfId === undefined ? [] : [[id, [idea.followUpOfId]] as [string, string[]]]))
      const followUpCycle = cyclePath(followUpGraph)
      if (followUpCycle !== undefined) {
        const id = followUpCycle.slice(0, -1).find(candidate => options.workspaceIds.has(candidate)) ?? followUpCycle[0]!
        issue = {
          conflictId: conflictId(id, 'followUpOfId', 'follow-up-cycle'),
          kind: 'follow-up-cycle',
          ideaId: id,
          field: 'followUpOfId',
          message: `follow-up references form a cycle: ${followUpCycle.join(' -> ')}`,
        }
      }
    }

    if (issue === undefined) {
      const graph = new Map([...options.candidate].map(([id, idea]) => [id, idea.blocks ?? []]))
      const blocksCycle = cyclePath(graph)
      if (blocksCycle !== undefined) {
        const id = blocksCycle.slice(0, -1).find(candidate => options.workspaceIds.has(candidate)) ?? blocksCycle[0]!
        issue = {
          conflictId: conflictId(id, 'blocks', 'dependency-cycle'),
          kind: 'dependency-cycle',
          ideaId: id,
          field: 'blocks',
          message: `blocking references form a cycle: ${blocksCycle.join(' -> ')}`,
        }
      }
    }

    if (issue === undefined) {
      // Symmetry is additive reconciliation, not a conflict. Apply reverse edges
      // to the complete candidate; the Host's existing import transition performs
      // the same repair over the complete persisted document.
      let changed = false
      for (const idea of options.candidate.values()) {
        for (const target of idea.relatesTo ?? []) {
          const peer = options.candidate.get(target)
          if (peer === undefined || peer.relatesTo?.includes(idea.id) === true) continue
          if ((peer.relatesTo?.length ?? 0) >= IDEA_RELATION_LIMIT) {
            issue = {
              conflictId: conflictId(idea.id, 'relatesTo', 'relation-limit'),
              kind: 'relation-limit',
              ideaId: idea.id,
              field: 'relatesTo',
              message: `making relation ${idea.id} <-> ${peer.id} symmetric would exceed the ${IDEA_RELATION_LIMIT}-edge limit`,
            }
            break
          }
          setField(peer, 'relatesTo', [...(peer.relatesTo ?? []), idea.id])
          if (options.merged.has(peer.id)) setField(options.merged.get(peer.id)!, 'relatesTo', peer.relatesTo)
          changed = true
        }
        if (issue !== undefined) break
      }
      if (issue === undefined) {
        if (!changed) return
        continue
      }
    }

    const resolution = options.resolutions.get(issue.conflictId)
    if (resolution === undefined) {
      options.conflicts.push(issue)
      return
    }
    options.consumed.add(issue.conflictId)
    if (options.attemptedStructural.has(issue.conflictId)) {
      options.conflicts.push({
        ...issue,
        resolutionError: 'the selected side still leaves this relation invalid; choose clear or resolve the other conflicting field',
      })
      return
    }
    options.attemptedStructural.add(issue.conflictId)
    const field = issue.field as RelationField | 'followUpOfId'
    const selected = resolution.choice === 'clear'
      ? undefined
      : fieldValue(resolution.choice === 'local' ? options.localRows.get(issue.ideaId) : options.incoming.get(issue.ideaId), field)
    const mergedIdea = options.merged.get(issue.ideaId)
    const candidateIdea = options.candidate.get(issue.ideaId)
    if (mergedIdea !== undefined) setField(mergedIdea, field, selected)
    if (candidateIdea !== undefined) setField(candidateIdea, field, selected)
  }
  options.conflicts.push({
    conflictId: conflictId('__relations__', 'blocks', 'dependency-cycle'),
    kind: 'dependency-cycle',
    ideaId: '',
    field: 'blocks',
    message: 'relation reconciliation did not converge after 64 explicit decisions',
  })
}

function duplicateCandidates(
  baseIds: ReadonlySet<string>,
  local: readonly IdeasSyncIdea[],
  incoming: readonly IdeasSyncIdea[],
  merged: ReadonlyMap<string, IdeasSyncIdea>,
): IdeasSyncDuplicateCandidate[] {
  const localAdditions = local.filter(idea => !baseIds.has(idea.id) && idea.status === 'open' && merged.get(idea.id)?.status === 'open')
  const incomingAdditions = incoming.filter(idea => !baseIds.has(idea.id) && idea.status === 'open' && merged.get(idea.id)?.status === 'open')
  const candidates: IdeasSyncDuplicateCandidate[] = []
  for (const localIdea of localAdditions) {
    for (const incomingIdea of incomingAdditions) {
      if (localIdea.id === incomingIdea.id) continue
      const { score, signals } = ideaSimilarity(localIdea, incomingIdea)
      if (score < IDEAS_SIMILAR_MIN_SCORE) continue
      candidates.push({
        candidateId: `duplicate\u0000${localIdea.id}\u0000${incomingIdea.id}`,
        localId: localIdea.id,
        incomingId: incomingIdea.id,
        score,
        signals,
        proposedMerge: {
          kind: 'merge',
          sourceId: incomingIdea.id,
          targetId: localIdea.id,
          mode: 'keepTargetRank',
        },
      })
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score
      || compareText(left.localId, right.localId)
      || compareText(left.incomingId, right.incomingId))
    .slice(0, DUPLICATE_LIMIT)
}

/** Build a deterministic plan without writing or mutating any input. */
export function planIdeasSyncMerge(input: IdeasSyncMergeInput): IdeasSyncMergePlan {
  const localWorkspace = input.localIdeas
    .filter(idea => idea.workspaceId === input.workspaceId)
    .map(portableIdeaOf)
  const local = new Map(localWorkspace.map(idea => [idea.id, idea]))
  const incoming = new Map(input.incoming.ideas.map(idea => [idea.id, clone(idea)]))
  const ancestor = new Map((input.ancestorIdeas ?? []).map(idea => [idea.id, clone(idea)]))
  const mode: IdeasSyncMergeMode = input.ancestorIdeas === undefined ? 'two-way' : 'three-way'
  const resolutions = new Map((input.resolutions ?? []).map(resolution => [resolution.conflictId, resolution]))
  const consumed = new Set<string>()
  const attemptedStructural = new Set<string>()
  const conflicts: IdeasSyncConflict[] = []
  const conflicted = new Set<string>()
  const merged = new Map<string, IdeasSyncIdea>()

  const ids = new Set([...local.keys(), ...incoming.keys(), ...ancestor.keys()])
  const orderedIds = [
    ...localWorkspace.map(idea => idea.id),
    ...input.incoming.ideas.map(idea => idea.id).filter(id => !local.has(id)),
    ...[...ancestor.keys()].filter(id => !local.has(id) && !incoming.has(id)),
  ]
  for (const id of ids) {
    const base = ancestor.get(id)
    const localIdea = local.get(id)
    const incomingIdea = incoming.get(id)

    if (mode === 'two-way') {
      // Absence is never a deletion without an ancestor. Destination-only rows
      // stay untouched; incoming-only rows are creations.
      if (localIdea === undefined) {
        if (incomingIdea !== undefined) merged.set(id, createdIdea(incomingIdea))
        continue
      }
      if (incomingIdea === undefined) {
        merged.set(id, clone(localIdea))
        continue
      }
    } else if (base !== undefined) {
      if (localIdea === undefined && incomingIdea === undefined) continue
      if (localIdea === undefined || incomingIdea === undefined) {
        const survivor = localIdea ?? incomingIdea!
        const idConflict = conflictId(id, 'existence', 'delete-edit')
        if (!equal(survivor, base)) {
          consumed.add(idConflict)
          conflicted.add(id)
          const resolution = resolutions.get(idConflict)
          if (resolution?.choice === 'local') {
            if (localIdea !== undefined) merged.set(id, clone(localIdea))
            conflicted.delete(id)
          } else if (resolution?.choice === 'remote') {
            if (incomingIdea !== undefined) merged.set(id, createdIdea(incomingIdea))
            conflicted.delete(id)
          } else if (resolution?.choice === 'clear') {
            conflicts.push({
              conflictId: idConflict,
              kind: 'delete-edit',
              ideaId: id,
              message: `idea ${id} was deleted on one machine and modified on the other`,
              resolutionError: 'a whole-idea deletion conflict cannot be cleared; choose local or remote',
            })
          } else {
            conflicts.push({
              conflictId: idConflict,
              kind: 'delete-edit',
              ideaId: id,
              ...(localIdea === undefined ? {} : { local: clone(localIdea) }),
              ...(incomingIdea === undefined ? {} : { incoming: clone(incomingIdea) }),
              base: clone(base),
              message: `idea ${id} was deleted on one machine and modified on the other`,
            })
          }
        }
        // One-sided deletion of unchanged content is accepted, including the
        // explicit delete/delete case where neither side carries the row.
        continue
      }
    } else if (localIdea === undefined) {
      if (incomingIdea !== undefined) merged.set(id, createdIdea(incomingIdea))
      continue
    } else if (incomingIdea === undefined) {
      merged.set(id, clone(localIdea))
      continue
    }

    const localRow = localIdea!
    const incomingRow = incomingIdea!
    const next = clone(localRow)
    for (const field of SCALAR_FIELDS) {
      setField(next, field, mergeField({
        ideaId: id,
        field,
        base,
        local: localRow,
        incoming: incomingRow,
        mode,
        resolutions,
        conflicts,
        consumed,
      }))
    }
    for (const field of [...RELATION_FIELDS, 'followUpOfId'] as const) {
      setField(next, field, mergeField({
        ideaId: id,
        field,
        base,
        local: localRow,
        incoming: incomingRow,
        mode,
        resolutions,
        conflicts,
        consumed,
      }))
    }
    const tags = mergeTags({
      ideaId: id,
      base,
      local: localRow,
      incoming: incomingRow,
      resolutions,
      conflicts,
      consumed,
    })
    setField(next, 'tags', tags)
    // Rank is intentionally not merged as a scalar. Existing rows keep the
    // destination rank; new rows stay unranked until an explicit reorder is
    // accepted below.
    next.updatedAt = mergedTimestamp(localRow, incomingRow, next)
    merged.set(id, next)
  }

  // Backlog order is compared as relative sequences, never as portable rank
  // numbers. Destination-only anchors keep their slots; creations append in
  // incoming package order.
  const baseOpen = openOrder([...ancestor.values()])
  const localOpen = openOrder(localWorkspace)
  const incomingOpen = openOrder(input.incoming.ideas)
  const baseSet = new Set(baseOpen)
  const localSet = new Set(localOpen)
  const incomingSet = new Set(incomingOpen)
  const localBaseOrder = localOpen.filter(id => baseSet.has(id))
  const incomingBaseOrder = incomingOpen.filter(id => baseSet.has(id))
  const localChanged = !sameSequence(baseOpen.filter(id => localSet.has(id)), localBaseOrder)
  const incomingChanged = !sameSequence(baseOpen.filter(id => incomingSet.has(id)), incomingBaseOrder)
  let acceptIncomingReorder = false
  let orderConflict = false
  if (mode === 'three-way' && incomingChanged) {
    if (!localChanged) acceptIncomingReorder = true
    else if (sameSequence(localBaseOrder.filter(id => incomingSet.has(id)), incomingBaseOrder.filter(id => localSet.has(id)))) {
      acceptIncomingReorder = true
    } else {
      orderConflict = true
      const id = conflictId('__order__', 'rank', 'order')
      consumed.add(id)
      const resolution = resolutions.get(id)
      if (resolution?.choice === 'remote') {
        acceptIncomingReorder = true
        orderConflict = false
      } else if (resolution?.choice === 'local') {
        orderConflict = false
      } else {
        conflicts.push({
          conflictId: id,
          kind: 'order',
          ideaId: '',
          field: 'rank',
          local: localBaseOrder,
          incoming: incomingBaseOrder,
          base: baseOpen,
          message: 'both machines reordered the open backlog differently',
          ...(resolution?.choice === 'clear' ? { resolutionError: 'a backlog order cannot be cleared; choose local or remote' } : {}),
        })
      }
    }
  }

  const finalOpenExisting = localOpen.filter(id => merged.has(id))
  const createdOpen = input.incoming.ideas
    .filter(idea => !local.has(idea.id) && merged.get(idea.id)?.status === 'open')
    .map(idea => idea.id)
  let finalOpen = [...finalOpenExisting, ...createdOpen]
  let reorderSlots = 0
  if (acceptIncomingReorder && !orderConflict) {
    const reorderable = new Set(baseOpen.filter(id => local.has(id) && incoming.has(id) && merged.get(id)?.status === 'open'))
    const slots: number[] = []
    finalOpen.forEach((id, index) => { if (reorderable.has(id)) slots.push(index) })
    const remoteOrder = incomingOpen.filter(id => reorderable.has(id) && merged.get(id)?.status === 'open')
    if (slots.length === remoteOrder.length) {
      reorderSlots = slots.length
      slots.forEach((slot, index) => { finalOpen[slot] = remoteOrder[index]! })
    }
  }
  const reorder = acceptIncomingReorder && reorderSlots > 0 && !sameSequence(finalOpenExisting, finalOpen)
    ? { status: 'open' as const, orderedIds: finalOpen }
    : null

  // Start from the complete destination board so cross-workspace references and
  // cycles are validated too, then overlay this workspace's merged projection.
  const originalCandidate = new Map(input.localIdeas.map(idea => [idea.id, portableIdeaOf(idea)]))
  const candidate = new Map([...originalCandidate].map(([id, idea]) => [id, clone(idea)]))
  const workspaceIds = new Set(orderedIds.filter(id => local.has(id) || incoming.has(id)))
  for (const id of workspaceIds) {
    const idea = merged.get(id)
    if (idea === undefined) candidate.delete(id)
    else candidate.set(id, clone(idea))
  }
  reconcileCandidate({
    candidate,
    merged,
    workspaceIds,
    deletedIds: new Set(input.localIdeas.map(idea => idea.id).filter(id => !candidate.has(id))),
    localRows: originalCandidate,
    incoming,
    resolutions,
    conflicts,
    consumed,
    attemptedStructural,
  })

  for (const conflict of conflicts) {
    if (conflict.ideaId !== '') conflicted.add(conflict.ideaId)
  }
  const externalRelationUpdates = input.localIdeas
    .filter(idea => !workspaceIds.has(idea.id)
      && candidate.has(idea.id)
      && !equal(originalCandidate.get(idea.id), candidate.get(idea.id)))
    .map(idea => idea.id)
  const outputOrder = [
    ...localWorkspace.map(idea => idea.id).filter(id => merged.has(id)),
    ...input.incoming.ideas.map(idea => idea.id).filter(id => !local.has(id) && merged.has(id)),
    ...externalRelationUpdates,
  ]
  const deletedIds = [...new Set([...localWorkspace.map(idea => idea.id), ...ancestor.keys()])].filter(id => !merged.has(id))
  const operations = [...outputOrder, ...deletedIds].map(id => operationFor(
    id,
    local.get(id) ?? originalCandidate.get(id),
    incoming.get(id),
    merged.get(id) ?? candidate.get(id),
    ancestor.get(id),
    conflicted,
  ))
  for (const id of workspaceIds) {
    if (conflicted.has(id) && !operations.some(operation => operation.ideaId === id)) {
      operations.push(operationFor(id, local.get(id), incoming.get(id), merged.get(id), ancestor.get(id), conflicted))
    }
  }
  operations.sort((left, right) => {
    const leftIndex = orderedIds.indexOf(left.ideaId)
    const rightIndex = orderedIds.indexOf(right.ideaId)
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
      || compareText(left.ideaId, right.ideaId)
  })

  const invalidResolutions = [...resolutions.keys()].filter(id => !consumed.has(id)).sort()
  const ideas = outputOrder.map(id => clone(merged.get(id) ?? candidate.get(id)!))
  return {
    format: 'dsh-ideas-merge-plan',
    version: 1,
    mode,
    incomingSnapshotId: input.incoming.snapshotId,
    baseSnapshotId: input.incoming.baseSnapshotId,
    ancestorSnapshotId: input.ancestorIdeas === undefined ? null : input.incoming.baseSnapshotId,
    workspaceId: input.workspaceId,
    syncKey: input.incoming.workspace.syncKey,
    operations,
    ideas,
    conflicts,
    invalidResolutions,
    duplicateCandidates: duplicateCandidates(new Set(ancestor.keys()), localWorkspace, input.incoming.ideas, merged),
    reorder,
    ready: conflicts.length === 0 && invalidResolutions.length === 0,
  }
}

/** Resolve one cached ancestor by the exact snapshot id carried by the package. */
export function ideasSyncAncestor(
  snapshots: readonly IdeasSyncSnapshotCache[],
  incoming: IdeasSyncPackage,
): readonly IdeasSyncIdea[] | undefined {
  if (incoming.baseSnapshotId === null) return undefined
  return snapshots.find(snapshot => snapshot.snapshotId === incoming.baseSnapshotId)?.ideas
}
