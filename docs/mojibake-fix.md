# Mojibake in analyst-generated titles / descriptions (idea #55)

The Ideas board sometimes showed mojibake in the titles and descriptions that
the `ideas-analyst` session produces. This page records the root cause, the
fix, and the cleanup of the cards that were already corrupted.

## Symptom

Cards on the ledger carried U+FFD replacement characters in their title /
body / summary / rationale — e.g. `standardisée` was stored as `standardis`,
one replacement character, then `e`. The corruption was visible in every read
(board, export, TaskBoard mirror) because it lived in the persisted value, not
in the display.

## Root cause

The ledger is written through `POST /api/ideas/action`, and the request body is
decoded at the source-of-truth boundary by `readBody` in `src/host-routes.ts`.
That decode was a naive `Buffer.concat(chunks).toString('utf8')`.

The `ideas-analyst` agent runs in a PowerShell 5.1 session on Windows. PS 5.1
sends a `-Body <string>` in the system ANSI codepage (windows-1252 on Western /
European locales) unless the caller explicitly passes
`[Text.Encoding]::UTF8.GetBytes(...)` bytes. A single accented byte (e.g.
e-acute = `0xE9`) is an invalid UTF-8 lead byte, so Node's lenient
`toString('utf8')` replaced it with U+FFD — and that replacement is LOSSY: the
original byte is gone, so the corruption was persisted into the ledger and can
never be recovered from storage.

This is why the bug was intermittent: it depends on which transport the agent
used (in-memory UTF-8 bytes = clean; a PS 5.1 string body = corrupted). The
`ideas-analyst` SKILL.md already told the analyst to send UTF-8 bytes, but that
is a mitigation — the server had no way to refuse or repair a mangled body.

## The fix (source of truth)

The decode now lives in `decodeRequestBody` (`src/http.ts`) and is applied by
`readBody` before `JSON.parse`:

1. If the bytes are valid UTF-8 (the common case, including CJK), decode as
   UTF-8 — byte-for-byte identical to the previous behavior, so no regression
   for correct clients (browser, Node fetch, migration scripts).
2. Otherwise the stream is a raw ANSI codepage (the PS 5.1 trap): decode as
   windows-1252. This recovers the Latin-1 accented letters AND the CP1252
   printable characters in `0x80..0x9F` (curly apostrophes / quotes, o-ligature,
   euro). Every byte is defined in windows-1252, so there is never an unknown
   byte.

The fix is conservative: valid UTF-8 is never reinterpreted (no false repair of
correct text); only genuinely-invalid UTF-8 is re-decoded. It is also localized:
one decode helper + its call sites, no ledger migration, no interface change.
`readBoundedJson` (the shared body reader) uses the same helper so the bug class
cannot resurface there. The ACTION_LIMIT size check now uses the received byte
count rather than the re-encoded length of the decoded text.

The `ideas-analyst` SKILL.md documents this as defense in depth: sending UTF-8
bytes is still the contract (the only encoding that carries every codepoint,
including CJK), but a stray single-byte accent is no longer lost to mojibake.

## Round-trip tests

`tests/encoding-round-trip.test.ts` pins the fix at the source-of-truth boundary
and proves the full round trip — intended text -> POST bytes -> stored ledger
file -> `GET /api/ideas/state` re-read — for BOTH transports:

- valid UTF-8 (French + CJK + curly quotes) round-trips intact;
- an ANSI (PowerShell 5.1) byte stream is recovered instead of corrupted to
  U+FFD, with the ledger file holding correct UTF-8 and no replacement char.

## Existing corruption + cleanup (executed 2026-09-24)

Two production cards were already corrupted before the fix landed (the
information is lost, so they cannot be auto-repaired):

| idea | id                     | status | corrupted fields            |
| ---- | ---------------------- | ------ | --------------------------- |
| #53  | `d1e2f3a4-b5c6-7890-defa-bc1234567890` | open | body, summary, rationale    |
| #54  | `6aedc6f8-a3cb-43c2-b8fc-f38c873f4870` | open | title, body, summary, rationale |

To detect corruption in any ledger, run:

```
node scripts/scan-mojibake.mjs <ledger.json>
```

It flags every string field carrying a U+FFFD replacement character or a
double-encoded UTF-8 signature. Exit code 1 when any field is flagged.

Because U+FFD is lossy, the clean path is a controlled re-analysis of each
affected card (the `reanalyze` verb, idea #30 flow): it snapshots the prior
content into the card's `analysisAudit` trail, then rewrites title / body /
summary / tags / rationale with fresh UTF-8 content. Re-analyzing through the
board UI is preferred over a manual edit because it preserves history and the
new run lands clean (and, with this fix, even slips into an ANSI transport are
recovered). Do not auto-mutate the production ledger from tooling — the
re-analysis is deliberate and traceable.

Both cards were re-analyzed on 2026-09-24 via `scripts/reanalyze-53-54.mjs`,
which posted `reanalyze` (snapshotting the prior corrupted content into
`analysisAudit`) then `update` with corrected UTF-8, for each card. #53's
title / body / summary / tags came from the clean create fixture
(`create_idea2.json`, verified to match the stored content modulo U+FFD); its
rationale and all of #54's fields were reconstructed from context (each U+FFD
is unambiguous in French). The cards' main fields are now clean; the scanner
still flags only their `analysisAudit` trail, which deliberately preserves the
prior corrupted content for traceability.
