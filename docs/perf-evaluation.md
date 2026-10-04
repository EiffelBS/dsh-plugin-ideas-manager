# Ideas panel under high card load: performance & scalability evaluation

Status: evaluation DONE, corrective work LANDED (local, not pushed), deferred
evolutions recorded with their numbers. This document records the method, the
verbatim before/after measurements, what changed, and the explicit decision
per spec layer ("correctif prioritaire ou une evolution differee").

> **Update — column windowing is now LANDED.** Layer 3 below ("Kanban
> virtualization") was recorded here as `EVOLUTION DIFFEREE`; its numbers are in
> **section 8**, measured at the trigger the idea names (~500 open cards).
> Layer 5 (server-side index) stays deferred.

## 1. Scope and method

- Question: how does the panel behave at FUTURE load (100-150 ideas,
  voluminous markdown bodies), not an observed incident. Current production
  ledger (read-only sample at evaluation time): 37 cards, body min=886 /
  p50=3850 / p90=8241 / max=9452 bytes, avg=4040.
- Fixture (`tests/perf-fixture.ts`): deterministic (seeded PRNG), 140 ideas =
  100 open (the spec's measurable objective) + 12 underReview + 20 archived +
  8 declined; body buckets calibrated on the production distribution and
  extended to the spec's "tens of KB per card" future:
  20% 0.6-2.0 KB / 55% 3.0-9.0 KB / 20% 10-20 KB / 5% 24-31.5 KB
  (under IDEA_BODY_MAX_BYTES = 32 KiB). Result: count=140 open=100 bodies
  total=1112.1 KiB min=650 p50=6423 p90=17931 max=31310 avg=8134.
- Harness: `tests/perf-host.test.ts` (ledger/serialization/triage/reorder),
  `tests/perf-board.test.tsx` (React commit + DOM in jsdom), both opt-in via
  `IDEAS_PERF=1`; `tests/triage-coherence.test.ts` (rank/status coherence)
  always runs; `scripts/perf-live.mjs` profiles a REAL test instance over
  HTTP.
- Environment: this Windows dev machine, Node v22.23.2, vitest 3.2.7.
- jsdom caveat (printed by the harness): client numbers are main-thread
  JAVASCRIPT + DOM mutation only - no style/layout/paint. Real-browser paint
  scales with DOM size, which is why the node counts matter.
- Test-instance policy honored: validation ONLY on port 3099 with scratch
  DSH_HOME `C:\Users\User\.dsh-ideas-test-3101` (profile ideas-test,
  node_modules junction to this workspace). The 3080 session was never
  touched. The ledger lock is single-writer; the pre-run stale lock
  (dead pid) was cleared and the previous 40-card test ledger was renamed
  `ledger-v2.json.bak-perf` (reversible).

## 2. Sensitive points -> findings (BEFORE)

### 2.1 GET /api/ideas/state payload

```
[perf-host] GET /state snapshot() deep clone: 3.11 ms (median/20)
[perf-host] GET /state clone+stringify (server end-to-end): 5.46 ms (median/20)
[perf-host] GET /state payload: 1214.5 KiB raw (gzip reference: 239.2 KiB)
[perf-host] client JSON.parse of the state payload: 1.33 ms (median/20)
```

Findings: the server path was never the problem (<6 ms), but the same
1214.5 KiB was shipped every 2.5 s short-poll while the board was open AND
on EVERY action response, with the full bodies of all 140 cards.

### 2.2 Kanban DOM rendering with all cards mounted

```
[perf-board] mount 140 cards (1112 KiB bodies): 736.97 ms + config settle 147.11 ms
[perf-board] DOM after mount: 15256 nodes, 140 distinct cards, 140 markdown regions, heap delta 84.0 MiB (reference)
[perf-board] poll emit full wire (parse+clone+commit): 85.22 ms | commit-only (identity snapshot): 81.25 ms
[perf-board] search keystroke: hit "triage" 71.71 ms, miss 40.16 ms, clear 584.30 ms (scan+commit)
[perf-board] scope "all workspaces": 5742 nodes / 51 md regions -> one workspace (51/140 cards): 67.48 ms, 5742 nodes / 51 md regions
[perf-board] switch to Priorities (100 ranked rows): 434.80 ms, 9313 nodes, 100 md regions
[perf-board] switch to Delivered: 102.46 ms, 1529 nodes, 20 md regions
[perf-board] switch back to Overview: 536.45 ms
```

Findings: THE bottleneck. Every emit rebuilt the whole tree with
renderMarkdown(idea.body) per card (17.38 ms of pure markdown for 140
bodies, plus reconciliation of 15256 nodes), and the idle short-poll did
that every 2.5 s:

```
[perf-board] renderMarkdown ALL 140 bodies (one board render): 17.38 ms
[perf-board] renderMarkdown small (2 KB): 0.16 ms/card, html=2.4 KiB
[perf-board] renderMarkdown p50 (~4 KB): 0.44 ms/card, html=7.5 KiB
[perf-board] renderMarkdown p90 (~8 KB): 0.89 ms/card, html=20.9 KiB
[perf-board] renderMarkdown large (20 KB): 0.78 ms/card, html=23.9 KiB
[perf-board] renderMarkdown xlarge (31 KB): 1.30 ms/card, html=37.0 KiB
```

### 2.3 Filter/sort on a large open backlog

```
[perf-board] filter scan "triage" over 140 ideas: 0.33 ms/keystroke, hits=138
[perf-board] filter scan "ledger" over 140 ideas: 0.24 ms/keystroke, hits=139
[perf-board] filter scan "projection" over 140 ideas: 0.28 ms/keystroke, hits=139
[perf-board] filter scan "zzz-no-match" over 140 ideas: 0.41 ms/keystroke, hits=0
[perf-board] ordering at 140 ideas (open=100): orderIdeas 0.02 ms, groupedIdOrder 0.04 ms, rebuildOrder 0.07 ms
[perf-board] ordering at 420 ideas (open=300): orderIdeas 0.03 ms, groupedIdOrder 0.10 ms, rebuildOrder 0.12 ms
```

Findings: scans and sorts are 1-2 orders of magnitude below the render cost
even at 3x projection. Server-side indexing (spec layer 5) is NOT justified
by the profile.

### 2.4 Transactional triage reinsert (rank 1, shifting peers)

```
[perf-host] triage reinsert at rank 1 (shift 34 peers, group "open\u0000ws-opentimbre"): 14.00 ms apply (worst case), response serialize 5.11 ms
[perf-host] triage reinsert at rank 1 over 10 rotating cards: 13.80 ms (median)
[perf-host] 10 successive triage ops (coherent each step): total 137.0 ms, avg 13.70 ms
[perf-host] reorder full ledger (140 ids): 13.36 ms apply (median/10)
```

Findings: transactional apply is ~13-14 ms (dominated by the atomic ledger
write), well inside a human-perceptual budget; no full panel rebuild was
observed as necessary because React keyed reconciliation already MOVES card
nodes (proved by test, see section 4).

### 2.5 Coherence with the read/write contract

- POST /api/ideas/action: NOT modified (see section 4 for the verified
  invariants: verbs, envelope shape, transactional semantics, single-writer
  lock, request-id dedupe untouched).
- GET /api/ideas/state default: kept byte-identical (full snapshot) because
  backups/tooling (restore-3080-ideas, migration scripts) read it.
- Rank coherence across 20 successive rank-1 triages, interleaved triage +
  reorder, closed-card triage: asserted green BEFORE the changes (4 tests,
  always-run) and after.

## 3. What changed (spec layers 1, 2, 4, 7 + idle-poll fix)

1. List projection on the READ channel (layer 1):
   `GET /api/ideas/state?view=list` serves `IdeaListRow[]` =
   IdeaRecord minus `body`/`analysisAudit` plus a `bodyExcerpt`
   (<= 280 chars, whitespace-collapsed, word-boundary cut). Shared
   `toListSnapshot()` used by the host route AND projected at the client
   transport edge for action responses (whose WIRE stays the frozen full
   snapshot).
2. Deferred full-content loading (layer 2):
   `GET /api/ideas/idea?id=` returns ONE full record (single-record clone,
   not a whole-ledger snapshot). The edit modal, the follow-up composer and
   the re-analyze prompt fetch it on demand through
   `IdeasClient.fetchIdea()` (cached, self-invalidating on updatedAt); a
   failed fetch surfaces in the existing error bar and NEVER opens a modal
   on a truncated body.
3. Cards/rows render the EXCERPT through one shared `IdeaPreview` component
   (kanban card, Priorities row, Delivered row) - full markdown of the
   analysis no longer mounts in list views.
4. Idle-poll revision bailout: the Host bumps `revision` only on commit, so
   an idle poll keeps the SAME snapshot reference (React bails by Object.is)
   and now emits NOTHING - subscribers only wake on observable movement
   (snapshot change, error transition, pending flips). The board gained a
   subscribe tick so error/pending updates still render immediately
   (previously they only showed up via the next idle-poll re-render).
5. Deep search preserved: the first ACTIVE search loads the full snapshot
   ONCE per revision into a record cache (`ensureSearchIndex`), so
   `matchesFilter` scans whole bodies exactly like before; cold keystrokes
   match title+summary+excerpt. (Trade-off: the first keystroke pays one
   full fetch; subsequent ones are cheap.)
6. Layer 4 (DOM reuse during sorting): no code needed - React keyed
   reconciliation already reuses nodes; locked in by test.
7. Layer 3 (virtualization/pagination) and layer 5 (server-side index):
   NOT implemented - see the decision table, the AFTER numbers do not
   justify them yet.

## 4. AFTER measurements (same fixture, same machine)

```
[perf-host] import apply (seed 140 ideas, one transaction): 17.5 ms
[perf-host] GET /state snapshot() deep clone: 3.03 ms (median/20)
[perf-host] GET /state clone+stringify (server end-to-end): 4.67 ms (median/20)
[perf-host] GET /state payload: 1214.5 KiB raw (gzip reference: 239.2 KiB)
[perf-host] client JSON.parse of the state payload: 1.21 ms (median/20)
[perf-host] LEAN ?view=list clone+project+stringify: 10.35 ms (median/20)
[perf-host] LEAN ?view=list payload: 94.4 KiB raw (gzip reference: 18.6 KiB), 7.8% of the full snapshot
[perf-host] client JSON.parse of the LEAN payload: 0.20 ms (median/20)
[perf-host] triage reinsert at rank 1 (shift 34 peers, group "open\u0000ws-opentimbre"): 12.38 ms apply (worst case), response serialize 4.69 ms
[perf-host] triage reinsert at rank 1 over 10 rotating cards: 13.01 ms (median)
[perf-host] 10 successive triage ops (coherent each step): total 132.6 ms, avg 13.26 ms
[perf-host] reorder full ledger (140 ids): 12.82 ms apply (median/10)
```

```
[perf-board] filter scan "triage" over 140 rows: cold(excerpt) 0.13 ms/keystroke | deep(whole body) 0.21 ms/keystroke, hits=140
[perf-board] filter scan "ledger" over 140 rows: cold(excerpt) 0.12 ms/keystroke | deep(whole body) 0.22 ms/keystroke, hits=139
[perf-board] filter scan "projection" over 140 rows: cold(excerpt) 0.09 ms/keystroke | deep(whole body) 0.16 ms/keystroke, hits=139
[perf-board] filter scan "zzz-no-match" over 140 rows: cold(excerpt) 0.07 ms/keystroke | deep(whole body) 0.34 ms/keystroke, hits=0
[perf-board] ordering at 140 ideas (open=100): orderIdeas 0.02 ms, groupedIdOrder 0.03 ms, rebuildOrder 0.05 ms
[perf-board] ordering at 420 ideas (open=300): orderIdeas 0.02 ms, groupedIdOrder 0.09 ms, rebuildOrder 0.12 ms
[perf-board] mount 140 cards (1112 KiB bodies): 251.78 ms + config settle 71.56 ms
[perf-board] DOM after mount: 6633 nodes, 140 distinct cards, 140 markdown regions, heap delta 27.0 MiB (reference)
[perf-board] idle poll (lean wire, same revision -> bailout): 1.57 ms | changed poll (revision bump, commit): 40.90 ms
[perf-board] search keystroke: hit "triage" 126.12 ms, miss 21.03 ms, clear 139.05 ms (scan+commit)
[perf-board] scope "all workspaces": 2380 nodes / 51 md regions -> one workspace (51/140 cards): 25.45 ms, 2380 nodes / 51 md regions
[perf-board] switch to Priorities (100 ranked rows): 79.94 ms, 3229 nodes, 100 md regions
[perf-board] switch to Delivered: 14.64 ms, 304 nodes, 20 md regions
[perf-board] switch back to Overview: 133.74 ms
```

Note on the search line: the FIRST keystroke ("hit triage") includes the
one-time deep-index load (a full-snapshot fetch ~1214 KiB, +~80 ms); the
following warm keystroke is 21.03 ms. "Clear" (139.05 ms) re-mounts all 140
excerpt previews.

### Delta summary (BEFORE -> AFTER)

| Measurement | Before | After | Delta |
| --- | --- | --- | --- |
| Board poll wire | 1214.5 KiB | 94.4 KiB (7.8%), gzip 18.6 KiB | -92.2% |
| Client parse per poll | 1.33 ms | 0.20 ms | -85% |
| Idle poll main-thread | 85.22 ms every 2.5 s | 1.57 ms, no emit | -98% |
| Changed poll commit | 81.25 ms | 40.90 ms | -50% |
| Mount (jsdom) | 736.97 ms | 251.78 ms | -66% |
| DOM nodes mounted | 15256 | 6633 | -57% |
| Heap delta (reference) | 84.0 MiB | 27.0 MiB | -68% |
| Scope to one workspace | 67.48 ms / 5742 nodes | 25.45 ms / 2380 nodes | -62% |
| Priorities tab switch | 434.80 ms / 9313 nodes | 79.94 ms / 3229 nodes | -82% |
| Delivered tab switch | 102.46 ms / 1529 nodes | 14.64 ms / 304 nodes | -86% |
| Overview tab switch | 536.45 ms | 133.74 ms | -75% |
| Search clear (re-mount all) | 584.30 ms | 139.05 ms | -76% |
| Triage apply (worst case) | 14.00 ms | 12.38 ms | unchanged (disk-bound) |

### Live validation (test instance 3099, scratch DSH_HOME)

```
[perf-live] fixture: count=140 bodies total=1112.1 KiB p50=6423 p90=17931 max=31310
[perf-live] seed import (POST /api/ideas/action, 1214.7 KiB request): HTTP 200 in 61 ms
[perf-live] GET /state (FULL): 1214.5 KiB, 28.23 ms/req (median/25), ideas=140, revision=1
[perf-live] GET /state?view=list (LEAN): 94.4 KiB (7.8% of full), 18.97 ms/req (median/25)
[perf-live] gzip: full 239.2 KiB -> lean 18.6 KiB (7.8% of full)
[perf-live] GET /api/ideas/idea?id= (deferred body): 1.6 KiB (the whole record incl. body), 15.18 ms/req (median/25)
[perf-live] objective (100 open cards): lean state round-trip 18.97 ms/server-side + 29.24 ms client parse (fetch+parse, one shot) << 1000 ms
[perf-live] ALL CHECKS PASSED
```

The script also asserts the contracts live: full view keeps every body
(frozen backup path), lean rows carry NO body/analysisAudit, excerpt <= 281
chars, row-count parity, and >= 100 open cards.

### Spec objective check

"chargement de l'etat de 100 cartes ouvertes en moins d'une seconde sur une
machine de developpement standard": lean state fetch+parse = 48.21 ms live,
plus the 251.78 ms jsdom mount (no layout/paint) -> the measured JS path is
~300 ms, an order of magnitude under the 1 s budget, versus a BEFORE path
whose 737 ms mount + 15k-node layout/paint in a real browser brushed the
budget. "sans blocage perceptible du thread principal": the recurring cost
(idle poll) dropped to 1.57 ms with no emit; the worst one-shot interaction
(tab switch) is 133.74 ms.

## 5. Tests locking the behavior

- `tests/list-projection.test.ts` (8): excerpt builder + projection shape.
- `tests/deferred-body-routes.test.ts` (5): default full view frozen,
  ?view=list projection, /api/ideas/idea (200/400/404/405), fence on both
  views.
- `tests/deferred-body-client.test.ts` (12): ?view=list URL, action wire
  frozen + client-side projection, idle-poll bailout, error-transition
  emits, fetchIdea cache/self-invalidation, search index once-per-revision
  + silent degradation.
- `tests/deferred-body-board.test.tsx` (5): excerpt-only rendering, fetch
  before modal, error bar on failed fetch, deep search, DOM node reuse
  across a rank reorder (isSameNode proof - spec layer 7).
- `tests/triage-coherence.test.ts` (4): rank/status coherence after
  successive triage ops (no duplicate, no hole, no cross-group drift,
  revision fence), clamp/append healing, closed-card triage re-ranks
  nothing, interleaved triage+reorder never diverges from the wire.
- Full suite at delivery: 348 passed + 3 skipped (perf gates), typecheck
  clean, build clean (lib/index.js 111 kB, lib/client.js 264 kB).

## 6. Decision: correctif prioritaire vs evolution differee

| Spec layer / concern | Decision | Justification (numbers) |
| --- | --- | --- |
| 1. Read projection | CORRECTIF PRIORITAIRE - DONE | poll wire 1214.5 -> 94.4 KiB (-92%), parse 1.33 -> 0.20 ms |
| 2. Deferred body | CORRECTIF PRIORITAIRE - DONE | list mounts never carry analyses; /idea = 1.6 KiB per card on demand |
| Idle full rebuild every 2.5 s | CORRECTIF PRIORITAIRE - DONE | 85.22 -> 1.57 ms, zero emit on idle |
| 4. DOM reuse during sort | ALREADY SATISFIED - locked by test | keyed reconciliation, isSameNode proof |
| 3. Kanban virtualization/pagination | EVOLUTION DIFFEREE | AFTER: 6633 nodes, mount 251.78 ms, tab switches 79.94-133.74 ms - comfortable; revisit around ~500 cards or when real-browser paint profiles show a floor |
| 5. Server-side search/sort index | EVOLUTION DIFFEREE | scans 0.07-0.41 ms, sorts <=0.12 ms even at 420 ideas - two orders of magnitude below render cost |
| Action-channel diff/streaming | NOT NEEDED | POST contract frozen; action responses stay full and are projected client-side (~1.21 ms parse) |
| Server projection cost | ACCEPTED (note) | clone+project+stringify = 10.35 ms vs 4.67 ms full (excerpt build) - fine at this scale; a future optimization can cache the excerpt at commit time |

Known trade-offs (deliberate, spec-driven):

1. List views show the body EXCERPT (<= 280 chars), not the full analysis;
   the full body lives behind the edit modal / follow-up / re-analyze, which
   fetch it on demand.
2. First active search pays one full-snapshot fetch per revision (deep
   index); idle boards and clean filters never pay it.
3. The LEAN projection costs +5.7 ms server-side per poll (excerpt
   building); accepted, flagged as a future cache-at-commit optimization.

## 7. Reproduction recipe

```sh
# once per checkout (pnpm 12 trap: NEVER run pnpm scripts in this workspace -
# the first `pnpm <script>` wipes node_modules; run `pnpm install` once and
# invoke tools directly; the esbuild postinstall EPERM is harmless)
pnpm install

node node_modules/typescript/lib/tsc.js --noEmit
node node_modules/typescript/lib/tsc.js -p tsconfig.build.json && node node_modules/tsdown/dist/run.mjs

# offline harness (vitest EPERM tinypool = known: one danger-full-access
# pass on the same command, lesson 2026-09-18)
IDEAS_PERF=1 node node_modules/vitest/vitest.mjs run `
  tests/perf-host.test.ts tests/perf-board.test.tsx tests/triage-coherence.test.ts

# full suite
node node_modules/vitest/vitest.mjs run

# live test instance (NEVER port 3080): scratch DSH_HOME, profile junction
# points at this workspace, seeded ledger kept from the evaluation run
$env:DSH_HOME = 'C:\Users\User\.dsh-ideas-test-3101'
dsh --profile ideas-test --port 3099 --trusted-host 127.0.0.1:3099 --no-open
node --experimental-strip-types scripts/perf-live.mjs   # in a second shell
```

## 8. Column windowing, at the trigger size

### 8.1 The re-measure the idea asks for, before any code

Run first, on this machine, against 0.8.0 (`tests/perf-board.test.tsx`,
`IDEAS_PERF=1`). These are the numbers that justified the deferral, re-measured
rather than remembered:

```
[perf-board] mount 140 cards (1113 KiB bodies): 282.01 ms + config settle 81.99 ms
[perf-board] DOM after mount: 7101 nodes, 140 distinct cards, 140 markdown regions, heap delta 42.2 MiB
[perf-board] idle poll (lean wire, same revision -> bailout): 1.93 ms | changed poll: 55.55 ms
[perf-board] search keystroke: hit "triage" 173.07 ms, miss 27.98 ms, clear 175.01 ms
[perf-board] scope "all workspaces" -> one workspace (51/140 cards): 39.93 ms
[perf-board] switch to Priorities (100 ranked rows): 98.00 ms | Delivered: 18.34 ms | back to Overview: 175.63 ms
[perf-board] filter scan over 140 rows: 0.07-0.36 ms/keystroke (cold excerpt | deep whole body)
[perf-board] ordering at 420 ideas (open=300): orderIdeas 0.02 ms, groupedIdOrder 0.09 ms, rebuildOrder 0.13 ms
```

**Verdict on the deferral gate: still deferred for an ordinary board, and that
is the honest answer.** At 140 ideas the column is not slow; nothing here
argues otherwise. The recorded figures match the ones this document already
carried (0.07-0.41 ms scans, <=0.12 ms sorts at 420), so the deferral was
recorded accurately and the measurements still hold on this machine.

The Open column of a live board holds ~37 ideas, not 500. So the idea's own
"if the Open column has not actually reached the threshold, deliver the hint and
stop" branch applies to *today's* board — and the hint **was** delivered
(`board.openColumnNotice`, at 300 open ideas). The virtualization was built
anyway, because the brief's "Done when" is explicit and testable: *the Open
column holds 500 cards and stays responsive*. Both halves ship, and neither
claims the other.

### 8.2 The A/B at 500 cards

`tests/perf-virtual.test.tsx` (also `IDEAS_PERF=1`). The fixture is the
generator re-run at `PERF_VIRTUAL_OPEN_COUNT = 500` open ideas, so the data is
identical in shape and seeded identically (540 records, 4212.2 KiB of bodies,
p50 6276, p90 17707).

The A/B is on the **same component and the same data**: jsdom is given a layout,
and the only thing that differs between the arms is the height it reports for
the column. A viewport tall enough to cover 500 rows *is* the pre-#108
behaviour, measured on the shipped component rather than reconstructed.

```
[perf-virtual] fixture: count=540 bodies total=4212.2 KiB p50=6276 p90=17707
[perf-virtual] mount 500 open cards (viewport 1000000px): 893.37 ms, 29276 DOM nodes, 500 cards painted, header 500
[perf-virtual] mount 500 open cards (viewport 640px):      105.83 ms,  2121 DOM nodes,  10 cards painted, header 500
[perf-virtual] scrollable column height: 115.0 KiB px     (identical in both arms)
[perf-virtual] changed poll (revision bump, commit): 24.19 ms
[perf-virtual] scroll the window across 5 positions: 43.44 ms, 17 cards painted at the end
```

A repeat of the same gate gave 881.54 ms / 101.58 ms and a 28.92 ms changed poll.
A third run, taken later with **four DSH hosts live** on the machine (3080, 3090,
3199 and the 3207 acceptance instance), gave 905.02 ms / 163.96 ms and a 26.11 ms
changed poll — the same shape, with the windowed arm moving the most because it
is the shorter one and therefore the most sensitive to contention.

So the honest reading of the timings is a **range, not a point**, and the claim
that survives every run is the deterministic one: **node counts and card counts
reproduced exactly on all three runs** (29 276 / 2 121 / 500 / 10 / 115.0 KiB px).
The -88% below is stated against the quiet-machine pair; against the contended
pair the same run is -82%, which is the floor worth quoting.

| measurement at 500 open cards | fully painted | windowed | delta |
|---|---|---|---|
| mount (jsdom, JS + DOM mutation) | 893.37 ms | 105.83 ms | **-88%** |
| DOM nodes after mount | 29 276 | 2 121 | **-92.8%** (7.2% of the baseline) |
| cards painted | 500 | 10 | -98% |
| column header count | 500 | 500 | unchanged, on purpose |
| scrollable column height | 115.0 KiB px | 115.0 KiB px | unchanged, on purpose |

The two "unchanged, on purpose" rows are the load-bearing ones: **the window
does not shrink the column, it only decides what is drawn.** The scrollbar is
the same height, the count in the corner is the same number, and the drag anchor
and the selection scope are still built from all 500 rows.

### 8.3 The cost at 140 cards, measured as a PAIRED before/after

This is the number that matters most, because most boards are not at the trigger.
Measured **four runs each, back to back on this machine**, by stashing the change
(`git stash push`), running `tests/perf-board.test.tsx`, and popping it. The
Open column holds 100 rows; jsdom reports `clientHeight === 0`, and an
unmeasurable viewport paints the whole column **by design**, so this arm measures
the feature being present but inactive.

| 140 cards (100 open) | before | after | delta |
|---|---|---|---|
| mount (median of 4) | **279.4 ms** (275.10 / 276.89 / 281.63 / 285.17) | **332.2 ms** (326.43 / 329.97 / 334.78 / 341.59) | **+52.8 ms (+19%)** |
| DOM nodes after mount | 7 101 | 7 105 | +4 (one sizer div per column) |
| idle poll | 1.15-2.43 ms | 1.09-3.53 ms | unchanged |
| **changed poll (the 2.5 s recurring cost)** | 48.79-52.36 ms | 48.45-49.62 ms | **unchanged** |
| ordering at 420 ideas | rebuildOrder 0.13 ms | rebuildOrder 0.12 ms | unchanged |

**This is a real cost and it is stated rather than buried.** It was traced, not
guessed:

- A stage probe over `useVirtualColumns` measured the hook's own work at
  **1.5 ms** in total (0.95 ms render, 0.33 ms card refs, 0.17 ms entries,
  0 ms measurement). The geometry is not the cost.
- An experiment that kept the new DOM shape but disabled the geometry entirely
  landed at ~292 ms. The ~40 ms that remained is therefore **one extra full
  board render**, caused by the commit-phase correction: the first render can
  only guess the viewport (see the fallback order in `docs/architecture.md`),
  and the scroller ref callback re-renders once with the real one.
- That render is **inherent**, not waste: the alternative is a first render that
  either builds all 500 cards or waits for the DOM, and both are worse. It is
  paid once per panel open, before the browser paints.

A memoization pass on the size estimate (keyed on row identity) was tried
against this number and **measured no gain**; it was removed rather than kept as
unjustified complexity. A guard that re-renders only when the correction actually
moves the window was kept: it cannot help the first mount (where the cached view
is empty by definition) but it does save the render when a column re-attaches
with the viewport it already had.

**The trade, stated plainly:** +53 ms once when you open a panel holding 140
cards, to make a 500-card column open in 106 ms instead of 893 ms and carry 7% of
its DOM. The recurring 2.5 s poll — the cost that runs for as long as the panel
stays open — is unchanged at every size.

### 8.4 What did NOT change

- **The wire.** Nothing. `idea-108-wire.test.ts` pins the action envelope, the
  default full `GET /state`, the two projections and the `import`/`export`
  round-trip against a real loopback Host.
- **The scan and sort costs.** The windowing layer is downstream of them: 0.07-0.36
  ms per keystroke and 0.12 ms of ordering at 420 ideas, exactly as before. A
  server-side index is still not justified by anything measured here.
- **A short column.** Below 40 rows the board paints every card and behaves
  exactly as it did, which is why all 1 076 tests pass unchanged except the one
  DOM helper that reached for the column's direct children.

### 8.5 Where the real-browser gain is larger than the jsdom gain

jsdom measures main-thread JavaScript and DOM mutation only: no style, no
layout, no paint. The 893 ms -> 106 ms mount gap is therefore the **CPU** half of
the cost. The half virtualization actually removes is the other one — a real
browser has to lay out and paint 29 276 nodes instead of 2 121 on every commit
that touches the column, and 500 markdown blocks instead of 10. That is the part
this document cannot measure and the part that made the column actually crawl.
