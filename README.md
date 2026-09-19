# dsh-plugin-ideas-manager

Generic idea manager for the DSH Web GUI: a Host-authoritative `/api/ideas`
ledger, capture, and a 3-column kanban (open / archived / declined) injected
into the sidebar under New Session — plus an optional TaskBoard mirror when the
task-board plugin is detected at runtime (P2). Autonomous without TaskBoard:
**zero hard dependency** on `@linxin666/dsh-client-ui-task-board`.

See `HANDOVER.md` for the full design session decisions and the phased plan.

## Status

- **P0 (done)** — dual-face plugin (host + browser), sidebar entry, empty
  3-column kanban, full `/api/ideas` route contract, build + link-install
  verified.
- **P1 (done)** — `~/.dsh/ideas/ledger-v2.json` persistence (atomic tmp+rename
  writes, corruption quarantine, row repair, single-writer lock), CRUD UI
  (edit / move / decline / restore / drag), restart-safe request-id dedupe,
  unidirectional markdown export, settings namespace.
- **P2 (done)** — TaskBoard bridge: feature-detect
  `GET /api/task-board/state`, mirror create → card read-only in `backlog`,
  update, decline / drag-to-archived → archive, restore → restore (delete →
  no-op, closing the loop to `done` is manual); `SKILL.md`. Verified live
  against TaskBoard 0.3.22.
- **UI polish pass (done)** — Ideas UI improvement card: safe markdown
  rendering for descriptions with a raw/MD toggle (cards + modal preview);
  value/effort as named-level comboboxes (low/medium/high mapped to stored
  numbers); single-click on a card title/body opens the edit modal;
  empty-filter state, Escape-to-close modals, pending-disabled actions,
  quick-add row in Open, updated date on cards, 50 % panel translucency.
  12 new unit tests (markdown XSS subset + levels).
- **Workspace UI (done)** — `workspaceId` now surfaces in the board: a
  header selector scopes the columns (and the search/tag filters inside
  them) to one workspace, and the New/Edit modal carries a workspace field
  so a capture lands in the right workspace immediately (preselected from
  the board scope) and an edit can move an idea to another workspace or
  back to generic. The picker merges every `workspaceId` present in the
  ledger with the DSH Workspace registry when the shell service is up, and
  degrades gracefully (ledger ids only) when it is not. Protocol/model
  already carried `workspaceId`, so this phase is UI-only.
- **P3 (done)** — OpenTimbre one-shot migration via `import`
  (`scripts/migrate-ot-ideas.mjs`: workspace resolved by title against the
  target registry, legacy `ot` fallback) + export-golden diff.

## Contract (Host API)

Prefix `/api/ideas`. Same-origin fence: loopback socket + browser markers
(`Sec-Fetch-Site` / `Origin`), `Content-Type: application/json` required,
64 KiB action / 2 MiB import caps, strict `exactKeys` envelope
`{ requestId, action, initiator? }`.

| Route | Purpose |
|---|---|
| `GET /api/ideas/state` | `{ schemaVersion: 1, revision, ideas[] }` |
| `POST /api/ideas/action` | `create`, `update`, `move` (open↔archived), `decline`, `restore`, `delete`, `reorder`, `import`, `export` |
| `GET /api/ideas/events` | SSE `{ revision }` |

Error ids mirror the task-board family: `forbidden` (403), `json-required`
(415), `invalid-action` (400), `body-too-large` (413).

Full contract (verbes table, mirror mapping, PowerShell gotchas): see
[`SKILL.md`](SKILL.md).

## Build, test & install (dev)

```powershell
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest (protocol gate, ledger persistence, export golden, mirror, OT parser)
pnpm run build       # tsc -p tsconfig.build.json (types -> lib/types) && tsdown (lib/index.js + lib/client.js)

# isolated test profile (never the production profile of a live instance)
dsh --profile ideas-test --from-default-profile web --dump-config
dsh plugin --profile ideas-test add link:C:/path/to/dsh-plugin-ideas-manager
dsh --profile ideas-test --port 3099                # omitting --no-open opens the browser with the token URL
```

The browser half is served at `/plugins/<id>/client.js` after the GUI
restarts; the host half registers the `/api/ideas` routes at boot.

## OT migration (P3)

One-shot import of the OpenTimbre `docs/IDEAS.md` / `docs/IDEAS-ARCHIVE.md`
capture documents into the ledger:

```powershell
# dry-run first (counts + per-idea summary + workspace resolution, nothing posted)
node scripts/migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md>

# apply after review (isolated/ledger home), then review the export golden diff
node scripts/migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md> --base http://127.0.0.1:3101 --apply

# target a specific workspace id / registry / title explicitly
node scripts/migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md> --workspace <id>
node scripts/migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md> --registry <workspace.json> --workspace-title "OpenTimbre"

# incremental re-sync (import only what the ledger is missing; DELIVERED
# sections land archived with a deliveredAt stamp, DELIVERED won overridden
# by DECLINED; uses a fresh request id so a re-run is not replay-deduped)
node scripts/migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md> --incremental --status-lines
```

Workspace resolution (highest wins):

1. `--workspace <id>` — explicit target workspace id.
2. title lookup — `--registry <workspace.json>` (default
   `~/.dsh/storages/workspace.json`) is scanned for `tables.workspaces` rows
   whose title equals `--workspace-title` (default `OpenTimbre`,
   case-insensitive); a single match wins, several matches warn and pick the
   first.
3. legacy fallback — the `ot` slug, with a warning.

The `--export-out <dir>` review export is filtered with the SAME resolved id,
so the golden diff matches the imported workspace.

Mapping:

- `## Idea #N ...` sections → ideas `ot-<N>`; `IDEAS.md` → `open`,
  `IDEAS-ARCHIVE.md` → `archived`, `DECLINED` sections → `declined`.
  With `--status-lines` (re-sync), each section is classified by its own
  status markers instead: DECLINED → `declined`, DELIVERED → `archived`
  (with `deliveredAt`), the rest keep the document default.
- `rank` from the Suggested-priority table; `createdAt`/`archivedAt` from the
  `captured` / `DELIVERED` / `DECLINED` dates in the headings (fallback: now)
- `workspaceId` = the resolved id above (on the author machine this is the
  OpenTimbre registry id `c34460c8-…`, never the `ot` slug); bodies kept
  verbatim
- An idea id living in both docs (a hard split — e.g. #15 has an open
  `(remaining)` slice AND a delivered `(slice)` record) resolves toward the
  **open backlog**; the collision is reported, and the archive doc stays the
  history of record.

## Ledger recovery (2026-09-18)

A test instance sharing the SAME DSH home as the production web profile held
`~/.dsh/ideas/ledger-v2.lock` and overwrote `ledger-v2.json` with its own
smoke-test cards, so the live board's edits only lived in memory. Recovery:
capture the live board first (`GET /api/ideas/state` with the loopback
same-origin markers), then run
`node scripts/restore-3080-ideas.mjs <backup.json> --apply` with the server
stopped — it rewrites the ledger (remapping the `ot` slug to the registry
OpenTimbre id by default) and clears stale locks; the previous file is kept as
a `.bak-…` sibling.

## Architecture

```
src/
  index.ts            # apply + mountOnce + Config + guidance section
  protocol.ts         # /api/ideas prefix, types, parseActionEnvelope (exactKeys)
  host-service.ts     # apply + mirror scheduling (P2)
  host-ledger.ts      # persisted ledger, dedupe cache, lock, internal bind
  host-routes.ts      # state / action / events + loopback guard
  taskboard-bridge.ts # P2 feature-detect + one-way mirror (no hard import)
  export-markdown.ts  # unidirectional ledger -> markdown (golden-tested)
  http.ts / loopback.ts / mount-once.ts   # task-board family discipline
  core/ideas.ts       # IdeaRecord, statuses, tag validation
  client/             # sidebar entry + 3-column kanban (React 18) + workspace scoping
scripts/
  migrate-ot-ideas.mjs  # P3 one-shot OT migration (parse + dry-run/--apply; workspace by title)
  restore-3080-ideas.mjs # recover an overwritten ledger from an API-state backup
tests/                  # vitest suites per module
  HANDOVER.md / SKILL.md / README.md
```

PowerShell note (agent usage): always `Invoke-RestMethod -UseBasicParsing`,
never `Invoke-WebRequest` non-interactively; for raw JSON POSTs prefer
`curl.exe --data @<bom-free ascii file>`. Watches out for the `-Encoding utf8`
BOM when writing JSON bodies from PowerShell 5.1.

## License

MIT — see `LICENSE`.