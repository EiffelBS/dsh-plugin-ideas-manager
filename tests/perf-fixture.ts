/**
 * Shared performance fixture (idea #34): one deterministic, realistic dataset
 * for the high-card-load evaluation, plus the small helper replicas the
 * benchmarks time.
 *
 * Shape (spec: 100-150 ideas, varied statuses; objective: 100 open cards
 * loading in <1s):
 *  - 140 ideas = 100 open + 12 underReview + 20 archived + 8 declined;
 *  - body sizes anchored on the production ledger (min 886 / p50 3850 /
 *    p90 8241 / max 9452 bytes at 37 cards) but extended to the spec's
 *    future "tens of KB per card" (up to 31.5 KiB, under IDEA_BODY_MAX_BYTES);
 *  - open ranks assigned per workspace group ("rank by workspace");
 *  - summaries, rationales, tags, audits (analysisAudit doubles the payload
 *    of re-analyzed cards), delivered/declined stamps as the ledger carries
 *    them; everything survives the import wire gate (protocol importedIdea).
 *
 * Deterministic: a seeded PRNG makes every BEFORE/AFTER run measure the same
 * data. Opt-in via IDEAS_PERF=1 (tests/perf-*.test.*) - the normal suite
 * stays performance-neutral.
 */

import type { IdeaRecord, IdeaStatus, IdeaTag } from '../src/core/ideas.ts'
import type { IdeasAction } from '../src/protocol.ts'

/** Dataset size: 100 open cards (the spec's measurable objective) + closed. */
export const PERF_OPEN_COUNT = 100
export const PERF_CLOSED_COUNT = 40
export const PERF_IDEA_COUNT = PERF_OPEN_COUNT + PERF_CLOSED_COUNT

/** Fixed wall-clock base so createdAt/updatedAt never drift between runs. */
const EPOCH_BASE = Date.UTC(2026, 0, 5)
const DAY_MS = 86_400_000

/** Seeded PRNG (mulberry32): same seed, same dataset. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'ledger kanban triage rank workspace snapshot projection virtualization ' +
  'markdown card panel render payload transactional backlog deferred ' +
  'analysis idea capture mirror recette decline deliver follow-up reorder ' +
  'filter sort index coerce coherence migration benchmark bottleneck cache ' +
  'stream schema serialize revision dedupe lock fence origin poll band ' +
  'latency memory node reuse clamp scope tag density gear modal drop line'
).split(' ')

type Rand = () => number

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!
}

function int(rand: Rand, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1))
}

function sentence(rand: Rand): string {
  const words = int(rand, 6, 14)
  const parts: string[] = []
  for (let i = 0; i < words; i++) parts.push(pick(rand, WORDS))
  const text = parts.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function paragraph(rand: Rand): string {
  const sentences = int(rand, 3, 6)
  const parts: string[] = []
  for (let i = 0; i < sentences; i++) parts.push(sentence(rand))
  return parts.join(' ')
}

const CODE_SAMPLE = 'const ordered = ideas.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))'

/** One markdown paragraph exercising the inline paths (links, bold, code). */
function inlineRichParagraph(rand: Rand): string {
  return `See [${sentence(rand)}](https://example.invalid/perf) for **details**; \`renderMarkdown\` stays *fast* while the panel scales.\n\n${paragraph(rand)}`
}

/**
 * Markdown body of approximately `targetBytes` (ASCII, so length == bytes),
 * mixing headings, lists, quotes, fenced code and inline-rich paragraphs -
 * every renderMarkdown block path. Truncation may leave a fence unterminated;
 * the renderer consumes it safely.
 */
function markdownBody(rand: Rand, targetBytes: number): string {
  const blocks: string[] = []
  let bytes = 0
  while (bytes < targetBytes) {
    const roll = rand()
    let block: string
    if (roll < 0.08) {
      block = `## ${sentence(rand)}`
    } else if (roll < 0.2) {
      const n = int(rand, 3, 6)
      const items: string[] = []
      for (let i = 0; i < n; i++) items.push(`- ${sentence(rand)}`)
      block = items.join('\n')
    } else if (roll < 0.26) {
      block = `> ${sentence(rand)}\n> ${sentence(rand)}`
    } else if (roll < 0.32) {
      block = `---\n${CODE_SAMPLE}\n${CODE_SAMPLE}`
    } else if (roll < 0.4) {
      block = inlineRichParagraph(rand)
    } else {
      block = paragraph(rand)
    }
    blocks.push(block)
    bytes += block.length + 2
  }
  return blocks.join('\n\n').slice(0, targetBytes)
}

/**
 * Target body size (bytes) per idea. Buckets calibrated on the production
 * ledger (min 886 / p50 3850 / p90 8241 / max 9452) and extended toward the
 * spec's future "tens of KB per card" load:
 *  - 20% small   0.6-2.0 KB (today's floor)
 *  - 55% medium  3.0-9.0 KB (today's p50..p90)
 *  - 20% large   10-20 KB (growth)
 *  -  5% xlarge  24-31.5 KB (spec's voluminous future, under the 32 KiB cap)
 */
function targetBodyBytes(rand: Rand): number {
  const roll = rand()
  if (roll < 0.2) return int(rand, 600, 2000)
  if (roll < 0.75) return int(rand, 3000, 9000)
  if (roll < 0.95) return int(rand, 10_000, 20_000)
  return int(rand, 24_000, 31_500)
}

const TITLE_POOL = [
  'Profile the state endpoint under load',
  'Deferred body projection for the list view',
  'Kanban column virtualization spike',
  'Transactional triage reinsert benchmark',
  'Rank coherence after successive reorders',
  'Server-side index for the open backlog',
  'DOM node reuse during sorting',
  'Tag filter scan optimization',
  'Payload diff between short polls',
  'Markdown render memoization per card',
  'Workspace scope catalog caching',
  'Delivered log pagination',
  'Import path streaming for large ledgers',
  'Settings revision fence latency',
  'Mirror ensure cycle under load',
  'Export markdown for 150 cards',
  'Search index build on snapshot change',
  'Drag autoscroll at long columns',
  'Card density layout measurement',
  'Session capture queue backpressure',
]

const TAG_POOL: readonly string[] = [
  'perf', 'payload', 'kanban', 'render', 'triage',
  'ledger', 'settings', 'mirror', 'i18n', 'a11y',
]

const WORKSPACES = ['ws-opentimbre', 'ws-audiocpp', undefined] as const

/** Status schedule: 100 open (spec objective) + varied closed columns. */
function statusAt(index: number): IdeaStatus {
  if (index < PERF_OPEN_COUNT) return 'open'
  const closed = index - PERF_OPEN_COUNT
  if (closed < 12) return 'underReview'
  if (closed < 32) return 'archived'
  return 'declined'
}

/** Realistic tag list (0-4 entries; open cards mostly tagged). */
function tagsFor(rand: Rand, status: IdeaStatus): IdeaTag[] | undefined {
  const count = status === 'open' ? int(rand, 0, 4) : int(rand, 0, 2)
  if (count === 0) return undefined
  const chosen = [...TAG_POOL]
  const tags: IdeaTag[] = []
  for (let i = 0; i < count && chosen.length > 0; i++) {
    const at = Math.floor(rand() * chosen.length)
    tags.push({ name: chosen.splice(at, 1)[0]! })
  }
  return tags.length === 0 ? undefined : tags
}

/**
 * The deterministic dataset (import-wire-safe, see module doc).
 * Seed fixed: every run, before or after the optimization work, measures the
 * identical 140-idea board.
 */
export function makePerfDataset(seed = 0x5eed): IdeaRecord[] {
  const rand = mulberry32(seed)
  const ideas: IdeaRecord[] = []
  // Ranks are relative to a (status, workspace) peer set ("rank by
  // workspace"): one running counter per group, so every column - open AND
  // the closed ones (closed cards keep their residual rank in the real
  // ledger) - carries contiguous 1..n ranks per workspace.
  const groupRank = new Map<string, number>()

  for (let i = 0; i < PERF_IDEA_COUNT; i++) {
    const id = `perf-idea-${i}`
    const status = statusAt(i)
    const workspaceId = pick(rand, WORKSPACES)
    const createdAt = EPOCH_BASE + int(rand, 0, 200) * DAY_MS
    const updatedAt = Math.min(createdAt + int(rand, 0, 40) * DAY_MS, EPOCH_BASE + 240 * DAY_MS)
    const body = markdownBody(rand, targetBodyBytes(rand))
    const title = `${pick(rand, TITLE_POOL)} (${i})`
    const tags = tagsFor(rand, status)

    const groupKey = `${status}\u0000${workspaceId ?? ''}`
    const rank = (groupRank.get(groupKey) ?? 0) + 1
    groupRank.set(groupKey, rank)

    const idea: IdeaRecord = {
      id,
      title,
      body,
      status,
      createdAt,
      updatedAt,
      ideaNumber: i + 1,
      ...(rank === undefined ? {} : { rank }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(tags === undefined ? {} : { tags }),
    }

    if (status === 'open' || status === 'underReview') {
      if (rand() < 0.7) {
        idea.summary = `${sentence(rand)} ${sentence(rand)}`.slice(0, 300)
      }
      idea.value = int(rand, 1, 5)
      idea.effort = int(rand, 1, 5)
      if (rand() < 0.8) idea.rationale = sentence(rand)
    }

    if (status === 'underReview') {
      idea.taskBoardId = `tb-card-${i}`
    }

    if (status === 'archived' || status === 'declined') {
      idea.archivedAt = updatedAt
      if (status === 'archived' && rand() < 0.7) idea.deliveredAt = updatedAt + 3_600_000
      if (status === 'declined') idea.decision = sentence(rand)
      // Re-analyzed closed cards keep a one-level prior analysis; its body
      // doubles this card's payload (the spec's voluminous-card concern).
      if (rand() < 0.15) {
        idea.analysisAudit = {
          at: updatedAt,
          title: `${title} (prior)`,
          body: markdownBody(rand, int(rand, 3000, 9000)),
        }
      }
    }

    ideas.push(idea)
  }

  // A few follow-up children link to archived parents (lineage badge cost).
  for (let k = 0; k < 3; k++) {
    const child = ideas[PERF_OPEN_COUNT - 1 - k]
    const parent = ideas[PERF_OPEN_COUNT + 12 + k]
    if (child !== undefined && parent !== undefined) child.followUpOfId = parent.id
  }
  return ideas
}

/** The import action the fixture is seeded through (one transaction). */
export function perfImportAction(ideas: readonly IdeaRecord[]): IdeasAction {
  return { kind: 'import', sourceId: 'perf-fixture', ideas: [...ideas] }
}

/**
 * Replica of board-view's private matchesFilter (board-view.tsx - kept in
 * sync manually): the benchmark times the exact per-keystroke scan the board
 * runs - title + summary + tag names always, plus either the whole body
 * (deepBody once the idea#34 search index is loaded) or the list excerpt.
 */
export function scanFilter(
  idea: { title: string; summary?: string; bodyExcerpt: string; tags?: IdeaTag[] },
  filter: string,
  deepBody: string | undefined,
): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  const haystacks = [idea.title, idea.summary ?? '', deepBody ?? idea.bodyExcerpt, ...(idea.tags ?? []).map(tag => tag.name)]
  return haystacks.some(text => text.toLowerCase().includes(needle))
}

/** Elapsed milliseconds of one synchronous run (performance.now based). */
export function timeMs(run: () => void): number {
  const start = performance.now()
  run()
  return performance.now() - start
}

/** Body-size statistics of a dataset, for the measurement report. */
export function bodySizeStats(ideas: readonly IdeaRecord[]): {
  count: number
  total: number
  min: number
  p50: number
  p90: number
  max: number
  avg: number
} {
  const sizes = ideas.map(idea => Buffer.byteLength(idea.body, 'utf8')).sort((a, b) => a - b)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  const at = (q: number): number => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))] ?? 0
  return {
    count: sizes.length,
    total,
    min: sizes[0] ?? 0,
    p50: at(0.5),
    p90: at(0.9),
    max: sizes[sizes.length - 1] ?? 0,
    avg: sizes.length === 0 ? 0 : Math.round(total / sizes.length),
  }
}
