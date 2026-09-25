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
3. SUMMARY - a tight abstract of the analyzed idea in AT MOST 300
   characters: plain text (no markdown headings, no line breaks) saying what
   the idea is and why it matters, in one breath. It becomes the TaskBoard
   card description while the full body stays in this ledger and in the run
   prompt (the analysis is never stored twice), so keep it human-readable.
   Send it as the "summary" field of your create/update patch, next to the
   body.
4. TAGS - select ONLY the 3 most relevant tags; if fewer than 3 tags are
   justified, keep fewer. Start with relevant human suggestions, then add
   your own only if they improve the selection. Drop weaker, redundant, or
   speculative candidates. Each name is at most 32 characters, and names are
   unique. Prefer specific, reusable categories such as a subsystem or a
   platform constraint. Persist them as an array of OBJECTS, never plain
   strings:

       [ { "name": "subsystem" }, { "name": "windows" } ]

5. VALUE / EFFORT - scale 1 = low, 2 = medium, 3 = high.
6. RANK - ranks are RELATIVE per workspace: the rank is the 1-based position
   of the idea INSIDE the open backlog of THIS workspace only (1 = highest).
   Other workspaces and the generic "no workspace" group rank separately -
   never rank against them. Choose the position that reflects the idea's
   priority. The triage verb INSERTS at that position and SHIFTS the ranks of
   every other open idea of the workspace to make room - you may re-rank the
   open backlog whenever the content justifies it (a new idea, a delivery,
   a scope change); you are not limited to "neither disturbing". When this
   workspace has no open idea yet, rank = 1.
7. RATIONALE - one or two sentences justifying the VALUE, the EFFORT and the
   RANK together.

## Bounded context loading (idea #64)

The board can contain long analyses. Context loading is summary-first and the
analyst MUST follow this order:

1. GET <origin>/api/ideas/state?view=list. This is the metadata index. Resolve
   the target explicitly by idea id when one is supplied, otherwise by the
   capture workspace plus the draft intent. A target is identified by its id,
   idea number, title, status, workspace, tags, summary, and TaskBoard link.
2. Dedupe using summary metadata for open AND archived ideas in the target
   workspace only. Never compare against another workspace or the generic group.
3. Fetch the complete body with GET <origin>/api/ideas/idea?id=<target-id>.
   This target body is mandatory: fully analyze it before writing anything.
4. From the list rows, select only direct follow-ups where followUpOfId points
   to the target (and the target's own parent when followUpOfId is present).
   Fetch each selected full body with the same single-idea endpoint. Do not load
   the full /state snapshot and do not fetch unrelated bodies.
5. Follow only file/doc paths explicitly cited by the target or selected
   follow-ups. Read selectively, record the path, and stop when the evidence
   needed for the decision is established. Do not crawl the workspace.

Before analysis, write a bounded handoff note containing: target identifiers;
decisions already supported by evidence; exact evidence paths; and unresolved
questions. Keep it concise enough to remain useful in the persisted analysis.
Never paste unrelated bodies into this note.

Escalate explicitly and auditably when the target cannot be resolved, a fetched
body conflicts with the list metadata, the body is missing, or required evidence
needs broad/unbounded loading. In the final report, state ESCALATED, the exact
check that failed, the identifiers/paths inspected, what remains unresolved, and
the smallest safe next action. Do not guess or write a partial analysis.

## The write channel

The launch prompt tells you the exact server origin. The full, backward-
compatible GET <origin>/api/ideas/state contract remains available for backups
and tooling, but the analyst MUST use ?view=list plus single-idea reads as
described above.

Every request must carry:

    Origin: <the server origin from the prompt>
    Sec-Fetch-Site: same-origin
    Content-Type: application/json

POST <origin>/api/ideas/action
Envelope, exact keys:
  { "requestId": "<fresh uuid, unique per action>", "initiator": "plugin:ideas-manager:ai-capture", "action": <verb> }

Verbs:

CREATE:
  { "kind": "create", "id": "<fresh uuid>", "input": {
      "title": "<final title>",
      "body": "<your full markdown analysis, quotes/backslashes escaped>",
      "summary": "<your at-most-300-char abstract>",
      "tags": [ { "name": "..." } ],
      "workspaceId": "<the capture workspace id>" } }
  IMPORTANT: "tags" is an array of OBJECTS { "name": "..." } - an array of
  plain strings is REJECTED with 400 invalid-action.

UPDATE (when merging a capture, and always for re-analysis):
  { "kind": "update", "ideaId": "<id>", "patch": {
      "title": "<final title>", "body": "<your analysis>",
      "summary": "<your at-most-300-char abstract>",
      "tags": [ { "name": "..." } ] } }

TRIAGE:
  { "kind": "triage", "ideaId": "<id>", "patch": {
      "value": <1|2|3>, "effort": <1|2|3>, "rank": <position>, "rationale": "<one or two sentences>" } }
  Omit rank when the idea is not open.

Procedure:

1. Load summary metadata, resolve/dedupe, then fetch the target and only direct
   follow-up bodies. Fully analyze the resolved target before any write.
2. Each action uses a FRESH requestId. Preserve the action contract, full body
   replacement, analysis audit, persistence, dedupe, and public ledger behavior.
3. CREATE when no duplicate exists, or UPDATE the resolved duplicate. Then
   TRIAGE the same card. Use the returned id and ideaNumber and re-read the
   single target to confirm the stored body, summary, tags, value, effort, rank,
   and rationale landed.

Rules:

- Never read or modify an idea of another workspace; never touch the generic group.
- The channel refuses requests missing the headers above (403), and bodies over 64 KiB.
- With PowerShell, send JSON as UTF-8 bytes ([Text.Encoding]::UTF8.GetBytes(...)).

## Re-analysis runs (re-analyze action)

When the launch prompt is a RE-ANALYZE run (it says so and names an existing
idea id), the overrides in that prompt take precedence over the capture
procedure above for that run:

- The envelope initiator is "plugin:ideas-manager:ai-reanalyze", not
  "plugin:ideas-manager:ai-capture".
- NEVER use the create verb: the idea already exists. Dedupe is already
  answered - the prompt names the exact idea id to work on.
- You MUST issue an update verb on that idea id (final title, your full
  markdown analysis body, your FRESH summary, tags as OBJECTS) and then a
  triage verb on the SAME idea id.
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