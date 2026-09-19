# Workspace cutover: from IDEAS.md to the ideas board

Status: 2026-09-19. Purpose: a per-workspace recipe to replace the
`IDEAS.md` / `IDEAS-ARCHIVE.md` file convention with the
dsh-plugin-ideas-manager board. The ledger is the source of truth; the
markdown files become optional generated views. The OpenTimbre doc
protocol lived in `docs/IDEAS.md` + the AGENTS.md "Ideas backlog sync"
section + `.dsh/skills/task-board/SKILL.md`; below is the equivalent,
generic, file-free workflow.

## 1. One-time: migrate the open backlog into the ledger

The migration script (`scripts/migrate-ot-ideas.mjs`) parses the canonical
`## Idea #N — Title` format into import payloads. Run it once per target
workspace, then keep capturing in the ledger only.

For OpenTimbre (as of 2026-09-19): the P3 migration imported ideas #1-#23;
ideas **#24-#28** were later captured in IDEAS.md. Re-sync them with the
incremental mode — it reads the live ledger, skips ids already present, and
uses a fresh request id (the fixed P3 id would be replay-deduped):

```
node scripts/migrate-ot-ideas.mjs \
  --ideas docs/IDEAS.md --archive docs/IDEAS-ARCHIVE.md \
  --base http://127.0.0.1:3101 --incremental --status-lines --apply
```

`--status-lines` classifies each section by its status markers — DELIVERED
sections land `archived` with a `deliveredAt` stamp (e.g. #22/#23 stay out of
the open backlog), DECLINED land `declined`, the rest stay `open` with their
Suggested-priority rank. Review the dry-run output first (drop `--apply`),
then re-run with `--apply`. Everything the script leaves in the ledger is
then managed through the normal triage/lifecycle verbs.

## 2. Enable the agent-visible protocol

- Plugin settings namespace `ideas`: set `announceToAgent: true` so the
  system-prompt section (the full capture/triage/re-rank protocol in
  `src/index.ts` `IDEAS_GUIDANCE`) is injected every session.
- Load the plugin's `SKILL.md` (the "Process" section) for the REST level
  of detail.

## 3. Rewrite the workspace AGENTS.md

Replace the idea section (for OpenTimbre: "## Ideas backlog sync") with
one paragraph, e.g.:

> **Ideas:** product ideas live in the ideas board (`Ideas` panel — Overview
> kanban + Priorities ranking), source of truth for the open backlog; old
> `IDEAS.md` / `IDEAS-ARCHIVE.md` files are stale generated views and are
> not edited. Capture new ideas into the ledger (`title` + analysis body,
> workspace-scoped), record a priority opinion (value/effort + suggested
> rank), and re-rank the whole open backlog on material change (deliveries,
> new ideas, scope changes). Load the `ideas` skill before idea work. The
> TaskBoard mirror follows the board's own conventions (capture → backlog,
> decline → archive; delivered cards close via the author's closure run).

## 4. Stop editing the markdown files

`IDEAS.md` / `IDEAS-ARCHIVE.md` may stay on disk as generated exports of
the ledger (the `export` verb of `/api/ideas`) but are never edited or
parsed. Nothing in the process reads them.

## 5. Triage discipline (unchanged from the old protocol, now enforced by the UI)

- The Priorities tab is the ranking: it stays the agent's current best
  ordering (never a plain append); re-rank only on material change.
- Ranks are advisory: scheduling is the author's call.
- Delivered ideas leave the open backlog with a delivery record (commit /
  verification notes); declined ideas leave with a decision note. Both are
  plain fields on the idea (recorded through the triage/lifecycle verbs).