# Gap analysis: replacing the OT IDEAS.md protocol with the generic ideas board

Status: analysis, 2026-09-19. No code change. Author request: detail what is
missing for dsh-plugin-ideas-manager to become a generic, workspace-agnostic
replacement for the OpenTimbre "IDEAS.md process" (docs/IDEAS.md +
docs/IDEAS-ARCHIVE.md + AGENTS.md "Ideas backlog sync" + the task-board skill)
so no project has to maintain those files anymore.

## 1. The OT process being replaced (facts)

Source of truth: sources/IDEAS.md (OpenTimbre), .dsh/skills/task-board/SKILL.md,
AGENTS.md §"Ideas backlog sync". The agent loop on OT:

1. The user tells the agent an idea in chat.
2. The agent edits docs/IDEAS.md: capture format `## Idea #N — Title`,
   sections Idea/Context/First-step sketch/Cost&risks, dated update blocks
   with commit hashes, status lines (future → STARTED → IMPLEMENTED →
   DELIVERED), doc links (RESEARCH/SPEC/PLAN).
3. Triage: the capturing agent records a priority opinion (value/effort +
   suggested rank), then RE-RANKS the whole open backlog against current
   project state (deliveries shrink remaining work, delivered infra
   unblocks successors), updates the "Suggested priority" table — never a
   plain append; re-rank only on a material change.
4. Delivery: idea graduates to docs/ROADMAP.md when scheduled; on delivery
   the full record moves to IDEAS-ARCHIVE.md with a delivered log; declined
   ideas are archived with a DECLINED marker and keep no board card.
5. Board mirror: one read-only Task Board card per open idea in `backlog`
   (create + move; fresh creates land in `todo`), updates mirror, decline →
   archive, delivery → closure run → `done` (runner-owned, no manual move).
6. The process is activated per session by AGENTS.md + a workspace-local
   skill (.dsh/skills/task-board/SKILL.md) documenting the undocumented
   /api/task-board REST envelope.

## 2. What the plugin already covers

- Persisted single-writer ledger (~/.dsh/ideas/ledger-v2.json), revisioned,
  quarantines corrupt files, dedupes requestIds across restarts.
- Per-workspace model: IdeaRecord.workspaceId + DSH "workspaces" registry
  pickers (client, defensive duck-typed; degrades to ledger-only).
- REST discipline /api/ideas (state/action/events), loopback + browser
  same-origin fence, exactKeys validation, bounded bodies, SSE revision
  frames. Contract documented in the repo SKILL.md (agent-facing).
- Lifecycle statuses open/archived/declined + rank/value/effort/tags.
- Unidirectional ledger → markdown export (IDEAS.md / IDEAS-ARCHIVE.md
  views; never parsed back).
- TaskBoard mirror (feature-detected, no hard import): create → backlog,
  update, decline/archive, restore; "done" intentionally manual.
- System-prompt section (IDEAS_GUIDANCE) gated on announceToAgent
  (default OFF), thin: existence + board description, no process.

## 3. The gaps (what is missing for full independence)

### G1 — The process itself is not encoded in the plugin (the main gap)

The OT agent follows IDEAS.md/AGENTS.md text. The plugin announces "the
board exists" but nowhere states the capture/triage/exec-prep/rank/re-rank
protocol. Missing:

- A process document that is authoritative and agent-visible:
  - enriched system-prompt guidance (announceToAgent) stating the full
    protocol: capture → analyze (context, first-step sketch, cost/risk,
    exec info) → priority opinion (value/effort + suggested rank) →
    RE-RANK all open ideas on any material change → lifecycle → delivery
    record → closure; ranks advisory.
  - a shipped ideas skill (SKILL.md exists but the process must move from
    "contract reference" to "protocol + contract").
- The cutover trigger for existing workspaces: their AGENTS.md must point
  at the board + skill instead of IDEAS.md. The plugin cannot rewrite
  arbitrary workspaces, but it can make the announcement/skill self-
  sufficient so each project only flips its AGENTS.md once.

### G2 — No atomic triage/re-rank operation; no rationale trail

- reorder exists but is a raw list write; nothing performs "insert idea at
  rank K + shift the open backlog + record who/why".
- Missing fields: triage rationale (who/when/why a rank), stable human
  sequence number (#N) for parity with the old docs (optional).
- Consequence: the OT rule "the table stays the agent's current best
  ordering, never a plain append" has no API equivalent; an agent could
  still implement it with read+reorder, but nothing enforces or records it.

### G3 — Lifecycle too shallow for the delivery/archive distinction

- Today any terminal non-declined idea collapses into `archived`; the OT
  process distinguishes delivered (full record: commits, measures,
  verification) from abandoned, with a decision trail.
- Missing: a delivered/done state (or milestone) with deliveredAt + record,
  a decision field on declined, and derived views (delivered log,
  sequencing notes / "next slice") that today are hand-written text.

### G4 — Generic workspace capture routing

- The board is workspace-aware in the UI (selector + chip + modal), but the
  agent-side capture has no notion of "the active workspace of this
  session": workspaceId is a free field. For "works with any DSH
  workspace", capture should resolve the session context (DSH workspaces
  registry + cwd + session metadata) and fall back to generic.
- Multi-home note: single-writer per DSH home means one live writer per
  machine; that is fine for one instance and does not block the per-
  workspace model.

### G5 — The OT cutover itself (work already behind)

- P3 migrated 23 ideas; IDEAS.md then kept being used for #24..#28
  (captured after the migration). Before IDEAS.md can be dropped the
  ledger must be re-synced, then AGENTS.md rewritten (source of truth =
  board; IDEAS*.md become optional generated exports — already supported).
- The "closing the loop to done is manual" convention stays: the ideas
  plugin never automates idea → done.

## 4. Proposed tranches (backwards-compatible; REST stays additive)

- T0 — process & activation, no schema change: enrich IDEAS_GUIDANCE into
  the full capture/triage/rank protocol + ship the process inside the
  SKILL.md; document the one-line AGENTS.md flip per workspace; re-sync
  IDEAS.md → ledger (#24..#28) so OT can stop writing the file.
- T1 — atomic triage API: new `triage` verb (scores + rationale + rank +
  transactional re-rank of open backlog) + `rationale`/`trier` field + a
  `deliver` verb (deliveredAt + record, mirrors to the board) + decision
  field on decline; stable sequence numbers.
- T2 — lifecycle/UI: done vs archived vs declined surfaced in the UI,
  derived "delivered log" and "suggested priority" views (the old tables,
  now generated), optional per-workspace export naming.
- T3 — session-aware capture: resolve the current session's workspace for
  captures; optional auto-install of the skill into workspaces' .dsh.

Risks: keep the fence (loopback + same-origin) for every new verb; keep the
ledger single-writer and revisioned; never parse markdown back into the
ledger; the TaskBoard "done" stays runner-owned.

## 6. Panel UX: tabs + chat commands (author request, 2026-09-19)

### Tabs inside the ideas panel — recommended

Platform evidence gathered from installed bundles:

- Session tabs (chat/trajectory/Context) = conversation VIEW model
  (dsh-client-ui-chat: `registerChatConversationView`, `openView("trajectory")`).
- dsh-context adds the "Context" tab through the platform slot
  `sidebar.right.pane.tab` (session-scoped) via
  `injected.slots.inject/<register({name,key,locale}, factory)>`.
- dsh-remote keeps a SELF-CONTAINED tab bar inside its own panel in the same
  top-left/center zone (`registerTab`/`setTab`/`switchTab`/`tabBtn`/
  `tabTitle`/`tabs`, persisted meta `TAB_EXPANDED_META`).

Recommended shape for ideas-manager (panel-internal tabs, dsh-remote pattern,
since our panel is DOM-injected into the center column):

- `Overview` — the current kanban (open/archived/declined, workspace filter).
- `Priorities` — the suggested ranking (OT "Suggested priority" table): rank,
  value/effort/risk, rationale (T1 field), move up/down + "propose re-rank"
  action. This is the natural home of the G2 triage flow.
- Future tabs plug into the same bar as isolated components: `Delivered log`
  (G3 derived views), `Export` (per-workspace IDEAS*.md generation), `Settings`
  (ideas namespace: enabled / announceToAgent / autoMirror).
- Design rules: tab bar + content share one container (survives DOM hub
  re-mounts); persist the active tab (meta-style, like TAB_EXPANDED_META);
  one component per tab so T1–T3 land without refactor.
- Optional follow-up: contribute a session-scoped view into the
  `sidebar.right.pane.tab` slot to tie chat context to the board (pairs with
  session-aware capture, T3).

### `/idea` chat commands — feasible, low priority

- No plugin-extensible slash-command registry exists in the platform
  (dsh-client-ui-chat exposes `conversation.chat.commandview` for SYSTEM
  command nodes — command.running/done/failed, command/run|done — not a
  user-command API).
- Possible via DOM interception (our existing body-mutations hub): catch a
  chat submit starting with `/idea`, cancel the send, open the New Idea modal
  pre-filled. Fragile (shell input coupling), isolate if built.
- Recommendation: prefer a panel keyboard shortcut (e.g. N → new idea) over
  input interception; re-evaluate `/idea` only when the platform grows a real
  plugin command surface (feature-detect like the mirror).

## 7. Evidence map

- Process text: test-dsh/OpenTimbre/docs/IDEAS.md (triage lines), AGENTS.md
  §"Ideas backlog sync" items 5–6, .dsh/skills/task-board/SKILL.md
  (card lifecycle, closure run).
- Current plugin: src/core/ideas.ts (model), src/protocol.ts (wire),
  src/host-routes.ts (fence), src/export-markdown.ts (flat view),
  src/client/workspaces.ts (registry pickers), src/index.ts (guidance,
  announceToAgent default false), repo SKILL.md (contract).
- Reference: sibling plugin family drives agents via REST + workspace skill
  (@linxin666/dsh-web-all has no registered tools either).