/**
 * One `document.body` MutationObserver per page, shared by every family
 * plugin bundle that injects at the DOM level (like the dsh-task-board /
 * dsh-ssh family hub). Consumers re-check their injected nodes whenever the
 * shell re-renders around them; a page carrying several family plugins pays
 * exactly one native observer instead of one per plugin.
 *
 * The registry lives on `globalThis` under a `Symbol.for` key, so separate
 * module instances (per-package copies, separately bundled plugins) all
 * reach the same hub at runtime instead of one hub per module instance.
 * Record subscribers receive the mutations accumulated since the last flush;
 * consumers that only re-check their DOM use subscribeBodyInvalidations (at
 * most one callback per animation frame). The last subscriber disconnects
 * the observer, cancels the pending frame and releases its records.
 *
 * Failure policy: without a DOM or `MutationObserver` the subscription is a
 * no-op disposer; when `requestAnimationFrame` is unavailable the flush runs
 * synchronously. A throwing subscriber cannot stop the others.
 */

/** The page-wide hub: one observer plus its subscribers and pending records. */
interface BodyMutationHub {
  observer: MutationObserver
  subscribers: Set<(records: MutationRecord[]) => void>
  pending: MutationRecord[]
  scheduled: boolean
  frame?: number
}

/** Cross-bundle registry key; `Symbol.for` so every module copy agrees. */
const HUB_KEY = Symbol.for('dsh-web.body-mutation-hub')
const INVALIDATION_ONLY = Symbol.for('dsh-web.body-mutation-invalidation')
type Subscriber = ((records: MutationRecord[]) => void) & { [INVALIDATION_ONLY]?: true }

function needsRecords(subscribers: Set<(records: MutationRecord[]) => void>): boolean {
  for (const listener of subscribers) {
    if (!(listener as Subscriber)[INVALIDATION_ONLY]) return true
  }
  return false
}

/**
 * Subscribe to a coalesced DOM re-check without retaining mutation records.
 */
export function subscribeBodyInvalidations(subscriber: () => void): () => void {
  const listener: Subscriber = () => { subscriber() }
  listener[INVALIDATION_ONLY] = true
  return subscribeBodyMutations(listener)
}

/**
 * Subscribe to body-level childList mutations.
 * @param subscriber - called at most once per animation frame with the records
 *   collected since the previous flush; must be safe to run repeatedly.
 * @returns the disposer removing this subscriber (and the observer when it was
 *   the last one).
 */
export function subscribeBodyMutations(subscriber: (records: MutationRecord[]) => void): () => void {
  if (typeof globalThis === 'undefined' || typeof document === 'undefined') return () => {}
  if (typeof MutationObserver !== 'function') return () => {}
  const registry = globalThis as unknown as Record<symbol, unknown>
  let hub = registry[HUB_KEY] as BodyMutationHub | undefined
  if (hub === undefined) {
    const subscribers = new Set<(records: MutationRecord[]) => void>()
    const created: BodyMutationHub = {
      observer: undefined as unknown as MutationObserver,
      subscribers,
      pending: [],
      scheduled: false,
    }
    const flush = (): void => {
      created.frame = undefined
      created.scheduled = false
      const batch = created.pending
      created.pending = []
      for (const listener of [...subscribers]) {
        if (!subscribers.has(listener)) continue
        try {
          listener(batch)
        } catch {
          // One subscriber must never break the others; the next flush retries it.
        }
      }
    }
    const schedule = (): void => {
      if (created.scheduled) return
      created.scheduled = true
      if (typeof requestAnimationFrame === 'function') created.frame = requestAnimationFrame(flush)
      else flush()
    }
    created.observer = new MutationObserver((records) => {
      if (needsRecords(subscribers)) {
        for (const record of records) created.pending.push(record)
      }
      schedule()
    })
    created.observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
    registry[HUB_KEY] = created
    hub = created
  }
  const active = hub
  active.subscribers.add(subscriber)
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    active.subscribers.delete(subscriber)
    if (!needsRecords(active.subscribers)) active.pending = []
    if (active.subscribers.size === 0 && registry[HUB_KEY] === active) {
      active.observer.disconnect()
      if (active.frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(active.frame)
      active.frame = undefined
      active.pending = []
      active.scheduled = false
      delete registry[HUB_KEY]
    }
  }
}
