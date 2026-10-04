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

## Host APIs move: probe by NAME, and never by property

This plugin is compatible from **DSH 0.1.5-rc.1** (`package.json` →
`dsh.engines.dsh`), so every host face it uses is a moving target. The failure
mode is specific and nasty: **a wrong NAME is not a feature that degrades, it is
a feature that is silently dead** — and the test suite stays green, because the
fake handed to the resolver is the shape you wished for rather than the shape the
page has. That cost two real bugs: a session link that never appeared (the probe
asked for `sessions.open()`, a method the host's `sessions` store never had) and
a property read that cordis refuses.

So, whenever you touch a host-facing call:

1. **Read services with `ctx.get(name)`**, never `ctx[name]` — an undeclared
   property read THROWS. `panel-navigation.ts` documents the lesson; a property
   read survives only as a deliberate second chance (`readServiceFace`).
2. **Probe every name the supported range may serve, most current first** (the
   settings section already has this dual-path shape: `register` vs
   `SettingsForms`). Keep the old name when it costs one line.
3. **Warn when nothing resolves.** An absent face must say so, so a wrong name is
   distinguishable from an unsupported deployment.
4. **Make the fake `get`-shaped**, like a real context. A plain-object fake
   cannot catch a wrong accessor, which is the bug.
5. **Verify the name against an installed DSH** rather than from memory:
   `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*/lib/types/**/*.d.ts`
   declares every `Context` key and every service method (`layout.selectPanel`,
   `uiWorkspace.openSession`, …). Reading those `.d.ts` files is how the session
   link was found and the `commands.execute` fourth argument was confirmed.
6. **A host method that grew a REQUIRED argument** is fixed by passing the extra
   one (older hosts ignore extras), never by narrowing the call — see
   `src/command-dispatch.ts`.

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

## Does this change the SKILL's surface?

**The ideas-analyst skill is a prompt pinned by string assertions, and it is
installed to `~/.dsh/skills/` on first run.** So a field added to the write
channel is invisible to the AI until the skill text names it — and that gap has
no symptom except "the AI doesn't use the new feature".

If your change adds, renames or removes a field the skill may **write**
(`IdeaAction` patches, `create` input, `triage`), then:

1. extend `src/skills/ideas-analyst.ts` — the verb example, the rules, and the
   derived/refused fields it must never send (`blockedBy`, `runStatus`,
   `runSessionId`, `taskBoardId`);
2. extend the field literal in `tests/session-queue.test.ts` ("KNOWS every patch
   field this plugin offers"), which fails when the skill does not name it;
3. remember the **tag `promptPrefix`**: the patch replaces the WHOLE tag list, so
   a tag the skill keeps must come back with its `promptPrefix`, or a
   human-written launch instruction is erased without a word.

The install path itself needs no bookkeeping: it always writes the bundled
prompt and keeps what it replaced beside it (`SKILL.md.<stamp>.bak`, the five
most recent), so a new release needs no digest list and no migration step.

## Toolchain

`pnpm run <script>` **wipes `node_modules`** here (pnpm 12.3.4). Call the tools
directly:

```sh
node node_modules/typescript/lib/tsc.js --noEmit      # typecheck
node node_modules/typescript/lib/tsc.js -p tsconfig.build.json && node node_modules/tsdown/dist/run.mjs  # build
node node_modules/vitest/vitest.mjs run                # tests (add IDEAS_PERF=1 for the opt-in perf gates)
```

`lib/` is committed: a release commit ships the rebuilt bundles and types.

**Never round-trip a source file through PowerShell.** `Get-Content -Raw` +
`[IO.File]::WriteAllText` reads UTF-8 as the ANSI code page and writes every
em-dash back as `â€"` — silently, with every test still green. Use `read`/`edit`
for source, and `node scripts/scan-mojibake.mjs` after any scripted rewrite.

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
- **The release gesture**: write the user-facing `CHANGELOG.md` section, bump
  `version`, rebuild `lib/`, commit, tag `vX.Y.Z`, push `main` **then** the tag —
  the tag is what publishes to npm. Never publish npm by hand: it is immutable
  and provenance comes from the workflow. A changelog corrected after the tag can
  only reach the **GitHub Release body**, never npm; re-derive it by dispatching
  the `release` workflow with `tag: vX.Y.Z` (it edits the body and skips npm).
  Note that npm's registry metadata can lag a successful publish by several
  minutes: a 404 right after the run is not proof that the publish failed.
- Never deploy, install or test on the live instance; use `dsh web --port <free>`
  with its own `DSH_HOME`.