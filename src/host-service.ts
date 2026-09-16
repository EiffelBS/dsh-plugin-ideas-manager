/**
 * Ideas host service: owns the ledger and fans its change notifications out to
 * the SSE route. No timers, no sessions — the ideas board is a passive
 * Host-authoritative store (unlike the task board's execution runner).
 */

import { IdeasHostLedger, type LedgerApplyResult } from './host-ledger.ts'
import {
  IDEAS_SCHEMA_VERSION,
  type IdeasAction,
  type IdeasEventPayload,
  type IdeasSnapshot,
} from './protocol.ts'

/** Apply response: the fresh snapshot, plus the generated export when asked. */
export interface IdeasApplyResponse {
  state: IdeasSnapshot
  export?: { ideasMd: string; archiveMd: string }
}

export class IdeasHostService {
  readonly ledger: IdeasHostLedger
  private readonly listeners = new Set<() => void>()
  private active = true
  private disposed = false

  constructor(options: { ledger?: IdeasHostLedger } = {}) {
    this.ledger = options.ledger ?? new IdeasHostLedger()
    this.ledger.subscribe(() => { this.emit() })
  }

  setActive(active: boolean): void {
    this.active = active
    this.emit()
  }

  snapshot(): IdeasSnapshot {
    const state = this.ledger.snapshot()
    return {
      schemaVersion: IDEAS_SCHEMA_VERSION,
      revision: state.revision,
      ideas: state.ideas,
    }
  }

  /** SSE frame payload; deliberately skips the ideas deep-clone of {@link snapshot}. */
  eventPayload(): IdeasEventPayload {
    return this.ledger.summary()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: IdeasAction, initiator?: string): IdeasApplyResponse {
    // P0: the initiator is accepted for contract parity and recorded by the
    // ledger cache only; P1 adds the audit stamp to created/updated ideas.
    void initiator
    if (!this.active) throw new Error('ideas plugin is disabled')
    const result: LedgerApplyResult = this.ledger.applyRequest(requestId, action)
    const state = result.state
    return {
      state: {
        schemaVersion: IDEAS_SCHEMA_VERSION,
        revision: state.revision,
        ideas: state.ideas,
      },
      ...(result.export === undefined ? {} : { export: result.export }),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ledger.dispose()
    this.listeners.clear()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
