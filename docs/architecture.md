# Architecture

Implementation notes for maintainers. The [README](../README.md) documents what
an installed user sees; everything here is how it is built and why — design
decisions, invariants and the sharp edges that are easy to break.

## Module map

```
src/
  index.ts            # apply + mountOnce + Config + guidance section
  protocol.ts         # /api/ideas prefix, types, parseActionEnvelope (exactKeys)
  agent-tools.ts      # the six ideas_* tools + the feature-detected registry
  host-service.ts     # apply + mirror scheduling + run dispatch + run poll
  host-ledger.ts      # persisted ledger, dedupe cache, lock, activity log, internal bind
  host-routes.ts      # state (+ list / summary / detail), idea?id=, action, launch, events
  host-settings.ts    # the fenced /api/ideas/config route (settings dual-path)
  taskboard-bridge.ts # runtime feature-detect + one-way mirror + the `run` verb
  session-runner.ts   # direct-session backend: Host RPCs + the roster the settle reads
  delivery-note.ts    # last-assistant-message extraction + the card `executions` pointer
  run-prompt.ts       # the execution prompt shared by every launch backend
  session-opener.ts   # the "Open session" jump from a running card
  export-markdown.ts  # unidirectional ledger -> markdown (golden-tested)
  http.ts / loopback.ts / mount-once.ts   # shared discipline
  core/ideas.ts       # IdeaRecord, statuses, run statuses, tag validation, activity log
                      # + the merge helpers and the pure near-duplicate signal
  client/find-similar.ts   # the Find similar gate + launch input (pure, DOM-free)
  client/             # shell panel registration + kanban + Priorities/Delivered + scoping
  client/activity-timeline.tsx  # the editor's read-only activity timeline
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

### Delivery note harvest

At settle time the host writes a short `deliveryNote` on the idea — the **last
assistant message** of the run, bounded by `DELIVERY_NOTE_MAX_BYTES` (2 KiB, cut
on a UTF-8 boundary, `…` appended). Three decisions shape it:

- **Host-written, never authored.** `runStatus`, `runSessionId` and `taskBoardId`
  are refused from `update`; `deliveryNote` joins that closed set. `import` is the
  one path that accepts it, so an export/import round-trip keeps harvested notes.
  It rides `IDEAS_READ_SELECTABLE_FIELDS`, hence default-on in `view=detail` and
  absent from `view=summary` — like `runStatus`, not like `summary`.
- **Best effort, never fatal.** `harvestNote` is called from `settleRun` *before*
  the `underReview` move and is **not awaited**: the gate opens on the same tick,
  and a refused RPC is logged and swallowed. A harvest failure can therefore never
  fail a settle. An absent note renders as an explicit "this run left no delivery
  note" line — the board never fabricates one.
- **Two RPCs, whichever backend.** `session/projections {sessionId}` returns
  `asOfSeq` (the last committed event seq = the page cursor, and the only honest
  "now" for a page read), then `session/page {address, throughSeq: asOfSeq,
  maxMessages: 24}`. A `null` baseline (session gone) is silence, not an error.
  The direct backend already knows its `runSessionId`; the **card** backend has no
  session of its own and reads `executions[].sessionId` off the task-board snapshot
  the poll already fetched (`TaskBoardMirror.cardSessionOf`, zero extra requests).
  When the board exposes no such pointer the note stays empty and the UI says so.

## Per-idea activity log (idea #92)

`IdeaRecord.events[]` is a bounded append-only log: `{ at, verb, actor,
summary }`, the last **50** entries, appended by `IdeasHostLedger.apply` in the
same commit as the state change it describes (one `recorded[]` buffer, flushed
after the verb switch, so a mutation and its log line can never disagree).

Decisions worth keeping in mind before touching it:

- **`IDEAS_SCHEMA_VERSION` is 1 and stays 1.** The wire is frozen, so the
  "migration" is additive and lazy: `parseHostIdeas` reads `row.events` through
  `normalizeIdeaEvents`, a document written before the field simply has none,
  and the first append creates it. Nothing is back-filled — inventing history
  for an idea is worse than admitting there was none.
- **`isIdeaEvent` is strict on its four keys and tolerant of unknown ones.** It
  runs on persisted logs, where an entry a later version wrote with an extra
  field is still history; `normalizeIdeaEvents` rebuilds it from the four keys
  and drops whatever travelled with it. A truncated entry is still refused.
- **Actors are derived, never asserted as a verb field.** `applyRequest`
  resolves the actor once from the envelope `initiator` (`agent:<initiator>`, or
  `human` when the browser sends none) or from the explicit `run` override the
  Host's own transitions use (`recordEvent`, the launch settle). The initiator is
  deliberately **not** part of the request-id dedupe fingerprint: replaying a
  request id must record nothing.
- **Silence is a decision, not an oversight.** `delete`, `import` and `reorder`
  record nothing (the row is gone; imported rows carry their own log; a drag
  would spend the bounded log on display noise). `update` records the *field
  names* it touched (`describePatch`) and never a value — the log must not
  become a second copy of the body it was meant to replace.
- **The envelope parser used to drop `initiator`.** It validated the field and
  then rebuilt the envelope without it, so `host-routes.ts` read
  `parsed.initiator` as always-undefined. The activity log made that visible;
  `parseActionEnvelope` now wraps `parseActionOnly` and carries the envelope
  fields through verbatim. Any future change to that function must keep the
  initiator, or every agent write starts reading as "a human did this".

### Where the log shows up

- **Editor timeline** (`client/activity-timeline.tsx`): oldest first, a scroll
  cap in CSS only (the host bound is the real one), and **nothing at all** when
  the log is empty — an absence is not a box.
- **`IdeaListRow` omits `events`** and `toListRow` drops it, so a 140-card poll
  never carries 50 entries per row. The editor reads the full record it already
  fetches for the deferred body. `events` is selectable on
  `GET /api/ideas/state?view=detail` (`fields=events`) for bounded reads.
- **Re-analysis** (`buildReanalysisPrompt`): the board refetches the full record
  before building the prompt and passes `activity`; an absent or failed read
  renders "nothing recorded yet", never a silent omission.
- **Export**: the markdown export **does** carry it, as a bounded `**Activity**`
  block per idea, after the metadata and before the body. Decision: those
  documents are the plugin's only portable artefact and "why was this declined?"
  is exactly what a last-state record cannot answer. `import` round-trips the
  log through the JSON path independently, and `importedIdea` repairs rather
  than trusts what arrives.

## Agent tools (idea #92)

`src/agent-tools.ts` exposes `ideas_list`, `ideas_get`, `ideas_capture`,
`ideas_triage`, `ideas_launch` and `ideas_review` to the Host's **optional**
agent-tool registry.

- **The registry is feature-detected, never declared.** `inject` in `index.ts`
  stays `['webServer', 'systemPrompt']`; the tools are followed through a scoped
  `ctx.inject(['tools'], …)` (with a direct `ctx.get('tools')` resolution as the
  fallback). `ctx.get` **throws** for a service nobody provides — the same trap
  the settings dual-path documents — so `resolveToolRegistry` catches and
  answers `undefined`. A missing registry is a downgrade, never a boot failure:
  the board, its routes and the announcement section are untouched.
- **No `@deepseek-ai/dsh-tools` dependency.** The definitions are plain
  structural objects (`parameters` written directly as the compiled object-rooted
  JSON Schema, `output: { schema: {}, render }`, the standard unconstrained-JSON
  form). The registry consumes only `{name, description, parameters, output,
  execute}` and validates only `output.schema` and `timeoutMs`; adding the
  package would make a Host without it a load-time failure for no behavioural
  gain. Arguments are therefore validated defensively inside `execute`, which
  answers `ok:false` + `code` rather than throwing.
- **One path, not two.** A tool never re-implements a verb: it builds the same
  envelope the HTTP route accepts and hands it to `parseActionEnvelope` (or
  `parseLaunchBody`) *before* calling `IdeasHostService`. A tool call and an
  HTTP call therefore cannot drift, and an invalid action is refused identically.
  Reads go through `buildIdeasReadSnapshot`, the same bounded projection the
  `?view=` routes serve.
- **No HTTP loopback.** Every call is a direct in-process method on the Host
  service; nothing leaves the machine and nothing depends on the web server.
- **System fields stay host-written.** `runStatus`, `runSessionId` and
  `taskBoardId` are refused by the wire gate; `carriesSystemField` re-checks the
  action the tools are about to submit so the invariant survives a future
  relaxation of that gate. The tools never *build* one either.
- **Everything a tool writes is attributed**: the envelope initiator is
  `plugin:ideas-manager:agent-tool`, so it reads back as
  `agent:plugin:ideas-manager:agent-tool` in the activity log, exactly like the
  analyst sessions.
- Registration is owned by the fiber that created it: the disposers ride the
  scoped-injection cleanup, so a replaced registry is re-registered rather than
  short-circuited by a stale disposer, and a disabled board registers nothing.

## Merge verb and the near-duplicate flag (idea #93)

### `merge` (one commit, two ideas)

`{ kind: 'merge', sourceId, targetId, mode }` reconciles a duplicate into the
idea that survives. It is a single `apply` switch arm in `host-ledger.ts`, so it
inherits the whole commit discipline for free: one revision, one persisted
dedupe-cache entry, one `commit()`, and both activity-log lines written from the
same `recorded[]` buffer.

Design decisions worth keeping in mind:

- **What reconciles is fixed; `mode` only settles the rank.** The loser's tags,
  its follow-up lineage and its card are reconciled either way, because that is
  what "these are the same idea" means. The only genuinely open question is
  where the survivor ends up in the open backlog, so `mode` is exactly
  `keepTargetRank` | `takeSourceRank`. Both verdicts re-use the existing
  `triageOrderedIds` helper, so a merge cannot produce a rank group the triage
  verb could not.
- **Same workspace or refuse.** `(loser.workspaceId ?? '') !==
  (survivor.workspaceId ?? '')` throws before anything is written. A merge that
  silently re-homed an idea would move work between projects behind the human's
  back. The workspace-less ideas compare as one generic group, exactly like
  `rankGroupKey`.
- **The survivor is rebuilt by spread, never reconstructed.** That is what
  structurally guarantees `runStatus`, `runSessionId` and `taskBoardId` survive:
  a bound card is the task-board's and the run poll owns the stamps. A merge
  that reset either would orphan a run the Host is still watching.
- **Tag union order is survivor-first.** `mergedIdeaTags` feeds the survivor's
  labels before the loser's, so `normalizeTags` keeps the survivor's
  `promptPrefix` for a duplicated name — the loser's prompt line must not
  rewrite a card the runner already owns.
- **An unranked loser has no position to give**, so `takeSourceRank` degrades to
  keeping the survivor's rank rather than demoting it to the bottom of the
  backlog.
- **Lineage is guarded against self-links.** The survivor inherits the loser's
  `followUpOfId` only when it has none of its own, and never a link equal to its
  own id; children of the loser are re-pointed except the survivor row itself.
- **Re-pointed children are silent in the activity log**, like `reorder`: they
  keep body and status and only move a parent pointer.
- **The mirror runs two ops on two chains** (`scheduleMirror` special-cases the
  verb exactly like `followUp` does): the survivor as an `update` — its content
  genuinely changed — and the loser as an `archive`, the same mapping `decline`
  uses. Neither can roll back: a mirror failure only logs, and a frozen
  post-run card refuses the patch by design.

### The flag: cheap, opt-in, and never on the poll

`findIdeaSimilar` (in `core/ideas.ts`, framework-free and unit-tested) compares
one anchor against the **open backlog of its own workspace**: normalized-title
token overlap and tag overlap, Dice on both, weighted `0.7 / 0.3`. Titles are
split on non-alphanumerics, and an **ideographic run is split per character** —
those scripts have no word separators, so whole-title tokens would make two CJK
titles score zero overlap no matter how similar they are.

The cost decision is the interesting part. The board's poll is a 2.5 s
`?view=list` fetch, and the brief's envelope for the existing scans is
0.07–0.41 ms at 420 ideas. Rather than spend that on every poll, the flag is
**opt-in through a read query**: `GET /api/ideas/state?view=summary&similar=<id>`.
Consequences worth stating:

- The **frozen full snapshot is untouched** — it never carries a `similar` key
  at all, and neither does the `?view=list` projection the poll actually uses.
  `tests/idea-93-similar.test.ts` asserts both, because "the poll payload did not
  change" is the real guarantee, far stronger than a timing measurement.
- The scan itself is cheap enough to be worth keeping: `perf-host.test.ts`
  measures **~0.13 ms over 420 ideas** (95 open same-workspace peers).
- `limit` bounds the candidate count (and is capped again at
  `IDEAS_SIMILAR_MAX_CANDIDATES`), so a caller cannot ask for a full ranking.
- The report is attached **after** the 512 KiB response-shrinking loop: the
  candidates are bounded metadata, so the report must never be the reason a row
  was dropped, and it must survive that loop intact.
- A single threshold (`IDEAS_SIMILAR_MIN_SCORE`) is the only tuning knob, and it
  is chosen so one shared tag out of eight stays noise while a perfect title
  match clears the bar.

### Find similar: the judgement is not the board's

The affordance is gated by `canFindSimilar` — **the same gate as `reanalyze`**:
`open`, a resolved session launcher, and a workspace the DSH app actually knows
(a ledger-only workspace cannot host a session). The two must appear and
disappear together because they are the same gesture.

The modal fetches the report when it opens rather than reading it from the
snapshot, and re-reads it on submit: a set fetched at open time may be a revision
old by the time the human clicks. It renders the score **with** the signal
legend, because a number with no explanation reads as a verdict. The launch
prompt then carries the bounded candidate set, tells the analyst to distrust the
score in both directions, requires a line per weighed candidate, and **forbids
the merge verb outright** — the run recommends a pair, the human merges. The
`ideas-analyst` skill mirrors those rules (`## Find similar runs`) so a session
that loads the skill obeys them even if the prompt is truncated.

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

Two consequences of this contract are worth knowing without any tooling:

- `workspaceId` is the **stable workspace UUID** (a key of
  `~/.dsh/storages/workspace.json`); `title` is only the display name. Renaming a
  workspace therefore rewrites nothing, and creating a second workspace under the
  same name gives every record a new id. Re-homing records between two
  workspaces is a batch of the ordinary `update` verbs — `workspaceId` is a legal
  field of both `IdeaUpdatePatch` and `TaskUpdatePatch` — never an edit of the
  ledger files, which a live single-writer Host overwrites. Archived cards are
  read-only for **every** verb, so such a batch needs the
  `restore` → `update` → `archive` round-trip (`restore` clears `archivedAt`
  alone: status, tags, executions and schedule survive).
- Editing an idea whose card binding is missing self-heals the mirror by
  **creating** its card, whatever the idea status. A bulk edit of many ideas
  therefore also mints cards for closed ideas, in `backlog`.

## Client notes

- The board is a **native shell panel**: one row in `sidebar.panellist` and one
  page in the layout's keyed `main` slot, both registered through
  `ctx.slots.inject` (`client/panel-registration.tsx`). The shell therefore owns
  the row box, the label, the font, the active highlight, the collapsed rail and
  the panel switch. It replaces an earlier raw `<button>` injection with its own
  visibility flag and its own ideas/taskboard/ssh eviction broadcasts, which is
  why Ideas used to behave like a toggle and did not look like the shipped rows.
  Mount/unmount is what opens and closes the board (`boardOpen`), which gates the
  background poll.
- Panel navigation is resolved from `ctx.layout` **defensively**, never declared
  in `inject`: cordis refuses an undeclared property, and declaring a service a
  deployment may not have would keep the whole plugin from booting.
- A launch refused by the TaskBoard **permission gate** is the one refusal with a
  destination: the card's effective permission sits above the session default, and
  only a human may confirm that binding. The modal names the card and offers
  `client/taskboard-focus.ts`, which selects the board panel through the layout
  and writes the idea title into the board's own filter. The write is DOM
  surgery on purpose — the board publishes no service, the `main` slot carries no
  selection payload and there is no deeplink — so it is scoped, bounded and
  silent on failure. The plugin never confirms a permission itself: `run` is the
  only launch verb it posts.
- The browser subscribes by **short-polling** (2.5 s) while the board is open
  and the page is visible, not by holding SSE connections: three tabs times SSE
  exhausted the browser's per-origin connection budget and stalled the Host.
- Cards render a short body excerpt; the full body is fetched on demand for the
  editor, the follow-up composer and re-analyze. A failed fetch never opens the
  modal (saving a partial body would silently truncate the analysis).
- The three interface dictionaries are held in strict key parity — the build
  fails on a missing key.
- The sidebar **"N to review" badge** is painted *inside the plugin's own glyph
  SVG*. The `sidebar.panellist` contract exposes metadata as `{id, order, label}`
  only, the icon component receives just `{size, active}`, and the row DOM is
  shell-owned (`button.panelRow > span.panelGlyph > our icon`), so **there is no
  badge seat**. Taking the row box back would undo the panel registration this
  plugin exists to use, so the pill is drawn in glyph coordinates with
  `overflow: visible`. The count is a `useSyncExternalStore` over the client
  snapshot already in memory (`client/review-count.ts`): no timer, no request.
  Its scope is the **persisted** `workspaceScope` (only when
  `rememberWorkspaceScope` is on), because the board's transient `workspaceFilter`
  does not exist while the board is closed. A shell whose glyph span clipped its
  own overflow would silently drop the pill — cosmetic, never a broken row.
- The **stale badge** is render-time only: `client/staleness.ts` compares the
  row's `updatedAt` against a `now` the board passes in once per render, so every
  badge of a paint agrees on the instant and no wall-clock timer exists. It is
  re-evaluated on each poll/redraw, `staleAfterDays <= 0` means OFF, and it only
  ever judges `open` ideas (a closed idea has a state that says more than a date).

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
