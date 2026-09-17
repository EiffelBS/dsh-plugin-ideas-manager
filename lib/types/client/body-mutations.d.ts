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
/**
 * Subscribe to a coalesced DOM re-check without retaining mutation records.
 */
export declare function subscribeBodyInvalidations(subscriber: () => void): () => void;
/**
 * Subscribe to body-level childList mutations.
 * @param subscriber - called at most once per animation frame with the records
 *   collected since the previous flush; must be safe to run repeatedly.
 * @returns the disposer removing this subscriber (and the observer when it was
 *   the last one).
 */
export declare function subscribeBodyMutations(subscriber: (records: MutationRecord[]) => void): () => void;
