# Changelog

What changed in each release, written for the people using the plugin. Internal
design notes live in [`docs/architecture.md`](docs/architecture.md); the
end-to-end API contract lives in [`SKILL.md`](SKILL.md).

Versions before 0.3.0 predate this file.

## Unreleased

### Added

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

## 0.8.0 - 2026-10-03

### Added

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

### Fixed

- The **initiator** of a write (the label an agent or a tool stamps on its
  action) was being discarded on the way into the Host, so every automated change
  looked like it had been made by you in the board. It is now recorded properly,
  which is what makes the activity log able to tell your changes from an agent's.

## 0.7.8 - 2026-10-02

### Added

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

## 0.7.7 - 2026-10-02

### Added

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
