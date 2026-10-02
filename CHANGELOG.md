# Changelog

What changed in each release, written for the people using the plugin. Internal
design notes live in [`docs/architecture.md`](docs/architecture.md); the
end-to-end API contract lives in [`SKILL.md`](SKILL.md).

Versions before 0.3.0 predate this file.

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
