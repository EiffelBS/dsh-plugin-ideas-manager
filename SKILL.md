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
hand-maintained markdown file convention (the markdown export is a
generated view, never parsed back). Follow this protocol when the user
mentions ideas / backlog / idees / notes:

1. **Capture into the ledger, never into a file**: `create` with a title
   plus a body holding the analysis as markdown — context, value, effort,
   first-step sketch / execution info, risks. Pick the `workspaceId` of the
   project being discussed (generic when the user does not scope it).
2. **Priority opinion on capture**: set `value` + `effort` levels and a
   suggested `rank`.
3. **Re-rank the whole open backlog** on every material change (new idea,
   delivery, scope change): read the bounded open workspace view with
   `GET /api/ideas/state?view=summary&workspaceId=<id>&status=open&fields=rank,value,effort,rationale&limit=200`,
   then re-order the open ideas so the Priorities tab stays the current best
   ordering — never a plain append. Follow `meta.nextOffset` if the page is
   truncated. Use `triage` when you are recording a priority opinion
   (value/effort + rationale + rank are applied transactionally with the
   re-rank); use `reorder` for pure re-ordering. Re-rank only on material
   change; ranks stay advisory (scheduling is the author's call).
4. **Lifecycle / review**: finished work moves to UNDER REVIEW — the review
   gate (automatically when its task-board card reaches `done`). An approved review
   delivers the idea (`deliver` → `archived` + `deliveredAt`; record
   commits/verification notes in the body first); a rejected review raises a
   linked follow-up idea with `followUp` (child, `open`, whose body carries
   the parent summary + the justification, `followUpOfId` → parent) and
   archives the parent — or use `decline` (+ `decision`) when the review
   rejects the idea outright. The ledger keeps a stable `#N` sequence per
   idea (`ideaNumber`) — the stable human reference for a captured idea.
5. **Duplicates**: two captures of the same work are reconciled with ONE
   `merge` (sourceId = the duplicate, targetId = the survivor, `mode` =
   `keepTargetRank` or `takeSourceRank`). Pick the survivor as the better-analysed
   card, not the newer one; both ids must share a workspace or the Host refuses
   the merge. To FIND a duplicate first, read the opt-in near-duplicate flag with
   `GET /api/ideas/state?view=summary&similar=<id>&limit=8` — it is a signal, not
   a verdict: read each candidate's real body through
   `GET /api/ideas/idea?id=<candidateId>` before deciding, then merge yourself
   rather than reporting a guess.
6. **TaskBoard mirror** (best-effort, one-way, when the board is present):
   capture → backlog card, updates → card update, decline / deliver →
   archive, a merge → update on the survivor + archive on the loser; a card
   reaching `done` moves its idea to under review
   automatically (the review gate) — the review verdict stays human-owned.

## Point the human at one idea

The board has a **Go to idea** box in its header: the human types `#N` and lands
on that card — opened, scrolled into view and ringed, whatever workspace scope,
search or tag filter was in the way. It works on a board that was closed, and on
an archived card.

So when your answer ends with "see idea #42":

- **Quote the `#N`.** It is the stable reference: a board exported and imported
  on another machine keeps its numbers, and an idea **id** does not survive that
  trip. An id is accepted by the box, but never hand one to a human.
- One line is enough. The human pastes the number; the board finds the card.
- If the box reports that nothing matches, the number is not on THIS board —
  re-read it with `ideas_get` rather than re-typing the title.

## `ideas_*` agent tools (preferred over hand-building the envelope)

When the deployment serves an agent-tool registry, six `ideas_*` tools drive the
same ledger, the same routes and the same launch path as the board. Prefer them
over hand-writing `/api/ideas` envelopes: they take the arguments in plain
language, they refuse the same malformed calls, and every write they make shows
up in the idea's activity log under `agent:plugin:ideas-manager:agent-tool`.

| tool | reads/writes | notes |
|---|---|---|
| `ideas_list` | read | One bounded page of metadata rows (`workspaceId`, `status`, `tag`, `query`, `limit`, `offset`). Never a description — call `ideas_get` for that. |
| `ideas_get` | read | One idea in full: description, priority opinion, activity log, follow-up rows. |
| `ideas_capture` | write | Title + markdown body; optional `summary`, `workspaceId`, `tags` (names only), `value`, `effort`, `rationale`, `rank`. |
| `ideas_triage` | write | Record `value` / `effort` / `rationale` / `rank` on an open idea in one transaction; answers with the resulting group ordering. |
| `ideas_launch` | write | Start the execution (mirrored card or fresh session, resolved by the Host). |
| `ideas_review` | write | Settle the review gate: `approve` (deliver), `followUp` (linked child + archived parent), `decline` (+ `decision`). |

Discipline the tools keep, and so must you:

- A tool call and an HTTP call cannot drift: both go through the same wire gate.
- `runStatus`, `runSessionId` and `taskBoardId` are host-written. No tool writes
  them and no verb accepts them.
- The tools refuse with `ok: false` plus a `code`; they never half-write.
- If the tools are absent the board still works over HTTP — that is a
  capability downgrade, not an error.
- **There is no bulk verb.** A batch is a sequence of ordinary per-idea
  `update` / `move` / `restore` calls — exactly what the board's own bulk
  actions post — so a batch is per idea by construction: one refusal never rolls
  back the others and never becomes a single blanket error. Re-homing is a
  batch of `update` with the stable `workspaceId`; an archived idea bound to a
  task card needs `restore` -> `update` -> `archive`, because an archived card
  is read-only for every verb.

## Per-idea activity log

Every idea keeps a bounded append-only `events[]` (the last 50 entries) of
what happened to it: a verb, a timestamp, the actor (`human`,
`agent:<initiator>` or `run`) and a one-line summary. Read it before writing:
it is the only record of *why* an idea was declined, delivered or
archived-and-restored. It rides along with every `import`/`export` and is
printed in the markdown export as an `**Activity**` block.

For a workspace whose AGENTS.md still points at hand-maintained idea files:

1. Point the AGENTS.md idea section at this board instead (announce
   `announceToAgent: true` in the plugin settings so the guidance above is
   injected every session) and load this skill before idea work.
2. Migrate the still-open ideas into the ledger once, via the `import` verb
   driven from the current capture documents (`## Idea #N` sections, with
   `open` / `archived` / `declined` states resolved per section and a target
   `workspaceId`), or capture them through the board. For a project already
   partially migrated, import only what the ledger is missing so the states
   and `deliveredAt` stamps land correctly.
3. Keep the generated markdown exports of the ledger (the `export` verb) as
   read-only views — never edit them by hand again.
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
- `GET /api/ideas/state` → `{ schemaVersion: 1, revision, ideas[] }` (frozen
  full-body snapshot; unchanged)
- `GET /api/ideas/state?view=summary` → bounded summary rows plus `meta`
  (revision is top-level; filters: repeated `workspaceId`, `status`, `id`,
  `number`; `limit` ≤200; `offset`; `fields`; `bodyLimit` ≤4096 bytes)
- `GET /api/ideas/state?view=detail` → the same bounded envelope with
  field-selectable detail rows; the raw `GET /api/ideas/idea?id=<id>` remains
  the full single-record read.
- `GET /api/ideas/state?view=summary|detail&similar=<ideaId>` → the same bounded
  envelope **plus** an opt-in `similar: { ideaId, found, scanned, candidates[],
  flagged }` block. A **flag, never an action**: it writes nothing and merges
  nothing. The scan compares the anchor against the **open backlog of its own
  workspace** only (the workspace-less ideas form one generic group), and each
  candidate carries `score` (0..1) plus the `signals` that fired (`title`,
  `tags`). `limit` bounds the candidate count; it is absent from the frozen full
  snapshot entirely, so the board's poll pays nothing for it.
- `meta` always reports `matched`, `returned`, `rowTruncated`, `nextOffset`,
  `bodyTruncated`, and `omittedFields`. A response never exceeds 512 KiB.
- `GET /api/ideas/state?view=stats` → the **bounded backlog-health aggregate**
  (idea #110), a separate contract that is NOT one of the row views and accepts
  no row query key. It takes `workspaceId` only: **absent** = every workspace,
  **blank** = the ideas with no workspace, a real id = that workspace; anything
  else is `400 invalid-query`. It is a READ — no `requestId`, no mutation — and
  it is never part of the board's poll. It answers one object per scope:

  | field | meaning |
  |---|---|
  | `revision` | the ledger revision the numbers were derived from |
  | `scope` | `{kind: 'all' \| 'generic' \| 'workspace', workspaceId?, ideas}` |
  | `window` | `{kind: 'calendarMonth', start, end}` — the Host's LOCAL month, so the label is checkable |
  | `openTotal`, `openByWorkspace[]`, `workspacesTotal` | open backlog, busiest first, capped at 8 rows |
  | `deliveredInWindow` | deliveries stamped inside `window` |
  | `delivery` | `{sample, withoutStamp, inconsistent, medianMs, minSamples}` |
  | `topTags[]`, `tagsTotal` | most used labels of the OPEN backlog, capped at 8 |
  | `triage` | `{open, missingRank, missingValue}` — work to do, never a score |

  **`delivery.medianMs` is `null` — and only `null` — when `sample <
  minSamples`.** The median is taken over every idea carrying a real
  `deliveredAt` (never one that precedes its own `createdAt`); ideas archived
  without a stamp are counted in `withoutStamp` and excluded, and that count is
  the honest explanation for a missing median. Never infer a median from a thin
  sample, and never report a missing one as `0`.
- `GET /api/ideas/events` → SSE frames `{ revision }` (no full list).
- `POST /api/ideas/action` verbs:

| kind | keys | notes |
|---|---|---|
| `create` | kind, id, input | input keys: `title`*, `body`*, `summary`, `workspaceId`, `rank`, `value`, `effort`, `rationale`, `tags`. Starts `open`, stamped with the next `ideaNumber`. |
| `update` | kind, ideaId, patch | patch keys: `title`, `body`, `summary`, `rank`, `value`, `effort`, `rationale`, `tags`, `workspaceId`, `relatesTo`, `blocks`; `null` clears (relations like tags). Relations are **not** accepted by `create`. |
| `move` | kind, ideaId, status | `open` / `underReview` / `archived` (manual drag; declined only via `decline`). |
| `triage` | kind, ideaId, patch | record the priority opinion and re-rank transactionally; patch keys: `value`, `effort`, `rationale`, `rank` (open ideas only). |
| `decline` | kind, ideaId, decision | → `declined` + `archivedAt` + optional `decision` note. |
| `deliver` | kind, ideaId | → `archived` + `archivedAt` + `deliveredAt`; works from `open` AND `underReview` (review approved). Mirrors the card archive; the card's `done` stays runner-owned. |
| `followUp` | kind, ideaId, input | review rejected: creates an `open` child idea (title/body, `followUpOfId` → parent, parent's workspace inherited) and archives the parent — one atomic commit; requires the parent `underReview`. Mirrors the child as a new card only. |
| `merge` | kind, sourceId, targetId, mode | folds the **source** (duplicate) into the **target** (survivor): union the loser's tags onto the survivor, re-point the loser's children and its own place in a follow-up chain at the survivor, then archive the loser with a `decision` naming the survivor — one atomic commit. `mode` is `keepTargetRank` (default) or `takeSourceRank` (the survivor takes the loser's position and its open workspace group re-ranks); an unranked loser degrades to `keepTargetRank`. **Refused** when the two ids are the same row or sit in different workspaces. Never rewrites the survivor's title/body/summary, and never touches `runStatus` / `runSessionId` / `taskBoardId`. Mirrors the survivor as an update and the loser as an archive. |
| `restore` | kind, ideaId | `archived`/`declined` → `open`. |
| `delete` | kind, ideaId | hard remove. |
| `reorder` | kind, orderedIds | rewrites ranks 1..n. |
| `import` | kind, sourceId, ideas | bulk migration; never executes fields. |
| `export` | kind, workspaceId | `{ ok: true, export: { ideasMd, archiveMd } }`; does **not** write — the agent writes the files. |

Errors: `forbidden` (403), `json-required` (415), `invalid-action` (400),
`body-too-large` (413). `IdeaRecord`: see `src/core/ideas.ts` — `id`, `title`
(≤200), `body` (≤32 KiB), `summary` (≤300, compact abstract — the TaskBoard
card description; blank/`null` clears), `status`, optional `rank/value/effort/
rationale/tags` (≤8, name ≤32, promptPrefix ≤200)/`workspaceId`/`taskBoardId`/
`deliveredAt`/`decision`, `relatesTo` and `blocks` (≤20 idea ids each), plus
`ideaNumber` (stable capture `#N`), timestamps, and `events` (≤50 activity
entries).

## Relations between ideas

Two stored kinds, both written with the ordinary `update` verb:

| kind | meaning | stored where |
|---|---|---|
| `relatesTo` | "adjacent to that, read the other one" | **both** rows — one statement, written once |
| `blocks` | "this cannot land before that one" | the row that waits, only |

`blockedBy` **is not a field and cannot be written.** Derive it:
`blockedBy(X) = the ideas whose blocks list contains X`. Both sides are in
`IDEAS_READ_SELECTABLE_FIELDS` and in the default `view=summary` row, so one
bounded read over the whole board answers every "what does this wait on?" — that
is `GET /api/ideas/state?view=summary&fields=id,title,ideaNumber,blocks&limit=200`.

Writing:

- `{"kind":"update","ideaId":"<X>","patch":{"relatesTo":["<Y>"]}}` — replaces X's
  whole list, and the Host writes the mirrored row for you. Removing works the
  same way: send the shorter list, or `null` to clear it.
- `{"kind":"update","ideaId":"<X>","patch":{"blocks":["<Y>"]}}` — `X` waits for
  `Y`. To express "Y waits for X", send the patch for **Y**.
- `create` takes no relations (a new idea has no id yet): `create` then `update`.
- Absent = untouched; an array replaces; `null` clears. Same contract as `tags`.

Refusals (the Host's own sentence comes back in `message`):

- an unknown target id, or a target equal to the idea itself;
- a `blocks` cycle, refused **with its chain** —
  `this would close a cycle: #1 "Alpha" → #2 "Beta"`. Never write one; `relatesTo`
  has no cycle rule.

Housekeeping the Host does for you: `merge` re-points the duplicate's edges at
the survivor and hands its lists over (a self edge, or one that would close a
loop, is dropped and the count is appended to the loser's `decision`); `delete`
**drops** the edges that named the removed idea rather than leaving a dangling
id; `import` and a restore re-impose the invariants (no self edge, no dangling
target, symmetric `relatesTo`, acyclic `blocks`) over the merged result.

**A relation is a statement the human makes.** Never infer one from a title, a
tag overlap or a near-duplicate score — report the candidate and let the human
write the edge.

## Snapshots, restore and moving a ledger (issue #95)

The ledger is a single-writer file, so backup/restore is a **dedicated route
family**, not action verbs: a snapshot writes a file instead of mutating the
document, so it never consumes the `requestId` cache, and a restore replaces the
document wholesale.

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/ideas/backup` | — | `{ ok, dir, retention, snapshots[], running }` — `running` counts the ideas whose execution is in flight |
| `POST /api/ideas/backup` | `{ reason?: 'manual' \| 'export' }` | `{ ok, snapshot, ideas, pruned }` |
| `GET /api/ideas/backup/content?name=<snapshot>` | — | the snapshot's raw document, `content-disposition: attachment` |
| `POST /api/ideas/backup/restore` | `{ name }` **or** `{ document }` (never both) | `{ ok, revision, ideas, source, displaced }` |

- Snapshots live in `<DSH_HOME>/ideas/backups/`, are written atomically through
  the ledger that owns the lock, and the plugin keeps the **last 10** it wrote.
  A file the plugin did not write is listed, restorable and **never pruned**.
- A restore is **refused (409) while an idea has `runStatus: 'running'`**, with
  the offending ideas in `running`. It also refuses (404) an unknown snapshot and
  (400, `message` = the reason) a document it cannot adopt: another schema
  version, a record without an id or a title, two records sharing an id. A
  broken plugin-written snapshot is renamed `<name>.corrupt-…` — evidence kept,
  never deleted.
- **What a restore replaces is displaced, not overwritten**: the current document
  is written as its own `pre-restore` snapshot first, and the answer names it in
  `displaced`. The revision only moves forward and the dedupe cache is never
  rewound, so a replayed `requestId` keeps meaning "this already ran".
- The **JSON document is the portable artifact** and round-trips every field the
  ledger holds (`events`, `runStatus`, `runSessionId`, `taskBoardId`,
  `deliveryNote`, `analysisAudit`, tags with their `promptPrefix`, `ideaNumber`
  and `ideaSequence`). Nothing is dropped. The `export` verb above stays the
  markdown VIEW, which is generated and never parsed back.
- The escape hatch for "a second Host on the same `DSH_HOME` refuses to start":
  **never share the folder** (the lock exists because a shared home has already
  destroyed a ledger). Export on the machine that owns the board and import it on
  the machine that should.

## TaskBoard mirror (P2)

- Feature-detect: the Host probes its own `GET /api/task-board/state` over
  loopback. Present → mirror active; absent → board fully autonomous.
- One-way, best-effort, never rolls back an idea:
  - idea `create` → task `create` (permission = the board's own session
    default, clamped to `workspace-write`; `read-only` when the board reports
    none) **+ `move backlog`**
  - idea `update` → task `update` (title/description/prompt/tags/workspaceId)
  - launch → the card's permission is raised to that same level when it sits
    below it, then `run`; both are non-content patches, legal on a card that
    already ran, and never above the board's default (so the TaskBoard's
    `confirmation-required` gate never fires)
  - idea `decline` / drag to archived / `deliver` → task `archive`
  - idea `followUp` → the child idea mirrors as a fresh task (the parent card
    is already done); the parent itself mirrors nothing
  - idea `move` to `underReview` → **no mirror** (the card already passed done)
  - idea `restore` → task `restore`
  - idea `delete` → **no-op** (the card outlives the idea)
- Under-review poll: while the mirror is active, the Host polls the task
  statuses (`GET /api/task-board/state`, every 30 s) and moves any open idea
  whose bound card is `done` to `underReview` — the automatic review gate.
- Mirror-late: an idea created while the bridge was off is self-healed on the
  first update/decline (the card is created then the op applies).
- The task `prompt` = the idea's tag `promptPrefix` lines joined with `\n`.
- **The review is human-owned**: when a card reaches `done`, the poll moves
  the linked idea to under review automatically — but the review verdict
  (review approved → deliver, or rejected → follow-up / decline) is the author's call
  on the board. Never automate an idea → done from the ideas side.
- The bound card id persists on the idea as `taskBoardId` (internal field,
  never accepted from the wire). The settings namespace `ideas` exposes
  `enabled`, `announceToAgent` (default false) and `autoMirror` (default true).
- **Launch**: `POST /api/ideas/launch` `{ ideaId, model? }` starts the
  idea's execution (a dedicated route, not a verb). The **host** picks the
  backend: the mirrored card when the task-board plugin is present (minting the
  `idea-<id>` card when the idea has none yet), otherwise a fresh direct chat
  session created through the Host `typertGateway` — so the route works on a
  board with no task-board at all, and the answer carries `taskId` only for the
  card path. Once a run has been started the card is **runner-owned**: its
  content is frozen, so later idea edits no longer replicate to the card, and
  `done` is the task-board's to set. `runStatus` / `runSessionId` on the idea are
  host-written system fields — an agent must never set them through
  `update`/`import` (the wire gate rejects them), and a launched idea should not
  be edited "to fix" the running card.

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
  live — the lock directory refuses a second writer. Snapshots live beside it in
  `~/.dsh/ideas/backups/` and are only ever written through the ledger
  (`POST /api/ideas/backup`), never by hand.

## File map

```
src/protocol.ts          wire gate (exactKeys, envelope) + the `view=stats` query parser
src/core/ideas.ts        domain model, tag validation, activity log, near-duplicate signal,
                         relation model + the `blocks` cycle check
src/core/ideas-stats.ts  the ONE definition of every backlog-health number (idea #110)
src/backup.ts            the snapshot folder (atomic write, list, quarantine, retention)
src/host-ledger.ts       persistence, dedupe cache, lock, activity log, internal taskBoardId bind,
                         snapshots + restore (strict validation, displaced-on-restore)
src/client/backup-panel.tsx  the settings section's Backup tab (snapshots/restore/export/import)
src/client/find-similar.ts  the Find similar gate + launch input (pure)
src/client/relations.ts     the relation views / candidates / diff (pure)
src/client/relations-view.tsx the card's relation line + the editor's Relations section
src/client/deeplink.ts      the deep-link reference grammar + board-wide resolver (pure)
src/client/deeplink-service.ts  the published `ideas-manager.board` focus service
src/agent-tools.ts       the ideas_* agent tools (feature-detected registry)
src/host-ledger.ts       persistence, dedupe cache, lock, activity log, internal taskBoardId bind
src/host-service.ts      apply + mirror scheduling
src/host-routes.ts       /api/ideas/* fence + SSE
src/taskboard-bridge.ts  feature-detect + one-way mirror + the `run` verb (no hard import)
src/run-prompt.ts        execution prompt shared by every launch backend
src/session-runner.ts    direct-session backend (Host RPCs + roster for the settle)
src/session-opener.ts    "Open session" jump from a card whose run is in flight
src/export-markdown.ts   unidirectional ledger -> markdown
src/core/ideas.ts        domain model, tag validation, activity log
```