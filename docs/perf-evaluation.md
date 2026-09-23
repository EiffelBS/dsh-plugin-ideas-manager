# Idea #34 - Ideas panel under high card load: performance & scalability evaluation

Status: evaluation DONE, corrective work LANDED (local, not pushed), deferred
evolutions recorded with their numbers. This document records the method, the
verbatim before/after measurements, what changed, and the explicit decision
per spec layer ("correctif prioritaire ou une evolution differee").

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
