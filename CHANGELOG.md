# Changelog

What changed in each release, written for the people using the plugin. Internal
design notes live in [`docs/architecture.md`](docs/architecture.md); the
end-to-end API contract lives in [`SKILL.md`](SKILL.md).

Versions before 0.3.0 predate this file.

## Unreleased

### Added

- **Undo for your own board actions.** A batch tag, a batch move to another
  workspace, a bulk archive, an edit, a ranking change — all of them can now be
  taken back with one click, or with **Ctrl+Z** (**Cmd+Z** on a Mac). A quiet
  row under the header names the action an *Undo* would reverse, and the shortcut
  never fires while you are typing in a field: **Ctrl+Z** in the description
  editor still undoes your text, as it always did.
  It is honest about its limits, which is the point. An idea that changed since
  the action is **left alone and named**, so one card an agent touched in between
  never overwrites the other fifty-nine the batch really did change. And it says
  plainly what it does **not** reverse: deleting an idea, merging two, raising a
  follow-up, declining one, and delivering one have no way back, because the
  board has no verb that undoes them — the interface would rather admit that
  than offer a promise it cannot keep. Undo lives in this browser session only:
  the last 20 actions, for 30 minutes, and it forgets on reload.
- **Agents can state and read the links between ideas.** The board has carried
  "related to" and "blocks" for a long time, but only the HTTP channel could
  reach them: an agent asked to link two cards had to hand-build the JSON
  envelope — or go and read the plugin's own source to find out the field
  existed. There is now an `ideas_relate` tool, and every read carries the links.
  `ideas_relate` edits the two lists by **add and remove** rather than by
  replacement, so a link the agent did not mention survives the call, and a call
  that would change nothing writes nothing at all (no revision, no card round
  trip, no misleading line in the activity log). It answers with the three lines
  a human reads on a card, each target resolved to its `#N` and title.
- **The launch window now tells you what it is about to ignore.** Open *Run* on an
  idea that still waits for another one and the dialog names it — *"This idea is
  still waiting for #47 Exports"* — with a louder line when that blocker sits
  *lower* in the backlog than the card you are about to run. It is a line, not a
  lock: the button is still the launch button, because the order, and the
  decision to start work anyway, are yours. A blocker that is no longer open
  stops being named, so the line cannot outlive its own reason. Agents read the
  same thing in the answer to `ideas_launch`.
- **A link is a way out of a number.** The chips a card prints used to be labels:
  `#47` told you an idea was related, blocking or blocked, and offered nothing
  else. Clicking one now opens *that* idea's editor — the chip points away from
  the card you are reading, on the Overview card and on the Priorities and
  Delivered rows alike.
- **The three links are three colours.** *Related* is green, *blocks* amber,
  *blocked by* red, on the cards and in the editor. Colour is the second channel,
  never the only one: the arrows (`↔` / `→` / `←`) and the editor's labels already
  say which link it is. A dependency the ranking contradicts is shown as a
  **ring** rather than a different colour, so the chip's hue keeps meaning "which
  edge" while the ring means "the order disagrees".
- **Reads now answer "what is this idea blocked by?" directly.** Every row a
  list returns, and every full read, carries the stored `relatesTo` and `blocks`
  **and** the derived `blockedBy` — the inverse side, which exists on no card and
  rode on no wire field, so an agent used to have to scan the whole board to work
  it out. The derivation is made from the whole document, so a blocker outside
  the current filter still counts.
- **A card that waits, but is scheduled first, says so.** Declare "#47 blocks
  #82" and the backlog may well put #82 above #47 — a real case, where #82's own
  text had argued for weeks that it should descend below #47 while its rank moved
  the other way. Nothing compared the declared link with the order, so nobody could
  see the contradiction. The *Waiting for this idea* chip is now highlighted on
  the card that waits, and its tooltip names it: hover it and it tells you the
  blocker is scheduled below. It stops there on purpose — the order stays yours.
  The board will not silently move a card for you, because a card can be worth
  doing first even when something else has to land before it. Agents get the same
  verdict in the answer to a ranking or a link change.

### Fixed

- **"Back to chat" works again.** The button at the top of the board did nothing
  at all: you clicked it, and the board stayed exactly where it was. The board
  asks the shell to show the conversation, and it was asking for the shell's
  panel service at a moment when the shell had not finished putting itself
  together — so the answer "not yet" was taken as a final "no" and remembered
  for the rest of the session. Every click after that was a no-op, silently. The
  board now asks at the moment you click, which is the only moment the answer
  matters, and the **Open Task Board** button in the run window — which asks the
  same way — is repaired with it.
- **Opening another idea from a link no longer shows the previous card.** The
  *Run* window now says what it is about to ignore, the link chips are a way out
  of a number, and the three links are three colours — details below, in
  *Added*. The first of them is a fix in its own right: switching the editor to
  another idea left every field showing the card you were reading before, because
  the form keeps its state unless it is told to start over.
- **Writing a reason for a ranking no longer demotes the idea to the bottom of
  the backlog.** Saving Value, Effort or the rationale *without* touching the rank
  used to send the idea to the last position of its workspace — on a live board, a
  card at 7 of 20 jumped to 20. The move was invisible twice over: nobody watching
  a card move to the end of a list thinks to check why, and the activity log
  announced it as done — *"rank 20 in its workspace group"*, a position the caller
  never asked for. A patch that does not name a rank now records the opinion and
  leaves the card exactly where it is, and the log names a rank only when one was
  actually sent. Sending a rank still re-ranks the whole backlog as before.
- **The blocking row no longer says the opposite of what it writes.** The
  interface labelled the row that writes "blocks" with the wording of the row
  that waits for an idea (*Waits for* / *Doit attendre* / *等待*), so a card
  that blocked #48 read "Waits for: #48 — Cannot land before #48". Whoever
  wanted "#51 waits for #47" could pick the wrong row, and the effect appeared
  on the other card, far from the mistake. The row, its picker and its chip now
  speak the direction they actually write: **Blocks**, "Add an idea this one
  blocks…", "{target} cannot land before this one". The read-only "waiting for
  this idea" row is unchanged, so both cards now tell you the same thing about
  one link.
- **A stray `{target}` no longer appears under the relations.** The note below
  the read-only row asks for a placeholder it was never given, so the interface
  printed the braces literally, in every language.
- **A delivered idea no longer wears a "Running" tag.** An idea whose work was
  finished and delivered could keep showing *Running* for ever: the tag also
  reads the mirrored TaskBoard card, and that observation stops the moment its
  idea leaves the backlog, so a card caught mid-flight froze the tag at
  *Running* while the run itself was long settled. The tag now follows the run
  the board actually recorded, and a card genuinely re-run still says so.

## 0.9.0 - 2026-10-04

### Added


- **The AI analysis can now relate an idea to its neighbours.** When the analysis
  establishes a real link, the analyst records it: **relates to** for a shared
  subsystem or constraint, and **blocks** with the direction that means — the
  card that depends on another is *blocked by* it, never the reverse. Only
  explicit relations, using resolved ids, at most three per run, and named in
  the report. An empty relation graph stays a normal state.

- **A re-analysis no longer erases your tag instructions.** The analysis rewrites
  the tag list, and a tag also carries the line shown to you before each launch.
  A tag the analysis keeps now comes back with that line intact.



- **Six agent tools: drive the board from any session.** When your DSH deployment
  serves agent tools, any chat can now work the ideas board directly — no shell,
  no hand-written JSON, no browser. `ideas_list` reads a filtered page of your
  backlog, `ideas_get` reads one idea in full, `ideas_capture` captures an idea
  together with its priority opinion, `ideas_triage` records value / effort /
  rationale / rank and re-ranks a workspace group, `ideas_launch` starts the
  execution, and `ideas_review` settles the review gate with **approve**,
  **follow-up** or **decline**. They go through exactly the same gate as the web
  board, so a call that would be refused in the interface is refused the same way
  here, and an idea written by an agent shows up on your board at once — marked as
  the agent's work in that idea's history. An agent still cannot write a run state
  or claim a task card; those stay the host's. If your deployment serves no agent
  tools, nothing changes: the board keeps every feature and the HTTP channel.
- **Every idea now remembers what happened to it.** Each idea keeps a short
  activity log — who did what, and when — and the editor shows it as a compact
  timeline under the description, right above the Approve / Follow-up / Decline
  buttons. It is written by the board itself: the capture, the ranking changes,
  the launch, the run that finished or failed, the approval, the follow-up, the
  decline with its reason. Entries are attributed, so you can tell your own
  changes from an agent's and from the run's. The log keeps the **last 50
  entries** and nothing more, and an idea that has recorded nothing yet shows
  nothing at all rather than an empty box — so "nothing has happened" is never
  mistaken for "something is missing".
- **Your ideas travel with their history.** The JSON export and import carry the
  activity log, and the markdown export prints it as a short **Activity** block
  under each idea — so an archived document can still answer *why was this
  declined?*, which a last-state record never could.
- **Re-analysis reads the real past.** When you ask for a fresh analysis of an
  idea, the analyst is now handed what actually happened to it before — the
  decline, the delivery, the archive-and-restore — and is told to read it before
  writing. A re-analysis can no longer re-propose something the board already
  refused.



- **Every finished run leaves a delivery note.** When a run ends, the board keeps
  the closing words of the run right under the description of the idea it worked
  on — on the card in the *To review* column, in the idea editor above the
  Approve / Follow-up / Decline buttons, and on the row of a delivered idea in the
  *Delivered* list. It is the last thing the run actually said, not a summary
  written for you: the board never invents one. When a run leaves nothing behind
  — it was interrupted before answering, or the workspace it ran in is gone — the
  note says exactly that, so an empty delivery can never be read as a successful
  one. The note is short by design (a couple of lines; longer answers are cut) and
  never changes what the run did: **Open the session** remains the way to watch
  the whole thing. The note follows the idea through the markdown export too, and
  nothing you type can overwrite it: it belongs to the run, not to you.
- **The sidebar entry now tells you what is waiting.** A small amber count sits on
  the Ideas icon and shows how many ideas of the current workspace scope are in the
  *To review* column. It reads the board's own list already loaded in the page, so
  it costs nothing, needs no extra polling, and disappears as soon as the gate is
  empty. With **Remember the workspace** turned on, the count follows the
  workspace you last worked in rather than mixing every workspace together.
- **A quiet *Stale* marker on ideas nobody has touched.** An open idea with no
  update for a while wears a discreet *Stale* badge next to its state, on the
  Overview cards and in the Priorities list. How long counts as too long is yours
  to set under **Stale after (days)**, which ships at 30 days; set it to 0 to turn
  the marker off entirely. The marker is a display aid only: it is drawn when the
  board paints and nothing is written to your ideas. It never appears on an idea
  that is already under review, delivered or declined — those have a state that
  says more than a date does.



- **A new idea card carries your TaskBoard's own permission.** Until now every
  mirrored card was stamped *read-only* whatever your deployment allowed, so an
  idea could never write anything when its card ran — while a card whose
  permission sat *above* the TaskBoard's session default refused to start until
  you walked to the board and confirmed it. A new card now takes the level your
  TaskBoard is configured with, never more, and launching raises an older card to
  that same level before the run. On a deployment left at *read-only* nothing
  changes at all; the plugin follows whatever you set, and never asks for
  anything above it, so **a launch stays one click** — no detour to the board to
  confirm a permission. A card you raised yourself is never lowered, and a card
  whose permission the board did not report is never written to.
- **A setting for the launches that have no card.** When you launch an idea while
  the TaskBoard plugin is absent, the run happens in a brand-new session. That
  session now starts at the level you pick in **Direct-launch permission**
  (*read-only*, *workspace-write* or *danger-full-access*), applied before the
  very first turn so the run never starts fenced. The default is
  *workspace-write*: the run brief asks for an implementation, so a read-only
  session would answer with a plan and settle the run having written nothing. If
  the elevation cannot be applied, the launch stops with the reason instead of
  quietly starting without it. Card-backed ideas ignore this setting.


### Changed


- **An update now replaces the installed analysis prompt, and keeps what it
  replaced.** The prompt was installed once and never replaced, so an instance
  that had installed an older version kept using it after every upgrade — the
  new features simply went unused, with nothing to show for it. Every start now
  writes this version's prompt, and the file it replaced is kept beside it
  (`SKILL.md.<timestamp>.bak`, the five most recent), so a prompt you wrote by
  hand is never lost: the start-up log names the copy, and the README says how
  to put it back.

- **A long Open column stays responsive.** Once the Open column grows past a few
  hundred ideas, the board draws only the cards you can actually see and leaves
  the rest behind the scrollbar, so scrolling, searching and dragging no longer
  get slower as the backlog fills up. Everything you can do still works on the
  whole column, not just on the part of it that happens to be on screen.
  - **Drag & drop still lands where you point.** You can drop a card before one
    you have scrolled past and one you have not: the written order is built from
    the entire column, not from the cards that happen to be drawn.
  - **A shift-click range still covers the whole block.** It selects every row
    between the two you clicked in the column's own order, including the ones
    scrolled out of view, and the bar keeps stating the truth — *n selected of
    m shown*, where *m* is the filter, never the window.
  - **A card keeps its place while you read.** Cards are not a fixed height, so
    their real height is measured as they appear — and every measurement is
    anchored to what you are looking at, so the column never slides under a
    resting hand.
  - **"Go to idea" still works on a card you have never scrolled to.** The board
    brings it into view first, then opens and rings it, exactly as before.
  - **A standing notice** appears above the Open column once it holds **300 or
    more** open ideas, naming the number. It tells you the size of what you are
    looking at before you start scrolling, rather than pretending the board is
    struggling.
  - **Short columns are untouched.** Below that size the board draws every card
    exactly as it did before, so a normal backlog behaves identically.
  - **Nothing changes for your data.** The board does this entirely on its own:
    no new stored field, no new API call, and the JSON export/import, the
    snapshots and the markdown export are byte for byte what they were.

- **A workspace can carry its own launch model.** The launch dialog used to ask
  which model every single run should use. Set one for a workspace and it stops
  asking: the dialog just tells you which model the run will use, and your click
  confirms.
  - **Remember this model for {workspace}** is offered right where you make the
    choice, in the launch dialog. From then on every idea launched in that
    workspace runs on it.
  - **Change…** brings the picker back over the remembered model, so one run can
    use another model **without** changing what every later run will use.
    **Save as the workspace default** is what makes a new pick stick.
  - **Forget this model** removes it, and the dialog goes back to asking.
  - **A workspace with no default behaves exactly as before**, and so does a
    deployment whose settings are unavailable. Both ways of running an idea —
    through the TaskBoard card and in a fresh session — use the same default.
  - **A model that no longer exists is never quietly replaced.** It is named as
    stored and the run is refused with the reason, so the fix is yours to make.
  - It is a preference of the workspace, stored like your other panel options:
    nothing is written onto the ideas, and it belongs to your DSH profile rather
    than travelling with an exported board.

- **Relate ideas to each other.** An idea can now carry **Related to** links
  ("this is adjacent to that, read the other one") and **Waits for** links
  ("this cannot land before that one"). The other card shows the same edge from
  its side, as **Waiting for this idea** — the same arrow on both cards, in
  opposite directions, so the links read without opening anything.
  - You add and remove them in the **editor**, under **Relations**: pick an idea
    from a list, or press the **×** on a chip. The **Overview card** and the
    **Priorities** and **Delivered** rows all print them as a quiet
    `↔ #12` / `→ #31` / `← #7` line, and print **nothing at all** for an idea
    that has none.
  - **A link is declared once, never twice.** *Related to* is one statement about
    two ideas and is true from both sides; *Waits for* is stored on the card that
    waits and the *Waiting for this idea* line is the same edge seen from the
    other side. That line is therefore read-only — the editor names the card
    that declares it, rather than quietly editing a card you never opened.
  - **A wait that loops is refused when you write it**, not discovered when the
    graph is drawn — and the refusal names the chain (`#1 → #2 → #3`), so you
    know which link to undo.
  - **Links follow the lifecycle.** Deleting an idea drops the links that named
    it instead of leaving a reference to nothing. Merging a duplicate re-points
    its links at the surviving idea and hands them over, the same way its
    follow-ups and its labels are handed over; the archived duplicate keeps its
    own, so restoring it is lossless.
  - **Nothing is inferred.** A relation is something you state. The board's
    *Find similar* score is a computed signal and never becomes an edge.
  - They are part of the board like everything else: the JSON export/import
    round-trips them, snapshots and restores carry them, and the markdown export
    prints them. **No API call, board layout or stored document changes for the
    rest of your ideas** — a board where nobody used the feature is byte for
    byte what it was before.

- **A Health tab: is this backlog healthy?** Five questions about the workspace
  you are looking at, answered **by the host** in one small read the board asks
  for on its own — your background refresh is not slowed by a single byte.
  - **How much is open**, and how it splits across workspaces.
  - **How many were delivered this month** — the label names the calendar month
    it measured, on your own clock, not a vague "recently".
  - **The median time to deliver**, which is deliberately cautious. Only ideas
    that were really **delivered** count. Until there are **five** of them the
    tab says *Not enough deliveries yet (n / 5)*, with the count it has, instead
    of printing a confident number computed from one or two rows. When a backlog
    is closed by dragging cards to Archived rather than delivering them, the tab
    also tells you **how many ideas left it without a delivery stamp** — that
    count is the reason a median can be missing, and it is a number you can act
    on rather than a silent zero.
  - **Your most used labels** on the open backlog.
  - **What is waiting to be triaged**: how many open ideas carry no rank, and
    how many carry no value. It is work to do, never a quality score.
  - The workspace selector scopes all of it, like the other tabs, and the
    figures follow your panel language. Nothing is stored: closing the tab
    forgets it and the next visit re-reads the host.
  - **It never leaves you reading stale figures as if they were current.** The
    board and the Health tab refresh on their own clock, so a quiet line under
    the numbers names the revision they came from and whether a refresh is on
    its way — or failed, with the host's own reason.

- **Go straight to an idea.** The board header has a small **Go to idea** box:
  type an idea's number (`#42`) and the board opens that card, scrolls it into
  view and rings it. It works from a cold panel load, across workspaces, and on
  an archived card — so when a conversation ends with "see idea #42", one click
  takes you there. Anything that would have hidden the card (the search, the tag
  filter, the workspace scope) is cleared, and a reference that matches nothing
  says so instead of quietly doing nothing. An internal idea id is accepted
  too, but the **number** is the reference to hand to a human: it survives
  moving the board to another machine, an id does not.
- **A refused launch now has a real destination.** When the TaskBoard refuses
  to run a card until you confirm its permission, the dialog offers **Show the
  card**, which brings that exact idea into view on the board — no second board,
  no filter to re-type.

- **Back up your board, and put it back.** The settings section has a new
  **Backup** tab. **Take a snapshot** writes a timestamped copy of the whole
  board — every idea, its activity log, its scores, its labels, the run it
  belongs to — into your ideas backups folder, and the last ten snapshots are
  kept for you. **Restore** puts one back: it asks first, it tells you exactly
  what it is replacing, and the board it replaces is **kept as its own
  snapshot**, so you can always go back to it.
- **A restore never lands on a running idea.** While an execution is still in
  flight the restore is refused, the panel says so before you click, and it
  names the idea that is busy. Your board is left exactly as it is.
- **A file that cannot be read is refused, not imported.** A snapshot that is
  not a ledger, was written by another version of the plugin, or holds a record
  the ledger cannot read is rejected **with the reason**, moved aside for
  evidence, and your current board is not touched. A half-imported board is
  never the outcome.
- **Move the board to another machine.** **Export a copy** downloads the board
  as one JSON file, and **Import** brings it back — every field included: the
  activity log, the run and session stamps, the task-card binding, the analysis
  audit, the delivery note, the ranks and the `#N` numbers, so the next capture
  never re-issues a number. This is the supported way out of a home where a
  second Host refuses to start: that Host already owns the board, so take the
  board with you instead of sharing the folder. The **markdown export** is
  unchanged — it stays a generated view for reading, not a backup.
- You can also drop an exported file straight into the backups folder: it
  appears in the list and can be restored from there, and the plugin never
  deletes a file it did not write.
- The Backup tab needs no settings service of its own: on a deployment where the
  display options are unavailable, snapshots, restore and the export still work.

- **Change many ideas at once.** The board now has a real multi-select: tick the
  box on a card (or on a Priorities / Delivered row), **shift-click** to paint a
  range of rows, or hit **Select all** to take everything the current filter
  shows. A quiet bar under the filters always says how many are selected out of
  how many are shown, **and which workspace, tags and search produced that
  set** — so "all" can never mean a batch of ideas you cannot see. The
  selection is a view: it is never written to your ideas, so the board's
  background refresh cannot overwrite it, and an idea that leaves the filter
  leaves the selection too.
- **Three bulk actions: tag, re-home workspace, archive.** Each one applies to
  the selection and answers **per idea**: a report lists what went through, what
  was skipped and why, and what failed with the host's own reason — one refused
  idea never stops the batch and never becomes a single blanket error. Bulk
  tagging **keeps the labels an idea already carries** (including their prompt
  lines) and adds yours, and it refuses rather than silently drops a label an
  idea has no room for. Bulk re-homing targets a workspace by its stable
  identity, so renaming a workspace moves nothing.
- **A bulk archive can be undone in one click.** The report of a bulk archive
  offers to restore exactly the ideas it archived. This is deliberately scoped
  to the reversible operation: an update carries no previous value, so bulk
  tagging and bulk re-homing say plainly that they have no undo here instead of
  pretending otherwise.
- An archived idea bound to a task card is restored, changed and archived again
  during a bulk tag or re-home, so its mirrored card actually follows the change
  (an archived card refuses every edit). Declined ideas are left alone in a bulk
  operation and reported as such — archiving one would erase the decline.

- **Duplicates can now be merged in one step.** The AI capture button has always
  said it would "create or merge a duplicate", and now it can: a new **merge**
  action folds a duplicate into the idea that survives. The surviving card keeps
  its title, its analysis and its place in the backlog, and simply gains the
  duplicate's **tags** and its place in any follow-up chain; the duplicate is
  **archived** with a note naming the card it was merged into, and any follow-up
  that hung off it now points at the survivor. It is a single commit, so there is
  never a moment where both cards are open, and both ideas remember it in their
  activity log. Two ideas in **different workspaces** are refused with a reason,
  because merging across projects would quietly move work between them. Whether
  the surviving card takes the duplicate's rank or keeps its own is your choice,
  per merge. Running a task card, and the run it is in, are never touched by a
  merge.
- **Ask whether an idea duplicates something.** A new **Find similar** action on
  an open idea, next to *Re-analyze*, does two things. The board first does its
  own quick check — it compares the idea's title and its tags against the open
  ideas of the same workspace and shows you the closest ones, with the score and
  which of the two signals produced it. Then a fresh analyst session reads the
  **real content** of those candidates and answers, for each one, whether it is a
  duplicate, a related-but-distinct idea, or unrelated — and says which
  candidates it weighed. The score it is shown is a rough signal, and the session
  is told to distrust it in both directions; the human still makes the call. The
  action can **never merge anything by itself**, and the session it starts is
  explicitly forbidden to merge. Like *Re-analyze*, it offers the same model
  picker and only appears when the idea's workspace is one your DSH app knows.
- The near-duplicate check is available to any agent and script through the
  board's read channel, and it is **opt-in**: it runs only when asked, so the
  board's own polling costs exactly what it did before.



- **An idea keeps the link to the chat it was worked on, in every column.** The
  **Open session** link only appeared while a run was in flight, and it never
  appeared at all when the execution went through the TaskBoard — which is the
  usual case, since the card backend is the default whenever the mirror is up. It
  now appears on any idea that has been run, whatever its column: **Running** and
  **Task failed** in the backlog, **Under review**, and the finished **Archived**
  and **Declined** cards. The conversation is one click away however long ago it
  happened, an idea that never ran shows no link, and a deployment without a
  sessions service still shows none rather than a broken button.

- **The permission gate no longer filters the TaskBoard for you.** When a launch
  is refused until you confirm a card's permission, **Open the TaskBoard** now
  opens that board unfiltered instead of pre-typing the idea title into its
  search box — reaching into another plugin's live form was never a stable thing
  to depend on. The card is filed under the idea title, printed right next to
  the button (and **Copy the title** is still there), and **Show the card** takes
  you straight to the idea on your own board if you want to look at it first.


### Fixed


- **The About tab tells the truth about which version you are running.** The
  number it printed was written by hand into the source and left behind at
  release time, so a panel installed from a recent version could still announce
  itself as an old one. It now reads the version of the package you actually
  installed, and a release cannot ship with it out of step any more.

- **The "Open session" link can now actually appear.** It asked the host to open
  a session under a name no version of DSH serves, so the link was silently
  missing everywhere — the conversation was on the card all along, the button was
  not. It now resolves the navigation face DSH actually offers, tries the known
  names in order (current first, the older one second) so an older instance keeps
  working, and says so in the log when neither is there.

- **Launching an idea no longer fails with "session permission failed: Cannot
  read properties of undefined".** Raising a new session's permission goes through
  the host's own command service, whose call now takes a **fourth** argument — a
  cancellation signal. The plugin still passed three, so the host threw while
  reading it and the launch died before your run started. It works again, and the
  failure mode is covered by a test rather than discovered at the launch button. A
  deployment that serves no command service at all now says so in the log instead
  of silently running the idea fenced.

- **Refreshing the page no longer takes the settings section down when the
  running instance is older than the page.** The Backup tab read the list of
  fields a restore could not carry as if the running instance always sent it; a
  browser half reloaded against an instance started before that field existed
  crashed the whole section with a TypeError after a restore. It now degrades to
  simply showing no warning. That one-sided upgrade stays fine everywhere else —
  the browser half reloads with the page, the routes come with a restart.

- **One button in the Backup tab, not two.** *Take a snapshot* and *Export a
  copy* wrote the same file through the same call and differed only by a stamp in
  its name — and every entry in the list already carried its own **Download**
  link, so the export's extra download was a second way to fetch a file that sat
  one row away. There is now a single **Export the board**: it writes the
  timestamped copy into your backups folder (still the restore point you take
  before a risky change) and hands it to you as a download (still the file you
  carry to another machine).

- **A backup taken by an older plugin keeps restoring, and a newer one is never
  adopted by an older plugin.** Restoring a file used to demand the *exact* ledger
  schema version of the build reading it, so every snapshot taken before an update
  became unusable — while a file from a **newer** build could be adopted with its
  extra data quietly dropped. The check is now directional: a file this build
  reads is accepted (a field it does not carry is simply filled in the first time
  the board writes it), and a file from a newer plugin is **refused** with an
  explanation instead of being half-adopted. And when a restore does leave out
  data this build cannot read, the panel names the exact fields — a partial
  restore never looks complete.

- **Drag & drop is never switched off by the Open column order any more.** While
  the column was laid out by date (or with the running ideas floated to the top),
  its handle was inert — which also killed the one gesture that has nothing to do
  with ranks, **dragging a card into another column**, the very gesture the board
  hints at. The sort is now what it says it is: a *default*. The handle is always
  live, a cross-column drop is the ordinary move it always was, and reordering the
  column by hand now writes the ranking **you built on screen** and shows it from
  then on (until you pick another order in the settings). Nothing is refused.



- The **initiator** of a write (the label an agent or a tool stamps on its
  action) was being discarded on the way into the Host, so every automated change
  looked like it had been made by you in the board. It is now recorded properly,
  which is what makes the activity log able to tell your changes from an agent's.

## 0.7.6 - 2026-10-01

### Fixed

- **The header gear and the "Open the TaskBoard" button work in the Desktop app.** In the Desktop app, Settings lives in the account menu instead of behind a standalone button, and the TaskBoard switch relied on a window call that shell does not always answer. The gear now opens Settings through whichever entry your window offers and still lands on the Ideas section. The TaskBoard button now switches to the board the same way clicking its sidebar entry does, then filters on the idea title as before. The browser version behaves exactly as before.

## 0.7.5 - 2026-09-30

### Fixed

- **The Ideas board works in the DSH Desktop app again.** In the official
  Desktop app every ideas request answered `403` and the board showed
  *Host operation failed: forbidden* — the panel was unusable, while the same
  install worked in an ordinary browser tab. The desktop shell talks to the
  Host on your behalf and rewrites the request on the way, which made the
  panel's own calls look like a stray local script to the fence. The fence now
  also accepts the shell's own sign-in credential as proof of an application
  running on this machine, so the board, the search, the settings and the
  launches all answer again. Nothing is loosened for anything else: a plain
  `curl`, a request from another machine, and a request naming another site
  are still refused with `403`, exactly as before.
- Installing this version replaces the whole plugin, so a hand-patched copy of
  the plugin in a profile is superseded by this release rather than kept
  alongside it.

## 0.7.4 - 2026-09-27

### Fixed

- **The Ideas row is a real panel row now.** It sits with Plugins, Task Board
  and Skill Center, in their row box, font and highlight, and it behaves like
  them: clicking another panel closes the board instead of leaving it stuck open
  behind the new one. Clicking Ideas again, or *Back to chat*, still closes it.
  Previously the row was a button this plugin injected itself and hid the
  conversation with a stylesheet, which is why only Ideas behaved like a toggle.
- **A launch refused by the card's permission gate now tells you what to do.**
  The board showed the Host's own English sentence and stopped there. It now
  names the card, explains that the permission is above the session default, and
  offers **Open the TaskBoard** — which switches to the board panel with the
  filter already set on the idea title, so the card is the one waiting in front
  of you. **Copy the title** is there for the case where the board does not
  answer. The permission itself is still yours to confirm, in the board: the
  plugin never confirms it for you.

## 0.7.3 - 2026-09-26

### Added

- **The list rows now show the run state.** The Priorities ranking and the
  Delivered log carry the same pills as the Overview cards — **Running**,
  **Task failed**, *follow-up of #N*, and **Open session** — in the row's
  top-right corner. The "is this one already being worked on?" answer is
  available on the list you actually read, without opening the card.
- **The Open column can be ordered by creation date.** The new **Open column
  order** setting offers *Creation date (oldest first)*, *Creation date (newest
  first)* and *Rank*.
- **A separate switch floats the running work to the top.** **Show running ideas
  at the top** (on by default) lifts the ideas whose run is in flight above
  whichever of the three orders you picked, without changing that order.

### Changed

- **The Overview's Open column now reads oldest-first by default**, so a backlog
  scans like the diary it is. Pick *Rank* to get your hand-set ranking back; the
  setting applies to that one column, and the Priorities tab always stays on the
  rank it prints.
- Only the **running** work is floated. A failed run keeps its red **Task
  failed** pill but stays where the selected order puts it — a date-ordered
  backlog that jumped every failure to the top would stop reading as a diary.
- Neither setting stores anything: the board refreshes every 2.5 s, and it can
  never overwrite the ranking you set.
- While the Open column displays something other than the stored rank, its drag
  grip is off and says why. The card buttons still move an idea to another
  column, and choosing *Rank* with the running float off brings the grip back.

### Fixed

- A restored idea no longer shows a stale **Delivered {date}** pill in the
  Priorities list. Restoring clears the archive stamp but keeps the delivery
  date, so the row was announcing "this one is done" on an idea you were about
  to pick up.
- Dropping a card into a reordered Open column no longer writes back the ranking
  it already had. The anchor you saw came from the displayed order while the
  write resolves in rank order, so the drag did nothing visible while still
  calling the host.

## 0.7.2 - 2026-09-26

### Fixed

- The npm and changelog links at the bottom of a release note pointed at a
  doubled version prefix, so they did not open. (The v0.7.1 release page still
  shows the wrong links: it was published before the fix.)

## 0.7.1 - 2026-09-26

### Added

- **The editor can start a run**, next to the button already on the card. The
  editor is the surface you reach from the Priorities and Delivered tabs, so an
  idea opened there no longer sends you back to the Overview to find its card.
- The editor is **titled with the card number** it is editing, so a dialog
  opened from a list never loses track of which idea it is about.
- **Release notes.** Each release now ships a curated, user-facing changelog
  section, and the GitHub Release body shows it.

### Changed

- The README now describes the plugin for the people who install it, with the
  implementation detail moved to `docs/`.

## 0.7.0 - 2026-09-26

### Added

- **Run an idea from the board.** An open idea with a workspace offers a
  **Launch execution** button, on its card and in the editor. Pick a model (or
  keep the session default), confirm, and DSH runs it: on the idea's TaskBoard
  card when that plugin is installed, or in a brand-new chat session in the
  idea's workspace when it is not. The button says which way it will run before
  you commit.
- **Runs keep going without you.** The run happens in the background: closing
  the tab, or restarting the web instance, does not lose it, and the board keeps
  watching it for you.
- **A card shows its run.** A blue **Running** pill, plus an **Open session**
  link that jumps you straight into the execution — the only way to watch a
  session DSH started on your behalf.
- **The editor can start a run too**, so an idea opened from the Priorities or
  Delivered tab no longer sends you back to the Overview to find its card. The
  editor is also titled with the card number it is editing.

### Changed

- A finished run moves the idea to **Under review** on both execution paths, so
  the review gate no longer depends on the TaskBoard plugin being installed.

### Fixed

- A run started on an idea that was already in review was no longer followed,
  leaving it marked as running forever.

## 0.6.0 - 2026-09-25

### Added

- **Bounded read views.** Reading the board over HTTP can now filter,
  paginate and select fields, with explicit truncation metadata, so a script
  never has to pull a whole backlog to answer a small question.

### Changed

- The analyst reads a short summary of an idea first and fetches the full
  analysis only when it needs it, so a large backlog no longer floods the
  analysis context.

## 0.5.0 - 2026-09-24

### Added

- An **About** section in Settings, with ready-to-copy examples for agent
  capture.
- **Resizable kanban columns.** Drag a column edge to resize it; your widths
  are remembered per profile.

### Fixed

- Accented and other non-ASCII idea text is repaired where it enters the
  plugin, instead of arriving corrupted.

## 0.4.0 - 2026-09-23

### Added

- **The panel speaks your language, independently of the shell.** Auto (follow
  DSH) or pin it to English, French or Simplified Chinese.
- A **Task failed** badge: an idea whose execution failed stays in the backlog
  (nothing was delivered, so there is nothing to review) and shows why.

### Changed

- The header text search now covers **all three tabs** (Overview, Priorities,
  Delivered) instead of the Overview only.
- Large boards load far faster: lean list reads, idea bodies fetched only when
  opened, and an idle poll that does no work at all.

## 0.3.5 - 2026-09-23

### Added

- A settings shortcut in the board header, and the first board display
  toggles.

## 0.3.4 - 2026-09-23

### Fixed

- The Settings section works on current hosts, which replaced the settings
  registration mechanism it used to rely on.

## 0.3.3 - 2026-09-22

### Added

- A **tag filter**: searchable chips, a bounded number of rows, an
  always-visible reset, and filtering that applies to every tab.
- An **Ideas section in DSH Settings**, with the first board options (default
  tab, markdown rendering, remembered workspace scope, lifecycle
  confirmations, declined column, card density).

### Fixed

- Tag-filter layout and scrolling in several browsers; compact card density now
  applies to every tab.

## 0.3.2 - 2026-09-22

### Added

- TaskBoard cards carry a short summary produced by the analysis, so the board
  is readable without opening every card.

### Fixed

- **One card per idea.** Running the mirror twice no longer creates a duplicate,
  and a card deleted by hand is recreated instead of duplicated.
- Very large or stalled TaskBoard responses no longer freeze the board.

## 0.3.1 - 2026-09-22

### Fixed

- AI capture and re-analyze work again on current hosts, where the agent scope
  handling changed.

## 0.3.0 - 2026-09-22

### Added

- **Re-analyze**: re-run the analyst on an existing open idea, with a model
  picker on the confirmation dialog.
