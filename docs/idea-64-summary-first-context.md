# Idea #64 — Summary-first analyst context

## Goal

Bound the context entering an ideas-analyst run independently of board size.
The launch prompt identifies the target; the analyst loads compact board
metadata first, fetches only the target and direct follow-up bodies, and reads
only explicitly referenced project evidence. The existing full `GET /state`
contract and the frozen full `POST /action` response remain unchanged for public
ledger compatibility.

## Workflow

1. `GET /api/ideas/state?view=list` supplies id, idea number, title, status,
   workspace, tags, summary, TaskBoard link, and follow-up lineage metadata.
2. The target is resolved explicitly by id for re-analysis, or by workspace and
   draft intent for capture. Dedupe remains workspace-local and covers open and
   archived ideas.
3. `GET /api/ideas/idea?id=<id>` loads the complete target body. The target is
   fully analyzed before any mutation.
4. Only direct lineage records are fetched: children whose `followUpOfId`
   points to the target, and the target's parent when present. Unrelated bodies
   never enter analyst context.
5. Only project paths cited by those records are inspected. The analyst records
   evidence paths and unresolved questions in a bounded handoff summary.
6. Missing or conflicting identity evidence produces an explicit `ESCALATED`
   report with inspected identifiers/paths and the smallest safe next action;
   the analyst does not guess or persist a partial analysis.

The analyst keeps the existing CREATE-or-UPDATE dedupe flow, fresh request id
per action, full body replacement, one-level analysis audit on re-analysis,
transactional triage, persistence, and public ledger response behavior.

## Large-board coverage

`tests/perf-fixture.ts` keeps its deterministic 140 long-body cards and adds
stable target/follow-up body sentinels. `tests/analyst-context.test.ts` proves that:

- the list projection contains no full bodies;
- a reanalysis launch prompt contains metadata and endpoint selectors but not
  the target or unrelated bodies;
- the target plus its one direct follow-up are the only full bodies loaded;
- the target is fully analyzed, updated, triaged, and persisted;
- the untouched full `/state` contract still returns every body.

## Prompt-size measurement

Run the deterministic fixture with:

    IDEAS_PERF=1 node node_modules/vitest/vitest.mjs run tests/perf-host.test.ts --reporter=verbose

The new `[perf-host] analyst target prompt metadata` line reports the compact
metadata bytes alongside the omitted target-body bytes. The BEFORE prompt for the
same reanalysis embedded the complete stored body; the AFTER prompt embeds only
selector metadata and instructs a single-idea fetch. This makes prompt growth
independent of the 140-card total and of unrelated body sizes. Measurements are
fixture bytes (UTF-8), not model-token estimates.
