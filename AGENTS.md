# AGENTS.md — working on dsh-plugin-ideas-manager

Project instructions for an agent editing this repository. The
[README](README.md) is what an installed user reads, [SKILL.md](SKILL.md) is the
end-to-end wire contract, and [docs/architecture.md](docs/architecture.md) is
where the design decisions live. **All code comments and documentation in this
repository are written in English**, whatever language the conversation is in.

## The contract this plugin does not break

- **The wire is frozen.** `POST /api/ideas/action` and the default (full)
  `GET /api/ideas/state` response are a published contract. Anything new is
  additive: a new route, an optional field, a new read view. Read
  [SKILL.md](SKILL.md) before touching `src/protocol.ts` or any `ideas_*` tool.
- **The ledger is Host-authoritative and single-writer.** Never hand-edit
  `~/.dsh/ideas/ledger-v2.json`, never write beside a live ledger. A test
  instance needs its OWN `DSH_HOME` (a shared home has destroyed this ledger
  before), and never the live one.
- **The board is a view, the ranking is the author's.** Display preferences are
  never written onto an idea, and the 2.5 s poll must never be able to undo a
  choice the human made.
- **No bulk-only verb, no ledger edit for a batch.** A batch is a sequence of the
  ordinary per-idea verbs (see `src/client/bulk.ts`).

## Before you release: does this change the backup surface?

**This plugin grows a feature almost every release, and a backup is only as good
as the field surface it carries.** If your change adds, removes or renames a
**persisted field on an idea record** (`IdeaRecord` in `src/core/ideas.ts`, or
anything the ledger writes under `~/.dsh/ideas/ledger-v2.json`), then the
backup/restore surface is part of the change. Concretely, check all of:

1. **`KNOWN_IDEA_FIELDS`** (`src/host-ledger.ts`) lists every key the record
   reader copies. Add yours. A field the reader does not know is **dropped on
   restore**, and the restore reports it in `unknownFields` — a silent loss is
   the failure mode this whole mechanism exists to prevent.
2. **`tests/idea-95-backup.test.ts`** — the round-trip test pins the field
   surface with a literal list (`IDEA_FIELDS`) and asserts the fixture really
   carries all of it, and a second test asserts the literal equals
   `KNOWN_IDEA_FIELDS`. Extend the fixture **and** the list, or the suite fails
   and the release stops (that is the point).
3. **`tests/idea-95-backup-routes.test.ts`** — the restore route's contract,
   including the schema-version refusal.
4. **Bump `IDEAS_SCHEMA_VERSION`** (`src/protocol.ts`) **only** when an OLDER
   build must refuse a newer file rather than adopt it. Fields added without a
   bump are fine (a file that predates a field simply lacks it, and the reader
   fills it on the first write that needs it) and keep old backups restorable;
   a bump makes a NEW build refuse every OLD backup, which is the one way a
   backup feature becomes useless.
5. **Export must stay host-side.** The portable export is the ledger's own
   document, written through the ledger. A client-side projection would silently
   omit whatever the list projection drops (bodies, analyses, events) — never
   build the export from `IdeasClient`'s list rows.

If your change adds a field that only ever exists in memory (a client patch
type, a view preference, a display mode), nothing above applies — say so in the
commit body so the next reader does not have to guess.

## Toolchain

`pnpm run <script>` **wipes `node_modules`** here (pnpm 12.3.4). Call the tools
directly:

```sh
node node_modules/typescript/lib/tsc.js --noEmit      # typecheck
node node_modules/typescript/lib/tsc.js -p tsconfig.build.json && node node_modules/tsdown/dist/run.mjs  # build
node node_modules/vitest/vitest.mjs run                # tests (add IDEAS_PERF=1 for the opt-in perf gates)
```

`lib/` is committed: a release commit ships the rebuilt bundles and types.

## House rules

- A bug fix lands with the test that would have caught it; a feature lands with
  its coverage. The perf gates assert correctness, never a wall-clock threshold.
- User-facing behaviour goes in `CHANGELOG.md` (written for the person using the
  plugin) and, if it changes the visible surface, in the README — which stays
  user-facing: no issue numbers, no design archaeology. Internal reasoning goes
  in `docs/architecture.md`.
- Copy ships in **all three** dictionaries (`fr`, `en`, `zh` in
  `src/client/locales.ts`); a key added to one and not the others fails the
  typecheck.
- Local commits are fine. **Never push, tag or publish** without the user saying
  so in the session.
- Never deploy, install or test on the live instance; use `dsh web --port <free>`
  with its own `DSH_HOME`.