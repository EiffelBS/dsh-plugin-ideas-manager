# dsh-plugin-ideas-manager

**The Ideas manager** brings an idea backlog straight into the DSH Web GUI. It's
a generic, self-contained alternative to a hand-maintained `IDEAS.md` file: an
AI agent captures ideas, each one becomes a card on a kanban, gets scored and
ranked, and flows through a lifecycle until it's delivered or declined. It also
bridges to the [TaskBoard plugin](#taskboard-integration) when present.

A Host-authoritative `/api/ideas` ledger keeps everything consistent and lets
an agent write cards directly over HTTP — no UI needed. Fully usable without
TaskBoard: **zero hard dependency** on it.

![Ideas manager board](./assets/ideas-manager.png)

---

## What it does for you

### Capture ideas, anywhere
- A **sidebar entry** (New Session → **Ideas**) opens the panel.
- **Capture** an idea with the *New idea* button or the **quick-add** row at the
  top of the Open column — a Title is the only required field.
- Optional description (markdown), **tags**, workspace and a **Suggested rank**.
- The **AI capture** button opens a fresh session that analyzes the draft,
  creates/merges the idea in the backlog, and reports the retained ranking.

### A 4-column kanban
Open · Under review · Archived · Declined.
- **Drag & drop** moves cards between columns and reorders them; the columns
  auto-scroll when you drag toward an edge (vertically and horizontally when
  Archived/Declined are off-screen on a narrow window).
- **Search** and a **conjunctive tag filter** narrow the columns.
- Single click on a card title or body opens the **edit modal** (raw text or
  rendered markdown).
- Every card shows its stable **`#N` number**, **workspace chip**, **tags**,
  **value/effort badges** and update date.

### Scoring & ranking
- Each idea carries **Value** and **Effort** (low / medium / high), shown as
  color-coded badges.
- The **Suggested rank** is the position in the *open backlog of its workspace*;
  entering one re-ranks the backlog transactionally (existing rows shift).
- A dedicated **Priorities** tab ranks the open ideas per workspace, with
  ↑/↓ buttons and drag & drop to re-rank.

### The lifecycle
- **Deliver** ✓ archives the idea with a green *Delivered {date}* stamp.
- **Under review** is the *recette* gate: finished work lands there, and each
  card offers **Recette OK** (deliver), **Follow-up needed** (creates a linked
  open child plus justification, archives the parent) and **Decline**.
- **Delivered** tab shows the exit log (delivered vs. manually archived).
- Restore, archive and delete are one click away on each card.

### Workspaces
- A header selector scopes the board to one workspace (or *all* / *none*).
- New ideas default to the **current session's workspace** when not scoped.
- The New/Edit modal carries a workspace field so a capture lands in the right
  place and an idea can be moved to another workspace.

---

## TaskBoard integration

When the TaskBoard plugin is present, the Ideas manager mirrors its ledger onto
TaskBoard's `backlog` so both tools stay in sync — **one-way** (Ideas → TaskBoard).
The mirror is detected at runtime (`GET /api/task-board/state`); if TaskBoard is
absent the Ideas manager simply works standalone.

| Ideas action | TaskBoard mirror |
|---|---|
| Create idea | New read-only card in `backlog` (bound to the idea id) |
| Update idea | Card updated |
| Decline / drag to Archived | Card archived |
| Restore | Card restored |
| Delete | No-op (closing to `done` stays manual) |
| **Task-Board card reaches `done`** | Idea auto-moves to **Under review** (the recette gate) |

Triage (scores, rationale, rank) is **ideas-only** and is never mirrored — it's a
backlog opinion, not a board state.

> **Note for a manual `IDEAS.md` workflow:** the capture → triage → lifecycle
> protocol and the full wire contract are documented in
> [`SKILL.md`](SKILL.md), so an agent can author cards directly over the HTTP
> API without the UI.

---

## Host API (agents)

The Host exposes a REST API so scripts and agents can read the board and write
ideas. Prefix `/api/ideas`, same-origin fence (loopback socket + browser
markers), JSON envelopes `{ requestId, action, initiator? }`.

| Route | Purpose |
|---|---|
| `GET /api/ideas/state` | `{ schemaVersion: 1, revision, ideas[] }` |
| `POST /api/ideas/action` | `create`, `update`, `move`, `decline`, `deliver`, `followUp`, `triage`, `restore`, `delete`, `reorder`, `import`, `export` |
| `GET /api/ideas/events` | SSE `{ revision }` |

Every action is **deduplicated by `requestId`** (fresh id per call), and a
mutating action returns the whole board so the caller can confirm the result.
Full contract (verb table, mirror mapping, PowerShell gotchas) lives in
[`SKILL.md`](SKILL.md).

---

## Install & update

From a local checkout (no registry needed):

```sh
dsh plugin --profile web add link:/path/to/dsh-plugin-ideas-manager
```

From a git URL (pinned to a released tag — recommended for end users):

```sh
dsh plugin --profile web add github:EiffelBS/dsh-plugin-ideas-manager#v0.2.2
```

`dsh plugin` runs `pnpm add` in the profile directory, then reconciles
`dsh.profile.bundles`: because this package declares a `dsh.bundle`, it is
auto-appended as a profile layer. Restart the web instance (or open a fresh
page session) for the bundle change to take effect.

Verify installation:

```sh
dsh web --profile web --no-open   # then look for the Ideas entry in the sidebar
```

To pick up a newer revision after a release (versions follow the package's
`version` field; releases are tagged, e.g. `v0.2.2`):

```sh
dsh plugin --profile web add github:EiffelBS/dsh-plugin-ideas-manager#v0.2.2
```

then restart the web instance.

Uninstall / disable:

```sh
dsh plugin --profile web remove dsh-plugin-ideas-manager
```

> **Maintainers:** bump `version` in `package.json` on each meaningful push so
> an installed profile's version stays observable (e.g. via `dsh plugin ls` or
> `pnpm list` in the profile directory).

---

## Build, test & install (dev)

```powershell
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest (protocol gate, ledger persistence, export golden, mirror, markdown parser)
pnpm run build       # tsc -p tsconfig.build.json (types -> lib/types) && tsdown (lib/index.js + lib/client.js)

# isolated test profile (never the production profile of a live instance)
dsh --profile ideas-test --from-default-profile web --dump-config
dsh plugin --profile ideas-test add link:C:/path/to/dsh-plugin-ideas-manager
dsh --profile ideas-test --port 3099                # omitting --no-open opens the browser with the token URL
```

The browser half is served at `/plugins/<id>/client.js` (re-resolved per
request); the host half registers the `/api/ideas` routes at boot.

## Architecture

```
src/
  index.ts            # apply + mountOnce + Config + guidance section
  protocol.ts         # /api/ideas prefix, types, parseActionEnvelope (exactKeys)
  host-service.ts     # apply + mirror scheduling
  host-ledger.ts      # persisted ledger, dedupe cache, lock, internal bind
  host-routes.ts      # state / action / events + loopback guard
  taskboard-bridge.ts # runtime feature-detect + one-way mirror (no hard import)
  export-markdown.ts  # unidirectional ledger -> markdown (golden-tested)
  http.ts / loopback.ts / mount-once.ts   # shared discipline
  core/ideas.ts       # IdeaRecord, statuses, tag validation
  client/             # sidebar entry + kanban + Priorities/Delivered + workspace scoping
tests/                # vitest suites per module
  SKILL.md / README.md
```

Persistence lives in `~/.dsh/ideas/ledger-v2.json` (atomic tmp+rename writes,
corruption quarantine, single-writer lock, restart-safe request-id dedupe).

## License

MIT — see `LICENSE`.
