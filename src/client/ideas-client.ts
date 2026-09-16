/**
 * Framework-free client controller for the ideas board: holds the open flag
 * and the latest Host snapshot, refreshes through the transport, and notifies
 * subscribers (the sidebar row and the React board). No React, no cordis —
 * the DOM mounts at the edges only.
 */

import type { IdeasSnapshot } from '../protocol.ts'
import type { IdeasHostTransport } from './host-api.ts'

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export class IdeasClient {
  boardOpen = false
  snapshot: IdeasSnapshot | undefined
  error: string | undefined
  pending = false
  private readonly listeners = new Set<() => void>()
  private unsubscribeEvents: (() => void) | undefined

  constructor(private readonly transport: IdeasHostTransport) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  toggleBoard(): void {
    this.boardOpen = !this.boardOpen
    this.emit()
  }

  closeBoard(): void {
    if (!this.boardOpen) return
    this.boardOpen = false
    this.emit()
  }

  /** Initial load + SSE revision push refresh. */
  start(): void {
    void this.refresh()
    try {
      this.unsubscribeEvents = this.transport.subscribe(() => { void this.refresh() })
    } catch (error) {
      // A failed SSE subscription degrades to manual refresh only.
      console.error('[dsh-plugin-ideas-manager] event subscription failed', error)
    }
  }

  dispose(): void {
    this.unsubscribeEvents?.()
    this.listeners.clear()
  }

  async refresh(): Promise<void> {
    try {
      this.snapshot = await this.transport.state()
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.emit()
  }

  /** Create an idea through the Host and adopt the returned snapshot. */
  async createIdea(input: { title: string; body: string; tags?: string[] }): Promise<void> {
    this.pending = true
    this.emit()
    try {
      const tags = (input.tags ?? [])
        .map(tag => tag.trim())
        .filter(tag => tag !== '')
        .map(name => ({ name }))
      const snapshot = await this.transport.action({
        kind: 'create',
        id: uuid(),
        input: {
          title: input.title,
          body: input.body,
          ...(tags.length === 0 ? {} : { tags }),
        },
      })
      this.snapshot = snapshot
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.pending = false
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
