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
  taskboard-bridge.ts # runtime feature-detect + one-way mirror + the `run` verb
  session-runner.ts   # direct-session backend: Host RPCs + the roster the settle reads
  delivery-note.ts    # last-assistant-message extraction + the card `executions` pointer
  run-prompt.ts       # the execution prompt shared by every launch backend
  session-opener.ts   # the "Open session" jump from a running card
  export-markdown.ts  # unidirectional ledger -> markdown (golden-tested)
  http.ts / loopback.ts / mount-once.ts   # shared discipline
  core/ideas.ts       # IdeaRecord, statuses, run statuses, tag validation, activity log
                      # + the merge helpers and the pure near-duplicate signal
  client/selection.ts    # the multi-select scope: toggle / range / all / prune (pure)
  client/bulk.ts         # bulk plans over the per-idea verbs + the runner + the report
  client/bulk-bar.tsx    # select box, selection bar, bulk dialog and per-idea report
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

## Multi-select and bulk actions (idea #94)

Two pure modules carry every rule, and the React half renders them:
`client/selection.ts` owns the selection, `client/bulk.ts` owns the plans and
the run; `client/bulk-bar.tsx` only paints and posts.

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

### Undo, scoped to the reversible operation

`summarizeBulk` marks a report `reversible` for a bulk archive only, and
`undoableIds` returns exactly the ideas the run **applied** — restoring a skipped
idea would resurrect a row that never moved. Tag and re-home reports render the
explicit "no undo here" line instead of offering a button. This is a batch
restore, deliberately not a general undo system.

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
