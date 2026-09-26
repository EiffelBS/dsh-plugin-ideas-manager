# Architecture

Implementation notes for maintainers. The [README](../README.md) documents what
an installed user sees; everything here is how it is built and why — design
decisions, invariants and the sharp edges that are easy to break.

## Module map

```
src/
  index.ts            # apply + mountOnce + Config + guidance section
  protocol.ts         # /api/ideas prefix, types, parseActionEnvelope (exactKeys)
  host-service.ts     # apply + mirror scheduling + run dispatch + run poll
  host-ledger.ts      # persisted ledger, dedupe cache, lock, internal bind
  host-routes.ts      # state (+ list / summary / detail), idea?id=, action, launch, events
  host-settings.ts    # the fenced /api/ideas/config route (settings dual-path)
  taskboard-bridge.ts # runtime feature-detect + one-way mirror + the `run` verb
  session-runner.ts   # direct-session backend: Host RPCs + the roster the settle reads
  run-prompt.ts       # the execution prompt shared by every launch backend
  session-opener.ts   # the "Open session" jump from a running card
  export-markdown.ts  # unidirectional ledger -> markdown (golden-tested)
  http.ts / loopback.ts / mount-once.ts   # shared discipline
  core/ideas.ts       # IdeaRecord, statuses, run statuses, tag validation
  client/             # sidebar entry + kanban + Priorities/Delivered + scoping
scripts/              # mirror reconciliation, mirror cycle check, live perf profiler
```

## Persistence

`~/.dsh/ideas/ledger-v2.json`, written atomically (tmp file + rename, with a
direct-write fallback for the transient Windows `EPERM` rename flake), with
corruption quarantine (renamed beside itself, never deleted) and a
**single-writer lock** (`ledger-v2.lock`, holding the owning PID). A second Host
pointing at the same home refuses to start rather than corrupting the file — two
test instances therefore need two `DSH_HOME`s.

Request-id dedupe is **restart-safe**: the cache is part of the ledger document,
not process memory. Actions are mutations and consume it; the launch route
deliberately does not (a run is not a ledger mutation) and honours replayed ids
through a short in-memory window instead.

## Execution launch

`POST /api/ideas/launch` is a **dedicated route, not an action verb**. The Host —
never the browser — resolves the backend, so a user cannot accidentally start two
different things:

| Condition | Backend |
|---|---|
| task-board present and the mirror is on | **card** (minting the deterministic `idea-<id>` card when the idea has none) |
| no task-board, mirror off, or the board turns out to be absent at click time | **direct session** |

- Card path: `ensureTask` → a **model-only** patch → `run`. The patch is
  model-only on purpose: once a card has run, a content patch is refused with
  `task has already been executed`. The model travels as `provider/model` on the
  task, never inside `run` (the task-board accepts exactly `['kind','taskId']`).
- Session path: `session/create` → `rename` → `selectModel` → `prompt` through the
  optional `typertGateway` service. One fresh session per launch, no reuse. A
  rejected model fails loudly rather than silently falling back.

Both paths are **host-side**, so a run survives a closed browser tab. The settle
is host-side too: the card path polls the task-board snapshot, the session path
reads the roster (`session/list` → per-session `running` bit). A restarted Host
re-attaches from the persisted `running` + `runSessionId` pair, which is the
whole reason that field exists. A settled `done` run opens the review gate on
both backends, so the gate does not depend on the task-board plugin.

### Known divergences, by design

- After a run the mirrored card is frozen, so later mirror updates fail by
  design and the idea stops replicating to the card.
- Mirrored cards never arm a cron schedule: a successful run would return to
  `todo` and never reach the review gate.
- A direct session has no permission field to bind, so it inherits the Host
  default for a new session; the card backend instead binds the card's
  permission and can answer `confirmation-required: …`.
- A direct run that ends in an error settles `done`. The card backend's history
  scan distinguishes success from failure; this backend deliberately does not.
- The wire quirk worth remembering: `session/list` takes `{_request}` on this
  RPC surface while every other method takes `{request}` (`invokeWireArgs`).

## Card mirror

Card ids are **deterministic** (`idea-` + the idea id), so re-running any mirror
path re-touches the same card instead of minting a twin. A bound idea's card is
rebuilt only when a *non-empty* task-board snapshot proves it was deleted
out-of-band — an empty or unreadable snapshot keeps the binding and attempts the
patch, never a create. Mirror operations are serialized per idea id, so a create
always completes (and binds) before a following update runs: "update" can never
silently mean "create".

The card `description` carries the idea's `summary` (<= 300 chars) while the full
analysis rides the card `prompt` and the ledger — the body is never stored twice.

Two scripts close the loop:

- `scripts/reconcile-taskboard-mirror.mjs [--url …] [--apply]` — detects orphan
  duplicates (unbound card whose exact title matches a bound idea) and archives
  them, keeping the bound card; dry-run by default.
- `scripts/validate-mirror-cycle.mjs [--base …]` — live acceptance run against a
  test instance: create → re-analyze → analyst rewrite → decline must end with
  exactly one card.

## Client notes

- The browser subscribes by **short-polling** (2.5 s) while the board is open
  and the page is visible, not by holding SSE connections: three tabs times SSE
  exhausted the browser's per-origin connection budget and stalled the Host.
- Cards render a short body excerpt; the full body is fetched on demand for the
  editor, the follow-up composer and re-analyze. A failed fetch never opens the
  modal (saving a partial body would silently truncate the analysis).
- The three interface dictionaries are held in strict key parity — the build
  fails on a missing key.

## Performance

`docs/perf-evaluation.md` holds the before/after numbers of the high-card-load
work (lean list reads, deferred body, zero-emit idle polls);
`scripts/perf-live.mjs` profiles a running test instance. Three perf gates run
under `IDEAS_PERF=1`.

## Settings storage

Two host generations coexist: hosts exposing `settings.register` get a
registered `ideas` namespace; hosts that removed it in the 0.1.7 SettingsForms
refactor get a plugin-owned versioned `<DSH_HOME>/ideas-manager-settings.json`
behind the same incrementing revision fence. Both answer the identical wire
contract, so the section behaves identically everywhere.

## Design archaeology

Historical decision records, kept for context rather than as guidance:

- `docs/client-transport-short-polling.md` — why the client short-polls.
- `docs/perf-evaluation.md` — the load evaluation and what was deferred.
- `docs/idea-64-summary-first-context.md` — why the summary is the first context
  an agent sees.
- `docs/internal/run_from_idea/README.md` — the phased plan behind the launch
  feature, including the open decisions and the rejected alternatives.
- `docs/about-section-guideline.md`, `docs/mojibake-fix.md` — small UI/encoding
  fixes worth remembering.
