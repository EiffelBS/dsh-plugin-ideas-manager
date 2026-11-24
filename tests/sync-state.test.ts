/** Pure synchronization view-state guards and complete-plan counts. */

import { describe, expect, it } from 'vitest'
import { bulkSyncResolutions, canApplySync, initialSyncUiState, syncPlanCounts, type SyncUiState } from '../src/client/sync-state.ts'
import type { IdeasSyncMergePlan, IdeasSyncPlanOperation } from '../src/sync-merge.ts'
import type { IdeasSyncPlanResponse } from '../src/sync.ts'

function preview(overrides: Partial<IdeasSyncMergePlan> = {}): IdeasSyncPlanResponse {
  return {
    ok: true,
    revision: 4,
    plan: {
      format: 'dsh-ideas-merge-plan', version: 1, mode: 'two-way',
      incomingSnapshotId: 'snapshot-in', baseSnapshotId: null, ancestorSnapshotId: null,
      workspaceId: 'workspace-a', syncKey: 'sync_12345678',
      operations: [], ideas: [], conflicts: [], invalidResolutions: [], duplicateCandidates: [], reorder: null, ready: true,
      ...overrides,
    },
  }
}

describe('synchronization view state', () => {
  it('counts a workspace-level order conflict even when no row operation is marked conflict', () => {
    const unchanged: IdeasSyncPlanOperation = { ideaId: 'a', action: 'unchanged', changedFields: [] }
    const counts = syncPlanCounts(preview({
      ready: false,
      operations: [unchanged],
      conflicts: [{ conflictId: 'order', kind: 'order', ideaId: '', field: 'rank', message: 'different order' }],
    }))
    expect(counts).toMatchObject({ unchanged: 1, conflict: 1, mappings: 1 })
  })

  it('builds one explicit bulk decision for every current conflict', () => {
    const conflicts = [
      { conflictId: 'title', kind: 'same-field' as const, ideaId: 'a', field: 'title' as const, message: 'title' },
      { conflictId: 'body', kind: 'same-field' as const, ideaId: 'a', field: 'body' as const, message: 'body' },
      { conflictId: 'existence', kind: 'delete-edit' as const, ideaId: 'b', message: 'delete/edit' },
    ]
    expect(bulkSyncResolutions(conflicts, 'remote', [{ conflictId: 'older', choice: 'local' }])).toEqual([
      { conflictId: 'older', choice: 'local' },
      { conflictId: 'title', choice: 'remote' },
      { conflictId: 'body', choice: 'remote' },
      { conflictId: 'existence', choice: 'remote' },
    ])
    expect(bulkSyncResolutions(conflicts, 'local')).toEqual([
      { conflictId: 'title', choice: 'local' },
      { conflictId: 'body', choice: 'local' },
      { conflictId: 'existence', choice: 'local' },
    ])
  })

  it('requires a ready current preview and explicit consent before apply', () => {
    const ready: SyncUiState = {
      ...initialSyncUiState(), phase: 'preview', preview: preview(), applyConsent: true,
    }
    expect(canApplySync(ready, 4)).toBe(true)
    expect(canApplySync(ready, 5)).toBe(false)
    expect(canApplySync({ ...ready, stale: true }, 4)).toBe(false)
    expect(canApplySync({ ...ready, applyConsent: false }, 4)).toBe(false)
    expect(canApplySync({ ...ready, preview: preview({ ready: false }) }, 4)).toBe(false)
  })
})
