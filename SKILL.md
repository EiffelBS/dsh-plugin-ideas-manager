# SKILL — dsh-plugin-ideas-manager

> Agent-facing usage guide for the generic ideas board. The Host owns a
> persisted `/api/ideas` ledger; the Web GUI renders a 3-column kanban
> (open / archived / declined). The board is **autonomous** — a TaskBoard
> mirror (P2) is optional and detected at runtime.

## When to use this skill

- The user mentions ideas / backlog / idees / notes / ideas board, or wants a
  capture + triage surface independent of the task board.
- Any workspace can host ideas: tag them with `workspaceId` and scope the
  export with `workspaceId` to get one document per workspace. The board
  itself is workspace-aware: the header selector scopes the columns to one
  workspace, the New/Edit modal carries a workspace field (a capture lands
  in the currently-selected scope), and cards with a workspace show a chip
  you can click to jump the board to that scope.

## Contract (copy of `src/protocol.ts`)

- Prefix: `/api/ideas`. Guard: loopback socket + browser same-origin markers
  (`Origin` / `Sec-Fetch-Site: same-origin`); `Content-Type: application/json`
  required; 64 KiB action cap / 2 MiB import cap.
- Envelope (strict `exactKeys`; `invalid-action` otherwise):
  `{ "requestId": "<non-empty <256>", "action": { "kind": "...", ... }, "initiator": "<opt>" }`.
  The `requestId` is deduped by the Host (persisted across restarts) — use a
  stable id for retries; reusing it with a different action is rejected.
- `GET /api/ideas/state` → `{ schemaVersion: 1, revision, ideas[] }`
- `GET /api/ideas/events` → SSE frames `{ revision }` (no full list).
- `POST /api/ideas/action` verbs:

| kind | keys | notes |
|---|---|---|
| `create` | kind, id, input | input keys: `title`*, `body`*, `workspaceId`, `rank`, `value`, `effort`, `tags`. Starts `open`. |
| `update` | kind, ideaId, patch | patch keys: `title`, `body`, `rank`, `value`, `effort`, `tags`, `workspaceId`; `null` tags clears. |
| `move` | kind, ideaId, status | `open` ↔ `archived` (manual drag). |
| `decline` | kind, ideaId | → `declined` + `archivedAt`. |
| `restore` | kind, ideaId | `archived`/`declined` → `open`. |
| `delete` | kind, ideaId | hard remove. |
| `reorder` | kind, orderedIds | rewrites ranks 1..n. |
| `import` | kind, sourceId, ideas | bulk migration; never executes fields. |
| `export` | kind, workspaceId | `{ ok: true, export: { ideasMd, archiveMd } }`; does **not** write — the agent writes the files. |

Errors: `forbidden` (403), `json-required` (415), `invalid-action` (400),
`body-too-large` (413). `IdeaRecord`: see `src/core/ideas.ts` — `id`, `title`
(≤200), `body` (≤32 KiB), `status`, optional `rank/value/effort/tags`
(≤8, name ≤32, promptPrefix ≤200)/`workspaceId`/`taskBoardId`, timestamps.

## TaskBoard mirror (P2)

- Feature-detect: the Host probes its own `GET /api/task-board/state` over
  loopback. Present → mirror active; absent → board fully autonomous.
- One-way, best-effort, never rolls back an idea:
  - idea `create` → task `create` (permission `read-only`) **+ `move backlog`**
  - idea `update` → task `update` (title/description/prompt/tags/workspaceId)
  - idea `decline` / drag to archived → task `archive`
  - idea `restore` → task `restore`
  - idea `delete` → **no-op** (the card outlives the idea)
- Mirror-late: an idea created while the bridge was off is self-healed on the
  first update/decline (the card is created then the op applies).
- The task `prompt` = the idea's tag `promptPrefix` lines joined with `\n`.
- **Closing the loop to `done` is manual**: run the mirrored task from the
  task board to complete the work; mark the idea delivered yourself. Never
  automate an idea → done.
- The bound card id persists on the idea as `taskBoardId` (internal field,
  never accepted from the wire). The settings namespace `ideas` exposes
  `enabled`, `announceToAgent` (default false) and `autoMirror` (default true).

## Gotchas (Windows PowerShell, DSH host)

- Prefer `curl.exe` with `--data @file` for JSON bodies: PowerShell 5.1
  `WriteAllText(..., UTF8)` emits a **BOM** that JSON.parse rejects, and
  inline `--data` mangles quotes. Write a BOM-free ASCII file first
  (`Set-Content -Encoding ascii -NoNewline`).
- `Invoke-RestMethod -UseBasicParsing` works; never `Invoke-WebRequest`
  non-interactively for the SSE/action calls.
- The loopback guard needs the browser markers — a bare curl is refused.
- Ledger: `~/.dsh/ideas/ledger-v2.json` (atomic tmp+rename, no fsync; a crash
  recovers via the corrupt/quarantine path). Do not hand-edit while a Host is
  live — the lock directory refuses a second writer.

## File map

```
src/protocol.ts          wire gate (exactKeys, envelope)
src/host-ledger.ts       persistence, dedupe cache, lock, internal taskBoardId bind
src/host-service.ts      apply + mirror scheduling
src/host-routes.ts       /api/ideas/* fence + SSE
src/taskboard-bridge.ts  feature-detect + one-way mirror (no hard import)
src/export-markdown.ts   unidirectional ledger -> markdown
src/core/ideas.ts        domain model + tag validation
```