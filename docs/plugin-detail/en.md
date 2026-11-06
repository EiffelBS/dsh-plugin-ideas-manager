# Ideas board

Keep a backlog of ideas inside the DSH Web GUI, triage it on a kanban, and turn
the one you pick into a real execution without leaving the page.

## Open the board

Select **Ideas board** in the sidebar, under New Session. The board is a normal
global panel: switching to another panel closes it, and the review badge on its
sidebar row shows how many ideas are waiting in **Under review**.

## Capture and triage

- **New idea** (or the quick-add row at the top of the Open column) takes a
  title, an optional Markdown description, tags and a suggested rank.
- **AI capture** hands the draft to a fresh analyst session and switches you to
  it. The analyst writes the card back to the board with its own analysis, an
  improved title, tags, a value/effort score and a suggested rank.
- Every card shows its stable number, workspace, tags, value/effort badges and
  last update. Drag cards between the four columns — **Open**, **Under review**,
  **Archived**, **Declined** — or reorder them inside a column.
- **Search** and the tag filter narrow the whole board. The **Priorities** tab
  shows the ranking, **Delivered** the approved ideas, and **Health** a one-row
  answer per backlog question.

## Run an idea

**Launch** starts the idea as a run. When the TaskBoard plugin is installed, a
TaskBoard card mirrors the idea and the run happens there; otherwise the plugin
starts a direct session in the idea's workspace. **Open session** on a launched
card jumps back to the session that worked on it, and the review gate decides
whether the result is delivered or sent back.

## Settings

The gear in the board header opens this plugin's section of the DSH Settings
window: display options (default tab, ordering, card density, language,
Markdown rendering, stale threshold), **Backup** (timestamped snapshots,
restore, portable export and import) and **About**.

## Requirements

- DSH Web GUI 0.1.5-rc.1 or newer.
- The TaskBoard plugin is optional; the ideas board works without it.
- The Host owns the ledger (`~/.dsh/ideas/ledger-v2.json`); agents and the UI
  read and write it through the plugin's `/api/ideas` routes.
