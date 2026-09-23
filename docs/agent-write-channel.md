# Agent write channel (Phase 2)

The ideas ledger is the single source of truth; every mutation goes through
the Host `/api/ideas` surface, never through a markdown file. This page is the
contract an **agent session** (or any loopback caller) must follow to read and
mutate the ledger programmatically — the same channel the Phase 3 "Start AI
analysis and create the idea" flow drives, and the one the migration script
uses.

No plugin change is required for the channel itself: it is the already-shipped
REST surface, validated end-to-end by the Phase 2 spike (see below).

## Endpoints (all under `IDEAS_API_PREFIX = /api/ideas`)

| Method | Path            | Purpose                                                        |
| ------ | --------------- | -------------------------------------------------------------- |
| GET    | `/api/ideas/state`  | Full snapshot `{ revision, ideas: IdeaRecord[] }`, `no-store` |
| POST   | `/api/ideas/action` | Apply ONE action, returns the resulting snapshot (200)        |
| GET    | `/api/ideas/events` | SSE stream: full snapshot per event + 15 s heartbeat           |

## Fence

Every request must come from loopback **and** carry a browser same-origin
signal — a bare `curl` without markers gets `403`:

```http
Origin: http://127.0.0.1:<port>
Sec-Fetch-Site: same-origin
```

This is the sibling-plugin discipline (task-board / ssh family): a tripwire
against stray local tooling, **not** an authority check — any local process can
forge these headers. The agent is the same user on the same machine, so this
is the accepted trust boundary. Content-type must be `application/json`
(`415` otherwise).

## Envelope

```jsonc
{
  "requestId": "uuid-or-fresh-token",        // required, <= 256 chars, unique per logical mutation
  "action": { "kind": "...", /* verb fields */ },
  "initiator": "agent:session-<id>"          // optional, <= 256 chars, recorded by the host
}
```

- **`requestId` is the idempotency key**: replaying a request id returns the
  current state WITHOUT re-applying the mutation (dedupe survives restarts —
  the persisted request cache). Generate a fresh value per new mutation.
- `initiator` is a free-form tag the caller can use to stamp its writes
  (e.g. the session id); it is accepted for parity and recorded by the host.
- Unknown envelope keys are rejected (`400 invalid-action`).

## Verbs (the exact-keys surface of `parseActionEnvelope`)

| kind        | Fields (besides `kind`)                            | Effect |
| ----------- | -------------------------------------------------- | ------ |
| `create`    | `id`, `input: { title, body, summary?, tags?, value?, effort?, rationale?, rank?, workspaceId? }` | New open idea; `workspaceId` absent = generic group; `summary` = compact abstract (<= 300 chars) |
| `update`    | `ideaId`, `patch: { title?, body?, summary?, tags?, value?, effort?, rationale?, rank?, workspaceId? }` | Plain field update (no re-rank); `summary` null/blank clears |
| `triage`    | `ideaId`, `patch: { value?, effort?, rationale?, rank? }` | Priority opinion; re-ranks the idea's OWN workspace group transactionally |
| `move`      | `ideaId`, `status: open \| underReview \| archived` | Column move |
| `deliver`   | `ideaId`                                          | Archive + delivery stamp |
| `decline`   | `ideaId`, `decision?`                             | Reject |
| `followUp`  | `ideaId`, `input: { title, body }`                | Review rejected: child idea + parent archived |
| `restore`   | `ideaId`                                          | Reopen an archived/under-review idea |
| `delete`    | `ideaId`                                          | Remove the record |
| `reorder`   | `orderedIds: string[]`                            | Re-derive per-(status, workspace) group ranks from the list order |
| `import`    | `sourceId`, `ideas: IdeaRecord[]`                 | Bulk import (2 MiB limit, migration path) |
| `export`    | `workspaceId?`                                    | Return generated `IDEAS.generated.md` / `IDEAS-ARCHIVE.generated.md` |

## Rank semantics (relative per workspace)

`rank` is a position INSIDE the idea's own `(status, workspace)` group — the
workspace-less ideas form one generic group. A `triage` re-ranks only that
group; other groups and the closed columns keep their ranks. The `reorder`
verb re-derives every group's ranks from the appearance order of the wire
list. Imported ideas carry the author's suggested rank; no data migration is
needed for relative ranks.

## Limits and errors

- `ACTION_LIMIT = 64 KiB` per action body (`413 body-too-large`), except
  `import` (`2 MiB`).
- Errors: `400 invalid-action` / business message (unknown id, bad title,
  follow-up on a non-under-review idea, …), `403 forbidden` (fence),
  `405 method-not-allowed`, `413 body-too-large`, `415 json-required`.
- Success (`200`) body = the resulting snapshot `{ revision, ideas }` (the
  `export` verb returns `{ ok: true, export }` instead). The caller can read
  the new revision / idea state directly from that response — no second GET.

## Reference example (Node 18+, matches the Phase 2 spike)

```js
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'

const base = new URL('http://127.0.0.1:3101')
const headers = {
  origin: base.origin,
  'sec-fetch-site': 'same-origin',
}

function post(path, body) { /* fetch-style helper, headers + content-type: application/json */ }

// 1. Snapshot
const state = await post('/api/ideas/state')                    // GET
// 2. Capture with a priority opinion (rank 1 of its workspace group)
const created = await post('/api/ideas/action', {
  requestId: `ideas-${randomUUID()}`,
  initiator: 'agent:my-session',
  action: { kind: 'create', id: `idea-${randomUUID()}`, input: {
    title: '…', body: '…', workspaceId: '…', value: 4, rank: 1 } },
})
// 3. Read the verdict straight from the response
const rank = created.ideas.find(idea => idea.id === createdId)?.rank
```

## Phase 3 — AI capture (board → analysing session)

The board's "Start AI analysis and create the idea" button (workspace-targeted
captures only; known-to-app workspaces) hands the captured idea to a fresh DSH
session instead of creating it manually:

1. The modal closes immediately — non-blocking, nothing stays pending.
2. The plugin calls `sessions.create({ workspaceId })` then
   `session.prompt([{ type: 'text', text }], 'queue')` on the resolved session
   face (`scope` → `sessionOf`), both duck-typed and optional — an absent
   service keeps the plain manual Create.
3. The launch prompt is MINIMAL: it carries only what the skill cannot know —
   the captured idea, the workspace (title + id), the priority hints, and the
   server **origin** (dynamic per instance). The analysis methodology AND the
   full write-channel contract live in the **`ideas-analyst` skill** the Host
   installs at `<dshHome>/skills/ideas-analyst/SKILL.md` (user-dsh root, rank
   400 — every session sees it, whatever the workspace). The session loads it
   from the `available_skills` catalog and follows it; if the file is missing,
   a one-line fallback in the prompt points it at the origin and asks it to use
   its own judgement.
4. The session writes exactly through the channel the skill documents
   (initiator `plugin:ideas-manager:ai-capture`, fresh requestId per action),
   reads the `id` / `ideaNumber` from the response (re-reading the state to
   confirm value/effort/rank/rationale landed), decides value/effort (1..3) and
   a PER-WORKSPACE rank via the `triage` verb, then reports the ranking
   decision to the human in the requester's language (English by default).

### Skill-as-file design (decision, P3 refinement)

Splitting the analyst prompt into a minimal prompt + an installed skill:

- **Why a skill file**: the methodology (body structure, title policy, tag
  rules, per-workspace rank semantics) AND the write-channel contract evolve
  without touching the prompt, the plugin code, or the prompt-fidelity tests;
  it matches the task-board precedent (`<projectRoot>/.dsh/skills/task-board/
  SKILL.md`); and any agent session in the workspace can read it directly. The
  prompt stays thin and free of duplication.
- **Installation**: `src/skill-install.ts` writes the bundled skill
  (authored in `src/skills/ideas-analyst.ts`) to the user-dsh root on plugin
  activation. First-wins: a missing file is created, a present file is never
  overwritten (delete it to restore the bundled version); a divergent present
  file is logged. Best-effort — a read-only home never breaks plugin boot.
- **What stays in the prompt** (authored there, never in the skill): the
  per-capture data (workspace title + id, the human draft, the priority hints)
  and the server **origin** (dynamic per instance — only the page knows it).
  Everything else about the channel — headers, envelope, verbs CREATE/UPDATE/
  TRIAGE, the tags-objects/400 rule, the fresh-requestId/dedupe rule, the
  UTF-8 guidance — is FIXED and lives in the skill. Keeping the contract in
  the skill (single source) is what lets the prompt be minimal; the wire gate
  (`isIdeaTagList`, `parseActionEnvelope`, ACTION_LIMIT) is what enforces it
  server-side regardless of where the docs live.
- **Resolution precedence** (lowest rank wins): project `.dsh/skills` (100)
  beats the user-dsh install (400), so a project copy always wins over the
  plugin's default.
- **Frontmatter is parsed as strict YAML**: a skill whose frontmatter does not
  parse is silently dropped from the catalog (the provider logs
  `skill file ... ignored: invalid YAML frontmatter` and skips it). Keep
  `whenToUse:` a plain scalar (quote-free start, internal quotes fine —
  exactly like `task-board/SKILL.md`); a value that opens with `"..."` and
  then continues with unquoted text is invalid YAML and the skill never
  appears. A changed file is picked up without a restart (the skill-filesystem
  watcher invalidates), since the user-dsh root is scanned on every session
  catalog build.
- **No backticks inside the skill**: the SKILL.md is authored inside a TypeScript
  template literal, so any backtick in its body breaks the build (TS1005). Keep
  code examples on 4-space-indented lines and never use backtick fence/emphasis.

Workspace-less captures always keep the plain manual Create.

## Phase 2 spike results (port 3101, test instance)

- Bare request without marker headers: `403`.
- Agent-style Node caller (Origin + `sec-fetch-site` + `initiator`): create
  `200`, triage (rank/value) applied, replay of the same `requestId`
  **deduped** (revision stable), delete cleanup — ledger returned to its exact
  prior state (35 ideas, no residual rows).
- Serving: the DSH client bundle is re-resolved per request; server-side
  plugin code (host routes/ledger) requires a server restart to pick up
  changes — irrelevant here since the channel ships unchanged.
