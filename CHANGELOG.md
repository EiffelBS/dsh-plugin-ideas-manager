# Changelog

What changed in each release, written for the people using the plugin. Internal
design notes live in [`docs/architecture.md`](docs/architecture.md); the
end-to-end API contract lives in [`SKILL.md`](SKILL.md).

Versions before 0.3.0 predate this file.

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
