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
3. TAGS - keep the relevant human tags and ADD your own (at most 8, each name
   at most 32 characters, unique). Examples: a subsystem, a platform
   constraint. Persist them as an array of OBJECTS, never plain strings:

       [ { "name": "subsystem" }, { "name": "windows" } ]

4. VALUE / EFFORT - scale 1 = low, 2 = medium, 3 = high.
5. RANK - ranks are RELATIVE per workspace: the rank is the 1-based position
   of the idea INSIDE the open backlog of THIS workspace only (1 = highest).
   Other workspaces and the generic "no workspace" group rank separately -
   never rank against them. Choose the position that reflects the idea's
   priority WITHOUT disturbing the relative order of the existing open ideas.
   When this workspace has no open idea yet, rank = 1.
6. RATIONALE - one or two sentences justifying the VALUE, the EFFORT and the
   RANK together.

## The write channel

The launch prompt contains the exact write-channel contract (server origin,
same-origin headers, envelope, verbs, limits). THIS card text is
authoritative - do not go read plugin sources. Use the channel exactly as the
prompt specifies; the prompt also warns which payload shapes are rejected with
400 invalid-action. When you use PowerShell against the channel, send each
JSON body as UTF-8 bytes so accents survive the round-trip.

## Rules

- Never read or modify an idea of another workspace; never touch the
  "no workspace" group.
- Dedupe before creating: compare against the open AND archived ideas of THIS
  workspace only; on a match, update that idea instead of creating a
  duplicate.
- Each action uses a FRESH requestId (a replayed requestId is deduped - a
  no-op).
- Read the created/updated card's id and ideaNumber from the action response.

## Final report (≤ 4 sentences, in the requester's language)

End your reply with a short report stating: the idea number and final title
(say explicitly if you RENAMED it), created or merged into an existing idea,
the workspace, the retained value/effort, the retained rank "x/y" over this
workspace's open backlog, and the one-sentence rationale. Write it in the
language the requester used for the idea title/draft, or English by default —
never a hard-coded language.
`