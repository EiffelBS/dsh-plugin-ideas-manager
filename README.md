# dsh-plugin-ideas-manager

**The Ideas manager** brings an idea backlog straight into the DSH Web GUI. It's
a generic, self-contained backlog: an AI agent captures ideas, each one becomes a
card on a kanban, gets scored and ranked, flows through a lifecycle, and can be
**run as a real execution** with one click. It also bridges to the
[TaskBoard plugin](#taskboard-integration)
([`@linxin666/dsh-client-ui-task-board`](https://www.npmjs.com/package/@linxin666/dsh-client-ui-task-board),
by linxin666 — third-party, not affiliated) when present.

A Host-authoritative `/api/ideas` ledger keeps everything consistent and lets an
agent write cards directly over HTTP — no UI needed. Fully usable without
TaskBoard: **zero hard dependency** on it.

![Ideas manager board](./assets/ideas-manager.png)

---

## What it does for you

### Capture ideas, anywhere
- A **panel row** beside Task Board and Plugins (under New Session) opens the
  board, and switching to another panel closes it like every other one.
- **Capture** an idea with the *New idea* button or the **quick-add** row at the
  top of the Open column — a Title is the only required field.
- Optional description (markdown), **tags**, workspace and a **Suggested rank**.
- The **AI capture** button opens a session that analyzes the draft,
  creates/merges the idea in the backlog, and reports the retained ranking.
- **Find similar** (on an open idea, next to *Re-analyze*) asks whether the idea
  duplicates something you already have: the board lists the open ideas of the
  same workspace whose title and tags look close, and an analyst session then
  reads their real content and rules on each one — duplicate, related but
  distinct, or unrelated. The score it shows is a rough signal the session is
  told to distrust, and the action never merges anything: it recommends, you
  decide.

### A 4-column kanban
Open · Under review · Archived · Declined.
- **Drag & drop** moves cards between columns and reorders them; the columns
  auto-scroll when you drag toward an edge.
- **Search** and a **conjunctive tag filter** narrow the whole board — the Overview columns, the Priorities ranking and the Delivered log all share both filters. The **Health** tab is the exception: it is one figure per question, not a list, so it has nothing to narrow and says which workspace it covers.
- Click a card title or its description to open the **editor** (raw text or
  rendered markdown). It edits the whole body, fetched on demand, and is titled
  with the card number it is editing.
- Every card shows its stable **`#N` number**, **workspace chip**, **tags**,
  **value/effort badges** and update date.

### Scoring & ranking
- Each idea carries **Value** and **Effort** (low / medium / high), shown as
  color-coded badges.
- The **Suggested rank** is the position in the *open backlog of its workspace*;
  entering one re-ranks that backlog (existing rows shift).
- A dedicated **Priorities** tab ranks the open ideas per workspace, with ↑/↓
  buttons and drag & drop to re-rank.

### The lifecycle
- **Deliver** ✓ archives the idea with a green *Delivered {date}* stamp.
- **Under review** is the review gate: finished work lands there, and each card
  offers **Approve** (deliver), **Follow-up needed** (creates a linked open child
  plus a justification, archives the parent) and **Decline**.
- A **Task failed** badge marks an idea whose execution failed. It deliberately
  **stays in the backlog** — a failed run delivered nothing, so there is nothing
  to review — and you retry or adjust the idea. The badge follows the last status
  observed and clears itself when the task is retried.
- A quiet **Stale** badge marks an **open** idea nobody has updated for a while,
  on the Overview cards and in the Priorities list. Set *Stale after (days)* in
  the settings (30 by default, 0 turns it off). It is a display aid only: it is
  drawn when the board paints, nothing is written to your ideas, and it never
  appears on an idea already under review, delivered or declined.
- The **sidebar** icon carries a small amber count of how many ideas are waiting
  in **Under review**, for the current workspace scope. It reads the list the page
  already has, and vanishes when the gate is empty.
- The **Delivered** tab shows the exit log (delivered vs. manually archived).
- Restore, archive and delete are one click away on each card.

### Is this backlog healthy?
A fourth tab, **Health**, answers five questions about the workspace you are
looking at — and answers them **on the host**, in one small read the board asks
for on its own. Your background refresh is not slowed by it, and the figures are
never re-counted in the browser.

- **How much is open**, and how that splits across workspaces.
- **How many were delivered this month.** The label names the month it
  measured — a calendar month on your machine's clock, not a vague "recently".
- **The median time to deliver.** This one is deliberately cautious. Only ideas
  that were really **delivered** count: an idea you dragged straight to Archived
  closed without delivering anything, so there is no honest lead time to take
  from it. Until there are **five** real deliveries the tab says *Not enough
  deliveries yet (n / 5)* — with the count it has — instead of printing a
  confident number computed from one or two rows. When a backlog is mostly
  dragged away rather than delivered, the tab also tells you how many ideas left
  it without a delivery stamp: that count is the reason a median may be missing,
  and it is the honest answer rather than a zero.
- **Your most used labels** on the open backlog.
- **What is waiting to be triaged**: how many open ideas carry no rank, and how
  many carry no value. It is work to do, not a score — nothing here judges an
  idea or the person who wrote it.

The workspace selector scopes all of it, exactly like the other tabs, and the
figures follow your panel language. Nothing here is stored anywhere: closing the
tab forgets it, and the next visit re-reads the host.

The board refreshes and the Health tab refreshes on their own clock, so there is
a moment where the figures describe a board that has just moved. The tab tells
you: a quiet line under the numbers names the revision they came from and
whether a refresh is on its way — or failed. You are never left reading stale
figures as if they were current.

### Run an idea
An open idea that has a **workspace** and no run in flight offers a
**Launch execution** button — on the card, and in the editor. The editor matters:
it is the surface you reach from the Priorities and Delivered tabs, so you never
have to hunt the card back in the Overview to start a run.

1. Click **Launch execution**, pick a model (or keep the session default) and
   confirm. DSH tells you which of the two ways it will run before you commit.
2. **With the TaskBoard plugin installed**, the run goes through that idea's
   board card. **Without it**, DSH opens a brand-new chat session in the idea's
   workspace instead. Either way you get a real execution, and the board needs no
   extra plugin for the feature to work.
3. The run happens in the **background**: closing the tab, or restarting the web
   instance, does not lose it and DSH keeps watching it for you.
4. While it runs, the card shows a blue **Running** pill and an
   **Open session** link — one click lands you in the execution, which is the
   only way to watch a session DSH started on your behalf. The same pills now
   ride the **Priorities** and **Delivered** rows too, in the row's top-right
   corner exactly like on the card, so the "is this one already being worked
   on?" answer is available on the list you actually read, without opening the
   card.
5. When it finishes, the idea moves to **Under review** for your verdict. If it
   failed, it stays in the backlog behind the **Task failed** badge.
6. The card shows what the run **delivered**: the closing words of the run, kept
   under the description, above the verdict buttons in the editor, and on the
   row in the *Delivered* list. It is the run's own last answer, not a summary
   written for you — and when a run leaves nothing behind, the note says so
   instead of showing an empty box. **Open session** still remains the way to
   watch the whole thing; the note is the short version for deciding.

A run takes a while, and the board reflects the result within roughly half a
minute of the session finishing.

> A direct session inherits your normal DSH permissions. TaskBoard's own run
> options (such as a confirmation prompt) are not applied to it.

### An idea remembers what happened to it
Every idea keeps a short **activity log** — who did what, and when — and the
editor shows it as a compact timeline under the description, right above the
verdict buttons.

- It is written by the board itself: the capture, the rank and score changes,
  the launch, the run that finished (or failed), the approval, the follow-up,
  the decline with its reason. Entries name their author — **you**, an agent,
  or the run itself — so a month-old decision is still attributable.
- It keeps the **last 50 entries** and nothing more. An older idea simply shows
  the tail of its life, and an idea that has recorded nothing yet shows nothing
  at all rather than an empty box.
- It travels with the idea: the JSON export/import carries it, and the markdown
  export prints it as a short **Activity** block, so an archived document can
  still answer *why was this declined?*.
- It also feeds **Re-analyze**. When you ask for a fresh analysis, the analyst
  is handed what actually happened to this idea before, so it re-reads the real
  history instead of re-proposing something already refused.

### Merging duplicates
Two captures can describe the same work. When that happens, one **merge** folds
the duplicate into the idea that survives.

- The surviving card keeps its **title, its analysis and its position** in the
  backlog. A duplicate contributes only what it has that the survivor lacks:
  its **tags**, its **relations** (see below), and its place in a follow-up
  chain — the survivor inherits that link, and any follow-up that hung off the
  duplicate now points at the survivor instead.
- The duplicate is **archived** with a note naming the card it was merged into,
  so the reason is still there long after the backlog moved on. Both ideas record
  it in their activity log.
- It is **one commit**: there is never a moment where both cards are open.
- **Different workspaces are refused** with a reason. Merging across projects
  would quietly move work between them, which is your call to make explicitly.
- Whether the survivor takes the duplicate's rank or keeps its own is chosen per
  merge.
- A merge **never touches a running execution or a bound task card**. If you want
  the duplicate's analysis rather than the survivor's, that is a different thing
  to ask for.

You do not have to trigger a merge by hand. The **Find similar** action finds the
candidates and asks the analyst to rule on them; the AI capture flow merges a
duplicate on its own when it judges one. Both are reversible: a merged card can be
restored from the archive like any other.

### Relate ideas to each other
A backlog of a hundred ideas is a list, and a list does not need edges — until
you know that two of them are the same subject, or that one cannot land before
another. An idea can now carry two kinds of link, and both of them are things
**you** state:

- **Related to** — "this is adjacent to that, go and read the other one".
- **Waits for** — "this cannot land before that one". The other card shows the
  same edge from its side, as **Waiting for this idea**.

- You add and remove them in the **editor**, under **Relations**: pick an idea
  from a list, or press the **×** on a chip. The **Overview card** and the
  **Priorities** and **Delivered** rows all print their links as a quiet line of
  `↔ #12`, `→ #31`, `← #7` — the arrow is the direction, so the links read on
  the row itself, and nothing is printed at all for an idea that has none.
- **You only declare a link once.** *Related to* is one statement about two
  ideas, so it is true from both sides and cannot disagree with itself. *Waits
  for* is stored on the card that waits, and the *Waiting for this idea* line on
  the other card is that same edge seen from there — which is why it is
  read-only: to remove it, open the card that declares it, and the editor names
  which card that is.
- **A wait that loops is refused.** "A waits for B" and "B waits for A" says
  nothing, so the board will not save it and names the whole chain
  (`#1 → #2 → #3`). The loop is caught when you write it, not when the graph is
  drawn.
- **Links follow the lifecycle.** Deleting an idea takes its links with it rather
  than leaving a reference to nothing. **Merging** a duplicate re-points them at
  the surviving idea — exactly like the duplicate's follow-ups — and the
  survivor inherits the links the duplicate stated. The archived duplicate keeps
  its own, so restoring it is lossless.
- They **travel with the board**: the JSON export/import carries them, and a
  snapshot or a restore brings them back with everything else.
- **They are never guessed at.** The score of *Find similar* is a computed
  signal; a relation is not. Nothing here is inferred from titles, tags or
  content — only you add one.

### Workspaces
- A header selector scopes the board to one workspace (or *all* / *none*).
- New ideas default to the **current session's workspace** when not scoped.
- The New/Edit modal carries a workspace field, so a capture lands in the right
  place and an idea can be moved to another workspace.

### Go straight to an idea
The board header carries a small **Go to idea** box: type an idea's number
(`#42`) and it opens that card, scrolls it into view and rings it — even when
the board was closed, and even when the card belongs to another workspace or is
archived. That is the point: **the number is the reference**, so a conversation
that ends with "see idea #42" ends with one click on it.

- It always finds the card. The search box, the tag filter and the workspace
  selector are cleared whenever they would hide it, and the board switches to
  the scope the idea actually lives in — the search box visibly emptying is the
  explanation.
- **A reference that matches nothing says so**, instead of leaving you wondering
  whether the board heard the request.
- The number is the durable reference. An internal idea id also works, but only
  on this board: a board moved to another machine keeps its `#N` numbers, not
  its ids. So always quote the number.

### Many ideas at once
- Every card — and every row of the Priorities and Delivered tabs — carries a
  **select box**. Click it to pick one idea, **shift-click** to paint a range of
  rows, or press **Select all** to take everything the current filter shows.
- The bar above the board always states the truth: **how many are selected, out
  of how many the filter shows, and which workspace, tags and search produced
  that set**. "All" therefore never means a batch of ideas you cannot see.
- The selection follows the filter: an idea that leaves it leaves the selection,
  so a bulk action can never reach a row you are not looking at. It is a view
  only — nothing about it is written to your ideas.
- Three bulk actions, all reporting **idea by idea**:
  - **Tag…** adds labels to the selection. The labels an idea already carries
    are kept, and an idea with no room left is reported rather than quietly
    losing the new label.
  - **Move to workspace…** re-homes the selection. Workspaces are chosen by their
    stable identity, so renaming one moves nothing.
  - **Archive…** moves the selection to the Archived column. Declined ideas are
    left untouched and reported, because archiving one would erase its decline.
- Every batch ends with a report: what was applied, what was skipped and why,
  and what failed with the reason — a partial failure is always visible per
  idea, never as one blanket error.
- **A bulk archive can be undone.** Its report offers to restore exactly the
  ideas it archived. This is scoped on purpose to the reversible operation:
  bulk tagging and re-homing carry no previous value, so their report says
  plainly that there is no undo there.

### Keep a copy of your board
Your board is a real file on your machine, so it can be copied, kept and put
back — from the **Backup** tab of the settings section (see
[Settings](#settings)).

- **Take a snapshot** writes a timestamped copy of the **whole** board into your
  ideas backups folder: every idea, its activity log, its scores, its labels,
  its tags' prompt lines, its relations to other ideas, the run it belongs to and
  the task card it is bound to.
  The last **ten** snapshots are kept for you; older ones are removed.
- **Restore** puts one back. It asks first, it says exactly what it is
  replacing, and the board it replaces is **kept as its own snapshot** — so a
  restore is never a one-way door, and the panel names the snapshot you can go
  back to.
- **A restore is refused while an execution is running**, and the panel says so
  before you click: wait for the run, then restore. Your board is left exactly
  as it is.
- **A file that cannot be read is refused, never half-imported.** A snapshot
  that is not a ledger, that was written by another version of the plugin, or
  that holds a record the board cannot read is rejected **with the reason**,
  moved aside for evidence, and nothing on your board changes.

### Move your board to another machine
The same tab **exports the board as one JSON file** and **imports it back**.
This is the supported way to move a ledger between machines — and the way out
of one very common DSH situation:

> **A second Host pointed at the same DSH home refuses to start.** That is
> deliberate: the ledger has exactly one writer, and two Hosts sharing a home
> have already destroyed one. Do not try to share the folder. Take the board with
> you instead — export it here, and import it on the machine that should own it.

An import brings back **every field** the board holds — the activity log, the
run and session stamps, the task-card binding, the analysis audit, the delivery
note, the **relations between ideas**, the ranks and the stable `#N` numbers, so
the next capture on the new machine never re-issues a number. You can also drop an exported file straight
into the backups folder: it shows up in the list and restores from there, and a
file the plugin did not write is never deleted by the retention policy.

The **markdown export** is unchanged and stays what it always was: a generated
view for reading, not a backup.

---

## Settings

The plugin contributes an **Ideas board** section to the DSH Settings modal.
It has three tabs — **Display** (the options below), **Backup** (snapshots,
restore and the portable export, described above) and **About**.

On the **Display** tab:

- **Visible tag-filter lines** (`tagRows`, 1–5, default 3): how many rows of
  tags the board shows under the tabs before the zone scrolls. The sticky header
  (label + search + clear) always stays visible. Applied immediately, stored per
  DSH profile.
- **Interface language** (`language`, default `auto`): the panel's **own**
  language, independent of the DSH shell setting. `auto` follows the shell, and
  `en` / `fr` / `zh` pin the panel to one dictionary. Applied immediately.
  Dictionaries: English (default fallback), French, Simplified Chinese.
- **Open column order** (`openOrdering`, default `createdAt`): the default layout
  of the Overview's Open column. `createdAt` shows the oldest idea first,
  `createdAtDesc` the newest first, and `rank` the ranking you set by hand.
  It is only a *default*: reorder that column by drag and drop and the column
  shows **your** order from then on, until you pick another order here.
- **Show running ideas at the top** (`runningFirst`, on by default): floats the
  ideas whose run is in flight above whichever of the three orders is selected,
  without changing that order. A failed run keeps its red tag but stays where the
  selected order puts it.
- **Direct-launch permission** (`directRunPermission`, default
  `workspace-write`): the level granted to the fresh session when you launch an
  idea that has **no TaskBoard card**. The run brief asks for implementation, so a
  read-only session would only answer with a plan and settle the run having
  written nothing. Card-backed ideas are not affected — a mirrored card carries
  the TaskBoard's own deployment permission (never above it), so launching one
  never asks for a confirmation.
- **Stale after (days)** (`staleAfterDays`, default 30): how long an **open** idea
  may go without an update before it wears the quiet *Stale* badge on its Overview
  card and its Priorities row. `0` turns the marker off. A display setting like the
  others: applied immediately, stored per DSH profile, and nothing is written to
  the ideas themselves.

Both are a **view only** — neither stores anything on its own, so the 2.5 s poll can
never overwrite the ranking you chose, and the move arrows in the Priorities tab still
write the rank you edit there. **Drag & drop is never switched off by them**: you can
always move a card to another column, and you can always reorder the Open column by
hand — a hand-made order takes over the default sort for the session. The
**Priorities** tab always stays on the stored rank — it prints a position number and
its arrows write one rank step.

Deployments without a settings service keep the defaults; the board never depends
on the settings surface — and neither does **Backup**, which keeps working there.
Options are stored per DSH profile and never leave your machine.

---

## TaskBoard integration

When the TaskBoard plugin
([`@linxin666/dsh-client-ui-task-board`](https://www.npmjs.com/package/@linxin666/dsh-client-ui-task-board),
repo: [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web)) is
present, the Ideas manager mirrors its ledger onto TaskBoard's `backlog` so
both tools stay in sync — **one-way** (Ideas → TaskBoard). If TaskBoard is
absent, the Ideas manager simply works standalone.

| Ideas action | TaskBoard mirror |
|---|---|
| Create idea | New card in `backlog`, at the deployment's own permission (never above it) |
| Update idea | Card updated |
| Decline / drag to Archived | Card archived |
| Restore | Card restored |
| Delete | No-op (closing to `done` stays manual) |
| Launch execution | The card runs it — raised to the deployment permission first if it predates it |
| **The run reaches `done`** | Idea auto-moves to **Under review** (the review gate) |

Triage (scores, rationale, rank) is **ideas-only** and is never mirrored — it's a
backlog opinion, not a board state. After a run, the card's content is frozen, so
later edits to the idea no longer replicate to it.

---

## Host compatibility

- **Requires Host >= 0.1.5** (see `dsh.engines.dsh` in `package.json`).
- The settings section, the board and both execution backends work on current
  hosts; older combinations degrade rather than break (for example, a very old
  TaskBoard without a run action simply means runs are started as sessions, or
  no Launch button is offered at all when neither route is available).

---

## Install & update

From npm (recommended):

```sh
dsh plugin --profile web add dsh-plugin-ideas-manager
```

Pinned to a version:

```sh
dsh plugin --profile web add dsh-plugin-ideas-manager@0.7.0
```

From a local checkout (no registry needed):

```sh
dsh plugin --profile web add link:/path/to/dsh-plugin-ideas-manager
```

From a git URL (fallback, pinned to a released tag):

```sh
dsh plugin --profile web add github:EiffelBS/dsh-plugin-ideas-manager#v0.7.0
```

`dsh plugin` runs `pnpm add` in the profile directory, then reconciles
`dsh.profile.bundles`: because this package declares a `dsh.bundle`, it is
auto-appended as a profile layer. Restart the web instance (or open a fresh page
session) for the bundle change to take effect.

Verify installation:

```sh
dsh web --profile web --no-open   # then look for the Ideas entry in the sidebar
```

To pick up a newer revision after a release:

```sh
dsh plugin --profile web add dsh-plugin-ideas-manager@latest
```

then restart the web instance.

Uninstall / disable:

```sh
dsh plugin --profile web remove dsh-plugin-ideas-manager
```

---

## For agents and integrators

**Six agent tools, when your deployment serves them.** Any DSH session can then
work the board directly, with no shell and no hand-built JSON:

| Tool | What it does |
|---|---|
| `ideas_list` | Read a filtered, paginated page of idea metadata |
| `ideas_get` | Read one idea in full, including its activity log |
| `ideas_capture` | Capture an idea with a priority opinion, in one call |
| `ideas_triage` | Record value / effort / rationale / rank on an open idea |
| `ideas_launch` | Start the idea's execution |
| `ideas_review` | Settle the review gate: approve, follow-up, or decline |

They drive the same ledger as the board, so anything a tool writes is on your
board immediately, and it shows up in that idea's activity log as the agent's
work. A call that would be invalid over HTTP is refused the same way. Nothing
lets an agent write a run state or claim a task card.

If your deployment serves no agent-tool registry, the board simply does not
offer them — every feature below still works.

**Or over HTTP.** The board is one HTTP surface away; scripts and agents can
read the state and write ideas without any UI:

| Route | Purpose |
|---|---|
| `GET /api/ideas/state` | Full snapshot of the board |
| `GET /api/ideas/state?view=summary` | Bounded reads: filters, pagination, selected fields, body-byte caps |
| `GET /api/ideas/state?view=summary&similar=<id>` | The same, plus a cheap near-duplicate **flag** for one idea |
| `GET /api/ideas/state?view=stats` | Bounded backlog health: one aggregate, optionally scoped to `workspaceId` |
| `GET /api/ideas/idea?id=<id>` | One complete idea |
| `POST /api/ideas/action` | `create`, `update`, `move`, `decline`, `deliver`, `followUp`, `merge`, `triage`, `restore`, `delete`, `reanalyze`, `reorder`, `import`, `export` |
| `POST /api/ideas/launch` | Start an idea's execution `{ ideaId, model? }` |
| `GET /api/ideas/events` | Server-sent change notifications |
| `GET /api/ideas/backup` | The snapshot folder: `{ ok, dir, retention, snapshots[], running }` |
| `POST /api/ideas/backup` | Take a snapshot now: `{ reason?: 'manual' \| 'export' }` |
| `GET /api/ideas/backup/content?name=<snapshot>` | One snapshot's raw document, as a download |
| `POST /api/ideas/backup/restore` | Adopt a snapshot `{ name }` or an imported document `{ document }` |

Actions are **deduplicated by `requestId`** (fresh id per call). The routes sit
behind a same-origin fence (loopback socket or browser).

The **`merge`** action is `{ sourceId, targetId, mode }`: the source is folded
into the target and archived, and `mode` is `keepTargetRank` or
`takeSourceRank`. The **`similar`** read query is opt-in — it reports which open
ideas of the same workspace look close, and on which signals, and it changes
nothing on disk. The **`view=stats`** read is the bounded backlog-health
aggregate described above: it takes only `workspaceId` (absent = every
workspace, blank = the ideas with no workspace), it is a read that consumes no
`requestId`, and it never appears on the board's background refresh. The
**backup routes** are a separate family, not action verbs:
a snapshot writes a file rather than mutating the ledger, so it never consumes
the `requestId` cache, and a refused restore answers **409** while a run is in
flight, **404** for an unknown snapshot and **400** with the reason in `message`
for a document that cannot be adopted.

- [`SKILL.md`](SKILL.md) — the full wire contract: verb table, read-query
  fields, mirror mapping, PowerShell gotchas.
- [`docs/agent-write-channel.md`](docs/agent-write-channel.md) — the write
  channel in depth, including the launch route.
- [`docs/architecture.md`](docs/architecture.md) — how the plugin is built
  (ledger, mirror, execution backends, performance work).
- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each release.

---

## Development

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest
pnpm run build       # types -> lib/types, bundles -> lib/index.js + lib/client.js
```

The browser half is served at `/plugins/<id>/client.js` (re-resolved per
request); the host half registers the `/api/ideas` routes at boot. Data lives in
`~/.dsh/ideas/ledger-v2.json`, and its snapshots in `~/.dsh/ideas/backups/`.

> **Maintainers:** this README describes what an installed user sees — keep it
> user-facing (no internal issue numbers, no design archaeology) and update it
> with the user-visible changes on every release. Implementation detail belongs
> in `docs/`. The release gesture is: write the `CHANGELOG.md` entry, bump
> `version`, tag — the GitHub Release body is that changelog section, so the two
> always tell the same story.

## License

MIT — see `LICENSE`.
