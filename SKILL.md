# SKILL — dsh-plugin-ideas-manager

> Agent-facing usage guide for the generic ideas board. The Host owns a
> persisted `/api/ideas` ledger; the Web GUI renders a 4-column kanban
> (open / under review / archived / declined). The board is **autonomous** — a
> TaskBoard mirror (P2) is optional and detected at runtime.

## When to use this skill

- The user mentions ideas / backlog / idees / notes / ideas board, or wants a
  capture + triage surface independent of the task board.
- Any workspace can host ideas: tag them with `workspaceId` and scope the
  export with `workspaceId` to get one document per workspace. The board
  itself is workspace-aware: the header selector scopes the columns to one
  workspace, the New/Edit modal carries a workspace field (a capture lands
  in the currently-selected scope), and cards with a workspace show a chip
  you can click to jump the board to that scope.

## Process (agent-facing protocol)

The ledger is the SOURCE OF TRUTH for ideas — it replaces any
`IDEAS.md` / `IDEAS-ARCHIVE.md` file convention (the markdown export is a
generated view, never parsed back). Follow this protocol when the user
mentions ideas / backlog / idees / notes:

1. **Capture into the ledger, never into a file**: `create` with a title
   plus a body holding the analysis as markdown — context, value, effort,
   first-step sketch / execution info, risks. Pick the `workspaceId` of the
   project being discussed (generic when the user does not scope it).
2. **Priority opinion on capture**: set `value` + `effort` levels and a
   suggested `rank`.
3. **Re-rank the whole open backlog** on every material change (new idea,
   delivery, scope change): read `GET /api/ideas/state`, then re-order the
   open ideas so the Priorities tab stays the current best ordering — never a
   plain append. Use `triage` when you are recording a priority opinion
   (value/effort + rationale + rank are applied transactionally with the
   re-rank); use `reorder` for pure re-ordering. Re-rank only on material
   change; ranks stay advisory (scheduling is the author's call).
4. **Lifecycle / recette**: finished work moves to UNDER REVIEW — the recette
   gate (automatically when its task-board card reaches `done`). A recette OK
   delivers the idea (`deliver` → `archived` + `deliveredAt`; record
   commits/verification notes in the body first); a recette NOK raises a
   linked follow-up idea with `followUp` (child, `open`, whose body carries
   the parent summary + the justification, `followUpOfId` → parent) and
   archives the parent — or use `decline` (+ `decision`) when the recette
   rejects the idea outright. The ledger keeps a stable `#N` sequence per
   idea (`ideaNumber`) — the stable human reference for a captured idea.
5. **TaskBoard mirror** (best-effort, one-way, when the board is present):
   capture → backlog card, updates → card update, decline / deliver →
   archive; a card reaching `done` moves its idea to under review
   automatically (the recette gate) — the recette verdict stays human-owned.

## Workspace cutover (replacing an IDEAS.md convention)

For a workspace whose AGENTS.md still points at an `IDEAS.md` / archive
convention:

1. Point the AGENTS.md idea section at this board instead (announce
   `announceToAgent: true` in the plugin settings so the guidance above is
   injected every session) and load this skill before idea work.
2. Migrate the still-open ideas into the ledger once, via the `import` verb
   driven from the current capture documents (`## Idea #N` sections, with
   `open` / `archived` / `declined` states resolved per section and a target
   `workspaceId`), or capture them through the board. For a project already
   partially migrated, import only what the ledger is missing so the states
   and `deliveredAt` stamps land correctly.
3. Keep `IDEAS.md` / `IDEAS-ARCHIVE.md` only as generated exports of the
   ledger (the `export` verb) — never edit them by hand again.
4. Ranks/records live on the ideas (rationale, delivery record, decision);
   nothing is hand-maintained in a document anymore.

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
| `create` | kind, id, input | input keys: `title`*, `body`*, `workspaceId`, `rank`, `value`, `effort`, `rationale`, `tags`. Starts `open`, stamped with the next `ideaNumber`. |
| `update` | kind, ideaId, patch | patch keys: `title`, `body`, `rank`, `value`, `effort`, `rationale`, `tags`, `workspaceId`; `null` tags clears. |
| `move` | kind, ideaId, status | `open` / `underReview` / `archived` (manual drag; declined only via `decline`). |
| `triage` | kind, ideaId, patch | record the priority opinion and re-rank transactionally; patch keys: `value`, `effort`, `rationale`, `rank` (open ideas only). |
| `decline` | kind, ideaId, decision | → `declined` + `archivedAt` + optional `decision` note. |
| `deliver` | kind, ideaId | → `archived` + `archivedAt` + `deliveredAt`; works from `open` AND `underReview` (recette OK). Mirrors the card archive; the card's `done` stays runner-owned. |
| `followUp` | kind, ideaId, input | recette NOK: creates an `open` child idea (title/body, `followUpOfId` → parent, parent's workspace inherited) and archives the parent — one atomic commit; requires the parent `underReview`. Mirrors the child as a new card only. |
| `restore` | kind, ideaId | `archived`/`declined` → `open`. |
| `delete` | kind, ideaId | hard remove. |
| `reorder` | kind, orderedIds | rewrites ranks 1..n. |
| `import` | kind, sourceId, ideas | bulk migration; never executes fields. |
| `export` | kind, workspaceId | `{ ok: true, export: { ideasMd, archiveMd } }`; does **not** write — the agent writes the files. |

Errors: `forbidden` (403), `json-required` (415), `invalid-action` (400),
`body-too-large` (413). `IdeaRecord`: see `src/core/ideas.ts` — `id`, `title`
(≤200), `body` (≤32 KiB), `status`, optional `rank/value/effort/rationale/
tags` (≤8, name ≤32, promptPrefix ≤200)/`workspaceId`/`taskBoardId`/
`deliveredAt`/`decision`, `ideaNumber` (stable capture `#N`), timestamps.

## TaskBoard mirror (P2)

- Feature-detect: the Host probes its own `GET /api/task-board/state` over
  loopback. Present → mirror active; absent → board fully autonomous.
- One-way, best-effort, never rolls back an idea:
  - idea `create` → task `create` (permission `read-only`) **+ `move backlog`**
  - idea `update` → task `update` (title/description/prompt/tags/workspaceId)
  - idea `decline` / drag to archived / `deliver` → task `archive`
  - idea `followUp` → the child idea mirrors as a fresh task (the parent card
    is already done); the parent itself mirrors nothing
  - idea `move` to `underReview` → **no mirror** (the card already passed done)
  - idea `restore` → task `restore`
  - idea `delete` → **no-op** (the card outlives the idea)
- Under-review poll: while the mirror is active, the Host polls the task
  statuses (`GET /api/task-board/state`, every 30 s) and moves any open idea
  whose bound card is `done` to `underReview` — the automatic recette gate.
- Mirror-late: an idea created while the bridge was off is self-healed on the
  first update/decline (the card is created then the op applies).
- The task `prompt` = the idea's tag `promptPrefix` lines joined with `\n`.
- **The recette is human-owned**: when a card reaches `done`, the poll moves
  the linked idea to under review automatically — but the recette verdict
  (Recette OK → deliver, or NOK → follow-up / decline) is the author's call
  on the board. Never automate an idea → done from the ideas side.
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