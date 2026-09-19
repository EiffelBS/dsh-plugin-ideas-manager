# T3 — Session-aware capture (design + delivered part)

Status: core delivered, 2026-09-19. Follows `docs/gap-analysis-ot-ideasm-process.md` G4
("Generic workspace capture routing"). This document pins the design decisions
and separates what is implemented from the optional follow-up that must stay
author-gated.

## Problem

The board is workspace-aware in the UI (scope selector, workspace field on the
New/Edit modal, clickable workspace chip), but agent-side capture had no notion
of "the active workspace of this session": `workspaceId` was a free field, so a
capture between two projects defaulted to generic unless the author selected a
board scope first. For a generic board that any DSH workspace can use, a capture
should land where the conversation is happening.

## Session resolution (implemented)

The shell already resolves "the workspace of the current session" for its own
flows (`@linxin666/dsh-web-all` git-graph auto-isolation and the task-board
family). The ideas plugin consumes the same two services defensively — no hard
import, degrades to the pre-T3 behaviour when either is absent.

Resolution rule (mirrors the shell exactly):

```
sessions.list.getSnapshot().current            -> the current session id
workspaces.list.getSnapshot().items[].sessionIds.includes(current)
                                               -> that session's workspace
workspaces.list.getSnapshot().recentWorkspaceId
                                               -> fallback when no session is
                                                  bound to a workspace yet
```

Files:

- `src/client/session-context.ts` — `resolveActiveWorkspace` (pure, unit-tested),
  `DshActiveWorkspaceSource` (watches both streams), `resolveActiveWorkspaceSource`
  (defensive `ctx.get` probing, `undefined` when malformed).
- `src/client/ideas-client.ts` — optional `ActiveWorkspaceSource` in the
  constructor, exposed as `client.activeWorkspace`.
- `src/client/board-view.tsx` — the New-idea modal default: an **edit** keeps
  the idea's own workspace; a **scoped** board preselects its scope (explicit
  beats session); an **unscoped capture** preselects the current session's
  workspace with a hint ("Current session workspace — change if needed").
- `src/client/index.ts` — `inject` now also waits on the `sessions` service.

Fallback chain (highest wins): idea workspace (edit) → board scope → current
session workspace → generic (`''`).

Tests: `tests/session-context.test.ts` (9 cases: resolution, fallback,
degradation, stream reactivity, ctx probing).

## Optional follow-up (design only — NOT implemented)

"Auto-install the ideas skill into a workspace's `.dsh`" (G4 wording). The OT
process ships a workspace-local skill (`.dsh/skills/task-board/SKILL.md`) so the
per-workspace AGENTS.md can point agents at the board. Two constraints keep this
out of the delivered tranche:

1. **No arbitrary workspace writes.** The plugin lives in the DSH home; writing
   a file inside a project workspace is a side effect on the author's repo and
   must be explicit per workspace, not silent. Any implementation must be a
   *manifested* workflow: the author touches a control (settings toggle "install
   the ideas skill for this workspace", or an action in the board once a
   workspace has ideas), never a capture-triggered write.
2. **The skill file itself already exists** (`SKILL.md` at the repo root). The
   install step would copy it to `<workspace>/.dsh/skills/ideas/SKILL.md`
   (optionally with the workspace id pre-resolved). Nothing in the plugin
   currently reads that location, so this is purely about the per-workspace
   AGENTS.md pointer — see the OT cutover note below.

Recommended shape when the author asks for it: a settings flag per workspace
stored in the ideas settings namespace (`ideas`), a Host verb `installSkill`
feature-detecting the target directory through the workspaces registry
(`ctx.workspaceRegistry`, read-only list + explicit path), and a confirmation
surface in the board UI. Fence: the verb stays behind the loopback + same-origin
guard like every other action; the write targets an explicit workspace path only.

## OT cutover

The per-workspace cutover stays a one-line AGENTS.md flip per project (T0):
point the "Ideas backlog sync" section at the board + `SKILL.md`, keep
`IDEAS.md` / `IDEAS-ARCHIVE.md` only as generated exports. T3 does not change
that; the session-aware default only means captures now land in the active
workspace without the agent asking "which project?".
