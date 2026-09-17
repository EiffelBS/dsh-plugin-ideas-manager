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
- **P3 (in progress)** — OpenTimbre one-shot migration via `import`
  (`scripts/migrate-ot-ideas.mjs`) + export-golden diff.

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
# dry-run first (counts + per-idea summary, nothing posted)
node scripts/migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md>

# apply after review (isolated/ledger home), then review the export golden diff
node scripts/migrate-ot-ideas.mjs --ideas <IDEAS.md> --archive <IDEAS-ARCHIVE.md> --base http://127.0.0.1:3101 --apply
```

Mapping:

- `## Idea #N ...` sections → ideas `ot-<N>`; `IDEAS.md` → `open`,
  `IDEAS-ARCHIVE.md` → `archived`, `DECLINED` sections → `declined`
- `rank` from the Suggested-priority table; `createdAt`/`archivedAt` from the
  `captured` / `DELIVERED` / `DECLINED` dates in the headings (fallback: now)
- `workspaceId: ot`; bodies kept verbatim
- An idea id living in both docs (a hard split — e.g. #15 has an open
  `(remaining)` slice AND a delivered `(slice)` record) resolves toward the
  **open backlog**; the collision is reported, and the archive doc stays the
  history of record.

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
  client/             # sidebar entry + 3-column kanban (React 18)
scripts/
  migrate-ot-ideas.mjs  # P3 one-shot OT migration (parse + dry-run/--apply)
tests/                  # vitest suites per module
  HANDOVER.md / SKILL.md / README.md
```

PowerShell note (agent usage): always `Invoke-RestMethod -UseBasicParsing`,
never `Invoke-WebRequest` non-interactively; for raw JSON POSTs prefer
`curl.exe --data @<bom-free ascii file>`. Watches out for the `-Encoding utf8`
BOM when writing JSON bodies from PowerShell 5.1.

## License

MIT — see `LICENSE`.