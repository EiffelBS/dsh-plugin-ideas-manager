# dsh-plugin-ideas-manager

Generic idea manager plugin for the DSH Web GUI. Host-authoritative `/api/ideas`
ledger, capture, and a 3-column kanban (open / archived / declined) injected
into the sidebar under New Session — with an optional TaskBoard mirror when the
task-board plugin is detected (P2). Autonomous without TaskBoard: **zero hard
dependency** on `@linxin666/dsh-client-ui-task-board`.

See `HANDOVER.md` for the full design session decisions and the phased plan.

## Status

- **P0 (this scaffold)** — dual-face plugin (host + browser), sidebar entry,
  empty 3-column kanban on the in-memory mock ledger, full `/api/ideas` route
  contract, build + link-install verified.
- **P1** — `~/.dsh/ideas/ledger-v2.json` persistence (atomic writes, migration,
  quarantine), CRUD UI (edit / move / decline / restore / drag), export UI,
  settings namespace.
- **P2** — TaskBoard bridge (feature-detect `GET /api/task-board/state`, mirror
  create → backlog, move, decline → archive), `SKILL.md`.
- **P3** — OpenTimbre one-shot migration via `import` + export-golden diff.

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
(415), `invalid-action` (400), `body-too-large` (413), `not-found` (400).

## Build & install (dev)

```sh
pnpm install
pnpm build          # tsc -p tsconfig.build.json (types -> lib/types) && tsdown (lib/index.js + lib/client.js)
pnpm test           # vitest (protocol exactKeys gate)
dsh plugin --profile web add link:%cd%   # link-install into the web profile
```

The browser half is served at `/plugins/dsh-plugin-ideas-manager/client.js`
after a GUI restart; the host half registers the `/api/ideas` routes at boot.

## Architecture

```
src/
  index.ts            # apply + mountOnce + Config + guidance section
  protocol.ts         # /api/ideas prefix, types, parseActionEnvelope (exactKeys)
  host-service.ts     # ledger, revision, snapshot, apply()
  host-ledger.ts      # P0 in-memory mock ledger (P1: file persistence)
  host-routes.ts      # state / action / events + loopback guard
  http.ts / loopback.ts / mount-once.ts   # task-board family discipline
  core/ideas.ts       # IdeaRecord, statuses, tag validation
  client/
    index.ts          # client apply + claim guard
    ideas-client.ts   # framework-free controller (open flag + snapshot)
    host-api.ts       # fetch state/action + SSE subscribe
    sidebar-entry.ts  # row injected under New Session (self-healing DOM)
    board-view.tsx    # 3-column kanban (React 18)
    panel-mount-core.ts / sidebar-entry-core.ts / body-mutations.ts # shared DOM lifecycle
    style.ts / locales.ts  # dsw-token CSS + fr/en copy
```

PowerShell note (agent usage): always `Invoke-RestMethod -UseBasicParsing`,
never `Invoke-WebRequest` non-interactively.

## License

MIT — see `LICENSE`.
