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
                      #   + snapshots / restore (idea #95)
  backup.ts           # the snapshot FOLDER only: atomic write, list, read, quarantine, retention
                      #   (knows nothing about the document — host-ledger validates that)
  host-routes.ts      # state (+ list / summary / detail), idea?id=, action, launch, events
  host-settings.ts    # the fenced /api/ideas/config route (settings dual-path)
                       #   + the per-workspace default launch model field (idea #107)
  taskboard-bridge.ts # runtime feature-detect + one-way mirror + the `run` verb
  session-runner.ts   # direct-session backend: Host RPCs + the roster the settle reads
  delivery-note.ts    # last-assistant-message extraction + the card `executions` pointer
  run-prompt.ts       # the execution prompt shared by every launch backend
  session-opener.ts   # the "Open session" jump from a running card
  export-markdown.ts  # unidirectional ledger -> markdown (golden-tested)
  http.ts / loopback.ts / mount-once.ts   # shared discipline
  core/ideas.ts       # IdeaRecord, statuses, run statuses, tag validation, activity log
                      # + the merge helpers and the pure near-duplicate signal
  core/ideas-stats.ts # idea #110: the ONE definition of every backlog-health number
                      #   (sample floor, calendar-month window, scope, triage gaps)
  client/health-view.tsx  # idea #110: the Health tab, which renders and computes nothing
  client/selection.ts    # the multi-select scope: toggle / range / all / prune (pure)
  client/windowing.ts    # idea #108: the column size cache, the estimate and the window
  client/virtual-column.ts # idea #108: the DOM binding (scroll offset, measurements, anchoring)
  client/bulk.ts         # bulk plans over the per-idea verbs + the runner + the report
  client/bulk-bar.tsx    # select box, selection bar, bulk dialog and per-idea report
  client/undo.ts         # idea #111: the inverse of the board's own actions, the
                         #   session stack and the drift guard (pure, DOM-free)
  client/undo-bar.tsx    # idea #111: the undo row, its button and its receipt
  client/deeplink.ts     # idea #105: reference grammar + board-wide resolver (pure)
  client/deeplink-service.ts # idea #105: the published `ideas-manager.board` service
  client/relations.ts    # idea #106: the relation views, candidates and diff (pure)
  client/relations-view.tsx # idea #106: the card's relation line + the editor section
  client/find-similar.ts   # the Find similar gate + launch input (pure, DOM-free)
  client/backup-panel.tsx  # the settings section's Backup tab (snapshot / restore / export)
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

The `model` those two paths take is resolved once, before the branch, from the
fallback order (an explicit choice, then the workspace's default, then the
backend's own default) — see *Default launch model per workspace* below.

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

- **The session id is a POINTER, not a lock (idea #66, revised).** `runSessionId`
  was a *live* pointer — stamped with the `running` state, **cleared at settle** —
  and the "Open session" link was gated on `runStatus === 'running'`. Two
  consequences, both wrong for a human: the link vanished the moment the run
  ended (exactly when you want to read the chat), and it **never existed at all**
  on a card-backed run, because only `launchInSession` ever wrote the field and
  the card backend is the default whenever the mirror is up (`viaCard = mirror
  && autoMirror`, `autoMirror` defaulting to true). The feature was unreachable
  in the default configuration — dead UI with a real copy behind it.
  It is now a *pointer to the last run*: the poll stamps
  `cardSessionOf(taskBoardId)` on every tick it reads a card (a settled one too,
  and while the execution is still in flight — `executions[]` carries the running
  attempt), the settle **keeps** the id and overwrites it with the run's own,
  and the link keys off the id alone, in every column including archived and
  declined. `setRunSession` no-ops on an unchanged value, so the steady state
  costs no revision. Re-attaching after a Host restart still requires the
  `running` status as well as the id, which is why keeping a settled id is inert
  for settling. No new persisted field: the field was already on the record and
  already in the backup surface, which is why the widened behaviour needed no
  change to `KNOWN_IDEA_FIELDS`.

- **The command dispatch is a version-skew boundary, and it is extracted.**
  Raising a fresh session's permission is a Host COMMAND (`/permission <level>`)
  dispatched through the shell's duck-typed `agents` + `commands` faces, because
  `session/create` carries no permission field and running fenced is worse than
  failing. Those faces are not typed against: `commands.execute` grew a
  **required fourth argument** (an `AbortSignal`) and the three-argument call
  this plugin still made threw a TypeError from the middle of the host —
  "session permission failed: Cannot read properties of undefined". The relay
  worked as designed (the modal shows the Host's own sentence), which is exactly
  why the skew went unnoticed until a human launched an idea.
  The call now lives in `src/command-dispatch.ts` as a pure function of the two
  faces, passes FOUR arguments (compatible both ways: an older host ignores the
  extra one), and is pinned by `tests/command-dispatch.test.ts` against a fake
  host that reads `signal.aborted` like the real one — the same shape of defence
  as the `unknownFields` normalization and `readJson`'s `message` preference.
  When the faces are absent the dispatcher is `undefined` (a direct launch then
  keeps the session default), and `index.ts` now **warns**: a launch that
  silently ran fenced would be the worst possible answer to "I asked for
  danger-full-access".

- **A wrong service NAME is a silently dead feature, not a degraded one.** The
  session link is the worked example: the probe asked the `sessions` store for
  `open()`, a method that store never had (the real face is
  `ctx.uiWorkspace.openSession(sessionId)`), so **every** deployment rendered no
  link — and the suite stayed green, because the fake it was given was the shape
  the plugin wished for rather than the shape a page has. Three rules now hold
  for every host-facing call, and they are the same rules the layout resolver
  already followed:

  1. **Services are read by NAME through `ctx.get(name)`**, never as a property:
     cordis throws on an undeclared property read, and the resolver kept a
     property read as a deliberate second chance only (`readServiceFace`).
  2. **Both names are probed, most current first.** The plugin declares
     compatibility from DSH 0.1.5-rc.1, and the way to show a session has moved;
     the settings section already carries this dual-path shape (`register` vs
     `SettingsForms`). An extra name costs one line; a missing one costs a
     feature nobody can tell is missing.
  3. **Nothing resolving WARNS.** Without it, "wrong name" and "unsupported
     deployment" are indistinguishable from the outside — the second is fine and
     the first is a bug.

  And the test fake is `get`-shaped, because a plain-object fake cannot catch a
  wrong accessor — which is precisely the bug. The recipe that settles any of it
  is in `AGENTS.md`: read the installed packages' `.d.ts`, where every `Context`
  key and service method is declared. That is how `uiWorkspace.openSession` was
  found and how the fourth `commands.execute` argument was confirmed; both facts
  came from the types on disk, not from memory.

  Two traps this feature alone is enough to teach, both found on a real page:

  - **A one-shot probe at mount is a timing bug wearing a feature's clothes.**
    `uiWorkspace` is provided when the workspace UI loads, which can be AFTER the
    plugin's client half mounts; probing once reported the face missing on a page
    that serves it. The probe is now repeated on every state update (the 2.5 s
    poll), so the link appears by itself within seconds, and the warning waits a
    grace period before claiming the face is absent.
  - **A name can match and still mean something else.** `feedbackUi.openSession`
    is present on the page, takes a session id, and opens the message-feedback
    form. It is not navigation, and it is written down as rejected so the next
    reader does not "fix" the link with it. Likewise `ISessions` documents that
    navigation belongs to the view owners, so `sessions.open()` is not coming back
    as a fallback.

  The missing-face warning is the third piece, and it is the one that found all of
  this: it enumerates the page's own services (through the reflection layer, which
  is a context *property*, not a service — `ctx.get('reflect')` finds nothing)
  and prints what the page really offers, filtered and complete. One line, once
  per page, after the grace.

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

## Multi-select and bulk actions (idea #94)

Two pure modules carry every rule, and the React half renders them:
`client/selection.ts` owns the selection, `client/bulk.ts` owns the plans and
the run; `client/bulk-bar.tsx` only paints and posts.

### The drag is never locked by a display order (idea #71 revisited)

Idea #71 shipped with the Open column's grip inert whenever the column painted
something other than the stored rank. The rationale was real but narrower than
the gate: the drop anchor is read from the **display** order while `rebuildOrder`
resolved it in **rank** space, so an in-column drop could land on the rank the
card already held. Two things followed that were wrong:

- The gate also killed the **cross-column** drop, whose semantics are the `move`
  verb and have nothing to do with ranks — and which the board's own drag hint
  promises.
- The gate refused a gesture the author is entitled to make.

What the board does now:

- **The grip is always draggable**, whatever the column displays.
- **`performDrop` passes the target column's DISPLAY order** to `rebuildOrder`
  (its new `targetOrder` argument), so the written rank is the order the author
  just built on screen. `rebuildOrder` still leaves every OTHER group
  rank-sorted, so one drop never rewrites ranks outside its column.
- **An in-column drop on the Open column takes over the default order** for the
  session (`openColumnReordered`, view state next to the multi-select — never a
  settings write), because a column that keeps painting a date order after the
  author arranged its cards would make the drop look like it did nothing. A
  cross-column move does NOT: there the status change is the point, so the
  column keeps the order it displays.
- `openOrdering` therefore means what its copy says — the column's **default**
  layout. The `card.dragLocked` copy is gone (`card.dragTakesOver` explains the
  takeover on the handle itself).

`tests/run-state-badges.test.tsx` drives the real HTML5 handlers (a transfer
stub plus dragstart/dragover/drop) and asserts the WIRE: an in-column drop posts
one `reorder` whose group is the display order with the card inserted at the drop
point, and a cross-column drop posts `move` then `reorder`.

### The selection is view state, and is bound to the scope

- Nothing about a selection is sent to the Host or persisted, so the 2.5 s
  poll cannot overwrite it — the same discipline as the `openOrdering` view of
  idea #71. The selection lives in `IdeasBoard`'s own state.
- **A selection can only hold ids inside the active scope** (the active tab's
  filtered rows: workspace selector + tag filter + search). Every helper that
  grows the set takes the scoped id list and refuses anything outside it, and
  `pruneSelection` runs in an effect keyed on the scope's id list. This is the
  load-bearing decision: it is what makes "Archive the selection" mean "the rows
  I can see are ticked", and it is why an idea that falls out of the filter
  leaves the selection instead of lurking in a pending batch.
- **The scope order is the display order**, so a shift-click paints the block
  the author is looking at: the Overview concatenates its columns in board
  order, Priorities reuses the same `groupOpenByWorkspace` + `compareWorkspaceGroups`
  layout the view paints, Delivered exports `deliveredRows` (its exit-date sort)
  for exactly this purpose. Duplicating that order anywhere else would make a
  range disagree with the screen, so all three go through the same helpers.
- `pruneSelection` returns the SAME object when nothing left the scope, which
  is what keeps the effect from looping on every poll tick.

### Bulk = the ordinary verbs, batched client-side

There is no bulk verb and no ledger edit on this path — the wire stays frozen
and each batch is literally the sequence an author would perform by hand.

- **`workspaceId` is the stable workspace UUID.** Re-homing is a batch of
  `update` patches; `''` is the generic (workspace-less) group, and an idea
  already in the target group is reported as skipped instead of spending a
  revision and a mirror round trip on a no-op.
- **Serial on purpose.** `IdeasClient.run` adopts the snapshot returned by every
  verb, so interleaved responses could adopt a stale revision and paint an older
  board than the ledger holds. A bulk run awaits each idea in turn and shows
  progress; a deliberate batch is not a latency race.
- **A refusal never aborts the batch.** `runBulkPlan` settles each idea
  independently (applied / skipped / failed with the Host's own message), which
  is what the "per-idea, never a blanket error" contract means in practice.

### The mirror round trip, and why declined is never round-tripped

An archived TaskBoard card is read-only for **every** verb, so a plain `update`
on an archived, card-bound idea would change the idea while its card silently
kept the old labels/workspace. Such an idea is therefore updated as
`restore` → `update` → `archive` (`restore` clears `archivedAt` alone: status,
labels, executions and schedule survive).

- **Declined ideas are skipped by every tag/workspace batch.** Restoring one to
  patch its card would move it to `open` and then archive it — rewriting a
  decline into a plain archive. They are reported as skipped instead, which is
  the honest answer: the bulk verb cannot touch them without changing what they
  are.
- **A failed round trip is compensated.** The `restore` has already landed, so a
  failed `update` would leave the idea in the OPEN backlog; the runner re-issues
  the archive and says which of the two happened (`rearchived` / `left-open`).
  A bulk tag must not be able to quietly open an archived backlog.
- A card that already **ran** stays frozen by design (see *Card mirror*); the
  idea write still succeeds and the board reports the idea change, which is
  what was asked for.

### Two smaller invariants

- **The label cap is checked up front.** `normalizeTags` DROPS an over-long or
  ninth label rather than refusing, so the planner skips such an idea with
  `tag-limit` and the dialog refuses an over-long name — a batch that reads
  "tagged" must have actually tagged.
- **`IdeaClientPatch.tags` accepts `IdeaTag[]` as well as `string[]`.** The wire
  patch replaces the whole set, so a name-only array would silently drop every
  existing label's `promptPrefix`. Bulk tagging rebuilds the union from the
  row's own tags and keeps each prompt line; the capture/edit modals keep
  sending plain strings.

### Undo, scoped to the reversible operation (superseded by idea #111)

`summaryBulk` marks a report `reversible` for a bulk archive only, and
`undoableIds` returns exactly the ideas the run **applied** — restoring a skipped
idea would resurrect a row that never moved. Tag and re-home reports render the
explicit "no undo here" line instead of offering a button. This is a batch
restore, deliberately not a general undo system.

That scoping was the right call *at the time*, because `update` carries no
previous value: the batch module had `reversible`, `undone` and `planBulkRestore`
but nothing to invert a tag with. Idea #111 removed the reason for the limit —
see [Undo](#undo-idea-111) below — and the `bulk.noUndo` sentence, which was
true only while tagging and re-homing had no previous value to restore.

### What the select box costs, measured

The affordance is **always visible** — a checkbox the author cannot see is not
an affordance, and arming a "selection mode" first would break the "click to
select" contract — so it is one extra element on every row of every view. The
`IDEAS_PERF=1` profile at 140 mounted cards, same machine, medians of three runs
against the pre-feature baseline:

| measurement | before | after |
|---|---|---|
| DOM nodes after mount | 6 948 | 7 097 (+2.1 %) |
| search keystroke (full 140-card re-render) | ~148 ms | ~180 ms |
| workspace scope (51 cards re-rendered) | ~30 ms | ~40 ms |
| mount / idle poll / tab switches | — | within run-to-run spread |

Two decisions come out of that profile, and one non-decision:

- **The tick is a CSS pseudo-element, not a child span.** Measured: dropping the
  span removed 140 DOM nodes but moved the timings by nothing, so the cost is
  the *element with its attributes*, not the node count — yet one node per row
  is still the right budget for a control that renders on every card.
- **The scope is derived where the columns are drawn**, reusing `byStatus`
  (which the Overview render already calls per column) instead of a second
  ordering pass, so the Overview pays at most one extra filtered scan per paint
  and the Priorities/Delivered tabs reuse the layout helpers their own views
  paint with.
- **The remaining ~20 ms is jsdom's element cost, not a real-browser cost.** The
  profile measures main-thread JS plus DOM mutation with no style/layout/paint,
  where creating an element and setting its attributes is the expensive part;
  a real browser builds that button in microseconds. The number is recorded
  because it is the honest "what did this feature add to a full board re-render"
  answer, not because it predicts a dropped frame.

## Snapshots, restore and portable transfer (idea #95)

Backup is a first-class surface here, not a script: a ledger has already been
lost in this project and put back by hand from `GET /api/ideas/state`.

### The split: a folder that knows nothing, and a ledger that knows everything

`src/backup.ts` is a **document-agnostic** filesystem store: write a text, list
the folder, read one back, rename a broken file aside, prune. It holds no lock
of its own — two writers would be worse than none, and the parent ledger already
refuses to boot a second Host on the same home — and it is constructed from the
ledger's directory, so a snapshot can only be produced THROUGH the lock holder.

Everything about the document lives in `host-ledger.ts`, where the two paths
that already existed were extended rather than duplicated:

- `parseHostIdeas` was split into `readIdeaRow` (one row + the reason it could
  not be repaired) and the lenient list built on top. The **boot** path keeps the
  lenient behaviour exactly (a hand-edited ledger must still open, repaired where
  it can be).
- `normalizeDocument` became the module-level `normalizeParsedDocument`, because
  the restore path needs the same repair and a private method is not reachable
  from a validator.

### The snapshot IS the portable document

A snapshot is the ledger document **plus** a `snapshot: {version, createdAt,
reason, ideas, revision}` stamp, written exactly as the ledger persists it. One
serializer, one validator, one file format — so the download the panel hands the
browser is byte-identical to what a restore adopts on the other machine, and
there is no second "export format" that could drift from the first. The stamp is
additive and ignored by the validator; the `export` VERB is untouched and stays
the markdown view.

The file **name** carries the same provenance (`snapshot-<epoch ms>-<8 hex>.json`,
`export-…`, `displaced-…`) so the list can be built from `readdir` + `stat`
without parsing a single snapshot: opening the settings section costs a directory
read whatever the board weighs.

**Retention is explicit and asymmetric.** `IDEAS_SNAPSHOT_RETENTION` (10) bounds
only the files the plugin wrote. A file the user dropped in — an export carried
from another machine — is `managed: false`, is listed and restorable, and is
**never pruned and never quarantined**: silently deleting someone's file because
a counter was reached would be the worst thing this feature could do.

### Restore: the order of the checks is the contract

1. **A run in flight refuses the whole restore** (`restore-run-in-flight`, 409).
   The Host polls that run and writes its settle onto an idea that may be gone.
   Checking the live state FIRST also means a refusal has no filesystem side
   effect — a broken snapshot is not quarantined as a side effect of being told
   to wait.
2. **Validate strictly, then displace, then adopt.** `validateLedgerDocument`
   is the deliberate opposite of the boot path: an unreadable live ledger is
   quarantined and the board starts empty, because a broken board must still
   open; a restore is a deliberate act with a good copy in hand, so the only
   acceptable failure is a refusal that names what is wrong. It refuses on the
   schema version, on the shape of every counter/list, on any record `readIdeaRow`
   cannot repair (naming the index: "record 2 of 3"), and on two records sharing
   an id — each of which `normalizeParsedDocument` would have silently dropped.
3. **The displaced document is written BEFORE anything is replaced.** If that
   write fails the answer is `restore-not-saved` and nothing is restored: "the
   board you have now" must always exist somewhere.
4. **The revision only moves forward** (the adopt reuses the live revision and
   `commit()` bumps it), so the browser's 2.5 s poll cannot mistake the restored
   board for the one it already holds, and **the dedupe cache is NOT rewound**:
   replaying a `requestId` must keep meaning "this already ran", even though the
   board it ran on is gone.

A broken plugin-written snapshot is renamed `<name>.corrupt-<stamp>-<rand>`
instead of being deleted, and then refuses the restore with that path in the
message.

### Forward compatibility: the schema gate is DIRECTIONAL

`readIdeaRow` is a **whitelist rebuild** — it starts from a fresh
`{id, title, body, status, createdAt, updatedAt}` and copies the fields it knows
— which is the right way to read an arbitrary object and the wrong way to be
surprised. A file written by a NEWER plugin therefore loses, silently, whatever
that plugin added. Two rules make that impossible to hit unawares:

- **A file from a newer plugin is REFUSED**, not adopted. `validateLedgerDocument`
  compares `schemaVersion` **directionally**: `>` the reader refuses
  (`snapshot-schema-newer`, answered 409 because retrying unchanged fails the
  same way), `<=` it accepts. The old strict equality was wrong in BOTH
  directions: it refused every backup ever taken by an earlier release, and it
  happily adopted a newer file it could only half-read.
- **Unknown keys are reported, never swallowed.** `KNOWN_IDEA_FIELDS` is the
  literal of every key the reader copies; anything present on a record and absent
  from it is collected per restore and returned as `unknownFields`, which the
  panel prints by name. This covers the case the schema gate cannot: a field
  added **without** a bump (the established pattern — see `events` #92 and
  `relatesTo`/`blocks` #106, where an old document simply lacks the key and the
  first write that needs it creates it).

The trade-off is deliberate and worth restating: **passing unknown keys through
was rejected.** It would make any file round-trip in both directions, but it
turns the reader into a garbage pass-through, contradicts the "silently lossy
for an import" stance the module documents, and a hand-edited typo would then be
preserved forever instead of repaired away.

**Bump `IDEAS_SCHEMA_VERSION` only when an older build must refuse a newer
file.** A bump makes a NEW build refuse every OLD backup (the check is
equality-free but the document is still written by the older version), which is
the one way a backup feature becomes useless.

### The release step that keeps this honest

The field surface is pinned twice, in literals, because the TypeScript type is
erased and nothing else can see it: `IDEA_FIELDS` in `idea-95-backup.test.ts`
(asserts the fully-populated fixture carries exactly that set) and
`KNOWN_IDEA_FIELDS` in `host-ledger.ts` (asserted equal to the first). Adding a
persisted field without naming it there **breaks the suite**. `AGENTS.md` turns
that into a written release step for the next agent, because the failure it
prevents is invisible in review: the field works, and the backup quietly stops
carrying it.

### Routes, not verbs

`GET|POST /api/ideas/backup`, `GET /api/ideas/backup/content`, and
`POST /api/ideas/backup/restore`. A snapshot writes a FILE rather than mutating
the document and a restore replaces it wholesale, so neither may consume the
persisted request-id cache — the same reason the launch route is dedicated. The
frozen action envelope and the default `GET /state` response are untouched
(`idea-95-backup-routes.test.ts` asserts both, and that `{kind:'snapshot'}` is
still an `invalid-action`).

`readJson` in the client transport now prefers a refusal's `message` over its
`error` code when both are present. It is inert for every pre-existing route
(none sends `message`) and it is what lets the panel print the Host's own
sentence rather than a code.

### The Backup tab, and the settings dual-path

`client/backup-panel.tsx` is a third tab of the settings section and drives its
**own** routes. That is the whole reason a deployment whose settings port is
unavailable (`available: false`, no `settings.register`, no SettingsForms) still
gets snapshots, restore and the portable export — the display options degrade to
the spelled defaults, the backup surface does not. A host that serves no backup
route at all (an older Host, a test fake) renders one explicit note instead of
empty buttons: the capabilities are optional on the transport for the same
reason `config` and `launch` are.

Two copy decisions worth keeping: the restore toggle and its confirmation button
have **different** labels ("Restore…" vs "Replace the board") because two buttons
reading "Restore" on one row is an accessibility bug as much as a UX one, and
the download is a plain `<a href>` to the content route (the server sets
`content-disposition`) rather than a Blob — the file the browser stores is then
exactly the document a restore adopts elsewhere, with no client-side copy of it.

**One write action, not two.** The panel originally offered *Take a snapshot*
(`reason: 'manual'`) and *Export a copy* (`reason: 'export'`). They called the
same client method with the same body and the Host wrote the same document; the
only differences were the file-name stamp and a post-export download link — and
**every** list entry already had its own Download link, so that link was a
duplicate of one a row below. The button is now the single **Export the board**
(reason `export`): the same file is both the restore point you take before a
risky change and the file that travels to another machine, which is exactly the
argument for having one. `manual` and `pre-restore` remain valid reasons on the
wire and in the list labels (a file the user drops in the folder is `manual`), so
nothing about the stored data or the API changed — only the UI stopped offering
the same write twice.

## Column windowing (idea #108)

This is the deferred half of the idea #34 high-card-load work (the other half, a
server-side index, stays deferred). The trigger is **~500 cards in the Open
column**, and the reason it was deferred is still true on every ordinary board:
the per-poll scans run at 0.07-0.41 ms, the sorts at 0.12 ms or better for 420
ideas, and `?view=list` already cut the poll payload to 7.8% of the full
snapshot. Numbers are in `docs/perf-evaluation.md`.

### One definition of "what the column contains"

`byStatus` used to be called nine times per render: four to paint, four to
build the multi-select scope, one per drop. It is now called four times, and its
results live in **one** `columnRows` map that the paint, the drop anchor
(`performDrop`), the header count, the standing notice and the selection scope
(`scopeRows`) all read.

That collapse is the load-bearing part of this feature, not a tidy-up. Windowing
creates a second candidate answer to "what is in this column" — the painted
window — and the three behaviours the idea names are each a place where a
virtualized list silently lies about what is on screen. Collapsing them onto one
map means windowing *cannot* become a second definition: the window decides what
is painted, and nothing else.

### The size cache is seeded from an estimate, not measured lazily

Cards are **not** a fixed height: the title wraps (`overflow-wrap: anywhere`, no
clamp), the workspace/tag line wraps, and the description is clamped to 2 (raw)
or 3 (markdown) lines. A virtualizer that starts every row at 0 and measures as
it scrolls has a wrong scrollbar on the first paint and a scroll position that
moves under the pointer as rows resolve.

`estimateIdeaCardHeight` is a **pure function of the row**: it counts exactly
the parts that wrap (title + its `#N` prefix, the tag line, the clamped
description, relation chips, a delivery note, the score badges) over a fixed
chrome. Two properties matter more than its accuracy:

- it is **deterministic**, so the same row has the same height in every column
  and on every render; and
- it is **correct on the first paint**, which is what makes the scrollbar honest
  before anything has been laid out.

`charsPerLine` is the one tuned input, and the React half derives it from the
column's measured width. A width of 0 (jsdom, a `display:none` panel, a
detached column) keeps the default budget rather than estimating like an
18-character sliver — a pessimistic estimate on every test and every hidden
panel would have been a permanent lie in the pessimistic direction.

### The inter-card gap lives in the slot, not in the flex container

`.dsh-ideas-column-body` still carries `gap: 8px`, and the sizer's children are
absolutely positioned, so that gap would stop applying. `IDEA_CARD_GAP_PX`
therefore lives in the geometry, and `slotSize` adds it on **both** the measured
and the estimated path.

This was a real bug, caught by the geometry suite: `slotSize` originally read
`measuredById.get(id) ?? estimate + GAP`, so the first time a card was measured
its slot **lost** 8 px and every row below it jumped up under the reader. A
sub-pixel-churn guard (`|Δ| < 1 px` returns 0) keeps a measure/resize feedback
loop from re-rendering forever.

### Anchoring is explicit, because the alternative is a lying scrollbar

`measure(id, height, anchorIndex)` returns **the movement of everything above
the anchored row**, and the caller adds it to `scrollTop`. A change at or below
the anchor returns 0, because the reader cannot see it move.

This is the whole difference between a windowed column that is usable and one
that is not: without it, every card that resolves to its real height pushes the
row being read up under the pointer, a deep-link lands on a row that visibly
moved, and a drag's insertion line points somewhere the author never saw.

### A viewport that cannot be measured paints everything

`window(scrollTop, 0)` returns the **whole column**. jsdom reports
`clientHeight === 0`, and so does any DOM without layout. Windowing against an
unknown viewport would paint a slice of the board and claim it is the board, so
an unmeasurable viewport is answered with everything — which is also why every
pre-existing board test keeps passing unchanged.

### The first paint still had to build the column — twice

The first render happens before the column has been laid out, so the window has
to start from a budget that needs no measurement. Two fallbacks, in order:

1. `lastViewport`, a **module-level** map of the last height each column
   actually had. It survives the panel being closed and re-opened, which is the
   common case: without it every re-open would rebuild the whole column and throw
   it away in the next commit.
2. `provisionalViewport()` = `window.innerHeight`, readable synchronously with no
   layout. A column can never usefully be taller than the window it is drawn in,
   so it is an upper bound that bounds how many cards the FIRST render builds.

The scroller ref callback then replaces both with the real measurement **in the
commit phase**, before the browser paints.

`rememberViewport` clamps what is *remembered* to four window heights while
windowing against the *live* value. A panel mounted where it has no height
(a detached container, a hidden tab) reports a huge `clientHeight`; remembering
that would pin a useless budget for the rest of the session and rebuild the
whole column on every later open. Remember conservatively, measure faithfully.

That correction costs **one extra full board render per panel open**, and it is
the price of not building the column: a stage probe measured the hook's own work
at **1.5 ms**, so the whole of the ~53 ms the 140-card mount pays is this second
render and nothing else. It is inherent — the alternatives are a first render
that builds all 500 cards, or one that waits for the DOM — and it is paid before
the browser paints, so nobody sees it. `scrollerRef` still re-renders **only when
the correction actually moves the window**: that cannot help the first mount
(the cached view is empty by definition) but it does save the render when a
column re-attaches with the viewport it already had. Numbers and the tracing
method are in `docs/perf-evaluation.md`.

### Below the floor, nothing changes

`IDEA_WINDOW_MIN_ROWS` (40) is where windowing starts. Under it a column is
painted whole, so a board that is fine today behaves exactly as it did — which is
also what keeps the drag, selection and deep-link suites untouched. All four
columns go through the same code path and the same floor; virtualizing only the
Open one would have left the other three inconsistent for no gain.

### The three behaviours, and where each is locked

| behaviour | the decision that keeps it | test |
|---|---|---|
| **scroll anchoring** | `measure` returns the movement above the anchor; the caller adds it to `scrollTop` | `idea-108-windowing.test.ts` (anchoring group), `idea-108-virtualization.test.tsx` (scroll anchoring) |
| **the drag drop anchor** | `performDrop` reads `columnRows[status]`, the FULL column; `dropNextId` is `columnIdeas[index + 1]` of that same list | `idea-108-virtualization.test.tsx` ("writes a reorder built from the WHOLE column") |
| **range selection over a filtered scope** | `scopeIds` is the full scope order, and `pruneSelection` runs on it; windowing never enters the selection path | `idea-108-virtualization.test.tsx` ("bound to the scope, not to the window") |
| **deep-link reveal** | two phases: `reveal(id)` mounts the card, then the pre-existing `scrollIntoView` still centres it | `idea-108-virtualization.test.tsx` ("never painted") |

The deep-link split is the subtlest of the four. `ideaCardOf` scans the DOM for
`[data-dsh-idea-id]`, and a card scrolled out of a windowed column has no DOM
node — so the link would have landed silently nowhere. Phase one moves the
column's scroll and mounts the card; phase two, re-run by that render's own
`revealTick`, does the `scrollIntoView` that is still the final authority for the
non-windowed columns and the two list tabs.

### The frozen wire

Nothing. `windowing.ts` and `virtual-column.ts` are imported by
`board-view.tsx` alone, `IdeaRecord` gained no field, and there is no new verb,
route or read query. `idea-108-wire.test.ts` drives a real loopback Host and pins
it: the default full `GET /state` answers exactly `{schemaVersion, revision,
ideas}` with whole bodies and no excerpt, the action envelope is still strictly
three keys, four candidate verbs (`virtualize`, `window`, `viewport`,
`setWindow`) are still `400`, and `import`/`export` round-trips a record
carrying every field the ledger holds.

## Backlog health (idea #110)

`src/core/ideas-stats.ts` is the whole feature on the host side: a pure
`buildIdeasStats(source, options)` over a `{revision, ideas}` slice, served by
`GET /api/ideas/state?view=stats` and painted by `client/health-view.tsx`.
Everything below is a decision that had to be taken before the code, and each
one is a place where the obvious implementation would have lied.

### Why a separate `view`, not a fold into `view=list`

The board's poll is a 2.5 s `?view=list` fetch and the full snapshot is over a
megabyte. Re-reducing a second copy of it in the browser on every paint is
exactly the cost idea #34 removed, so the aggregate is a **separate bounded
read**: two hard-capped arrays and a handful of scalars, ~600 bytes on a
14-idea board and provably under the 512 KiB wire cap at the 140-card fixture
(`idea-110-stats.test.ts`). The poll URL, its payload and its cadence are
untouched, and the panel asks for the aggregate only while the Health tab is
open and only when the ledger revision or the workspace scope actually moved.

`view=stats` deliberately does **not** run through `parseIdeasReadQuery`: it
takes only `view` and `workspaceId`, and an unknown key is a `400` rather than
a silently broader answer. Every key the row views take (`limit`, `fields`,
`similar`, …) would be a second set of definitions for the same numbers.

### Why `ledger.statsSource()` breaks the clone-on-read rule

Every other reader of the ledger gets `snapshot()`, a deep clone of all 140
records. For an aggregate that reads counters and keeps nothing, cloning a
megabyte to produce forty numbers is precisely the waste this feature exists to
avoid, so `IdeasHostLedger.statsSource()` hands over the document's rows
directly. Two rules keep that safe: the document reference is captured ONCE, so
revision and rows always come from the same revision (a commit replaces the
document wholesale rather than mutating it, so the array cannot tear), and the
rows are typed `readonly`, so the only consumer — a pure function — cannot write
through the seam even by accident. `applyRequest` remains the only writer.

### The median: the honest answer is sometimes no answer

`deliveredAt` is stamped by the `deliver` verb and is only as honest as the way
the backlog is closed. A backlog whose ideas are dragged to Archived has no
delivery data at all, and a median computed over that sample is a confident
wrong number — worse than none. So:

- **The sample is every idea carrying a real stamp** (`deliveredAt` present,
  finite, and not before its own `createdAt`), across the WHOLE board, not just
  this month. "How long does a delivery take here" is a property of the backlog,
  not of the current calendar month.
- **Below `IDEAS_STATS_MEDIAN_MIN_SAMPLES` (5) the response is
  `medianMs: null`** and the UI prints *Not enough deliveries yet (n / 5)*. The
  floor and the sample size both travel in the payload, so no surface can
  render a different rule than the Host applied. The floor is a constant and
  not a percentage on purpose: a percentage would let a small board print a
  median off two rows while a big one stayed silent.
- **`withoutStamp` is reported next to it.** How many ideas left the backlog
  with no delivery stamp is the number that explains a missing median, and
  naming it is the difference between "we know nothing" and "nothing happened".
  A DECLINED idea is deliberately excluded from it: an honest "no" is not work
  closed without a delivery. Conversely a delivery keeps its place in the sample
  even if the idea was restored and declined afterwards — `restore` clears
  `archivedAt` alone, and the delivery really happened.
- **`inconsistent` is never averaged.** A stamp before its own creation is only
  reachable through a hand-edited or imported document; it is counted and
  excluded rather than silently folded into a median.

### "This month" means the local calendar month, and says so

`window` is `{kind: 'calendarMonth', start, end}` with `start` the Host's LOCAL
first instant of the month and `end` the instant the aggregate was measured. The
label can therefore be checked against the data it claims, and the panel prints
the month name it actually measured rather than "recently". A rolling window
would have needed a different label ("last 30 days"); the words on the card mean
this one.

### Scoped, not global

The view follows the board's workspace selector like every other tab, so a
number never answers a different question than the one on screen. The payload
is self-describing — `scope.kind` is `all`, `generic` (the workspace-less
group) or `workspace` — and the wire maps the board's three selector values onto
them directly: the key is **absent** for all, **blank** for the generic group,
and the id otherwise. The per-workspace breakdown is therefore "open per
workspace *in scope*": eight rows when the scope is everything, one when it is
narrowed, which is correct rather than a degradation.

### What the view refuses to say

- **Triage is work, not a score.** `missingRank` / `missingValue` count OPEN
  ideas in scope, and the copy says so. A closed idea without a value is not
  backlog triage — nothing is being decided about it.
- **Labels are counted on the open backlog only.** A label that only appears on
  closed work is history, not work to do. Counting is case-folded (first
  spelling wins) so `Perf` and `perf` are one row to a reader.
- **The panel computes nothing.** `health-view.tsx` renders the Host's numbers
  verbatim; the only computation it does is `durationParts()`, the shared helper
  from the same module, which turns milliseconds into a value and a unit while
  the dictionary supplies the words. An aggregate is the easiest thing in this
  codebase to compute two different ways in two places, and a panel that
  recomputed would be exactly that second place.
- **The list-only affordances step aside.** The search box, the tag filter and
  the selection bar are hidden on the Health tab: none of them can narrow an
  aggregate computed on the host, and offering them would promise a narrowing
  that never happens. The workspace selector stays — it IS the scope.

### An aggregate goes stale, and says so

The board poll moves the instant the ledger does; the aggregate answers for ONE
revision. That leaves a window — however short — where the figures on screen
describe a board that no longer exists. A health view that cannot say when it is
out of date is exactly the "looks authoritative and is not" failure the idea was
deferred to avoid, so the staleness is **stated, not hidden**:

- `IdeasStats.revision` is the ledger revision the numbers came from, and the
  panel compares it with the revision it is painting. This is the ONLY consumer
  of that field, and shipping a field nothing reads is how it rots.
- The figures **stay on screen** when they go stale. Blanking them would flicker
  on every commit and punish the reader for the board being busy; a note under
  them names the revision they describe instead.
- The note distinguishes the three real states, because they need different
  reactions: `refreshing` (a fetch is in flight), `stale` (nothing in flight —
  treat the numbers as history), and `staleError` with the Host's own message
  when the refresh **failed**. The last one is the case that would otherwise be
  invisible forever: a failed background refresh, with the old numbers quietly
  still on screen and no way for the reader to know they are old.

`statsPending` exists for exactly that third branch; without it the view cannot
tell "being refreshed" from "stuck".

### Degradation, not breakage

`stats` is an **optional capability** on `IdeasHostTransport`. A Host that
predates the route leaves the client on `undefined` forever and the tab prints
one explicit note ("this deployment does not serve the health view") rather than
figures that read as zero. `IdeasClient.loadStats` carries a supersession guard:
switching the workspace selector while a request is in flight starts another
one, and only the LAST may write, so a slow answer can never repaint the panel
with numbers the reader is no longer asking for. The stored result also travels
with the scope it was computed for, and the view renders nothing rather than
another scope's figures while its own fetch is in flight.

## Deep-link to an idea (idea #105)

### The surface decision, taken before the code

The brief asked for the surface to be chosen first and written down, because the
two candidates were genuinely different and only one of them is ours to build.
This is that decision, and the reasoning is kept so the next reader does not
re-open it.

**Chosen surface: a published client service + a selection payload the panel's
own state carries. No new route, no URL write, and no DOM.**

- **A published service.** `ctx.provide('ideas-manager.board', …)` is the cordis
  way for another plugin to reach a panel that is not on its dependency list, and
  it is the same mechanism the shell itself uses for cross-plugin faces. It is
  feature-detected by the caller (`ctx.get(…)`), so a deployment that never asks
  for it pays nothing, and this plugin never declares it in `inject` — a missing
  consumer must not be able to keep the board from booting.
- **A panel-state payload.** The request lands on `IdeasClient` (framework-free,
  subscribable) and is consumed by `IdeasBoard`, which owns the scope, the tab and
  the filters. The payload lives on the client rather than in React state because
  a deep-link has to survive the panel being **closed** at the moment it is
  requested — that is the "cold panel load" case.
- **Not a route.** The board is a page in the layout's keyed `main` slot; a
  top-level route of our own would compete with the shell's navigation, and the
  brief says to stop for a decision rather than invent one. Nothing here touches
  `location`, so we cannot fight whatever the shell does with its own URL.
- **Not DOM.** Everything is our own React tree and our own cordis context.

### What was verified about the third party

The one refusal with a destination is the TaskBoard **permission gate**: a
mirrored card whose effective permission sits above the session default can only
be confirmed by a human, in the TaskBoard. `client/taskboard-focus.ts` used to get
there by writing the idea title into that board's filter field through the native
value setter and a bubbling `input` event — pure DOM surgery on someone else's
React tree.

The installed task-board (0.4.4) was read to see whether a contract exists to
replace it: `lib/types/client/index.d.ts` exports `apply`, `bindSettingsForm`,
`servedEntryForm`, `TaskBoardPanel`, `registerTaskBoardPanel` and the panel id —
there is **no provided service**, no deeplink, and `BoardController.openTask(id)`
is internal to that plugin's own fiber. So the surgery had no contract to be
replaced by, and the honest fix is to stop depending on the foreign DOM: the
refusal now deep-links to **our** card (an exact destination, by number) and opens
the TaskBoard panel through the shell's own layout face, unfiltered. The module is
deleted rather than kept as a second way to do one thing; the convenience it
provided — the TaskBoard pre-filtered on the idea title — is the real cost of that
decision and is stated in the CHANGELOG rather than hidden.

### The rules that make it a link and not a filter

- **The number is the reference.** `#42`, `42` and a raw id are all accepted, and
  `idea-<id>` (the deterministic mirrored-card id) parses too, so a card id copied
  from the TaskBoard still lands on the right card. An id is accepted, never
  advertised: it does not survive a re-import on another machine, so the copy
  always shows the number.
- **Resolution is board-wide, never scoped.** The poll carries every idea of every
  workspace, so the resolver runs over the whole snapshot: `open idea #42` lands
  on #42 whatever the workspace selector, the tag chips or the search box say.
- **Focusing clears the narrowings.** A focused card that the filters hide is not
  a focus, so the search and the tag filter are reset (the search box visibly
  empties, which is the explanation) and the workspace scope becomes the idea's
  own workspace. The scope is *not* persisted: the remembered scope is a
  preference about how the board opens, not about where a link pointed.
- **A cold board reads once.** The 2.5 s poll only runs while the board is open,
  so a request that misses the current snapshot asks the Host through the
  existing bounded read (`?view=summary&numbers=` / `&ids=`, one row) and adopts a
  fresh list before answering. The card must exist before it can be focused. This
  is the same wire the agent tools read; nothing was added to it.
- **Archived and declined land too.** Every status has a column on the Overview,
  and the tab always switches there. The single exception is a declined idea
  while the *hide Declined column* setting is on: there is no card to paint, so
  the board says exactly that instead of silently doing nothing.
- **The focus is view state.** It is never written to the Host and never
  persisted, and it is dropped the moment the human narrows the scope, searches,
  toggles a tag or changes tab — the same discipline as the multi-select
  (idea #94), for the same reason: the poll must never fight the reader.

## Relations between ideas (idea #106)

Two new record fields, `relatesTo` and `blocks`, each a list of idea ids capped
at `IDEA_RELATION_LIMIT` (20). `blockedBy` is **never stored**. Everything below
is a decision that had to be taken before the code, and the rejected alternative
is named in each case so the next reader does not re-open it.

### Cardinality: a list of ids ON THE ROW, not an edge table

**Chosen: `relatesTo?: string[]` and `blocks?: string[]` on `IdeaRecord`.**

The rejected alternative is a top-level `relations: [{from, to, kind}]` edge
table in the ledger document. It was rejected for three reasons that only matter
at the size this feature was deferred to (~100 ideas in a workspace), which is
exactly why the cost was judged permanent and the benefit felt:

- **Every read in this plugin is "give me this row".** `GET /api/ideas/idea?id=`
  is the single-record read, the editor already fetches it, and the list rows
  are the board's only data. With a list on the row, one read returns the edges
  with no join and no index; with a table, every one of those reads becomes two
  passes, and the `IdeaListRow` type (which is `Omit<IdeaRecord, …>`, the reason
  a full-body dependency cannot silently grow back) stops describing the row.
- **The document-level invariants already have a home.** `parseHostIdeas`,
  `validateLedgerDocument` and the `import` merge all work on a row list. A
  table would need its own boot repair, its own strict validator and its own
  merge step, three more places to get wrong.
- **Deletion and merge become row rewrites.** `delete` sweeps one field;
  `merge` re-points one field. With a table both become index maintenance with
  dangling-reference rules, on a board where a dangling reference is invisible.

Rejected for the record: an edge table is the right shape at a thousand ideas
across several workspaces, where the board grows a real graph view. That board
does not exist yet, and the row layout converts to a table without a migration
(it is the same data, read differently).

### Direction: `blocks` is stored, `blockedBy` is derived

**Chosen: one stored direction per kind. `blockedBy` is computed at read time
by `ideaBlockedBy`.**

The rejected alternative is storing `blockedBy` on the blocked row as its own
key. It was rejected because `X.blockedBy = [Y]` and `Y.blocks = [X]` would be
two independent facts about one edge, with no shared invariant and nothing able
to tell which is the truth. Every verb would then have to write both sides, and
`merge` / `delete` would have to reconcile both or leave the graph disagreeing
with itself — a drift nobody would notice until a card printed "blocked by an
idea that does not know it is blocking".

The precedent is `followUpOfId`: the lineage marker is stored on the child alone
and both directions are presented. That is the whole rule here.

The presentation is what makes the decision worth anything, so the two
spellings are actually shown: a card prints `→ #31` next to *Waits for* and
`← #7` next to *Waiting for this idea*, and the editor's third line is the
derived one — **read-only**, with the declaring card named. It is read-only
because "removing" an incoming edge would mean writing a patch to a row the
human never opened, and a verb whose name does not tell you which card it edits
is worse than one that says "open that card".

`relatesTo` is symmetric by MEANING and stored symmetrically: writing
`A.relatesTo = [B]` also writes `B.relatesTo = [A]` in the same commit
(`applyRelationPatch`). The rejected alternative was storing it in one direction
and deriving the inverse like `blockedBy`. That was rejected because "these two
are adjacent" is one sentence about two ideas: a human who typed it once would
have to find the other card to type it again, and the two spellings would then be
two edges. There is still exactly one KIND and one key per endpoint — no second
spelling exists anywhere, which is the property the direction rule is about. The
cost is that the symmetry is an invariant the ledger must maintain, and
`reconcileRelations` re-imposes it wherever a document is repaired.

A consequence worth stating because it is visible: **a merged duplicate keeps its
own lists.** Its edges still name the survivor, so the survivor shows the
archived duplicate as related, and restoring the duplicate is lossless. Clearing
them would make the graph tidier and a restore lossy.

### A cycle is refused on write, with its chain

`blocks` is the one relation where a cycle is expressible and meaningless
("A waits for B" and "B waits for A" states nothing). `update` runs
`blockCyclePath` against the graph **with this row's own list removed** — an edge
can only close a loop by being added, never by being dropped — and throws with
the path it found: `this would close a cycle: #1 "Alpha" → #2 "Beta" → #3
"Gamma"`. The alternative, detecting at render time, is exactly the failure this
refusal exists to prevent: a graph that renders fine and means nothing.

`relatesTo` has no cycle rule, because an undirected adjacency cycle is not a
defect.

The **merge** cannot refuse: it is a reconciliation, not a new statement, and
refusing it would leave a duplicate unmergeable because of the shape of its
neighbourhood. So `reconcileRelations` drops the edge that would close a loop,
in document order (deterministic), and the merge appends the count to the loser's
decision note — "1 relation edge could not follow the merge". A refusal with a
destination would need the human to unlink by hand first; a reported drop is
one re-add away from correct.

### `delete` drops the edge; it does not tombstone it

A deleted idea's id is stripped from every remaining row's `relatesTo` and
`blocks` in the same commit. The rejected alternative is a tombstone — keeping
the id so the statement survives. A tombstone was rejected because it keeps a
deleted idea's number alive in every surviving card and in every export, pointing
at nothing a reader can open, with no way to distinguish "blocked by something
deleted" from "blocked by something you forgot". **Merge re-points where delete
drops** — one removes an idea, the other reconciles two into one — and that
asymmetry is the whole argument.

### The invariants, and where they are re-imposed

`reconcileRelations` (host-ledger) runs wherever a document is READ rather than
written by a verb — at boot (`normalizeParsedDocument`), on a restore, and after
an `import` merge — and re-imposes, in order: no self edge, no dangling target,
symmetric `relatesTo`, acyclic `blocks`. Every verb already keeps them, so in
practice it only touches a hand-edited or imported document, which is exactly the
case that must not be able to leave the board drawing a broken graph. It returns
the number of edges it dropped, which is what the merge note reports.

### Where relations ride the wire

**On the `update` patch: `relatesTo?: string[] | null` and
`blocks?: string[] | null`, with the same contract as `tags`** — absent leaves
the list alone, an array replaces it, `null` (or an empty array) clears it. No
new verb and no new envelope key; `parseActionEnvelope` still demands exactly
`{requestId, action, initiator}`. A new verb was not needed and would have been
wrong: the envelope is the frozen surface, and a relation is exactly the shape of
an edit.

`create` deliberately takes **no** relations. A brand-new idea has no id yet, so
its targets may not exist, and a capture that half-succeeds is worse than a
capture followed by an `update`. An agent writes `create` then `update`.

`blockedBy` is refused at the wire gate, which is the mechanical guarantee behind
the direction rule: there is no code path that can write the inverse.

**The mirror is skipped for a relations-only patch** (`mirrorKindOf` in
host-service). A card does not show an idea's relations, so a relations-only
edit must not spend a mirror round trip — and must not unfreeze, by attempting a
content patch, a card that has already run.

### What a poll pays for

`relatesTo` and `blocks` are in `IDEAS_READ_SELECTABLE_FIELDS` and in
`SUMMARY_READ_FIELDS`, so `view=summary` carries them by default; `view=detail`
inherits them (it is every field except `body`), and `?view=list` carries them
because they are record fields. They are **reference-shaped** — a few dozen bytes
of ids on the rows that have an edge, zero on the rows that do not — and unlike
`events` a bounded reader cannot answer "what does this wait on?" without them.
`blockedBy` costs nothing anywhere: it is derived from the `blocks` lists a
reader already has.

The card line is derived ONCE per paint by `relationIndexOf`, not per card: a
naive per-card `relationViews` rebuilds the row map and rescans the board once
per card, which is O(rows²) on every poll. Measured on the 140-card perf fixture
(which carries no relation), the feature adds **zero DOM nodes** and no
measurable time — `RelationChips` returns `null` for an idea with no edge, and
the index is a single pass.

**Three surfaces, one index.** The Overview card, the Priorities row and the
Delivered row all print the same line, because two of them already print the
labels beside them and a reader who sees `core` on a ranked row would read its
absence of links as "this idea has none". The index is built by the board and
passed down as the `relations` prop rather than recomputed by each view, for a
reason that is not only performance: **both list views receive SCOPED rows**
(Priorities the open rows of the current scope, Delivered the archived ones), so
neither can resolve a `#N` on its own — an edge to a card outside the current
filter would print a bare id. The board already holds the whole snapshot, and
only the active tab is mounted, so handing the index down costs one pass.

## Default launch model per workspace (idea #107)

One `provider/model` per workspace, stored as a **display/launch preference**
(`IdeasSettingsValue.launchModelByWorkspace`, a flat
`workspaceId -> provider/model` map) and resolved **on the Host** at launch
time. The value of the feature is a removed repetition, not a removed
obstacle, so every decision below is deliberately the smallest one that cannot
lie.

### The fallback order, written down because both halves depend on it

1. **The run's explicit choice.** What `POST /api/ideas/launch` pinned. A blank
   string is NO choice, not "pin the empty string": `parseLaunchBody` already
   drops it and `launchIdea` trims it again, so the order holds for a browser,
   an agent tool and an in-process caller alike.
2. **The workspace's default** — `IdeasHostService.workspaceLaunchModel`.
3. **Whatever the chosen backend defaults to.** This is the pre-#107
   behaviour, so a deployment that never used the feature posts exactly the
   wire it posted before (`tests/idea-107-launch-model.test.ts` asserts the
   bare `run`, not merely "no crash").

### Resolved once, before the backend branch

`launchIdea` computes the target inside the mirror chain, **before** choosing
between the card and the session, and passes that one string to both:

```ts
const explicit = model?.trim()
const target = explicit === undefined || explicit === '' ? this.workspaceLaunchModel(fresh) : explicit
if (!viaCard) return await this.launchInSession(fresh, target)
try { const taskId = await this.mirror!.launchTask(fresh, target) … }
catch (error) { … return await this.launchInSession(fresh, target) }
```

This is the load-bearing part of the whole feature. The two backends take a
model by completely different routes — a **model-only task patch** then `run`
on the card, `selectModel` on a fresh session — and a fallback resolved inside
either branch would be a fallback one backend silently does not honour. The
third call site (the card-unavailable catch) matters for the same reason: a
backend fallback must not change the model.

### A dead model fails loudly, and never quietly retries

A stored target that no longer resolves is **not** validated here. Both
backends already refuse one, visibly — the task-board answers the patch with
its own `unknown model`, the session backend answers `session run failed: …`
off the rejected `selectModel` — and the launch route relays that sentence to
the modal. Adding a pre-flight check, or retrying without the model, would
turn an actionable refusal into a run on a model nobody chose. The only thing
that was added is a test on both backends asserting no second attempt is made.

### Where it is stored, and the two alternatives that were rejected

The service reads it through **one** settings seam: `setSettingsReader(() =>
IdeasSettingsValue | undefined)`, the late-bound reader `src/index.ts` binds to
the config port. It replaced a narrower `setRunPermission(() => string)`, which
existed to carry the direct-launch permission alone; with two launch preferences
in play, one reader of the whole value is the shape that cannot drift (and
`tests/idea-107-launch-model.test.ts` guards BOTH consumers, the permission
included — it is the pre-existing behaviour this seam had to keep).

- **Rejected: a field on `IdeaRecord`.** The board's background poll adopts
  whatever the Host serves, so a per-idea copy would be written straight back
  over the choice the human just made — the same reason `openOrdering` and the
  multi-select are view state. It would also put a profile preference in the
  portable ledger document.
- **Rejected: a new route family, like the backup tab.** The setting needs the
  revision fence both settings generations already provide, and it is one more
  field on a value the config route already round-trips.
- **Chosen: the settings document.** Consequence, stated because it is a real
  trade-off: **the default does not travel with an exported board**, exactly
  like `language`, `cardDensity` and every other panel option — those are
  per-profile preferences, and the JSON document stays the ledger. `import`
  and `export` therefore round-trip nothing new *because nothing new was added
  to the ledger*, which is asserted rather than assumed.

The schema field needed one build-level fix: `z.dict` types its result with
cosmokit's `Dict`, a transitive package, so an inferred type naming it cannot
be written to `lib/types` (TS2742 degrades it to a `.pnpm/…` path). The one
leaking field is pinned (`launchModelByWorkspaceSchema: Schemastery<any, any>`)
so the enclosing object's inferred type stays both precise and portable.

### One map, replaced whole, fenced by the revision

`parseSettingsBody` **replaces** the map instead of merging into it, and
refuses `null` rather than reading it as "clear this one". Both halves are
deliberate: the legacy namespace port applies a patch by shallow overwrite, so a
merge would have to be re-implemented per host generation to keep the two
behaving identically, and a whole-map replace is the one thing both can do
unchanged. The revision fence is what makes it safe — a client holding a stale
map is refused (409) rather than allowed to drop another workspace's default.
The client always sends the map it holds (`withWorkspaceLaunchModel` /
`withoutWorkspaceLaunchModel`, pure and unit-tested), so the replace is lossless
for the only writer that exists.

### The modal is the surface, and it asks nothing

The rejected alternative is a settings row with its own workspace picker: it
would make the launch modal the odd one out, and it would ask about models on a
surface that has to guess which workspace it means. The launch modal is already
the place the choice is made, and it is reachable from every tab.

- **A default is NAMED, not picked.** The modal hides the picker and shows the
  model, so the confirmation stays a confirmation.
- **The request then pins nothing.** The modal deliberately sends `model:
  undefined` rather than re-sending the id it just displayed: the Host resolves
  the same default from the same document one step later, and re-sending would
  claim a choice nobody made. An agent-launched run, or a run from a browser
  that never opened the modal, therefore lands on an identical model.
- **Change… defers the picker rather than deleting it**, preselected with the
  current default, so one run can override the workspace without editing what
  every later run uses.
- **Forget is offered even without a model catalog.** It needs no picker, and a
  default nobody can remove is a setting nobody can undo from the surface that
  owns it.
- A target the catalog does not know is displayed **as stored**. Showing some
  other row would be a lie, and hiding it would make the run unexplainable.

### What a workspace that no longer exists holds

It keeps its default, and nothing prunes the map. The map is keyed by a stable
workspace id, and a workspace the Host has forgotten is not a reason to forget
a preference — re-creating it, or re-homing an idea back into it, restores the
behaviour instead of silently running on something new. The only way the entry
disappears is the **Forget** gesture. An idea in a workspace with no entry
resolves to step 3, which is why deleting every idea of a workspace changes
nothing about the setting.

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

## Undo (idea #111)

`client/undo.ts` is the inverse of the board's own actions, and it is a **pure
module**: plain-data plans, array stack helpers, and a keyboard predicate. It
imports nothing from React and touches no DOM, so every rule is unit-testable
without mounting the board — the same discipline `bulk.ts` set.

### The inverse is the ordinary verb vocabulary, not a new verb

An entry's `steps` **are** `BulkStep`s, so an undo posts `restore` / `update` /
`move` / `triage` through `IdeasClient` exactly as the forward action did. The
frozen `POST /api/ideas/action` envelope gains nothing, the ledger is never
written directly, and an undo is indistinguishable in the activity log from a
human having done it by hand. `BulkStep` grew a `triage` variant and a wider
`move.status` for this: the bulk planners never emit either, but one step type
now covers every write the board makes, forward or backward.

Two consequences of routing the inverse back through `run()` — both are risks
closed by construction rather than by new code:

- **A fresh `requestId` per post.** The Host caches by `requestId`, so a replayed
  identifier is a silent success that never executes. `undoStepRunner` calls the
  ordinary client verbs, which reach `transport.action()`, and that mints a
  `uuid()` per call (`host-api.ts:213`). An undo of a sixty-idea batch therefore
  cannot inherit a previous action's identity.
- **No capture of the undo's own posts.** `run()` captures before every post,
  including the ones an undo makes, which would make the second Ctrl+Z put the
  change straight back. The `undoing` flag suppresses it for the duration.

`updateSteps` was exported from `bulk.ts` rather than reimplemented — the mirror
round trip is the rule an undo needs just as much as a bulk run, because an
archived, card-bound idea is read-only for every verb. An undo of a label change
on such an idea replays `restore` → `update` → `archive`; a bare `update` would
move the idea while its card silently kept the old labels. `planUndo` re-decides
that rule at undo time rather than trusting what each verb decided while the idea
was passing through the archive on its way in (see the guard section below).

### The previous value exists at exactly one moment

`update` **replaces**, so the previous title / body / label set cannot be
reconstructed from the ledger after the fact. The client can only read it *before*
the post, from the snapshot it holds — and, for a body, from the `fullRecords`
cache, because the list projection drops `body`, `analysisAudit` and `events`
(`toListRow`). That makes `IdeasClient.run()` the one place that can capture
anything, and it is the goulet every client verb already passes through
(`updateIdea`, `moveIdea`, `triageIdea`, … all delegate to it).

The capture is split around the post on purpose:

1. **before** — build the inverse from the pre-action row (and the pre-action
   cached record);
2. **after, and only on success** — push it, seeding the drift guard from the
   snapshot the action itself returned.

A refused action changed nothing, so it produces no entry: an undo button for an
action that never landed would be a lie. Step 2 also explains why a triage's
expectation can only come from the Host's answer — the re-rank moves a whole
workspace group, so the resulting rank is not derivable from the patch.

### Absence IS the guarantee

`invertAction` answers `undefined` whenever the inverse cannot be expressed in
ordinary verbs, and `undefined` means no entry, which means no button. The cases
are deliberate, not gaps:

| case | why no entry |
|---|---|
| `decline`, `deliver` | no verb erases `decision` / `deliveredAt`; a `restore` would bring back a card still stamped as delivered |
| `delete`, `merge`, `followUp` | out of scope by design (delete leaves no trace, merge is atomic, followUp archives the parent and creates the child in one commit) |
| `reanalyze`, `reorder`, `create` | a ledger-wide rewrite, a whole-list ordering, and a row that had no "before" |
| `value` / `effort` that did not exist | the wire patch sets a score but has **no way to clear one**, so an opinion that was never there cannot be taken away |
| `rank` that did not exist | likewise: the re-rank is transactional and an unranked idea has no position to return to |
| a `body` whose full record is not cached | nothing to restore — and a *stale* cached record (`full.updatedAt !== row.updatedAt`) is refused rather than trusted, since it would put an older draft over a newer edit |

`restore` is deliberately **not** used as a generic inverse: it forces `open` and
clears `archivedAt` alone, so it would drop an idea from Under review into Open
and resurrect a delivery. The inverse of a column move is a `move` back to the
previous column.

Redo is out of scope on purpose. The inverse of a mis-typed tag is a safety; the
inverse of an archive is a "do it again" button; and redoing a destructive batch
without the confirmation its original click carried is a new source of error, not
a comfort.

### Batches, because "undo" has to mean an action a human recognises

A bulk tag of sixty ideas is sixty `update` posts. Without grouping, the stack
would hold sixty entries and one Ctrl+Z would reverse one card. `beginUndoBatch` /
`endUndoBatch` bind every verb posted inside them into one entry under the label
the human saw; the bulk dialog opens one per run, and the open-idea editor opens
one around its `update` + `triage` save so a single Ctrl+Z restores the card
rather than half of it. Batches do not nest, and a batch that changed nothing
pushes no entry.

The bulk dialog keeps its own restore button for a bulk archive — it reports the
per-idea outcome better than the generic row can — and calls `discardUndoBatch`
afterwards, so the same action is never reversible twice and a second press
cannot undo the first undo.

### The drift guard, and why it protects narrow fields

Each entry records what the action actually wrote for **the fields its inverse is
about to overwrite**, read off the row the action left behind. At undo time those
fields are compared against the current row; a mismatch refuses that idea, names
the field, and **still undoes the rest of the batch**. One card an agent touched
must not leave the other fifty-nine of a bulk tag standing.

The unit of an undo is the **idea**, not the captured verb, and three details of
`planUndo` follow from that:

- **The guards of an idea's verbs are merged per field, the last write winning.**
  A mirrored tag change is three verbs (`restore` -> `update` -> `archive`) and
  so three captures; at undo time the row holds the result of the LAST write to
  each field, not the state it passed through in between. Guarding each verb on
  the snapshot its own post returned refuses the very batch the feature exists to
  reverse — the `restore` guard reads `status: 'open'` while the row has been
  archived ever since. (This was the first real bug, caught by the test that
  replays a three-verb chain and expects no refusal.)
- **A plan that already round-tripped is replayed verbatim.** Its trailing
  `archive` is what puts the idea back where the forward action found it, so
  pruning it as "already archived" would leave the idea in Open.
- **At most one captured column step survives, the first.** Per-verb column
  inverses do not compose: that same chain captures `move archived` for its
  `restore` and `move open` for its `archive`, and replayed in order the second
  lands last and leaves the idea in the column the action started from. The
  first one asks for that column, so it wins and the rest — states the action
  itself passed through — are dropped. Every other `update` step is re-derived
  through `updateSteps`, the one function that owns the mirror rule, which is
  what keeps the mirrored card and the idea in agreement.

Two more details are load-bearing:

- **The expectation is read from `after`, never from the inverse's own values.**
  A `move` back to `open` is guarded on the row still being `archived`; taking the
  expectation from the plan would make the guard compare the card against itself
  and always pass. (A second real bug, caught by the test that asserts a move's
  guard is `status: 'archived'`.)
- **The guard is narrow on purpose.** An unrelated commit — a launch settle, a
  task-status observation — must not make a perfectly reversible label edit
  un-undoable. The one exception is a body, which the list row cannot hold: an
  update that touched one is guarded on the row's whole `updatedAt` stamp, the
  only signal a body edit leaves in the projection.

The entry is dropped **before** the run, never after: an undo that refused
everything will never succeed on a retry, and one that half-landed is exactly the
state the human must see and decide about.

### Why the receipt, and not `client.error`

The spec points the drift refusal at the existing error bar
(`ideas-client.ts:925`), and that was the first implementation. It is the wrong
widget, for two reasons that are worth stating rather than rediscovering:

- **The error bar is framed as a Host failure.** It renders
  `t('board.hostError', { error })` and offers a **Retry Host** button. A card
  that moved between the click and the Ctrl+Z is not a Host failure, and a
  "Retry Host" button is an action that cannot fix it — it would teach the
  reader that the button is noise, which is the exact failure mode the risk
  section warns about ("otherwise the reader thinks undo is broken").
- **The error bar cannot carry a batch failure anyway.** `run()` sets
  `this.error = undefined` on every success, so a step refused in the middle of
  a ten-idea undo is erased by the nine that follow it.

So the receipt carries both refusals and failures, with the reason, and it does
not time out — an undo whose result nobody saw is an undo they press twice.
`client.error` still does its real job: a genuine transport failure is a Host
error and belongs there.

The failure state is a state of its own (`data-dsh-ideas-undo-result="failed"`),
not a flavour of "partial": "undone on 9 of 10, 1 unchanged" and "undone on 9 of
10, 1 failed to post" are different problems with different fixes, and collapsing
them would let a reader believe a card was put back when it was not. A failed
round trip that left an idea **open** also carries the runner's compensation
note, which is the one case where the idea is now in a column nobody chose.

Every count the reader sees is an **idea** count (`undoIdeaCount`), never an item
count: a mirrored chain is captured three times, so an item count would tell the
reader a one-card undo had put three cards back.

### The shortcut, and the filter that is not optional

The board registers `keydown` in the **capture** phase (the model already exists
for `Escape`). That means the handler runs *before* the browser's own undo on a
focused field, so `shouldHandleUndo` refuses `input` / `textarea` / `select` /
`contenteditable` targets — otherwise a single Ctrl+Z in the markdown editor
would rewrite the ledger instead of the text the caret was in, which is the worst
possible victim for a global shortcut.

It also refuses an **empty stack without calling `preventDefault`**: a board that
has nothing to undo must leave the page's native undo working. `Ctrl+Shift+Z` is
deliberately not bound, since that chord is redo everywhere and this board has
no redo. The predicate is structural (`tagName` / `isContentEditable`, never
`instanceof`), so it runs in a test process with no DOM globals.

### Session-local, on purpose

The stack is **memory only**: bounded at 20 entries, expiring after 30 minutes,
gone on reload, and never written to the ledger or sent to the Host. The honest
promise is therefore "undo the last action of this session", never "undo
anything" — so the UI says exactly that, and the bulk report carries the line
naming what undo does **not** cover (delete, merge, follow-up, decline,
delivery).

Nothing here touches the backup surface: no persisted field on `IdeaRecord` was
added, `KNOWN_IDEA_FIELDS` and the two `idea-95` backup tests are unchanged, and
`IDEAS_SCHEMA_VERSION` stays 1. A persisted journal (an `UndoAudit` bounded field
in the shape of `AnalysisAudit`) is the deferred follow-up that would let undo
survive a reload and cover agent writes.

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
  only a human may confirm that binding. The modal now deep-links to **our own**
  card for that idea (`Show the card`, by its `#N`) and opens the TaskBoard panel
  through the shell's layout face. It used to be `client/taskboard-focus.ts`, which
  typed the idea title into that board's filter field through the native value
  setter and a bubbling `input` event — DOM surgery on a third-party React tree,
  for a board that publishes no service to call instead (verified on the installed
  0.4.4). See *Deep-link to an idea* below for the decision and its cost. The
  plugin never confirms a permission itself: `run` is the only launch verb it posts.
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

The **Backup** tab is deliberately outside that dual-path: it needs no settings
port at all (see *Snapshots, restore and portable transfer* above), which is
what keeps snapshots available on a deployment that has neither settings
contract.

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
