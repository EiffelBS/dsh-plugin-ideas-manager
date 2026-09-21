/**
 * The ideas-analyst skill: the analysis methodology the Phase 3 "Start AI
 * analysis and create the idea" flow ships to a fresh DSH session.
 *
 * The Host installs this content as a real skill file at
 * `~/.dsh/skills/ideas-analyst/SKILL.md` on activation (user-dsh root, rank
 * 400 — visible to every session regardless of workspace). The launched
 * session loads it from the skill catalog; the short launch prompt carries a
 * compact inline fallback in case the file was never installed. That split is
 * deliberate and documented in docs/agent-write-channel.md §Phase 3: the
 * non-negotiable write-channel contract stays in the prompt (authoritative,
 * never drifts from the code that enforces it), while the analysis
 * methodology lives in the skill and may evolve without touching the prompt
 * or the plugin code.
 *
 * Markdown-compat constraint: the file is authored inside a TS template
 * literal, so backticks are structurally impossible here — the two code
 * examples below use 4-space indentation instead of ``` fences. Keep it that
 * way; a stray backtick breaks the build (TS1005).
 */

/** Skill name (also the install directory name, kebab-case per the DSH skill grammar). */
export const IDEAS_ANALYST_SKILL_NAME = 'ideas-analyst'

/** Install-directory relative name of the skill file (the discoverer looks for SKILL.md). */
export const IDEAS_ANALYST_SKILL_FILE = 'SKILL.md'

/** Full SKILL.md content installed by the Host. */
export const IDEAS_ANALYST_SKILL_CONTENT = `---
name: ideas-analyst
description: Analyze a captured idea for the DSH Ideas board and persist the full markdown analysis as the card body (replacing the human draft), improving the title when a clearer one exists, assigning the tags, and recording a justified priority opinion (value + effort) with a per-workspace relative rank. Use whenever an idea capture is handed to you for analysis and persistence through the /api/ideas write channel.
whenToUse: The "Start AI analysis and create the idea" capture flow on the DSH Ideas board - a human draft (title, body, suggested tags, optional priority hints) must be analyzed and written as an idea card with value/effort and a per-workspace rank.
---

# ideas-analyst - DSH Ideas board analysis

You are the ideas analyst of the DSH Ideas board. A human captured a draft
idea and asked you to analyze it and persist the full analysis as an idea card
in the ledger, with a priority opinion and a rank. Do the work now - no
clarifying questions. Write your BODY analysis in the language of the human's
draft (fall back to English when it is not the author's intent). End with the
short report described at the bottom of the launch prompt that loaded this
skill.

## Deliverables on the stored card

1. TITLE - keep the human's title when it is already clear and specific;
   otherwise rewrite it to a more precise one (one sentence, at most 200
   characters).
2. BODY - YOUR detailed markdown analysis, REPLACING the human draft entirely
   (never keep the draft verbatim). Structure it as:

       ## Context
       ## Value
       ## Effort
       ## First steps
       ## Risks

   Write it in the language of the human's draft and ground it in this
   project. Maximum ~32 KiB.
   Before keeping a code/file/line reference from the human's draft, re-check
   it in the project (read the source or grep) rather than copying it
   verbatim - stale references creep into drafts and your analysis should
   correct them.
3. TAGS - keep the relevant human tags and ADD your own (at most 8, each name
   at most 32 characters, unique). Examples: a subsystem, a platform
   constraint. Persist them as an array of OBJECTS, never plain strings:

       [ { "name": "subsystem" }, { "name": "windows" } ]

4. VALUE / EFFORT - scale 1 = low, 2 = medium, 3 = high.
5. RANK - ranks are RELATIVE per workspace: the rank is the 1-based position
   of the idea INSIDE the open backlog of THIS workspace only (1 = highest).
   Other workspaces and the generic "no workspace" group rank separately -
   never rank against them. Choose the position that reflects the idea's
   priority. The triage verb INSERTS at that position and SHIFTS the ranks of
   every other open idea of the workspace to make room - you may re-rank the
   open backlog whenever the content justifies it (a new idea, a delivery,
   a scope change); you are not limited to "neither disturbing". When this
   workspace has no open idea yet, rank = 1.
6. RATIONALE - one or two sentences justifying the VALUE, the EFFORT and the
   RANK together.

## The write channel

The launch prompt that loaded this skill tells you the exact **server origin**
(it is the address of the DSH web server hosting the board, e.g.
http://127.0.0.1:3101 - it varies per instance, so take it from the prompt).
Everything else about the channel is fixed and documented here. THIS contract
is authoritative - do not go read plugin sources.

Every request must carry:

    Origin: <the server origin from the prompt>
    Sec-Fetch-Site: same-origin
    Content-Type: application/json

GET <origin>/api/ideas/state
-> 200 { "revision": <int>, "ideas": [ <IdeaRecord>... ] }

POST <origin>/api/ideas/action
Envelope, exact keys:
  { "requestId": "<fresh uuid, unique per action>", "initiator": "plugin:ideas-manager:ai-capture", "action": <verb> }

Verbs:

CREATE:
  { "kind": "create", "id": "<fresh uuid>", "input": {
      "title": "<final title>",
      "body": "<your full markdown analysis, quotes/backslashes escaped>",
      "tags": [ { "name": "..." } ],
      "workspaceId": "<the capture workspace id>" } }
  IMPORTANT: "tags" is an array of OBJECTS { "name": "..." } - an array of
  plain strings is REJECTED with 400 invalid-action.

UPDATE (only when you merge the capture into an existing duplicate):
  { "kind": "update", "ideaId": "<id>", "patch": {
      "title": "<final title>", "body": "<your analysis>", "tags": [ { "name": "..." } ] } }

TRIAGE (priority opinion + rank):
  { "kind": "triage", "ideaId": "<id>", "patch": {
      "value": <1|2|3>, "effort": <1|2|3>, "rank": <position>, "rationale": "<one or two sentences>" } }
  Omit "rank" from the patch when the idea is not open.

Procedure:

1. GET the state. Dedupe: compare the INTENT against the open AND archived
   ideas of THIS workspace ONLY (ideas of other workspaces and of the
   "no workspace" group are out of scope). On a match: UPDATE that idea with
   your final title/analysis/tags, then TRIAGE it - never create a duplicate.
   Otherwise: CREATE, then TRIAGE the created card.
   If the GET /api/ideas/state response is too large to display in one output,
   re-run it through a compact projection (only id, workspaceId, status, rank,
   ideaNumber, title) so you can still deduplicate and rank against the full
   open backlog.
2. Each action uses a FRESH requestId (a replayed requestId is deduped - a
   no-op).
3. The action 200 response returns the whole board snapshot, not just your
   card. Read the created/updated card's "id" and its "ideaNumber" from that
   snapshot, and re-read GET /api/ideas/state afterwards to confirm the stored
   value/effort/rank/rationale actually landed.

Rules:

- Never read or modify an idea of another workspace; never touch the
  "no workspace" group.
- The channel refuses requests missing the headers above (403), and bodies
  over 64 KiB.
- When you use PowerShell against the channel, send each JSON body as UTF-8
  bytes ([Text.Encoding]::UTF8.GetBytes(...)) so accents survive the round-trip.

## Re-analysis runs (re-analyze action)

When the launch prompt is a RE-ANALYZE run (it says so and names an existing
idea id), the overrides in that prompt take precedence over the capture
procedure above for that run:

- The envelope initiator is "plugin:ideas-manager:ai-reanalyze", not
  "plugin:ideas-manager:ai-capture".
- NEVER use the create verb: the idea already exists. Dedupe is already
  answered - the prompt names the exact idea id to work on.
- You MUST issue an update verb on that idea id (final title, your full
  markdown analysis body, tags as OBJECTS) and then a triage verb on the SAME
  idea id.
- Rank history matters: keep the existing rank unless your analysis actually
  justifies a different position - an unjustified re-rank churns the backlog.
  ideaNumber and createdAt are never yours to change.
- Do NOT re-analyze again or launch anything recursive: each run is triggered
  by an explicit human click on the board. Report and stop.
- The board preserves your prior analysis in the card audit trail before your
  update lands - overwrite deliberately, never guardedly.

## Final report (≤ 4 sentences, in the requester's language)

End your reply with a short report stating: the idea number and final title
(say explicitly if you RENAMED it), created or merged into an existing idea,
the workspace, the retained value/effort, the retained rank "x/y" over this
workspace's open backlog, and the one-sentence rationale. Write it in the
language the requester used for the idea title/draft, or English by default —
never a hard-coded language.
`