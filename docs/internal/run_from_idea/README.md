# Run from idea — analysis & implementation plan

Internal design note for the **"Launch execution"** capability: start a TaskBoard
task run directly from an idea card, with an explicit model choice, and let the
board pick up the `done` → *Under Review* transition it already knows how to
observe.

- **Scope (v1)**: TaskBoard plugin present on the same process (the current
  reality of the `web` profile).
- **Scope (v2)**: launch a chat session *directly* from an idea with
  no TaskBoard at all. It shipped as P6, additive behind the same route.
- **Status**: v1 (P0–P5) and v2 (P6) IMPLEMENTED — bridge `launchTask`, the
  `runStatus` / `runSessionId` system fields, `POST /api/ideas/launch` with
  HOST-side backend resolution, the card backend and the direct-session backend
  (`session-runner.ts`), and the green Launch button.
- **Tracked as**: idea *Run from idea…* in workspace `dsh-plugin-ideas-manager`
  (see §10).

---

## 1. Executive summary

| Question | Answer |
| --- | --- |
| Can the plugin find the associated task? | **Yes.** Deterministic card id `idea-<idea.id>`, persisted binding `idea.taskBoardId`, snapshot read via `GET /api/task-board/state`, 6-branch `ensureTask()` ladder, 30 s status poll. |
| Can it launch the run today? | **No.** The local action union is `create \| update \| move \| archive \| restore` (`src/taskboard-bridge.ts:57`). Nothing ever posts `run`. |
| Does the capability exist on the TaskBoard side? | **Yes.** `POST /api/task-board/action` accepts `{kind:'run', taskId}` and `{kind:'rerun', taskId}` and the Host launches a real session for it. |
| Can a model be passed? | **Yes, but never inside `run`.** `run`/`rerun` accept exactly `['kind','taskId']`. The model lives on the **task** (`create.input.model` / `update.patch.model`, format `provider/model`) and is pinned by the runner right before the prompt. |

---

## 2. Verified TaskBoard contract (`@linxin666/dsh-client-ui-task-board@0.3.24`)

Everything below was read from the installed bundle used by the `web` profile
(`node_modules/@linxin666/dsh-client-ui-task-board/lib/{index,client}.js`).

### 2.1 Routes (prefix `TASK_BOARD_API_PREFIX = "/api/task-board"`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/state` | full snapshot `{ schemaVersion, revision, tasks[], scheduler, power, sessionDefaultPermission }` |
| POST | `/action` | apply ONE action envelope, returns the new snapshot |
| GET | `/events` | SSE revision stream |
| POST | `/parse` | LLM natural-language → task draft |

Guard: `isTrustedTaskBoardRequest` (loopback + same-origin markers), same fence
as ours. Body cap `ACTION_LIMIT` (non-`import`), `400 invalid-action` on any
exact-keys violation.

> ⚠️ **Version caveat**: the `desktop` profile carries `0.1.18`, which registers
> `/api/dsh-task-board/*` only (ledger GET/PUT/DELETE + events + scheduler) and
> has **no `/action`, no `model`, no `run`**. On that profile our mirror probe
> (`GET /api/task-board/state`) fails and the whole bridge is a silent no-op.
> Every statement in this document is 0.3.x.

### 2.2 Action union (`parseEnvelopeAction`)

Envelope: exact keys `['requestId','action','initiator']`, `initiator` optional.

| kind | accepted keys | effect |
| --- | --- | --- |
| `import` | `sourceId`, `tasks` | bulk merge (2 MiB-ish path) |
| `create` | `id`, `input` | **`input` allows `title, description, prompt, workspaceId, mode, permission, schedule, freeze, handover, model, reuseSession, tags`** |
| `update` | `taskId`, `patch` | **`patch` allows the same minus `schedule`, plus `null` to clear** |
| `set-schedule` | `taskId`, `patch` | cron arm/disarm |
| `move` | `taskId`, `status` | manual target must be in `MANUAL_STATUSES = ['backlog','todo']`, and never *from* `running` |
| `delete` / `archive` / `restore` | `taskId` | lifecycle |
| `confirm-permission` | `taskId` | clears the elevated-permission gate |
| **`run`** | **`taskId`** | start an execution |
| **`rerun`** | **`taskId`** | `withStatus(task,'todo')` then start |

Statuses: `ALL_STATUSES = backlog | todo | running | done | failed`
(there is **no `open`** on the task side — `open` is an *idea* status).

### 2.3 The `model` field

- Accepted on **create** and **update**, plain string, `trim()`-ed
  (`normalizeTargetId`); `""` clears it, **`null` is rejected** (`400`).
- Format read by the runner: **first `/` splits `provider` / `modelId`**, no `/`
  means "model id only, keep session provider".
- The TaskBoard UI builds those ids from `session.modelCatalog()` as
  `` `${provider}/${model.id}` `` — **exactly what our `ModelChoice {provider, model}`
  maps to** (`src/client/session-queue.ts:300` reads the same RPC).
- `model` is **not** in `TASK_CONTENT_FIELDS` (`title, description, prompt`), so
  unlike the prompt it stays editable **after** the first execution, and a
  model-only patch does not touch `permissionConfirmedAt`.

### 2.4 Launch pipeline

```
POST /action {kind:'run'|'rerun', taskId}
  → HostTaskLedger.apply()        // gates, then startExecution() → status 'running'
  → service.apply(): if (result.run) this.scheduleLaunch(result.run)
  → HostExecutionRunner.launch(task)
       ├─ validates workspaceId against the registry
       ├─ validates mode (agent preset) when set
       ├─ session.create({workspaceId?, agentPreset?}) | reuse (reuseSession)
       ├─ session.rename(title)
       ├─ pinAndPrompt():
       │    /permission <task.permission>          (command dispatcher)
       │    session.selectModel({provider?, model}) ← THE MODEL PIN
       │    session.prompt([{text: promptText(task)}], 'queue')
       └─ ledger.attachSession(taskId, executionId, sessionId)
  → settle: task-board reconciles via session.list every SESSION_POLL_MS = 5 s
```

**Model pin is best-effort**: a rejected/unknown model logs a warning and the
run proceeds on the session default. Our `post()` currently discards the body,
so that failure is invisible from our side.

### 2.5 Run gates (`case "run"`)

Throws (→ `400` with `body.error`) when:

| Condition | Message |
| --- | --- |
| task missing, `status === 'running'`, or an open execution | `task is already running or missing` |
| archived | `archived task is read-only` |
| effective permission above session default without `permissionConfirmedAt` | `confirmation-required: …` |
| board disabled | `task board is disabled` (thrown by `service.apply` before the ledger) |

Our mirror creates every card with `permission: 'read-only'`, and
`DEFAULT_SESSION_PERMISSION = 'read-only'`, so **the confirmation gate never
trips for mirrored cards**.

### 2.6 Settle semantics (`settleExecution`)

| outcome | resulting status |
| --- | --- |
| `succeeded` | **`done`** — unless `schedule.enabled` → back to `todo` (recurring tasks) |
| `failed` | `failed` |
| `cancelled` | `todo` (if it was `running`) |

### 2.7 Observed latency

`task.startExecution()` → `running` immediately; `done` only after the
TaskBoard's own 5 s session reconciliation **plus** our 30 s
`UNDER_REVIEW_POLL_MS`. End-to-end **~5 s … 35 s** between "session finished"
and "idea moved to Under Review".

---

## 3. What the plugin does today (`src/`)

| Piece | Location | Notes |
| --- | --- | --- |
| Deterministic card id | `taskboard-bridge.ts:112` `mirrorCardIdFor()` | `idea-` + idea id |
| Duplicate guard ladder | `taskboard-bridge.ts:338` `ensureTask()` | 6 logged branches, get-before-create |
| Snapshot read | `taskboard-bridge.ts:380` `fetchTaskStatuses()` | `Map<id,status>`, `undefined` = absent/malformed |
| Action union | `taskboard-bridge.ts:57` | **no `run`** |
| Envelope post | `taskboard-bridge.ts:490` `post()` | **ignores `body`, only status is checked** |
| Run prompt (private) | `taskboard-bridge.ts:481` `taskPrompt()` | tag prompt lines, else derived mission prompt |
| Model field on the wire | `taskboard-bridge.ts:71/81` | **absent from both local types** |
| Mirror scheduling + per-idea chain | `host-service.ts:206/233` | strict per-idea ordering, never rejects |
| Status poll → Under Review | `host-service.ts:149` `pollUnderReviewTransitions()` | 30 s; stamps `taskBoardStatus`, moves on `done` |
| Binding persistence | `host-ledger.ts:276` `bindTaskBoardId()` | system field, wire-gated |
| Routes | `host-routes.ts:96-203` | `state`, `idea`, `action`, `events`, `config` |
| Host injection | `index.ts:23` | `inject = ['webServer','systemPrompt']` — **no session face on the Host** |
| Model picker (client) | `client/board-view.tsx:228` `useAnalystModelPicker`, `ModelPickerField` | reused by the re-analyze modal |
| Direct session launch (client) | `client/session-queue.ts:380` `launchAnalystSession()` | create → selectModel → prompt('queue') |
| Failed badge | `client/board-view.tsx:1817` | renders when `taskBoardStatus === 'failed'` |

---

## 4. Gap analysis (v1)

1. **No `run` action** in the local union, no method that posts it.
2. **No model field** in `TaskBoardNewTaskInput` / `TaskBoardTaskPatch`.
3. **No host route** through which the client can ask for a launch (the client
   must not call `/api/task-board/action` itself: the mirror is Host-owned).
4. **No error surface**: `post()` throws only on non-2xx status, never relays
   `body.error` (`confirmation-required`, `task is already running`, …).
5. **No UI affordance**: no button, no modal, no icon (icons are inline
   feather-style SVG, `board-view.tsx:69-156` — there is no icon library).
6. **Run-lifecycle state is card-shaped**: the Under Review transition reads
   `observed === 'done'` from the card. Nothing generic exists for a run that
   has no card (v2).

---

## 5. Design

### 5.1 One capability, two execution backends

```ts
// src/client/launch.ts (new)
export interface LaunchBackend {
  readonly id: 'taskboard' | 'session'
  available(idea: IdeaViewLite): Promise<boolean>
  launch(idea: IdeaViewLite, model?: ModelChoice): Promise<{ runId: string }>
}
```

- `taskboard` → Host route (§5.4) → `ensureTask` → `update{model}` → `run`.
- `session` (v2) → `launchAnalystSession()` with the shared prompt (§5.2).

The button/modal render from `resolveLaunchBackend(idea)`; adding v2 is then a
new class, **not** a component change.

### 5.2 Shared run prompt — extract `taskPrompt()`

Move `taskboard-bridge.ts:481` to `src/run-prompt.ts` as `runPromptOf(idea)` and
use it for (a) the mirrored card `prompt` and (b) the first message of a direct
session. The TaskBoard runs `task.prompt !== '' ? task.prompt : task.title`, so
the prompt *is* the run instruction; if the two backends diverge, an idea behaves
differently depending on whether TaskBoard happens to be installed.

### 5.3 Run lifecycle state — introduce it **now**

New **system fields** (host-written only, like `taskBoardId`; never accepted from
the wire), next to the existing `taskBoardStatus` which stays the raw mirror
observation:

```ts
runStatus?: 'running' | 'done' | 'failed'
runSessionId?: string
```

Then `pollUnderReviewTransitions()` → `pollRunTransitions()` with two sources:

```
if (idea.taskBoardId)  → GET /api/task-board/state   (v1, source A)
if (idea.runSessionId) → session observation         (v2, source B)
both write runStatus → move to underReview on 'done'
```

*Why now*: this touches `core/ideas.ts` (record + `isIdeaRecordShape`),
`protocol.ts` (selectable fields, length guards, lowercase normalization),
`host-ledger.ts` (row parse + setter), the projection and the export. Adding
that surface while v1 ships is one line per file; retrofitting it after
`taskBoardStatus` has been reused as a generic run status costs a migration.

### 5.4 Host endpoint

`POST /api/ideas/launch` (new route beside `config` in `host-routes.ts`), body:

```jsonc
{ "requestId": "<fresh uuid>", "initiator": "plugin:ideas-manager:launch",
  "ideaId": "…", "model": "provider/model" /* optional */ }
```

Handler (on the idea's mirror chain, `host-service.ts:233`):

1. `ensureTask(idea)` — reuses the whole duplicate guard.
2. `post({kind:'update', taskId, patch:{model}})` — **model-only patch**, never
   `taskPatch()` (§6).
3. `post({kind:'run', taskId})`.
4. Stamp `runStatus: 'running'` (+ keep `taskBoardStatus` flowing from the poll).
5. Return `{ ok, taskId, runStatus }` — relaying `body.error` on 4xx.

Keep the response contract backend-neutral (`{ok, runId, runStatus}`) so v2 can
serve the same route.

### 5.5 UI

- **Button** `Launch execution` + inline `IconPlay` (triangle, green) on the idea
  card action row (`board-view.tsx:683+` already hosts Re-analyze / Check /
  Archive / Decline / Restore).
- **Visible when**: `idea.status === 'open'` ∧ `idea.workspaceId !== undefined`
  ∧ `idea.taskBoardId !== undefined` ∧ `taskBoardStatus ∈ {backlog, todo}`.
  **Include `failed`** (decision D4, §8): `run` accepts it, and with
  `{backlog, todo}` only a failed card could never be relaunched from the board.
- **Hidden when**: card `running` (poll flips it ≤30 s), archived, idea not open,
  workspace absent, or `resolveLaunchBackend()` returns nothing.
- **Modal**: the existing re-analyze modal shape — `ModelPickerField`, model
  preselected from `currentModel()` (`matchSessionSelection`), "inherit session
  default" when the catalog is empty.

### 5.6 Degradation

`mirror.availableNow()` already handles "TaskBoard absent" (probe cached, 30 s
retry). The whole feature must degrade to *no button*, never to an error state —
same discipline as the rest of the bridge.

---

## 6. Pitfalls (from the verified contract)

| # | Pitfall | Consequence | Mitigation |
| --- | --- | --- | --- |
| P1 | Reusing `taskPatch()` to set the model | sends `title/description/prompt` = content patch → `task has already been executed` on any card that ran | model-only patch |
| P2 | `model: null` | `400 invalid-action` (`optionalString` rejects null) | omit the key, or `""` to clear |
| P3 | Sending `model` **on** the `run` action | `400 invalid-action` (`exactKeys(['kind','taskId'])`) | model is a task field, patch first |
| P4 | Ordering | run can beat the model patch | both writes on the idea's mirror chain |
| P5 | Card `running` / archived | `400 task is already running or missing` / `archived task is read-only` | pre-check status; surface `body.error` |
| P6 | Workspace id no longer registered | launch fails → settle `failed` | keep the "workspace required" UI rule |
| P7 | Patching the model mid-run | accepted, but a no-op (pin already happened) | disable the modal while `running` |
| P8 | Post-run `mirrorUpdate` | `task has already been executed` → logged, no rollback, spec no longer syncs to the card | accepted divergence, document it |
| P9 | Scheduling (cron) on the card | `done` never sticks (returns to `todo`) → never Under Review | mirrored cards never set `schedule` |
| P10 | Profile `desktop` (0.1.18) | no routes at all | feature gated on `availableNow()` |
| P11 | Model id containing `/` | only the first `/` splits → wrong provider | ids come from `modelCatalog()`, which qualifies them |
| P12 | Session default permission > card permission | `confirmation-required` | mirrored cards are `read-only`; if the session default is raised, we must POST `confirm-permission` first |

---

## 7. Implementation plan

Ordered so every step is independently testable and the mirror stays green.

### P0 — Refactors that cost nothing today
- [x] **Extract `runPromptOf(idea)`** → `src/run-prompt.ts`; bridge imports it.
      *Test*: existing `taskboard-bridge.test.ts` prompt cases keep passing.
- [x] **Relay errors from `post()`** → include `body.error`/`body.code` in the
      thrown `Error` message.
      *Test*: fake transport answering `400 {error:'task is already running…'}`.

### P1 — Bridge: the run verb
- [x] `TaskBoardAction` += `{kind:'run'; taskId}` (and `rerun` if we want a retry
      button later).
- [x] `model?: string` on `TaskBoardNewTaskInput` and `TaskBoardTaskPatch`.
- [x] `TaskBoardMirror.launchTask(idea, model?)`:
      `ensureTask` → `post(update{model})` (only when a model was chosen) →
      `post(run)` → returns the task id.
- [x] `createCard()`/`taskPatch()` unchanged (no model by default → session
      default, current behaviour).
- *Tests* (`tests/taskboard-bridge.test.ts`): happy path posts exactly
  `[update{patch:{model}}, run]`; no-model path posts `[run]` only; existing
  card adopted by `ensureTask`; `400 task is already running` surfaces the
  message; probe-absent throws `TaskBoardUnavailableError`.

### P2 — Run-lifecycle fields
- [x] `runStatus` / `runSessionId` on `IdeaRecord` + `isIdeaRecordShape`.
- [x] Host-only setter in `host-ledger.ts`; never in any wire patch.
- [x] `protocol.ts`: selectable field + guards (≤32 chars, lower-case like
      `taskBoardStatus`).
- [x] `pollRunTransitions()` = current poll + writes `runStatus` from the
      `taskBoardStatus` observation (source A), moves on `done`.
- *Tests*: `host-ledger` parse round-trip; poll stamps `running → done`;
  wire patch attempting `runStatus` is rejected.

### P3 — Host route
- [x] `POST /api/ideas/launch` in `host-routes.ts` (loopback + same-origin fence,
      `content-type: application/json`, `requestId` dedupe).
- [x] Service method `launchIdea(ideaId, model)` running the three steps on the
      idea's chain; auto-mirror-off → `409`/`400` with a clear message.
- *Tests*: `tests/host-routes.test.ts`-style — fence 403, 405, 415, unknown id,
  happy path (fake transport), replay dedupe, unavailable TaskBoard → `503`
  `taskboard-unavailable`.

### P4 — Client
- [x] `src/client/launch.ts`: `LaunchBackend` + `resolveLaunchBackend()`.
- [x] `IconPlay` (inline SVG, green) + button in the card action row.
- [x] Launch modal: `ModelPickerField` + preselect + "default model" option;
      disabled while `pending` or the card is `running`.
- [x] `ideas-client.ts`: `launch(ideaId, model)` → the new route; surface
      `body.error` as a toast/console line.
- *Tests*: `session-queue`-style unit tests for backend resolution; button
  visibility matrix (status × taskBoardStatus × workspace × availability).

### P5 — Docs & skill
- [x] README section (mirror contract now includes `run`).
- [x] `docs/agent-write-channel.md`: new verb/route row.
- [x] Analyst skill: mention that a launched idea is runner-owned.

### P6 — v2 (direct session) — IMPLEMENTED
- [x] `session-runner.ts` = the Host `typertGateway` RPCs (`session/create`,
      `rename`, `selectModel`, `prompt`) + `runPromptOf()`, instead of
      `launchAnalystSession()`. Host-side, not client-side: a direct run must
      survive a closed tab.
- [x] `runSessionId` persisted (`setRunSession`) + the run settled from the
      roster (`session/list` -> per-session `running` bit): stops running
      settles `done`, a vanished session settles `failed`, an unknown roster
      settles nothing.
- [x] Restart re-attach: the poll rebuilds its in-memory tracker from the
      persisted `running` + `runSessionId` pair.
- [x] Backend resolution lives in the HOST (`launchIdea`): card when the
      task-board plugin is present (minting the card when the idea has none),
      direct session otherwise — including a runtime fallback when the board
      turns out to be absent at click time. The browser cannot choose.
- [x] `canLaunch` no longer requires a bound card (a card that exists still
      constrains it); the modal states which of the two will happen.
- [x] One fresh session per launch (D5 settled): no reuse. A settled `done` run
      opens the review gate on both backends, so the gate no longer depends on
      the task-board plugin.
- [x] `tests/session-launch.test.ts` (19) + a route test for the card-less
      answer; live acceptance on a task-board-free profile (port 3102).

**Acceptance (v1)**: in a workspace-assigned open idea whose card is
`backlog`/`todo`, the green button opens the model modal; confirming patches
`model` then posts `run`; the card goes `running` (visible ≤30 s), the session
starts on the chosen model; on success the card settles `done`, our poll stamps
`runStatus`/`taskBoardStatus`, and the idea moves to **Under Review** within
~35 s; a failure settles `failed`, the badge shows and the idea stays **open**.

**Acceptance (v2)**: on a profile with NO task-board plugin, an open,
workspace-assigned idea with no mirrored card shows the button; confirming
answers `{ok, runId: <sessionId>}` with **no** `taskId`, stamps
`runStatus: 'running'` + `runSessionId`, and a real session runs; on success the
roster stops reporting it running, the poll settles `done`, clears
`runSessionId` and moves the idea to **Under Review** — verified live on port
3102 (settle ~35 s, no card, no task-board).

---

## 8. Open decisions

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Endpoint shape | dedicated `POST /api/ideas/launch` vs a new `IdeasAction` verb | dedicated route — a launch is not a ledger mutation and must not consume the action dedupe cache |
| D2 | Run fields | new `runStatus` vs reusing `taskBoardStatus` | new fields (v2 needs them; renaming later costs a migration) |
| D3 | Model persistence | model only on the card vs also stored on the idea | only on the card in v1 (no new idea field, no protocol churn) |
| D4 | Launchable statuses | `{backlog,todo}` vs also `failed` | **include `failed`** — otherwise a failed card is unrelaunchable from our board |
| D5 | v2 state across reload | UI-only vs persisted `runSessionId` | persisted; UI-only loses `running` on refresh |
| D6 | Explicit "stop"/cancel | out of scope vs add `cancel` | out of scope for v1 |

---

## 9. v2 impact assessment (direct session launch)

Reusable as-is: model modal + picker, `ModelChoice`/`currentModel()`,
`launchAnalystSession()`, per-idea chaining, the poll skeleton, the icon/button,
the error surfacing.

Backend-specific and isolated behind `LaunchBackend`: `/api/task-board/*`
transport, `ensureTask`, card permission/mode pins, the `run` action,
`taskBoardId`/`taskBoardStatus`.

Genuine shared work: `runPromptOf()` (§5.2) and the run-lifecycle fields
(§5.3). Doing both in v1 is what makes v2 additive.

Divergences to document in the interface: TaskBoard pins `/permission` and
renames the session, stores the model as `provider/model` (no
`reasoningEffort`), and owns idempotence through the deterministic card id;
the direct path pins nothing, can carry `reasoningEffort`, and guards with
`runStatus === 'running'`.

---

## 10. Related

- **Idea #66** — *"Lancer l'exécution d'une idée depuis le panneau Ideas (carte
  TaskBoard d'abord, session directe ensuite)"* — id
  `7f4cff77-6b1c-4a20-bc16-17465dff22f5`, workspace
  `dsh-plugin-ideas-manager`, value 3 / effort 2 / rank 1, tags
  `ideas-manager, taskboard-mirror, execution`. Body links back to this file.
  Created through the write channel (`POST /api/ideas/action`, revision 630);
  the mirror already bound card **`idea-7f4cff77-6b1c-4a20-bc16-17465dff22f5`**
  in **`backlog`** with `permission: read-only` and no `model` — i.e. the card is
  sitting in exactly the state the button's precondition requires, which makes
  #66 its own end-to-end test fixture.
- `docs/agent-write-channel.md` — the write fence and verb table this plan
  extends.
- `docs/idea-64-summary-first-context.md` — bounded reads the launch flow should
  follow.
- `scripts/reconcile-taskboard-mirror.mjs` / `scripts/validate-mirror-cycle.mjs`
  — existing mirror acceptance tooling to extend with the run cycle.
- `tests/taskboard-bridge.test.ts` — the fake-transport harness used throughout.
