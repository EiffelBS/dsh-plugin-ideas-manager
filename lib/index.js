import z from "schemastery";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";
//#region src/core/ideas.ts
/** The three run states, as a lookup for normalization. */
const IDEA_RUN_STATUSES = [
	"running",
	"done",
	"failed"
];
/** Actor label of a caller that asserted no initiator (the board UI, the API). */
const IDEA_ACTOR_HUMAN = "human";
/**
* Resolve the actor label of one mutation. The initiator is the envelope field
* the write channel already carries: absent means "the human in front of the
* board", present means an agent stamped its own label. A host-only override
* (`run`) marks the transitions the Host itself writes.
* @param initiator - asserted envelope initiator, if any.
* @param override - explicit actor for a Host-written transition.
* @returns the bounded actor label.
*/
function ideaEventActor(initiator, override) {
	if (override !== void 0) return override;
	const trimmed = initiator?.trim();
	if (trimmed === void 0 || trimmed === "") return IDEA_ACTOR_HUMAN;
	return `agent:${trimmed}`.slice(0, 128);
}
/**
* Whether an unknown value is a well-formed activity entry.
*
* Strict on the four keys it owns — every one of them must be present and of
* the right type, so a truncated or half-written entry is refused — and
* deliberately tolerant of unknown keys, because this guard runs on PERSISTED
* logs: an entry a later version wrote with an extra field is still history
* worth keeping, and {@link normalizeIdeaEvents} rebuilds it from the four keys
* this returns, dropping whatever else travelled with it.
*/
function isIdeaEvent(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const event = value;
	if (typeof event.at !== "number" || !Number.isFinite(event.at)) return false;
	return typeof event.verb === "string" && event.verb !== "" && typeof event.actor === "string" && event.actor !== "" && typeof event.summary === "string";
}
/** Build one well-formed entry, bounding every free-text field. */
function ideaEvent(at, verb, actor, summary) {
	return {
		at,
		verb: verb.trim().slice(0, 32) || "update",
		actor: actor.trim().slice(0, 128) || "human",
		summary: summary.replace(/\s+/g, " ").trim().slice(0, 200)
	};
}
/**
* Append one entry to a bounded log and drop what falls off the tail. The
* input list is never mutated: the ledger keeps one immutable record per
* revision.
* @param events - the current log (any length; undefined = empty).
* @param entry - the entry to append.
* @returns the new log, at most {@link IDEA_EVENT_LIMIT} entries long.
*/
function appendIdeaEvent(events, entry) {
	const next = [...events ?? [], entry];
	return next.length > 50 ? next.slice(next.length - 50) : next;
}
/**
* Repair a persisted activity log: drop malformed entries, bound every field
* and keep only the last {@link IDEA_EVENT_LIMIT}. This is also the schema
* migration for documents written before the log existed — such a row simply
* has no `events` field, and the first append creates it.
* @param value - the raw stored value.
* @returns the repaired log, or undefined when nothing usable remains.
*/
function normalizeIdeaEvents(value) {
	if (!Array.isArray(value)) return void 0;
	const events = [];
	for (const entry of value) {
		if (!isIdeaEvent(entry)) continue;
		const repaired = ideaEvent(entry.at, entry.verb, entry.actor, entry.summary);
		if (repaired.summary === "") continue;
		events.push(repaired);
	}
	if (events.length === 0) return void 0;
	return events.length > 50 ? events.slice(events.length - 50) : events;
}
/** Whether an unknown value is a well-formed tag (strict: the wire gate). */
function isIdeaTag(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const tag = value;
	if (Object.keys(tag).some((key) => key !== "name" && key !== "promptPrefix")) return false;
	if (typeof tag.name !== "string") return false;
	const name = tag.name.trim();
	if (name === "" || name.length > 32) return false;
	if (tag.promptPrefix !== void 0 && typeof tag.promptPrefix !== "string") return false;
	return tag.promptPrefix === void 0 || tag.promptPrefix.trim().length <= 200;
}
/**
* Whether an unknown value is a well-formed tag list (strict: the wire gate).
* An empty list is rejected — clearing tags is expressed by omitting the field
* (create) or by an explicit null (update), never by an empty array.
*/
function isIdeaTagList(value) {
	return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(isIdeaTag);
}
/**
* Repair a persisted tag list: keep the well-formed entries, trim, drop
* blanks and repeats, cap the count, and collapse a blank prompt line to
* "display-only". Returns undefined when nothing usable remains, so the caller
* clears the field instead of storing an empty array.
*/
function normalizeTags(value) {
	if (!Array.isArray(value)) return void 0;
	const tags = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const row = entry;
		if (typeof row.name !== "string") continue;
		const name = row.name.trim();
		if (name === "" || name.length > 32 || seen.has(name)) continue;
		const raw = typeof row.promptPrefix === "string" ? row.promptPrefix.trim() : "";
		const promptPrefix = raw === "" ? void 0 : raw.slice(0, 200);
		seen.add(name);
		tags.push(promptPrefix === void 0 ? { name } : {
			name,
			promptPrefix
		});
		if (tags.length >= 8) break;
	}
	return tags.length === 0 ? void 0 : tags;
}
/** All valid statuses (closed union guard). */
const ALL_IDEA_STATUSES = [
	"open",
	"underReview",
	"archived",
	"declined"
];
/** Brand an unknown string as an idea status; undefined when it is not one. */
function isIdeaStatus(value) {
	return typeof value === "string" && ALL_IDEA_STATUSES.includes(value);
}
/** Brand an unknown string as a run status; undefined when it is not one. */
function isIdeaRunStatus(value) {
	return typeof value === "string" && IDEA_RUN_STATUSES.includes(value);
}
/** Normalize one optional target string: trim; blank collapses to undefined. */
function normalizeOptionalId$1(value) {
	const trimmed = value?.trim();
	return trimmed === void 0 || trimmed === "" ? void 0 : trimmed;
}
/**
* Normalize a stored card summary: trim, blank collapses to undefined, hard
* cap at IDEA_SUMMARY_MAX_LENGTH. The wire gate accepts any string; this is
* the single place that enforces the size contract on persisted values.
*/
function normalizeSummary(value) {
	const trimmed = value?.trim();
	if (trimmed === void 0 || trimmed === "") return void 0;
	return trimmed.slice(0, 300);
}
/**
* Normalize a harvested delivery note: trim, blank collapses to
* undefined (an absent note is honest — the review gate says so in the UI), and
* the text is cut at DELIVERY_NOTE_MAX_BYTES **UTF-8 bytes**, never mid
* code point, with a trailing ellipsis marking the cut. Same discipline as
* `normalizeSummary`: the wire accepts any string, this is the one place that
* enforces the size contract on a persisted value.
*/
function normalizeDeliveryNote(value) {
	const trimmed = value?.trim();
	if (trimmed === void 0 || trimmed === "") return void 0;
	const encoder = new TextEncoder();
	if (encoder.encode(trimmed).byteLength <= 2048) return trimmed;
	let bytes = 0;
	let end = 0;
	for (const character of trimmed) {
		const size = encoder.encode(character).byteLength;
		if (bytes + size > 2048) break;
		bytes += size;
		end += character.length;
	}
	return `${trimmed.slice(0, end).trimEnd()}…`;
}
/**
* Whether an unknown value is a well-formed relation list (the wire gate).
* An EMPTY list is legal here — unlike tags, where an empty array is a
* confusing way of saying "clear" — because an empty relation list simply means
* "this kind of edge was cleared", and the board never sends one by accident.
*/
function isIdeaRelationList(value) {
	return Array.isArray(value) && value.length <= 20 && value.every((entry) => typeof entry === "string" && entry.trim() !== "" && entry.length <= 256);
}
/**
* Repair a persisted relation list: trim, drop blanks and repeats, cap at
* {@link IDEA_RELATION_LIMIT}. Returns undefined when nothing usable remains, so
* the caller omits the field rather than storing an empty array — which is also
* this schema's migration: a document written before relations existed simply
* has no `relatesTo` / `blocks` key, and the first write creates it.
*/
function normalizeRelationIds(value) {
	if (!Array.isArray(value)) return void 0;
	const ids = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const id = entry.trim();
		if (id === "" || id.length > 256 || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
		if (ids.length >= 20) break;
	}
	return ids.length === 0 ? void 0 : ids;
}
/**
* One relation list rewritten for a row that changed identity in a merge:
* `fromId` becomes `toId`, duplicates collapse, and any edge that would point
* at the row itself is dropped. That last rule is why a merge can never leave an
* idea related to itself — the failure a self-link makes invisible afterwards.
*
* @param list - the row's stored list (absent = no edge of this kind).
* @param rowId - the id of the row the list belongs to.
* @param fromId - the id that disappears (the merge loser).
* @param toId - the id that inherits it (the merge survivor).
*/
function repointedRelationIds(list, rowId, fromId, toId) {
	if (list === void 0) return void 0;
	const ids = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of list) {
		const id = raw === fromId ? toId : raw;
		if (id === "" || id === rowId || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
		if (ids.length >= 20) break;
	}
	return ids.length === 0 ? void 0 : ids;
}
/** `blocks` adjacency of a whole document, for the cycle check. */
function blocksGraphOf(ideas) {
	const graph = /* @__PURE__ */ new Map();
	for (const idea of ideas) if (idea.blocks !== void 0) graph.set(idea.id, idea.blocks);
	return graph;
}
/**
* The `blocks` chain that adding `from blocks to` would close, or undefined
* when the edge is safe.
*
* `blocks` is the one relation where a cycle is expressible and meaningless
* ("A waits for B" and "B waits for A" says nothing), so it is refused ON WRITE
* rather than discovered at render time. The path is returned so the refusal
* can NAME it: "A blocks B, B blocks C, C blocks A" is an answer a human can
* act on, where "invalid relation" is not.
*
* The graph is already acyclic (every write checks), so the walk is bounded by
* the number of ideas in the document.
*/
function blockCyclePath(blocks, from, to) {
	if (from === to) return [to];
	const seen = /* @__PURE__ */ new Set();
	const walk = (node, path) => {
		if (seen.has(node)) return void 0;
		seen.add(node);
		for (const next of blocks.get(node) ?? []) {
			if (next === from) return [
				...path,
				node,
				from
			];
			const deeper = walk(next, [...path, node]);
			if (deeper !== void 0) return deeper;
		}
	};
	return walk(to, []);
}
/**
* The ideas that block `ideaId`: the `blockedBy` side of the stored `blocks`
* edges. Derived, never stored, so a card can answer "what is this waiting on?"
* from a poll that only carries the stored direction.
*/
function ideaBlockedBy(ideas, ideaId) {
	const blockers = [];
	for (const idea of ideas) {
		if (idea.id === ideaId) continue;
		if (idea.blocks?.includes(ideaId) === true) blockers.push(idea.id);
	}
	return blockers;
}
/**
* The relation lists a merge hands to the survivor: its own edges first, then
* the loser's. Duplicate ids collapse, the cap holds, and the survivor's own id
* is dropped, so the result is always a legal relation list and the union can
* never make an idea relate to itself.
*
* `blocks` unions the same way — a surviving idea cannot both wait for and be
* waited on by the same idea, and {@link normalizeRelationIds} keeps the single
* edge. The caller is responsible for the acyclicity that a union can break
* (re-pointing an edge can close a loop); this function does not check, because
* it is a pure list operation and the cycle rule belongs to the write.
*/
function mergedIdeaRelations(survivor, loser) {
	const self = survivor.id;
	const union = (a, b) => normalizeRelationIds([...a ?? [], ...b ?? []])?.filter((id) => id !== self);
	const relatesTo = union(survivor.relatesTo, loser.relatesTo);
	const blocks = union(survivor.blocks, loser.blocks);
	return {
		...relatesTo === void 0 ? {} : { relatesTo },
		...blocks === void 0 ? {} : { blocks }
	};
}
/**
* Rank group of an idea: its manual rank is a position RELATIVE to the other
* ideas of the same (status, workspace) pair — the "rank by workspace" model.
* The workspace-less ideas (workspaceId undefined) share one generic group, so
* the board and the Priorities view rank them against each other only. Used by
* both the host (triage/reorder re-rank) and the client (order rebuilds).
*/
function rankGroupKey(status, workspaceId) {
	return `${status}\u0000${workspaceId ?? ""}`;
}
/**
* Every declared dependency the current order contradicts: `B.blocks` contains
* `A`, yet A is scheduled above B inside the same ranking group.
*
* **A statement, never a constraint.** `blocks` is a fact about scope and `rank`
* is a judgement about value; the board does not refuse a ranking that
* contradicts one (docs/architecture.md records the decision and the rejected
* alternatives). What it does is stop being silent about it: the case this
* exists for was a card whose own rationale said "descend below #47" while its
* rank said the opposite, which no reader could see.
*
* Only pairs inside ONE rank group are compared. A cross-workspace dependency is
* legitimate and common, and the two numbers come from two different sequences,
* so "6 < 7" would be a fiction. An unranked card states no order at all, so it
* contradicts nothing.
*
* @param ideas - every row that carries a rank and/or a `blocks` list.
* @returns the conflicting pairs, blocked card first, in input order.
*/
function rankBlockConflicts(ideas) {
	const byId = new Map(ideas.map((idea) => [idea.id, idea]));
	const conflicts = [];
	for (const blocker of ideas) for (const blockedId of blocker.blocks ?? []) {
		const blocked = byId.get(blockedId);
		if (blocked === void 0) continue;
		if (blocked.rank === void 0 || blocker.rank === void 0) continue;
		if (blocked.status === void 0 || blocker.status === void 0) continue;
		if (rankGroupKey(blocked.status, blocked.workspaceId) !== rankGroupKey(blocker.status, blocker.workspaceId)) continue;
		if (blocked.rank < blocker.rank) conflicts.push({
			blockedId: blocked.id,
			blockerId: blocker.id
		});
	}
	return conflicts;
}
/** Normalize an unknown persisted status back into the closed status union. */
function normalizeStatus(status) {
	return isIdeaStatus(status) ? status : "open";
}
/** Create an idea from user input (starts 'open'). */
function createIdea(input, now, id) {
	const tags = normalizeTags(input.tags);
	const rationale = input.rationale?.trim();
	const summary = normalizeSummary(input.summary);
	return {
		id,
		title: input.title.trim().slice(0, 200),
		body: input.body.trim(),
		status: "open",
		createdAt: now,
		updatedAt: now,
		...summary === void 0 ? {} : { summary },
		...input.rank === void 0 ? {} : { rank: input.rank },
		...input.value === void 0 ? {} : { value: input.value },
		...input.effort === void 0 ? {} : { effort: input.effort },
		...rationale === void 0 || rationale === "" ? {} : { rationale },
		...normalizeOptionalId$1(input.workspaceId) === void 0 ? {} : { workspaceId: normalizeOptionalId$1(input.workspaceId) },
		...tags === void 0 ? {} : { tags }
	};
}
/** Clone an idea with an updated status and a fresh updatedAt. */
function withStatus(idea, status, now) {
	return {
		...idea,
		status,
		updatedAt: now
	};
}
/**
* How a merge settles the LOSER's rank onto the survivor. The merge itself is
* unconditional — the loser's tags, its follow-up lineage and its card are
* reconciled either way — so the only genuinely open question is the position
* the survivor ends up at inside the open backlog.
*/
const IDEAS_MERGE_MODES = ["keepTargetRank", "takeSourceRank"];
/** Whether an unknown string is a well-formed merge mode (the wire gate). */
function isIdeaMergeMode(value) {
	return typeof value === "string" && IDEAS_MERGE_MODES.includes(value);
}
/**
* The label set a merge hands to the survivor: the survivor's own labels first
* (so a duplicate name keeps the survivor's `promptPrefix` — the losing card's
* prompt line must not rewrite a card the runner already owns), then the
* loser's. {@link normalizeTags} deduplicates by name, trims and caps the
* result at {@link IDEA_TAG_LIMIT}, so the union is always a legal tag list.
*
* @returns the reconciled labels, or undefined when the union is empty (the
*   caller omits the field rather than storing an empty list).
*/
function mergedIdeaTags(survivor, loser) {
	return normalizeTags([...survivor.tags ?? [], ...loser.tags ?? []]);
}
/** Weight of the normalized-title signal in the combined score. */
const IDEAS_SIMILAR_TITLE_WEIGHT = .7;
/**
* A run of ideographic script (Han, Kana, Hangul): those scripts have no word
* separators, so a whole-title "word" would make two unrelated CJK titles look
* as unrelated as two unrelated English ones while hiding the real overlap.
*/
const IDEOGRAPHIC_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
/**
* Comparison tokens of one title: lowercased, split on every non-alphanumeric
* boundary, duplicates collapsed. An ideographic run is split per CHARACTER so
* CJK titles overlap at the character level; every other script keeps its
* words. Nothing is stemmed and nothing is fuzzy — this is a cheap signal, and
* a real judgement belongs to a human or to the analyst.
*/
function ideaTitleTokens(title) {
	const tokens = /* @__PURE__ */ new Set();
	for (const part of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (part === "") continue;
		if (IDEOGRAPHIC_RUN.test(part)) for (const character of part) tokens.add(character);
		else tokens.add(part);
	}
	return tokens;
}
/** Comparison tokens of one label set (names lowercased, order irrelevant). */
function ideaTagTokens(tags) {
	const tokens = /* @__PURE__ */ new Set();
	for (const tag of tags ?? []) {
		const name = tag.name.trim().toLowerCase();
		if (name !== "") tokens.add(name);
	}
	return tokens;
}
/**
* Dice coefficient of two token sets: `2 * shared / (|a| + |b|)`. Symmetric,
* 0 when either side is empty, and linear in the smaller set — the shape that
* makes "one shared word out of five" read as a real overlap rather than as
* either nothing or everything.
*/
function diceCoefficient(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let shared = 0;
	for (const token of small) if (large.has(token)) shared += 1;
	return 2 * shared / (a.size + b.size);
}
/**
* Combined near-duplicate score of one pair: a weighted sum of the title
* overlap ({@link IDEAS_SIMILAR_TITLE_WEIGHT}) and the label overlap. Rounded
* to 3 decimals so the wire payload is stable and a report never carries
* float noise the reader would have to interpret.
*/
function ideaSimilarity(anchor, other) {
	const titleScore = diceCoefficient(ideaTitleTokens(anchor.title), ideaTitleTokens(other.title));
	const tagScore = diceCoefficient(ideaTagTokens(anchor.tags), ideaTagTokens(other.tags));
	const signals = [];
	if (titleScore > 0) signals.push("title");
	if (tagScore > 0) signals.push("tags");
	return {
		score: Math.round((IDEAS_SIMILAR_TITLE_WEIGHT * titleScore + (1 - IDEAS_SIMILAR_TITLE_WEIGHT) * tagScore) * 1e3) / 1e3,
		signals
	};
}
/**
* Scan the OPEN BACKLOG OF THE ANCHOR'S OWN WORKSPACE for near-duplicates.
*
* Scope is deliberate and narrow: the anchor itself, every non-open row and
* every other workspace are excluded, so the flag means "this backlog already
* holds something like this", never "some idea somewhere scored highly". The
* workspace-less ideas form one generic group, exactly like
* {@link rankGroupKey}.
*
* `limit` clamps into 1..{@link IDEAS_SIMILAR_MAX_CANDIDATES}. The whole scan
* is O(open peers) token comparisons and runs only when a caller asks for it —
* it is deliberately NOT part of the default snapshot, so the board's 2.5 s
* poll neither pays for it nor grows by it (see docs/architecture.md).
*
* @returns the report, or undefined only when `ideaId` is blank.
*/
function findIdeaSimilar(ideas, ideaId, limit = 20) {
	const anchor = ideas.find((idea) => idea.id === ideaId);
	if (anchor === void 0) return {
		ideaId,
		found: false,
		scanned: 0,
		candidates: [],
		flagged: false
	};
	const anchorWorkspace = anchor.workspaceId ?? "";
	const peers = ideas.filter((idea) => idea.id !== anchor.id && idea.status === "open" && (idea.workspaceId ?? "") === anchorWorkspace);
	const scored = [];
	for (const peer of peers) {
		const { score, signals } = ideaSimilarity(anchor, peer);
		if (score < .34) continue;
		scored.push({
			id: peer.id,
			...peer.ideaNumber === void 0 ? {} : { ideaNumber: peer.ideaNumber },
			title: peer.title,
			score,
			signals,
			createdAt: peer.createdAt
		});
	}
	scored.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const maximum = Math.min(20, Math.max(1, Math.trunc(limit)));
	const candidates = scored.slice(0, maximum).map(({ createdAt: _createdAt, ...candidate }) => candidate);
	return {
		ideaId,
		found: true,
		scanned: peers.length,
		candidates,
		flagged: candidates.length > 0
	};
}
/** Suffix every plugin-written snapshot (and quarantine) carries. */
const SNAPSHOT_SUFFIX = ".json";
const REASON_STEMS = {
	manual: "snapshot",
	export: "export",
	"pre-restore": "displaced"
};
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;
/**
* Whether a caller-supplied name is an acceptable selector. Bounded, ASCII,
* rooted: a name can never escape the folder or name a directory. A leading dot
* is refused so `..` and dotfiles are out by construction.
*/
function isSnapshotName(name) {
	return NAME_PATTERN.test(name) && !name.includes("..");
}
/** File name of one snapshot: `<reason>-<epoch ms>-<8 hex>.json`. */
function snapshotFileName(reason, at) {
	const stamp = String(Math.trunc(at));
	const unique = randomUUID().replace(/-/g, "").slice(0, 8);
	return `${REASON_STEMS[reason]}-${stamp}-${unique}${SNAPSHOT_SUFFIX}`;
}
/** Decode a plugin-written name back into its reason and timestamp. */
function readSnapshotName(name) {
	const parts = name.slice(0, -5).split("-");
	if (parts.length !== 3) return void 0;
	const [reasonStem, stamp, unique] = parts;
	const reason = Object.keys(REASON_STEMS).find((candidate) => REASON_STEMS[candidate] === reasonStem);
	if (reason === void 0) return void 0;
	if (!/^[0-9]{10,17}$/.test(stamp) || !/^[0-9a-f]{1,8}$/.test(unique)) return void 0;
	return {
		reason,
		createdAt: Number(stamp)
	};
}
var IdeasBackupStore = class {
	/** Absolute path of the backup folder. */
	dir;
	constructor(dir) {
		this.dir = dir;
	}
	/**
	* Every restorable file in the folder, newest first. Nothing is parsed: the
	* plugin-written name carries the reason and the timestamp, and a file the
	* plugin did not write (an export dropped in by hand — a supported way in)
	* falls back to its mtime.
	*/
	list() {
		let entries;
		try {
			entries = readdirSync(this.dir);
		} catch {
			return [];
		}
		const files = [];
		for (const name of entries) {
			if (!isSnapshotName(name)) continue;
			const path = join(this.dir, name);
			try {
				const stats = statSync(path);
				if (!stats.isFile()) continue;
				const stamp = readSnapshotName(name);
				files.push({
					name,
					path,
					bytes: stats.size,
					modifiedAt: stats.mtimeMs,
					reason: stamp?.reason ?? "manual",
					createdAt: stamp?.createdAt ?? stats.mtimeMs,
					managed: stamp !== void 0
				});
			} catch {}
		}
		return files.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
	}
	/** Absolute path of one snapshot, or undefined when the name is not usable. */
	pathOf(name) {
		return isSnapshotName(name) ? join(this.dir, name) : void 0;
	}
	/**
	* Write one snapshot atomically and return it. The folder is created on
	* demand: a first snapshot on a fresh install is a normal event, not an
	* error, and the folder must not exist just to prove the plugin booted.
	*/
	write(text, reason, at) {
		mkdirSync(this.dir, { recursive: true });
		const name = snapshotFileName(reason, at);
		writeFileAtomic(join(this.dir, name), text);
		const stats = statSync(join(this.dir, name));
		return {
			name,
			path: join(this.dir, name),
			bytes: stats.size,
			modifiedAt: stats.mtimeMs,
			reason,
			createdAt: at,
			managed: true
		};
	}
	/** Read one snapshot back as text; never throws. */
	read(name) {
		const path = this.pathOf(name);
		if (path === void 0) return {
			ok: false,
			reason: "invalid-name"
		};
		try {
			return {
				ok: true,
				text: readFileSync(path, "utf8")
			};
		} catch (error) {
			const code = error.code;
			if (code === "ENOENT" || code === "EISDIR") return {
				ok: false,
				reason: "not-found"
			};
			return {
				ok: false,
				reason: "unreadable"
			};
		}
	}
	/**
	* Move an unusable snapshot beside itself (`<name>.corrupt-<stamp>`), the
	* ledger's quarantine discipline: evidence is kept, the bad file is never
	* offered again. A file this plugin did not write is NOT renamed — a foreign
	* export is the user's file, and moving it would be a surprise.
	*
	* @returns the quarantine path, or undefined when nothing was moved.
	*/
	quarantine(file) {
		if (!file.managed) return void 0;
		const target = `${file.path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
		try {
			renameSync(file.path, target);
			return target;
		} catch {
			return;
		}
	}
	/**
	* Keep the newest {@link IDEAS_SNAPSHOT_RETENTION} snapshots this plugin
	* wrote and remove the older ones. Unmanaged files are NEVER touched: a user
	* who dropped an exported ledger in this folder must not watch it disappear
	* because the retention count was reached.
	*
	* @returns how many files were removed.
	*/
	prune(retention = 10) {
		const managed = this.list().filter((file) => file.managed);
		if (managed.length <= retention) return 0;
		let removed = 0;
		for (const file of managed.slice(retention)) try {
			unlinkSync(file.path);
			removed += 1;
		} catch {}
		return removed;
	}
	/** Whether the folder exists at all (a fresh install has none until needed). */
	exists() {
		return existsSync(this.dir);
	}
};
/**
* Atomic tmp+rename commit (the ledger's own discipline, see this module's
* header). The tmp path never survives a successful write; on the transient
* Windows EPERM rename flake the same bytes go straight to the destination.
*/
function writeFileAtomic(file, text) {
	const tmpFile = `${file}.tmp-${process.pid}`;
	writeFileSync(tmpFile, text);
	try {
		renameSync(tmpFile, file);
	} catch {
		try {
			writeFileSync(file, text);
		} finally {
			try {
				unlinkSync(tmpFile);
			} catch {}
		}
	}
}
//#endregion
//#region src/dsh-home.ts
/**
* DSH_HOME resolution for the ideas Host half, following the dsh-task-board
* family discipline: the environment override wins, the platform home
* fallback follows.
*/
/**
* Resolve the DSH home directory.
* @param env - process environment to read DSH_HOME from.
* @param home - platform home directory fallback (test seam).
* @returns the absolute DSH home path.
*/
function resolveDshHome(env = process.env, home = homedir()) {
	const raw = env.DSH_HOME;
	if (raw !== void 0 && raw.trim() !== "") {
		const trimmed = raw.trim();
		return isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
	}
	return join(home, ".dsh");
}
/** Resolve the DSH home directory from the live environment. */
function dshHome() {
	return resolveDshHome();
}
//#endregion
//#region src/export-markdown.ts
/** ISO-8601 UTC instant (stable across the platform). */
function iso(ms) {
	return new Date(ms).toISOString();
}
function bullet(label, value) {
	return `- ${label}: ${value}`;
}
/** Render one idea as a markdown section. */
function ideaToMarkdown(idea) {
	const lines = [`## ${idea.title}`, ""];
	lines.push(bullet("id", `\`${idea.id}\``));
	lines.push(bullet("status", idea.status));
	if (idea.ideaNumber !== void 0) lines.push(bullet("number", `#${idea.ideaNumber}`));
	if (idea.tags !== void 0 && idea.tags.length > 0) lines.push(bullet("tags", idea.tags.map((tag) => `\`${tag.name}\``).join(", ")));
	const scores = [];
	if (idea.value !== void 0) scores.push(`value: ${idea.value}`);
	if (idea.effort !== void 0) scores.push(`effort: ${idea.effort}`);
	if (scores.length > 0) lines.push(bullet("scores", scores.join(" · ")));
	if (idea.rank !== void 0) lines.push(bullet("rank", String(idea.rank)));
	if (idea.workspaceId !== void 0) lines.push(bullet("workspace", `\`${idea.workspaceId}\``));
	if (idea.rationale !== void 0) lines.push(bullet("rationale", idea.rationale));
	if (idea.decision !== void 0) lines.push(bullet("decision", idea.decision));
	if (idea.followUpOfId !== void 0) lines.push(bullet("follow-up of", `\`${idea.followUpOfId}\``));
	if (idea.relatesTo !== void 0 && idea.relatesTo.length > 0) lines.push(bullet("relates to", idea.relatesTo.map((id) => `\`${id}\``).join(", ")));
	if (idea.blocks !== void 0 && idea.blocks.length > 0) lines.push(bullet("blocks", idea.blocks.map((id) => `\`${id}\``).join(", ")));
	lines.push(bullet("created", iso(idea.createdAt)));
	lines.push(bullet("updated", iso(idea.updatedAt)));
	if (idea.deliveredAt !== void 0) lines.push(bullet("delivered", iso(idea.deliveredAt)));
	if (idea.archivedAt !== void 0) lines.push(bullet("archived", iso(idea.archivedAt)));
	if (idea.deliveryNote !== void 0) lines.push(bullet("delivery note", idea.deliveryNote));
	if (idea.events !== void 0 && idea.events.length > 0) {
		lines.push("", "**Activity**", "");
		for (const entry of idea.events) lines.push(`- ${iso(entry.at)} · ${entry.verb} · ${entry.actor} — ${entry.summary}`);
		lines.push("");
	}
	if (idea.body.trim() !== "") lines.push("", idea.body.trim(), "");
	lines.push("");
	return lines.join("\n");
}
/**
* Generate the two export documents.
* @param ideas - the full ledger ideas (filtered by the caller when a
*   workspace is requested).
* @param title - document heading (e.g. "IDEAS" / "IDEAS-ARCHIVE").
* @param noun - singular labelling used in the empty state.
*/
function ideasToMarkdown(ideas, title, noun) {
	const lines = [
		`# ${title}`,
		"",
		`> Generated by dsh-plugin-ideas-manager at ${iso(Date.now())}. Unidirectional: edit the ledger, never this file.`,
		""
	];
	if (ideas.length === 0) {
		lines.push(`_No ${noun} yet._`, "");
		return lines.join("\n");
	}
	for (const idea of ideas) lines.push(ideaToMarkdown(idea));
	return lines.join("\n");
}
/**
* Build the export for a ledger (optionally filtered to one workspace).
* Open + under-review ideas go to the main document (under review = task
* done, human acceptance pending — still active work, not delivered);
* archived/declined ideas go to the archive document.
*/
function buildIdeasExport(ideas, workspaceId) {
	const filter = workspaceId === void 0 ? void 0 : (idea) => idea.workspaceId === workspaceId;
	const active = ideas.filter((idea) => (idea.status === "open" || idea.status === "underReview") && (filter === void 0 || filter(idea)));
	const closed = ideas.filter((idea) => (idea.status === "archived" || idea.status === "declined") && (filter === void 0 || filter(idea)));
	return {
		ideasMd: ideasToMarkdown(active, "IDEAS", "open ideas"),
		archiveMd: ideasToMarkdown(closed, "IDEAS-ARCHIVE", "archived ideas")
	};
}
/**
* First instant of the Host's LOCAL calendar month containing `at`.
*
* Local, not UTC, and deliberately: "delivered this month" is a sentence a
* reader checks against their own wall clock, and a UTC month boundary would
* put the last delivery of a month in the wrong bucket for most of the day.
*/
function calendarMonthStart(at) {
	const date = new Date(at);
	return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0).getTime();
}
/** Median of a non-empty sample (mean of the two middle values when even). */
function medianOf(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	return Math.round(value);
}
/**
* Build the health aggregate for one scope.
*
* One pass over the ideas in scope, no allocation proportional to the ledger:
* the only structures that grow are the workspace groups and the label counts,
* and both are cut to their cap before the response is built.
*
* @param source - the current snapshot (revision + rows).
* @param options - the workspace scope and the clock.
* @returns the bounded aggregate; never throws on a partial or odd ledger.
*/
function buildIdeasStats(source, options = {}) {
	const now = options.now ?? Date.now();
	const scopeId = options.workspaceId;
	const inScope = (idea) => scopeId === void 0 ? true : (idea.workspaceId ?? "") === scopeId;
	const windowStart = calendarMonthStart(now);
	const groups = /* @__PURE__ */ new Map();
	const tagCounts = /* @__PURE__ */ new Map();
	const leadTimes = [];
	let ideas = 0;
	let openTotal = 0;
	let deliveredInWindow = 0;
	let withoutStamp = 0;
	let inconsistent = 0;
	let missingRank = 0;
	let missingValue = 0;
	for (const idea of source.ideas) {
		if (!inScope(idea)) continue;
		ideas += 1;
		const key = idea.workspaceId ?? "";
		const group = groups.get(key) ?? {
			open: 0,
			total: 0
		};
		group.total += 1;
		if (idea.status === "open") {
			group.open += 1;
			openTotal += 1;
			if (idea.rank === void 0) missingRank += 1;
			if (idea.value === void 0) missingValue += 1;
			for (const tag of idea.tags ?? []) {
				const name = tag.name.trim();
				if (name === "") continue;
				const folded = name.toLowerCase();
				const entry = tagCounts.get(folded);
				if (entry === void 0) tagCounts.set(folded, {
					name,
					count: 1
				});
				else entry.count += 1;
			}
		}
		groups.set(key, group);
		const deliveredAt = idea.deliveredAt;
		if (deliveredAt === void 0 || !Number.isFinite(deliveredAt)) {
			if (idea.status === "archived") withoutStamp += 1;
			continue;
		}
		const leadTime = deliveredAt - idea.createdAt;
		if (leadTime < 0) {
			inconsistent += 1;
			continue;
		}
		leadTimes.push(leadTime);
		if (deliveredAt >= windowStart && deliveredAt <= now) deliveredInWindow += 1;
	}
	const openByWorkspace = [...groups.entries()].map(([workspaceId, group]) => ({
		...workspaceId === "" ? {} : { workspaceId },
		open: group.open,
		total: group.total
	})).sort((a, b) => b.open - a.open || b.total - a.total || (a.workspaceId ?? "").localeCompare(b.workspaceId ?? ""));
	const topTags = [...tagCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	const sample = leadTimes.length;
	return {
		schemaVersion: 1,
		revision: source.revision,
		computedAt: now,
		scope: {
			kind: scopeId === void 0 ? "all" : scopeId === "" ? "generic" : "workspace",
			...scopeId === void 0 || scopeId === "" ? {} : { workspaceId: scopeId },
			ideas
		},
		window: {
			kind: "calendarMonth",
			start: windowStart,
			end: now
		},
		openTotal,
		openByWorkspace: openByWorkspace.slice(0, 8),
		workspacesTotal: openByWorkspace.length,
		deliveredInWindow,
		delivery: {
			sample,
			withoutStamp,
			inconsistent,
			medianMs: sample < 5 ? null : medianOf(leadTimes),
			minSamples: 5
		},
		topTags: topTags.slice(0, 8),
		tagsTotal: topTags.length,
		triage: {
			open: openTotal,
			missingRank,
			missingValue
		}
	};
}
const IDEAS_API_PREFIX = "/api/ideas";
/** Default number of rows in a bounded read. */
const IDEAS_READ_DEFAULT_LIMIT = 100;
/** Hard row cap for one bounded read. */
const IDEAS_READ_MAX_LIMIT = 200;
/** Hard UTF-8 byte cap for one selected idea body. */
const IDEAS_READ_MAX_BODY_BYTES = 4 * 1024;
/** Hard UTF-8 byte cap for one bounded-read JSON response. */
const IDEAS_READ_MAX_RESPONSE_BYTES = 512 * 1024;
/**
* Optional top-level fields a bounded read may select. Identity and timestamp
* fields are always present (revision is top-level); `analysisAudit` is
* intentionally unavailable in
* this projection because it can carry a second full body. The frozen raw
* single-idea route remains the explicit full-detail escape hatch.
*
* `relatesTo` and `blocks` are selectable and, unlike `events`, they are part of
* BOTH default views: a relation is reference-shaped (ids, not prose), so what
* a poll pays for them is a few dozen bytes on the rows that carry one — and
* without them a bounded reader cannot answer "what does this wait on?" at all.
* The `blockedBy` side is derived from `blocks`, never stored, so it costs
* nothing on the wire.
*/
const IDEAS_READ_SELECTABLE_FIELDS = [
	"summary",
	"rank",
	"value",
	"effort",
	"rationale",
	"tags",
	"workspaceId",
	"taskBoardId",
	"taskBoardStatus",
	"runStatus",
	"runSessionId",
	"deliveryNote",
	"followUpOfId",
	"deliveredAt",
	"decision",
	"archivedAt",
	"reanalyzeAt",
	"body",
	"events",
	"relatesTo",
	"blocks"
];
const SUMMARY_READ_FIELDS = [
	"summary",
	"workspaceId",
	"tags",
	"taskBoardId",
	"followUpOfId",
	"relatesTo",
	"blocks"
];
const DETAIL_READ_FIELDS = IDEAS_READ_SELECTABLE_FIELDS.filter((field) => field !== "body");
const READ_QUERY_KEYS = /* @__PURE__ */ new Set([
	"view",
	"workspaceId",
	"status",
	"id",
	"number",
	"fields",
	"bodyLimit",
	"limit",
	"offset",
	"similar"
]);
function uniqueBoundedStrings(values, maximum) {
	const unique = [...new Set(values)];
	return unique.length <= maximum ? unique : void 0;
}
function queryValues(params, key, splitCommas = true) {
	return (splitCommas ? params.getAll(key).flatMap((value) => value.split(",")) : params.getAll(key)).map((value) => value.trim());
}
function queryInteger(params, key, fallback, minimum, maximum) {
	const raw = params.get(key);
	if (raw === null) return fallback;
	if (!/^(0|[1-9][0-9]*)$/.test(raw)) return void 0;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : void 0;
}
/**
* Parse and bound the additive read query. `status`, `id`, `number`, and
* `fields` are repeatable; `status` and `fields` also accept comma-separated
* lists. Unknown keys and out-of-range values reject instead of silently
* broadening a read.
*
* `similar` is an anchor idea id for the near-duplicate scan. Like every other
* bounded-read key it only applies to `view=summary|detail`: the frozen full
* snapshot carries no `similar` block at all (the route serves that view
* without consulting this parser), which is exactly why the flag costs the
* board's poll nothing.
*/
function parseIdeasReadQuery(params) {
	if ([...params.keys()].some((key) => !READ_QUERY_KEYS.has(key))) return void 0;
	const rawView = params.get("view");
	if (rawView !== null && rawView !== "summary" && rawView !== "detail") return void 0;
	const view = rawView ?? "summary";
	const workspaceId = params.get("workspaceId")?.trim();
	if (params.has("workspaceId") && (workspaceId === void 0 || workspaceId === "" || workspaceId.length > 256)) return void 0;
	const rawStatuses = queryValues(params, "status");
	if (rawStatuses.length > 100 || rawStatuses.some((status) => !isIdeaStatus(status))) return void 0;
	const rawIds = queryValues(params, "id", false);
	if (rawIds.length > 100 || rawIds.some((id) => id === "" || id.length > 256)) return void 0;
	const rawNumbers = queryValues(params, "number", false);
	if (rawNumbers.length > 100 || rawNumbers.some((value) => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) return void 0;
	const rawFields = queryValues(params, "fields");
	if (rawFields.length > IDEAS_READ_SELECTABLE_FIELDS.length || rawFields.some((field) => !IDEAS_READ_SELECTABLE_FIELDS.includes(field))) return void 0;
	const limit = queryInteger(params, "limit", 100, 1, 200);
	const offset = queryInteger(params, "offset", 0, 0, 1e6);
	const bodyLimit = queryInteger(params, "bodyLimit", 0, 0, IDEAS_READ_MAX_BODY_BYTES);
	if (limit === void 0 || offset === void 0 || bodyLimit === void 0) return void 0;
	const rawSimilar = params.get("similar")?.trim();
	if (params.has("similar") && (rawSimilar === void 0 || rawSimilar === "" || rawSimilar.length > 256)) return void 0;
	const fields = uniqueBoundedStrings(rawFields, IDEAS_READ_SELECTABLE_FIELDS.length);
	const ids = uniqueBoundedStrings(rawIds, 100);
	const numbers = uniqueBoundedStrings(rawNumbers.map(String), 100)?.map(Number);
	const status = uniqueBoundedStrings(rawStatuses, 100);
	if (fields === void 0 || ids === void 0 || numbers === void 0 || status === void 0) return void 0;
	return {
		view,
		...workspaceId === void 0 ? {} : { workspaceId },
		status,
		ids,
		numbers,
		fields: rawFields.length === 0 ? [...view === "detail" ? DETAIL_READ_FIELDS : SUMMARY_READ_FIELDS] : fields,
		bodyLimit,
		limit,
		offset,
		...rawSimilar === void 0 ? {} : { similar: rawSimilar }
	};
}
/** Serialize a bounded-read query for the browser transport. */
function ideasReadSearchParams(query) {
	const params = new URLSearchParams();
	if (query.view !== void 0) params.set("view", query.view);
	if (query.workspaceId !== void 0) params.set("workspaceId", query.workspaceId);
	for (const status of query.status ?? []) params.append("status", status);
	for (const id of query.ids ?? []) params.append("id", id);
	for (const number of query.numbers ?? []) params.append("number", String(number));
	for (const field of query.fields ?? []) params.append("fields", field);
	if (query.bodyLimit !== void 0) params.set("bodyLimit", String(query.bodyLimit));
	if (query.limit !== void 0) params.set("limit", String(query.limit));
	if (query.offset !== void 0) params.set("offset", String(query.offset));
	if (query.similar !== void 0) params.set("similar", query.similar);
	return params;
}
const STATS_QUERY_KEYS = /* @__PURE__ */ new Set(["view", "workspaceId"]);
/**
* Parse and bound the health query. Unknown keys reject rather than being
* ignored, so a caller that misspelled a selector is told rather than quietly
* answered for the wrong population.
*
* @returns the query, or undefined when `view` is not `stats` or a key is
*   unknown/oversized.
*/
function parseIdeasStatsQuery(params) {
	if ([...params.keys()].some((key) => !STATS_QUERY_KEYS.has(key))) return void 0;
	if (params.get("view") !== "stats") return void 0;
	if (!params.has("workspaceId")) return {};
	const workspaceId = params.get("workspaceId")?.trim() ?? "";
	if (workspaceId.length > 256) return void 0;
	return { workspaceId };
}
function utf8Bytes(value) {
	return new TextEncoder().encode(value).byteLength;
}
/** Slice by UTF-8 bytes without splitting a Unicode code point. */
function bodyPrefix(body, maximumBytes) {
	if (utf8Bytes(body) <= maximumBytes) return {
		value: body,
		truncated: false
	};
	let bytes = 0;
	let end = 0;
	for (const character of body) {
		const size = utf8Bytes(character);
		if (bytes + size > maximumBytes) break;
		bytes += size;
		end += character.length;
	}
	return {
		value: body.slice(0, end),
		truncated: true
	};
}
function projectReadRow(idea, query, selected) {
	const row = {
		id: idea.id,
		title: idea.title,
		status: idea.status,
		createdAt: idea.createdAt,
		updatedAt: idea.updatedAt,
		...idea.ideaNumber === void 0 ? {} : { ideaNumber: idea.ideaNumber }
	};
	for (const field of query.fields) {
		if (field === "body" || !Object.prototype.hasOwnProperty.call(idea, field)) continue;
		Object.assign(row, { [field]: idea[field] });
	}
	if (selected.has("body")) {
		const body = bodyPrefix(idea.body, query.bodyLimit);
		row.body = body.value;
		if (body.truncated) row.bodyTruncated = true;
	}
	return row;
}
function readResponse(revision, rows, query, matched, omittedFields) {
	const bodyTruncated = rows.some((row) => row.bodyTruncated === true);
	const returned = rows.length;
	const next = query.offset + returned;
	const rowTruncated = next < matched;
	return {
		schemaVersion: 1,
		revision,
		ideas: rows,
		meta: {
			view: query.view,
			fields: [...query.fields],
			bodyLimitBytes: query.bodyLimit,
			limit: query.limit,
			offset: query.offset,
			matched,
			returned,
			rowTruncated,
			nextOffset: rowTruncated ? next : null,
			bodyTruncated,
			omittedFields
		}
	};
}
function validReadQuery(input) {
	const statusValid = (input.status ?? []).every((status) => isIdeaStatus(status));
	const idsValid = (input.ids ?? []).every((id) => id !== "" && id.length <= 256);
	const numbersValid = (input.numbers ?? []).every((number) => Number.isSafeInteger(number) && number > 0);
	const fieldsValid = (input.fields ?? []).every((field) => IDEAS_READ_SELECTABLE_FIELDS.includes(field));
	const bounded = (value, minimum, maximum) => value === void 0 || Number.isSafeInteger(value) && value >= minimum && value <= maximum;
	return (input.workspaceId === void 0 || input.workspaceId !== "" && input.workspaceId.length <= 256) && (input.status?.length ?? 0) <= 100 && (input.ids?.length ?? 0) <= 100 && (input.numbers?.length ?? 0) <= 100 && (input.fields?.length ?? 0) <= IDEAS_READ_SELECTABLE_FIELDS.length && (input.similar === void 0 || input.similar !== "" && input.similar.length <= 256) && statusValid && idsValid && numbersValid && fieldsValid && bounded(input.bodyLimit, 0, 4096) && bounded(input.limit, 1, 200) && bounded(input.offset, 0, 1e6);
}
/**
* Project a source-of-truth snapshot into a bounded filtered read. No cache
* or mutable view state is introduced: every response is derived from the
* current ledger revision. If selected fields would exceed the hard wire
* budget, trailing rows are omitted and `nextOffset` makes that explicit.
*
* The opt-in near-duplicate report is the ONLY extra work this function can
* do, and it happens strictly when `similar` names an anchor: the scan reads
* the same `snapshot.ideas` array (no extra ledger pass) and its candidates
* are capped by `limit` as well as by IDEAS_SIMILAR_MAX_CANDIDATES. Without
* the key the response is exactly what it was before this feature existed.
*/
function buildIdeasReadSnapshot(snapshot, input = {}) {
	if (!validReadQuery(input)) throw new Error("invalid-query");
	const query = {
		view: input.view ?? "summary",
		...input.workspaceId === void 0 ? {} : { workspaceId: input.workspaceId },
		status: [...new Set(input.status ?? [])],
		ids: [...new Set(input.ids ?? [])],
		numbers: [...new Set(input.numbers ?? [])],
		fields: [...new Set(input.fields ?? (input.view === "detail" ? DETAIL_READ_FIELDS : SUMMARY_READ_FIELDS))],
		bodyLimit: input.bodyLimit ?? 0,
		limit: input.limit ?? 100,
		offset: input.offset ?? 0,
		...input.similar === void 0 ? {} : { similar: input.similar }
	};
	const statuses = new Set(query.status);
	const ids = new Set(query.ids);
	const numbers = new Set(query.numbers);
	const hasSelector = ids.size > 0 || numbers.size > 0;
	const matchedIdeas = snapshot.ideas.filter((idea) => (query.workspaceId === void 0 || idea.workspaceId === query.workspaceId) && (statuses.size === 0 || statuses.has(idea.status)) && (!hasSelector || ids.has(idea.id) || idea.ideaNumber !== void 0 && numbers.has(idea.ideaNumber)));
	const selected = new Set(query.fields);
	const omittedFields = [...IDEAS_READ_SELECTABLE_FIELDS.filter((field) => !selected.has(field)), "analysisAudit"];
	const rows = matchedIdeas.slice(query.offset, query.offset + query.limit).map((idea) => projectReadRow(idea, query, selected));
	let response = readResponse(snapshot.revision, rows, query, matchedIdeas.length, omittedFields);
	while (rows.length > 0 && utf8Bytes(JSON.stringify(response)) > 524288) {
		rows.pop();
		response = readResponse(snapshot.revision, rows, query, matchedIdeas.length, omittedFields);
	}
	if (query.similar !== void 0) response.similar = findIdeaSimilar(snapshot.ideas, query.similar, query.limit);
	return response;
}
/**
* Leading slice of a body for previews and search: whitespace collapses to
* single spaces (this is a teaser, not markdown structure), the cut lands on
* a word boundary when one is reasonably close, and a truncated excerpt
* carries an ellipsis.
*/
function bodyExcerptOf(body) {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= 280) return flat;
	const cut = flat.slice(0, 280);
	const lastSpace = cut.lastIndexOf(" ");
	return `${lastSpace > 280 * .6 ? cut.slice(0, lastSpace) : cut}…`;
}
/** Project one full record to its list row (drops body + analysisAudit + events). */
function toListRow(idea) {
	const { body, analysisAudit, events, ...rest } = idea;
	return {
		...rest,
		bodyExcerpt: bodyExcerptOf(body)
	};
}
/**
* Project a full snapshot to the list view. Shared by the host (the
* `?view=list` state route) and the client (action responses still carry
* the FULL snapshot - the POST /api/ideas/action contract is frozen - and
* are projected here at the transport edge).
*/
function toListSnapshot(snapshot) {
	return {
		schemaVersion: snapshot.schemaVersion,
		revision: snapshot.revision,
		ideas: snapshot.ideas.map(toListRow)
	};
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function exactKeys(value, allowed) {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function optionalString(value) {
	return value === void 0 || typeof value === "string";
}
function optionalFiniteNumber(value) {
	return value === void 0 || typeof value === "number" && Number.isFinite(value);
}
const FORBIDDEN_IMPORT_FIELDS = /* @__PURE__ */ new Set([
	"args",
	"command",
	"executable",
	"powershell",
	"shell"
]);
function hasForbiddenImportField(value) {
	if (Array.isArray(value)) return value.some(hasForbiddenImportField);
	const row = record(value);
	if (row === void 0) return false;
	return Object.entries(row).some(([key, nested]) => FORBIDDEN_IMPORT_FIELDS.has(key.toLowerCase()) || hasForbiddenImportField(nested));
}
function importedIdea(value) {
	const input = record(value);
	if (input === void 0 || hasForbiddenImportField(input)) return void 0;
	const row = { ...input };
	if (typeof row.title !== "string" || typeof row.body !== "string") return void 0;
	if (typeof row.id !== "string" || row.id === "") return void 0;
	if (typeof row.createdAt !== "number" || typeof row.updatedAt !== "number") return void 0;
	if (!isIdeaStatus(row.status)) return void 0;
	if (row.tags !== void 0 && !isIdeaTagList(row.tags)) return void 0;
	if (row.rank !== void 0 && row.rank !== null && (typeof row.rank !== "number" || !Number.isFinite(row.rank))) return void 0;
	if (row.value !== void 0 && row.value !== null && (typeof row.value !== "number" || !Number.isFinite(row.value))) return void 0;
	if (row.effort !== void 0 && row.effort !== null && (typeof row.effort !== "number" || !Number.isFinite(row.effort))) return void 0;
	if (row.rationale !== void 0 && row.rationale !== null && typeof row.rationale !== "string") return void 0;
	if (row.decision !== void 0 && row.decision !== null && typeof row.decision !== "string") return void 0;
	if (row.ideaNumber !== void 0 && row.ideaNumber !== null && (typeof row.ideaNumber !== "number" || !Number.isFinite(row.ideaNumber))) return void 0;
	if (row.deliveredAt !== void 0 && row.deliveredAt !== null && typeof row.deliveredAt !== "number") return void 0;
	for (const key of ["workspaceId", "taskBoardId"]) if (row[key] !== void 0 && typeof row[key] !== "string") return void 0;
	if (row.taskBoardStatus !== void 0 && row.taskBoardStatus !== null && (typeof row.taskBoardStatus !== "string" || row.taskBoardStatus.length > 32)) return void 0;
	if (row.runStatus !== void 0 && row.runStatus !== null && !isIdeaRunStatus(row.runStatus)) return void 0;
	if (row.runSessionId !== void 0 && row.runSessionId !== null && (typeof row.runSessionId !== "string" || row.runSessionId.length > 128)) return void 0;
	if (row.deliveryNote !== void 0 && row.deliveryNote !== null && typeof row.deliveryNote !== "string") return void 0;
	if (row.archivedAt !== void 0 && row.archivedAt !== null && typeof row.archivedAt !== "number") return void 0;
	if (row.followUpOfId !== void 0 && row.followUpOfId !== null && typeof row.followUpOfId !== "string") return void 0;
	if (row.reanalyzeAt !== void 0 && row.reanalyzeAt !== null && typeof row.reanalyzeAt !== "number") return void 0;
	if (row.summary !== void 0 && row.summary !== null && typeof row.summary !== "string") return void 0;
	if (row.analysisAudit !== void 0 && row.analysisAudit !== null && !isAnalysisAudit(row.analysisAudit)) return void 0;
	const events = normalizeIdeaEvents(row.events);
	if (row.events !== void 0 && row.events !== null && events === void 0) return void 0;
	const relatesTo = normalizeRelationIds(row.relatesTo);
	if (row.relatesTo !== void 0 && row.relatesTo !== null && relatesTo === void 0) return void 0;
	const blocks = normalizeRelationIds(row.blocks);
	if (row.blocks !== void 0 && row.blocks !== null && blocks === void 0) return void 0;
	return {
		id: row.id,
		title: row.title,
		body: row.body,
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		...typeof row.summary === "string" ? { summary: row.summary } : {},
		...typeof row.rank === "number" ? { rank: row.rank } : {},
		...typeof row.value === "number" ? { value: row.value } : {},
		...typeof row.effort === "number" ? { effort: row.effort } : {},
		...typeof row.rationale === "string" ? { rationale: row.rationale } : {},
		...typeof row.decision === "string" ? { decision: row.decision } : {},
		...typeof row.ideaNumber === "number" ? { ideaNumber: row.ideaNumber } : {},
		...typeof row.deliveredAt === "number" ? { deliveredAt: row.deliveredAt } : {},
		...isIdeaTagList(row.tags) ? { tags: row.tags } : {},
		...typeof row.workspaceId === "string" ? { workspaceId: row.workspaceId } : {},
		...typeof row.taskBoardId === "string" ? { taskBoardId: row.taskBoardId } : {},
		...typeof row.taskBoardStatus === "string" ? { taskBoardStatus: row.taskBoardStatus.toLowerCase() } : {},
		...isIdeaRunStatus(row.runStatus) ? { runStatus: row.runStatus } : {},
		...typeof row.runSessionId === "string" ? { runSessionId: row.runSessionId } : {},
		...typeof row.deliveryNote === "string" ? { deliveryNote: row.deliveryNote } : {},
		...typeof row.followUpOfId === "string" ? { followUpOfId: row.followUpOfId } : {},
		...relatesTo === void 0 ? {} : { relatesTo },
		...blocks === void 0 ? {} : { blocks },
		...typeof row.archivedAt === "number" ? { archivedAt: row.archivedAt } : {},
		...typeof row.reanalyzeAt === "number" ? { reanalyzeAt: row.reanalyzeAt } : {},
		...isAnalysisAudit(row.analysisAudit) ? { analysisAudit: row.analysisAudit } : {},
		...events === void 0 ? {} : { events }
	};
}
function createInput(value) {
	const input = record(value);
	if (input === void 0 || !exactKeys(input, [
		"title",
		"body",
		"summary",
		"workspaceId",
		"rank",
		"value",
		"effort",
		"rationale",
		"tags"
	])) return false;
	if (typeof input.title !== "string" || typeof input.body !== "string") return false;
	if (!optionalString(input.workspaceId)) return false;
	if (!optionalString(input.rationale)) return false;
	if (!optionalString(input.summary)) return false;
	if (!optionalFiniteNumber(input.rank) || !optionalFiniteNumber(input.value) || !optionalFiniteNumber(input.effort)) return false;
	return input.tags === void 0 || isIdeaTagList(input.tags);
}
function updatePatch(value) {
	const patch = record(value);
	if (patch === void 0 || !exactKeys(patch, [
		"title",
		"body",
		"summary",
		"rank",
		"value",
		"effort",
		"rationale",
		"tags",
		"workspaceId",
		"relatesTo",
		"blocks"
	])) return false;
	for (const key of [
		"title",
		"body",
		"workspaceId",
		"rationale"
	]) if (!optionalString(patch[key])) return false;
	if (patch.summary !== void 0 && patch.summary !== null && typeof patch.summary !== "string") return false;
	for (const key of [
		"rank",
		"value",
		"effort"
	]) if (patch[key] !== void 0 && (typeof patch[key] !== "number" || !Number.isFinite(patch[key]))) return false;
	if (patch.tags !== void 0 && patch.tags !== null && !isIdeaTagList(patch.tags)) return false;
	for (const key of ["relatesTo", "blocks"]) if (patch[key] !== void 0 && patch[key] !== null && !isIdeaRelationList(patch[key])) return false;
	return true;
}
function triagePatch(value) {
	const patch = record(value);
	if (patch === void 0 || !exactKeys(patch, [
		"value",
		"effort",
		"rationale",
		"rank"
	])) return false;
	if (!optionalString(patch.rationale)) return false;
	for (const key of [
		"value",
		"effort",
		"rank"
	]) if (!optionalFiniteNumber(patch[key])) return false;
	return true;
}
function followUpInput(value) {
	const input = record(value);
	if (input === void 0 || !exactKeys(input, ["title", "body"])) return false;
	return typeof input.title === "string" && typeof input.body === "string";
}
/** Whether an unknown value is a well-formed preserved prior analysis. */
function isAnalysisAudit(value) {
	const audit = record(value);
	if (audit === void 0 || !exactKeys(audit, [
		"at",
		"title",
		"body",
		"summary",
		"tags",
		"value",
		"effort",
		"rationale"
	])) return false;
	if (typeof audit.at !== "number" || typeof audit.title !== "string" || typeof audit.body !== "string") return false;
	if (audit.summary !== void 0 && typeof audit.summary !== "string") return false;
	if (audit.tags !== void 0 && !isIdeaTagList(audit.tags)) return false;
	for (const key of ["value", "effort"]) if (audit[key] !== void 0 && (typeof audit[key] !== "number" || !Number.isFinite(audit[key]))) return false;
	return audit.rationale === void 0 || typeof audit.rationale === "string";
}
function reorderList(value) {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "");
}
/**
* Strict parser for the action envelope `{ requestId, action, initiator? }`.
*
* The action is validated by the same gate the ledger's verbs rely on; the
* envelope fields are carried through VERBATIM, `initiator` included. That
* detail is load-bearing: the initiator is the activity log's
* provenance — the writer of a mutation is read back from it — so a parse that
* validated it and then dropped it would silently turn every agent write into
* "a human did this".
*/
function parseActionEnvelope(value) {
	const envelope = record(value);
	if (envelope === void 0 || !exactKeys(envelope, [
		"requestId",
		"action",
		"initiator"
	])) return void 0;
	if (typeof envelope.requestId !== "string" || envelope.requestId.trim() === "" || envelope.requestId.length > 256) return void 0;
	if (envelope.initiator !== void 0 && (typeof envelope.initiator !== "string" || envelope.initiator.trim() === "" || envelope.initiator.length > 256)) return void 0;
	const parsed = parseActionOnly(envelope.action);
	if (parsed === void 0) return void 0;
	const initiator = typeof envelope.initiator === "string" ? envelope.initiator.trim() : "";
	return {
		requestId: envelope.requestId,
		action: parsed.action,
		...initiator === "" ? {} : { initiator }
	};
}
/** Validate the `action` member alone; the envelope fields are the caller's. */
function parseActionOnly(value) {
	const action = record(value);
	if (action === void 0 || typeof action.kind !== "string") return void 0;
	const ideaId = typeof action.ideaId === "string" && action.ideaId !== "" ? action.ideaId : void 0;
	switch (action.kind) {
		case "import":
			if (!exactKeys(action, [
				"kind",
				"sourceId",
				"ideas"
			])) return void 0;
			if (typeof action.sourceId !== "string" || action.sourceId === "" || !Array.isArray(action.ideas)) return void 0;
			{
				const ideas = action.ideas.map(importedIdea);
				return ideas.every((idea) => idea !== void 0) ? { action: {
					kind: "import",
					sourceId: action.sourceId,
					ideas
				} } : void 0;
			}
		case "create": {
			if (!exactKeys(action, [
				"kind",
				"id",
				"input"
			])) return void 0;
			if (typeof action.id !== "string" || action.id === "" || !createInput(action.input)) return void 0;
			const input = action.input;
			const tags = normalizeTags(input.tags);
			const sanitized = tags === void 0 ? {
				...input,
				tags: void 0
			} : {
				...input,
				tags
			};
			return { action: {
				kind: "create",
				id: action.id,
				input: sanitized
			} };
		}
		case "update":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"patch"
			])) return void 0;
			if (ideaId === void 0 || !updatePatch(action.patch)) return void 0;
			return { action: {
				kind: "update",
				ideaId,
				patch: action.patch
			} };
		case "move":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"status"
			])) return void 0;
			if (ideaId === void 0) return void 0;
			return action.status === "open" || action.status === "underReview" || action.status === "archived" ? { action: {
				kind: "move",
				ideaId,
				status: action.status
			} } : void 0;
		case "decline":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"decision"
			])) return void 0;
			if (ideaId === void 0 || !optionalString(action.decision)) return void 0;
			return action.decision === void 0 ? { action: {
				kind: "decline",
				ideaId
			} } : { action: {
				kind: "decline",
				ideaId,
				decision: action.decision
			} };
		case "deliver":
			if (!exactKeys(action, ["kind", "ideaId"])) return void 0;
			return ideaId === void 0 ? void 0 : { action: {
				kind: "deliver",
				ideaId
			} };
		case "triage":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"patch"
			])) return void 0;
			if (ideaId === void 0 || !triagePatch(action.patch)) return void 0;
			return { action: {
				kind: "triage",
				ideaId,
				patch: action.patch
			} };
		case "followUp":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"input"
			])) return void 0;
			if (ideaId === void 0 || !followUpInput(action.input)) return void 0;
			return { action: {
				kind: "followUp",
				ideaId,
				input: action.input
			} };
		case "restore":
		case "delete":
			if (!exactKeys(action, ["kind", "ideaId"])) return void 0;
			return ideaId === void 0 ? void 0 : { action: {
				kind: action.kind,
				ideaId
			} };
		case "merge":
			if (!exactKeys(action, [
				"kind",
				"sourceId",
				"targetId",
				"mode"
			])) return void 0;
			if (typeof action.sourceId !== "string" || action.sourceId.trim() === "" || action.sourceId.length > 256) return void 0;
			if (typeof action.targetId !== "string" || action.targetId.trim() === "" || action.targetId.length > 256) return void 0;
			if (!isIdeaMergeMode(action.mode)) return void 0;
			return { action: {
				kind: "merge",
				sourceId: action.sourceId.trim(),
				targetId: action.targetId.trim(),
				mode: action.mode
			} };
		case "reanalyze":
			if (!exactKeys(action, ["kind", "ideaId"])) return void 0;
			return ideaId === void 0 ? void 0 : { action: {
				kind: "reanalyze",
				ideaId
			} };
		case "reorder":
			if (!exactKeys(action, ["kind", "orderedIds"])) return void 0;
			return reorderList(action.orderedIds) ? { action: {
				kind: "reorder",
				orderedIds: action.orderedIds
			} } : void 0;
		case "export":
			if (!exactKeys(action, ["kind", "workspaceId"])) return void 0;
			return action.workspaceId === void 0 || typeof action.workspaceId === "string" ? { action: {
				kind: "export",
				...action.workspaceId === void 0 ? {} : { workspaceId: action.workspaceId }
			} } : void 0;
		default: return;
	}
}
/**
* Request cap of the restore route (8 MiB). The 64 KiB action cap is sized for
* a single mutation and the 2 MiB import cap for a migration batch; a full
* ledger with long analyses is simply larger, and truncating it would be the one
* failure mode this route must never have.
*/
const IDEAS_RESTORE_LIMIT = 8 * 1024 * 1024;
/**
* Validate the restore body. Exactly one source must be present: a name alone
* for the local snapshot, a document alone for the portable import.
*/
function parseRestoreRequest(value) {
	const body = record(value);
	if (body === void 0 || !exactKeys(body, ["name", "document"])) return void 0;
	const name = body.name;
	const document = body.document;
	if (name === void 0 && typeof document !== "string") return void 0;
	if (name !== void 0 && typeof document === "string") return void 0;
	if (name !== void 0 && (typeof name !== "string" || name.trim() === "" || name.length > 128)) return void 0;
	if (document !== void 0 && (typeof document !== "string" || document.length === 0)) return void 0;
	return {
		...typeof name === "string" ? { name: name.trim() } : {},
		...typeof document === "string" ? { document } : {}
	};
}
/** Reasons the restore route answers 409 rather than 400: a state, not a bad request. */
const IDEAS_RESTORE_CONFLICT = /* @__PURE__ */ new Set([
	"restore-run-in-flight",
	"snapshot-schema-newer",
	"ideas plugin is disabled"
]);
/**
* Panel tabs, mirror of BOARD_TABS (src/client/tabs.ts): spelled here so the
* host bundle never pulls the client model — same discipline as the defaults.
*/
const IDEAS_TABS = [
	"overview",
	"priorities",
	"delivered",
	"health"
];
/** Card densities offered by the settings row. */
const IDEAS_DENSITIES = ["comfortable", "compact"];
/**
* Orderings of the OPEN backlog offered by the settings row:
*  - `createdAt` (the default): oldest idea first. A backlog reads as a diary,
*    so the default is the order the ideas actually arrived in;
*  - `createdAtDesc`: newest idea first;
*  - `rank`: the human ranking, exactly as the reorder verb wrote it.
*
* All three are VIEW ONLY: none of them is persisted, so the 2.5 s client poll
* can never rewrite the ranking behind the reader's back. The independent
* `runningFirst` toggle (ON by default) floats the in-flight work above
* whichever of the three is selected.
*/
const IDEAS_OPEN_ORDERINGS = [
	"createdAt",
	"createdAtDesc",
	"rank"
];
/**
* Interface languages of the panel: `auto` follows the DSH shell language
* (the shipped default), the others pin the panel to one dictionary
* independently of the shell. DSH serves en + zh today, so `auto` gives an
* English panel on an English shell and a Chinese one on a Chinese shell;
* `fr` exists for a French-reading operator and future-proofs a French shell.
*/
const IDEAS_LANGUAGES = [
	"auto",
	"en",
	"fr",
	"zh"
];
/**
* The permission a DIRECT launch — an idea with no runnable card, run in a
* fresh session — starts that session at.
*
* Why a setting and not a constant: the card backend has no choice to make
* (the mirrored card carries the task-board's own deployment default, see
* taskboard-bridge.ts), but a fresh session is created by this plugin and
* inherits whatever the Host hands a new session. The run prompt says
* "You are implementing the idea below... Work in the current workspace
* directory", so the default is `workspace-write`: a read-only direct run
* would answer with a plan and settle `done` having written nothing. A
* deployment that wants the fence back sets `read-only` here.
*/
const IDEAS_RUN_PERMISSIONS = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
/** Inclusive bounds of the columnMinWidth option (settings row). */
const COLUMN_MIN_WIDTH_RANGE = {
	min: 120,
	max: 480
};
/** Inclusive bounds of the columnMaxWidth option (settings row). */
const COLUMN_MAX_WIDTH_RANGE = {
	min: 240,
	max: 1382
};
/**
* Defaults the browser half keeps when no settings surface answers. Spelled
* here rather than imported from the host entry so the client bundle never
* pulls the Node-side module — same discipline as IDEAS_SETTINGS_NAMESPACE.
*/
const IDEAS_SETTINGS_DEFAULTS = {
	tagRows: 3,
	defaultTab: "overview",
	renderMarkdown: true,
	rememberWorkspaceScope: false,
	workspaceScope: "",
	confirmLifecycle: false,
	hideDeclinedColumn: false,
	cardDensity: "comfortable",
	language: "auto",
	openOrdering: "createdAt",
	runningFirst: true,
	columnMinWidth: 200,
	columnMaxWidth: 922,
	directRunPermission: "workspace-write",
	staleAfterDays: 30,
	launchModelByWorkspace: {}
};
/**
* Inclusive bounds of the `staleAfterDays` option. 0 is a real
* value, not "unset": it means "never flag an idea as stale", which is the
* escape hatch for a backlog the reader watches in another tool. The ceiling
* keeps a hand-edited value from parking the badge on a decade-old idea.
*/
const STALE_AFTER_DAYS_RANGE = {
	min: 0,
	max: 3650
};
/**
* Clamp an unknown input to a legal tagRows value: finite numbers round to
* the nearest integer and clamp into 1..5; anything else falls back to the
* default. Hand-edited settings and hand-crafted wire values can never store
* or render an illegal row count (the clamp, not the schema, is the guard —
* a schema range would reject a bad stored section at registration).
*/
function clampTagRows(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return IDEAS_SETTINGS_DEFAULTS.tagRows;
	return Math.min(5, Math.max(1, Math.round(value)));
}
/**
* Clamp an unknown input to a legal minimum column width: finite numbers round
* and clamp into the range; anything else falls back to the default. Same guard
* discipline as clampTagRows — the clamp, not a schema range, is the boundary.
*/
function clampColumnMinWidth(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 200;
	return Math.min(COLUMN_MIN_WIDTH_RANGE.max, Math.max(COLUMN_MIN_WIDTH_RANGE.min, Math.round(value)));
}
/** Clamp an unknown input to a legal maximum column width (see the min twin). */
function clampColumnMaxWidth(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 922;
	return Math.min(COLUMN_MAX_WIDTH_RANGE.max, Math.max(COLUMN_MAX_WIDTH_RANGE.min, Math.round(value)));
}
/**
* Clamp an unknown input to a legal `staleAfterDays`: finite numbers round and
* clamp into {@link STALE_AFTER_DAYS_RANGE}; anything else falls back to the
* default (30). Same guard discipline as the other numeric options — the
* clamp, not the schema, is the boundary.
*/
function clampStaleAfterDays(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return IDEAS_SETTINGS_DEFAULTS.staleAfterDays;
	return Math.min(STALE_AFTER_DAYS_RANGE.max, Math.max(STALE_AFTER_DAYS_RANGE.min, Math.round(value)));
}
/**
* Sanitize the per-workspace default launch models into a bounded map of
* `workspaceId -> provider/model`.
*
* Read policy, same as every other field: a non-object is no map at all, and
* inside a map a key that trims to empty, a value that is not a string and a
* target that trims to empty are DROPPED rather than refused — one malformed
* entry must not cost the human every other workspace's default. Both halves
* are bounded (a workspace id like {@link WORKSPACE_SCOPE_MAX_LENGTH}, a
* target like {@link IDEAS_LAUNCH_MODEL_MAX_LENGTH}) and the map itself is
* capped, so neither a hand-edited document nor a hand-crafted wire can grow
* the settings section without limit.
*
* An empty result is the honest representation of "no workspace has a
* default", which is what makes an untouched deployment behave exactly as it
* did before the field existed.
*/
function sanitizeLaunchModelByWorkspace(raw) {
	const out = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	const entries = Object.entries(raw);
	for (let index = 0; index < entries.length && Object.keys(out).length < 64; index++) {
		const [key, value] = entries[index];
		if (typeof value !== "string") continue;
		const workspaceId = key.trim().slice(0, 256);
		const target = value.trim().slice(0, 256);
		if (workspaceId === "" || target === "") continue;
		out[workspaceId] = target;
	}
	return out;
}
/** Unknown -> one of `allowed`, else the fallback (enum fields). */
function oneOf(value, allowed, fallback) {
	return typeof value === "string" && allowed.includes(value) ? value : fallback;
}
/** Unknown -> a real boolean, else the fallback. */
function booleanOr(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
/**
* Sanitize a raw section into a COMPLETE legal value: both read paths (host
* viewOf, client loadConfig) run every field through its guard, so a
* hand-edited document or a corrupt wire can never widen what the UI renders.
* Policy on READS: numbers clamp, enums/booleans fall back to the default,
* strings bound. (Writes are stricter: a non-boolean rejects — see
* parseSettingsBody.)
*/
function sanitizeSettings(raw) {
	const row = record(raw) ?? {};
	return {
		tagRows: clampTagRows(row.tagRows),
		defaultTab: oneOf(row.defaultTab, IDEAS_TABS, IDEAS_SETTINGS_DEFAULTS.defaultTab),
		renderMarkdown: booleanOr(row.renderMarkdown, IDEAS_SETTINGS_DEFAULTS.renderMarkdown),
		rememberWorkspaceScope: booleanOr(row.rememberWorkspaceScope, IDEAS_SETTINGS_DEFAULTS.rememberWorkspaceScope),
		workspaceScope: typeof row.workspaceScope === "string" ? row.workspaceScope.slice(0, 256) : IDEAS_SETTINGS_DEFAULTS.workspaceScope,
		confirmLifecycle: booleanOr(row.confirmLifecycle, IDEAS_SETTINGS_DEFAULTS.confirmLifecycle),
		hideDeclinedColumn: booleanOr(row.hideDeclinedColumn, IDEAS_SETTINGS_DEFAULTS.hideDeclinedColumn),
		cardDensity: oneOf(row.cardDensity, IDEAS_DENSITIES, IDEAS_SETTINGS_DEFAULTS.cardDensity),
		language: oneOf(row.language, IDEAS_LANGUAGES, IDEAS_SETTINGS_DEFAULTS.language),
		openOrdering: oneOf(row.openOrdering, IDEAS_OPEN_ORDERINGS, IDEAS_SETTINGS_DEFAULTS.openOrdering),
		runningFirst: booleanOr(row.runningFirst, IDEAS_SETTINGS_DEFAULTS.runningFirst),
		columnMinWidth: clampColumnMinWidth(row.columnMinWidth),
		columnMaxWidth: clampColumnMaxWidth(row.columnMaxWidth),
		directRunPermission: oneOf(row.directRunPermission, IDEAS_RUN_PERMISSIONS, IDEAS_SETTINGS_DEFAULTS.directRunPermission),
		staleAfterDays: clampStaleAfterDays(row.staleAfterDays),
		launchModelByWorkspace: sanitizeLaunchModelByWorkspace(row.launchModelByWorkspace)
	};
}
/** Every patchable field (exactKeys allow-list of the write body). */
const SETTINGS_PATCH_KEYS = [
	"tagRows",
	"defaultTab",
	"renderMarkdown",
	"rememberWorkspaceScope",
	"workspaceScope",
	"confirmLifecycle",
	"hideDeclinedColumn",
	"cardDensity",
	"language",
	"openOrdering",
	"runningFirst",
	"columnMinWidth",
	"columnMaxWidth",
	"directRunPermission",
	"staleAfterDays",
	"launchModelByWorkspace"
];
/**
* Strict parser for the config write body ({ patch, expectedRevision? }).
* Unknown keys reject; booleans must be REAL booleans (no meaningful clamp —
* a non-boolean is a corrupt wire); tagRows clamps and the enums sanitize to
* their default (the lenient read policy); workspaceScope is a bounded
* string. An absent field yields an empty patch (a no-op merge that still
* carries the revision fence).
*/
function parseSettingsBody(value) {
	const body = record(value);
	if (body === void 0 || !exactKeys(body, ["patch", "expectedRevision"])) return void 0;
	if (!optionalFiniteNumber(body.expectedRevision)) return void 0;
	const raw = record(body.patch);
	if (raw === void 0 || !exactKeys(raw, SETTINGS_PATCH_KEYS)) return void 0;
	const patch = {};
	for (const key of SETTINGS_PATCH_KEYS) {
		const field = raw[key];
		if (field === void 0) continue;
		if (key === "renderMarkdown" || key === "rememberWorkspaceScope" || key === "confirmLifecycle" || key === "hideDeclinedColumn") {
			if (typeof field !== "boolean") return void 0;
			patch[key] = field;
		} else if (key === "workspaceScope") {
			if (typeof field !== "string") return void 0;
			patch.workspaceScope = field.slice(0, 256);
		} else if (key === "tagRows") {
			if (typeof field !== "number" || !Number.isFinite(field)) return void 0;
			patch.tagRows = clampTagRows(field);
		} else if (key === "defaultTab") patch.defaultTab = oneOf(field, IDEAS_TABS, IDEAS_SETTINGS_DEFAULTS.defaultTab);
		else if (key === "language") patch.language = oneOf(field, IDEAS_LANGUAGES, IDEAS_SETTINGS_DEFAULTS.language);
		else if (key === "openOrdering") patch.openOrdering = oneOf(field, IDEAS_OPEN_ORDERINGS, IDEAS_SETTINGS_DEFAULTS.openOrdering);
		else if (key === "runningFirst") patch.runningFirst = booleanOr(field, IDEAS_SETTINGS_DEFAULTS.runningFirst);
		else if (key === "columnMinWidth") {
			if (typeof field !== "number" || !Number.isFinite(field)) return void 0;
			patch.columnMinWidth = clampColumnMinWidth(field);
		} else if (key === "columnMaxWidth") {
			if (typeof field !== "number" || !Number.isFinite(field)) return void 0;
			patch.columnMaxWidth = clampColumnMaxWidth(field);
		} else if (key === "directRunPermission") patch.directRunPermission = oneOf(field, IDEAS_RUN_PERMISSIONS, IDEAS_SETTINGS_DEFAULTS.directRunPermission);
		else if (key === "staleAfterDays") {
			if (typeof field !== "number" || !Number.isFinite(field)) return void 0;
			patch.staleAfterDays = clampStaleAfterDays(field);
		} else if (key === "launchModelByWorkspace") {
			if (typeof field !== "object" || field === null || Array.isArray(field)) return void 0;
			for (const entry of Object.values(field)) if (typeof entry !== "string") return void 0;
			patch.launchModelByWorkspace = sanitizeLaunchModelByWorkspace(field);
		} else patch.cardDensity = oneOf(field, IDEAS_DENSITIES, IDEAS_SETTINGS_DEFAULTS.cardDensity);
	}
	return {
		patch,
		expectedRevision: body.expectedRevision
	};
}
/**
* Strict parser for the launch body. Unknown keys reject (same discipline as
* every other ideas body), `ideaId` is required and non-blank, and the model is
* a plain string that trims to empty = "no model pinned" (never `null`: the
* task-board task field rejects null, and an empty selection is expressed by
* OMITTING the key).
*/
function parseLaunchBody(value) {
	const body = record(value);
	if (body === void 0 || !exactKeys(body, [
		"requestId",
		"initiator",
		"ideaId",
		"model"
	])) return void 0;
	if (typeof body.ideaId !== "string" || body.ideaId.trim() === "") return void 0;
	if (body.requestId !== void 0 && (typeof body.requestId !== "string" || body.requestId.trim() === "")) return void 0;
	if (body.initiator !== void 0 && typeof body.initiator !== "string") return void 0;
	if (body.model !== void 0 && typeof body.model !== "string") return void 0;
	const model = typeof body.model === "string" ? body.model.trim() : "";
	return {
		ideaId: body.ideaId.trim(),
		...typeof body.requestId === "string" ? { requestId: body.requestId.trim() } : {},
		...typeof body.initiator === "string" && body.initiator !== "" ? { initiator: body.initiator } : {},
		...model === "" ? {} : { model }
	};
}
const IDEAS_LEDGER_FILE_NAME = "ledger-v2.json";
const IDEAS_LOCK_FILE_NAME = "ledger-v2.lock";
const LOCK_OWNER_FILE = "owner.json";
const MAX_REQUEST_CACHE = 256;
function cloneIdeas(ideas) {
	return JSON.parse(JSON.stringify(ideas));
}
/** Cheap liveness probe: the zero signal throws when the process is gone. */
function processIsAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/** Normalize an optional id: trim; blank collapses to undefined. */
function normalizeOptionalId(value) {
	const trimmed = value?.trim();
	return trimmed === void 0 || trimmed === "" ? void 0 : trimmed;
}
/** Normalize a mirrored task status: trim, lowercase, cap 32 chars; blank collapses to undefined. */
function normalizeTaskBoardStatus(value) {
	const trimmed = value?.trim().toLowerCase();
	if (trimmed === void 0 || trimmed === "") return void 0;
	return trimmed.slice(0, 32);
}
/**
* Normalize a persisted run status: the closed union only — an
* unknown persisted value is DROPPED rather than stored, so a hand-edited
* ledger can never put the board in a state the run poll cannot reason about.
*/
function normalizeRunStatus(value) {
	return isIdeaRunStatus(value) ? value : void 0;
}
/**
* Structural repair of ONE persisted idea row: `ok: false` carries the reason
* it could not be repaired, which is what a strict reader (a restore) reports
* instead of silently dropping the row.
*
* The repair is the same one the boot path has always applied — a hand-edited
* document must not brick the board — and it is TOLERANT of unknown keys: a
* record written by a later version keeps its extra fields harmless.
*/
/**
* Every key `readIdeaRow` copies off an incoming record.
*
* This literal is the forward-compatibility contract. The record reader is a
* WHITELIST rebuild (it refuses to trust an arbitrary object), so a field a
* build does not know is dropped — correctly, but silently, and that silence is
* how a restore would quietly lose data written by a NEWER plugin. Two things
* make it non-silent:
*
*  - anything present on the row and absent from this list is REPORTED (see
*    `LedgerValidation.unknownFields`), so a partial restore always says what it
*    did not carry; and
*  - `tests/idea-95-backup.test.ts` asserts this list equals the key set of a
*    fully populated record, so adding a field without naming it here breaks the
*    suite instead of quietly surviving a release.
*
* Keep it in step with the reader, and treat a mismatch as a missing release
* step — the ledger's field surface is what a backup is made of.
*/
const KNOWN_IDEA_FIELDS = /* @__PURE__ */ new Set([
	"id",
	"title",
	"body",
	"status",
	"createdAt",
	"updatedAt",
	"summary",
	"rank",
	"value",
	"effort",
	"rationale",
	"decision",
	"ideaNumber",
	"deliveredAt",
	"archivedAt",
	"workspaceId",
	"taskBoardId",
	"taskBoardStatus",
	"runStatus",
	"runSessionId",
	"deliveryNote",
	"followUpOfId",
	"tags",
	"reanalyzeAt",
	"analysisAudit",
	"events",
	"relatesTo",
	"blocks"
]);
/** Keys the reader does not know about, sorted and de-duplicated. */
function unknownIdeaFields(row) {
	return Object.keys(row).filter((key) => !KNOWN_IDEA_FIELDS.has(key)).sort();
}
function readIdeaRow(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {
		ok: false,
		reason: "not a JSON object"
	};
	const row = value;
	if (typeof row.id !== "string" || row.id === "") return {
		ok: false,
		reason: "no id"
	};
	if (typeof row.title !== "string" || row.title.trim() === "") return {
		ok: false,
		reason: "no title"
	};
	const idea = {
		id: row.id,
		title: row.title.trim(),
		body: typeof row.body === "string" ? row.body.trim() : "",
		status: normalizeStatus(row.status),
		createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
		updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now()
	};
	const summary = normalizeSummary(typeof row.summary === "string" ? row.summary : void 0);
	if (summary !== void 0) idea.summary = summary;
	if (typeof row.rank === "number" && Number.isFinite(row.rank)) idea.rank = row.rank;
	if (typeof row.value === "number" && Number.isFinite(row.value)) idea.value = row.value;
	if (typeof row.effort === "number" && Number.isFinite(row.effort)) idea.effort = row.effort;
	if (typeof row.rationale === "string" && row.rationale.trim() !== "") idea.rationale = row.rationale.trim();
	if (typeof row.decision === "string" && row.decision.trim() !== "") idea.decision = row.decision.trim();
	if (typeof row.ideaNumber === "number" && Number.isFinite(row.ideaNumber)) idea.ideaNumber = row.ideaNumber;
	if (typeof row.deliveredAt === "number") idea.deliveredAt = row.deliveredAt;
	if (typeof row.archivedAt === "number") idea.archivedAt = row.archivedAt;
	const workspaceId = typeof row.workspaceId === "string" ? normalizeOptionalId(row.workspaceId) : void 0;
	if (workspaceId !== void 0) idea.workspaceId = workspaceId;
	const taskBoardId = typeof row.taskBoardId === "string" ? normalizeOptionalId(row.taskBoardId) : void 0;
	if (taskBoardId !== void 0) idea.taskBoardId = taskBoardId;
	const taskBoardStatus = normalizeTaskBoardStatus(typeof row.taskBoardStatus === "string" ? row.taskBoardStatus : void 0);
	if (taskBoardStatus !== void 0) idea.taskBoardStatus = taskBoardStatus;
	const runStatus = normalizeRunStatus(row.runStatus);
	if (runStatus !== void 0) idea.runStatus = runStatus;
	const runSessionId = typeof row.runSessionId === "string" ? normalizeOptionalId(row.runSessionId) : void 0;
	if (runSessionId !== void 0) idea.runSessionId = runSessionId;
	const deliveryNote = normalizeDeliveryNote(typeof row.deliveryNote === "string" ? row.deliveryNote : void 0);
	if (deliveryNote !== void 0) idea.deliveryNote = deliveryNote;
	if (typeof row.followUpOfId === "string" && row.followUpOfId.trim() !== "") idea.followUpOfId = row.followUpOfId.trim();
	const tags = normalizeTags(row.tags);
	if (tags !== void 0) idea.tags = tags;
	if (typeof row.reanalyzeAt === "number") idea.reanalyzeAt = row.reanalyzeAt;
	const audit = auditOf(row.analysisAudit);
	if (audit !== void 0) idea.analysisAudit = audit;
	const events = normalizeIdeaEvents(row.events);
	if (events !== void 0) idea.events = events;
	const relatesTo = normalizeRelationIds(row.relatesTo);
	if (relatesTo !== void 0) idea.relatesTo = relatesTo;
	const blocks = normalizeRelationIds(row.blocks);
	if (blocks !== void 0) idea.blocks = blocks;
	return {
		ok: true,
		idea,
		unknown: unknownIdeaFields(row)
	};
}
/** Lenient repair of a persisted idea list (mirrors the import repair): unusable rows are dropped. */
function parseHostIdeas(rows) {
	const ideas = [];
	for (const value of rows) {
		const read = readIdeaRow(value);
		if (read.ok) ideas.push(read.idea);
	}
	return ideas;
}
/**
* Re-impose the document-level relation invariants. This is the
* schema repair for relations, and it runs where `parseHostIdeas` runs: at boot,
* on a restore and after an import. Every write path already keeps the
* invariants, so in practice this only touches a hand-edited or imported
* document — which is exactly the case that must not be able to leave the board
* rendering a broken graph.
*
*  1. **Every edge points at a live row, and never at itself.** A `delete`
*     sweeps the edges that pointed at the removed row, so a dangling id is
*     only reachable through a hand edit.
*  2. **`relatesTo` is symmetric.** Each edge appears on both endpoints, so
*     neither row is "the truth" and the derived reverse read (`ideaRelatedTo`)
*     cannot disagree with the stored one.
*  3. **`blocks` stays acyclic.** An edge that would close a cycle is dropped in
*     document order, which makes the outcome deterministic. A WRITE refuses
*     instead (the human is told why); this path has no author to tell, and a
*     silently rendered cycle is the failure the refusal exists to prevent.
*/
function reconcileRelations(ideas) {
	const live = new Set(ideas.map((idea) => idea.id));
	let dropped = 0;
	const cleaned = ideas.map((idea) => {
		const next = { ...idea };
		for (const key of ["relatesTo", "blocks"]) {
			const current = idea[key];
			if (current === void 0) continue;
			const kept = normalizeRelationIds(current.filter((id) => id !== idea.id && live.has(id)));
			if (kept?.length === current.length) continue;
			dropped += current.length - (kept?.length ?? 0);
			if (kept === void 0) delete next[key];
			else next[key] = kept;
		}
		return next;
	});
	const byId = new Map(cleaned.map((idea) => [idea.id, idea]));
	const incoming = /* @__PURE__ */ new Map();
	for (const idea of cleaned) for (const id of idea.relatesTo ?? []) {
		if (id === idea.id || !byId.has(id)) continue;
		const set = incoming.get(id) ?? /* @__PURE__ */ new Set();
		set.add(idea.id);
		incoming.set(id, set);
	}
	const symmetric = incoming.size === 0 ? cleaned : cleaned.map((idea) => {
		const gain = incoming.get(idea.id);
		if (gain === void 0) return idea;
		const merged = normalizeRelationIds([...idea.relatesTo ?? [], ...gain])?.filter((id) => id !== idea.id);
		if (merged === void 0 || merged.length === (idea.relatesTo?.length ?? 0)) return idea;
		return {
			...idea,
			relatesTo: merged
		};
	});
	const graph = blocksGraphOf(symmetric);
	let pruned = false;
	const acyclic = symmetric.map((idea) => {
		if (idea.blocks === void 0) return idea;
		const kept = [];
		for (const target of idea.blocks) {
			if (blockCyclePath(graph, idea.id, target) !== void 0) {
				dropped += 1;
				pruned = true;
				continue;
			}
			kept.push(target);
			graph.set(idea.id, [...kept]);
		}
		graph.set(idea.id, kept);
		if (kept.length === idea.blocks.length) return idea;
		const next = { ...idea };
		if (kept.length === 0) delete next.blocks;
		else next.blocks = kept;
		return next;
	});
	return {
		ideas: pruned ? acyclic : symmetric,
		dropped
	};
}
/** Structural repair of a persisted prior-analysis snapshot (undefined when unusable). */
function auditOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const row = value;
	if (typeof row.at !== "number" || typeof row.title !== "string" || typeof row.body !== "string") return void 0;
	const tags = normalizeTags(row.tags);
	const summary = normalizeSummary(typeof row.summary === "string" ? row.summary : void 0);
	return {
		at: row.at,
		title: row.title,
		body: row.body,
		...summary === void 0 ? {} : { summary },
		...tags === void 0 ? {} : { tags },
		...typeof row.value === "number" ? { value: row.value } : {},
		...typeof row.effort === "number" ? { effort: row.effort } : {},
		...typeof row.rationale === "string" && row.rationale.trim() !== "" ? { rationale: row.rationale.trim() } : {}
	};
}
/** Error text of an unknown throwable (refusals carry their own sentence). */
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** JSON.parse without the throw (a snapshot that is not JSON is a refusal). */
function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** Human reference of one idea: `#12 title`, the label the board itself uses. */
function ideaReference(idea) {
	return idea.ideaNumber === void 0 ? `"${idea.title}"` : `#${idea.ideaNumber} "${idea.title}"`;
}
/**
* Validate a document a caller wants to ADOPT as the whole board.
*
* This is deliberately the opposite of the boot path. At boot an unreadable
* ledger is quarantined and the board starts empty, because a broken board must
* still open; a restore is a deliberate act with a good copy in hand, so the
* only acceptable failure is a refusal that names what is wrong. Every check
* below therefore refuses rather than repairs:
*
*  - the schema version must be the one this host reads (an unknown version
*    means the file was written by a different plugin generation, and guessing
*    would corrupt the board);
*  - the shape of every counter/list the document carries is checked, because
*    `normalizeDocument` silently drops what it does not understand — fine for a
*    boot, silently lossy for an import;
*  - **every** record must survive `readIdeaRow`. A document where 2 of 40 rows
*    are unusable is a half-broken document, and adopting it would look like a
*    successful restore of a smaller board;
*  - two records sharing an id would collapse into one, so that is refused too.
*/
function validateLedgerDocument(parsed) {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {
		ok: false,
		reason: "snapshot-shape",
		message: "the file is not a ledger document (expected a JSON object)"
	};
	const row = parsed;
	if (typeof row.schemaVersion !== "number" || !Number.isSafeInteger(row.schemaVersion)) return {
		ok: false,
		reason: "snapshot-schema",
		message: "the file carries no ledger schema version, so it is not an ideas ledger document"
	};
	if (row.schemaVersion > 1) return {
		ok: false,
		reason: "snapshot-schema-newer",
		message: `the file was written by a newer version of the plugin (ledger schema ${row.schemaVersion}, this build reads 1); update the plugin, or restore it with the version that wrote it, so no field it does not know is dropped`
	};
	if (!Array.isArray(row.ideas)) return {
		ok: false,
		reason: "snapshot-shape",
		message: "the ledger document carries no idea list"
	};
	for (const key of ["revision", "ideaSequence"]) {
		const value = row[key];
		if (value === void 0) continue;
		if (!Number.isSafeInteger(value) || value < 0) return {
			ok: false,
			reason: "snapshot-shape",
			message: `the ledger document has an unreadable "${key}" counter`
		};
	}
	if (row.importedSources !== void 0 && (!Array.isArray(row.importedSources) || row.importedSources.some((entry) => typeof entry !== "string"))) return {
		ok: false,
		reason: "snapshot-shape",
		message: "the ledger document has an unreadable import history"
	};
	if (row.recentRequests !== void 0 && !Array.isArray(row.recentRequests)) return {
		ok: false,
		reason: "snapshot-shape",
		message: "the ledger document has an unreadable request history"
	};
	const seen = /* @__PURE__ */ new Set();
	const unknown = /* @__PURE__ */ new Set();
	for (const [index, value] of row.ideas.entries()) {
		const read = readIdeaRow(value);
		if (!read.ok) return {
			ok: false,
			reason: "snapshot-records",
			message: `record ${index + 1} of ${row.ideas.length} is unusable (${read.reason}), so the whole file was refused`
		};
		if (seen.has(read.idea.id)) return {
			ok: false,
			reason: "snapshot-records",
			message: `two records share the id ${read.idea.id}, so the whole file was refused`
		};
		for (const key of read.unknown) unknown.add(key);
		seen.add(read.idea.id);
	}
	return {
		ok: true,
		document: normalizeParsedDocument(row),
		unknownFields: [...unknown].sort()
	};
}
/**
* Repair a parsed document into the live shape. Lenient BY DESIGN: this is the
* boot path, where a field a document does not carry must not stop the board
* from opening. The restore path validates the same fields strictly first
* (see {@link validateLedgerDocument}) so nothing is silently dropped there.
*/
function normalizeParsedDocument(parsed) {
	return {
		schemaVersion: 1,
		revision: Number.isSafeInteger(parsed.revision) && (parsed.revision ?? -1) >= 0 ? parsed.revision : 0,
		ideas: reconcileRelations(parseHostIdeas(Array.isArray(parsed.ideas) ? parsed.ideas : [])).ideas,
		ideaSequence: Number.isSafeInteger(parsed.ideaSequence) && (parsed.ideaSequence ?? -1) >= 0 ? parsed.ideaSequence : 0,
		importedSources: Array.isArray(parsed.importedSources) ? parsed.importedSources.filter((entry) => typeof entry === "string" && entry !== "") : [],
		recentRequests: Array.isArray(parsed.recentRequests) ? parsed.recentRequests.flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) return [];
			const request = entry;
			return typeof request.requestId === "string" && request.requestId !== "" && typeof request.fingerprint === "string" ? [{
				requestId: request.requestId,
				fingerprint: request.fingerprint
			}] : [];
		}).slice(-256) : []
	};
}
var IdeasHostLedger = class {
	document;
	requestCache = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	now;
	dir;
	file;
	lockDir;
	lockOwnerFile;
	lockToken = randomUUID();
	/**
	* The snapshot folder, INSIDE the ledger folder so it can only ever be
	* reached through the ledger that owns the lock. It deliberately holds no
	* lock of its own: two writers would be worse than none, and the parent
	* ledger already refuses to boot a second Host on the same home.
	*/
	backups;
	disposed = false;
	constructor(options = {}) {
		this.now = options.now ?? Date.now;
		this.dir = options.dir ?? join(dshHome(), "ideas");
		this.file = join(this.dir, IDEAS_LEDGER_FILE_NAME);
		this.lockDir = join(this.dir, IDEAS_LOCK_FILE_NAME);
		this.lockOwnerFile = join(this.lockDir, LOCK_OWNER_FILE);
		this.backups = options.backups ?? new IdeasBackupStore(join(this.dir, "backups"));
		this.acquireLock();
		try {
			this.document = this.load();
		} catch (error) {
			this.releaseLock();
			throw error;
		}
		for (const entry of this.document.recentRequests) this.requestCache.set(entry.requestId, entry.fingerprint);
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	snapshot() {
		return {
			schemaVersion: this.document.schemaVersion,
			revision: this.document.revision,
			ideas: cloneIdeas(this.document.ideas)
		};
	}
	summary() {
		return { revision: this.document.revision };
	}
	/**
	* Read-only view of the current document for a PURE aggregate,
	* without the deep clone every other reader pays.
	*
	* The one exception to "every reader gets its own copy", and it exists
	* because the health aggregate reads nothing but counters: cloning a
	* megabyte-wide document to produce forty numbers is precisely the waste the
	* bounded view was written to avoid. Two rules keep it safe:
	*  - the document reference is captured ONCE, so the revision and the rows
	*    always come from the same revision (a commit replaces the document
	*    wholesale rather than mutating it, so the array cannot tear);
	*  - the rows are typed `readonly`, so the only consumer this seam has —
	*    `buildIdeasStats` — cannot write through it even by accident.
	*
	* A route that needs to MUTATE an idea must keep using `applyRequest`, which
	* is the only writer in the process.
	*/
	statsSource() {
		const document = this.document;
		return {
			revision: document.revision,
			ideas: document.ideas
		};
	}
	/**
	* One idea, deep-cloned like a snapshot row: the deferred-body
	* read GET /api/ideas/idea?id= clones a SINGLE record instead of paying
	* the whole-ledger snapshot clone for one card.
	*/
	idea(id) {
		const found = this.document.ideas.find((idea) => idea.id === id);
		if (found === void 0) return void 0;
		return cloneIdeas([found])[0];
	}
	/** Absolute path of the snapshot folder (diagnostics; never a UI string). */
	backupDir() {
		return this.backups.dir;
	}
	/** Snapshot folder listing, newest first. Never parses a file. */
	snapshots() {
		return this.backups.list();
	}
	/** One snapshot of the folder by name (undefined when it is not there). */
	snapshotFile(name) {
		return this.backups.list().find((file) => file.name === name);
	}
	/** Raw snapshot document for the download route; never throws. */
	readSnapshot(name) {
		return this.backups.read(name);
	}
	/** Ideas whose execution is in flight (a restore refuses while any is). */
	runningIdeas() {
		return cloneIdeas(this.document.ideas.filter((idea) => idea.runStatus === "running"));
	}
	/**
	* Take a snapshot of the CURRENT document.
	*
	* Written through this instance on purpose: the single-writer lock is what
	* makes a snapshot trustworthy, and there is no supported way to produce one
	* beside a live ledger. The document is serialized from memory (never copied
	* off disk), so a snapshot can never catch the file mid-rename, and the
	* retention policy runs right after the write so the folder stays bounded.
	*/
	takeSnapshot(reason = "manual") {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const at = this.now();
		return {
			snapshot: this.backups.write(this.serializeDocument(reason, at), reason, at),
			ideas: this.document.ideas.length,
			pruned: this.backups.prune()
		};
	}
	/**
	* Restore the board from a snapshot (local file) or from a document handed
	* over in full (the portable import).
	*
	* The order of the checks IS the contract, and each step is there for a
	* reason a real restore got wrong in this project before it had a supported
	* escape hatch:
	*
	*  1. **A run in flight refuses the whole restore.** The Host polls that run
	*     and writes its settle onto an idea that may no longer exist; worse, the
	*     displaced board could be one the run then resurrects. The refusal names
	*     the ideas involved so the human knows what to wait for.
	*  2. **Validate strictly, then displace, then adopt.** The boot path is
	*     lenient (an unreadable live ledger is quarantined and the board starts
	*     empty) because a broken board must still open; a restore is the
	*     opposite case — half a document adopted as a whole board is worse than
	*     a refusal, so every record must survive the repair.
	*  3. **The displaced document is written BEFORE anything is replaced.** If
	*     that write fails, nothing is restored: "the board you have now" always
	*     exists somewhere, and the panel can always go back to it.
	*  4. **The revision only ever moves forward** (commit() bumps it) so the
	*     browser's 2.5 s poll cannot mistake the restored board for the one it
	*     already holds, and **the dedupe cache is NOT rewound**: replaying a
	*     request id must keep meaning "this already ran", even though the board
	*     it ran on is gone.
	*/
	restore(source) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const running = this.document.ideas.filter((idea) => idea.runStatus === "running");
		if (running.length > 0) return {
			ok: false,
			reason: "restore-run-in-flight",
			message: `an execution is still running on ${running.map((idea) => ideaReference(idea)).join(", ")}; wait for it to finish before restoring a snapshot`,
			running: cloneIdeas(running)
		};
		let text;
		let label;
		let file;
		if ("document" in source) {
			text = source.document;
			label = "the imported ledger";
		} else {
			label = source.name;
			const read = this.backups.read(source.name);
			if (!read.ok) return {
				ok: false,
				reason: `snapshot-${read.reason}`,
				message: read.reason === "not-found" ? `there is no snapshot named ${source.name} in the backups folder` : `the snapshot ${source.name} could not be read (${read.reason.replace("-", " ")})`
			};
			text = read.text;
			file = this.backups.list().find((candidate) => candidate.name === source.name);
		}
		const parsed = parseJson(text);
		const validated = parsed === void 0 ? {
			ok: false,
			reason: "snapshot-unreadable",
			message: "the file is not readable JSON, so it was not restored"
		} : validateLedgerDocument(parsed);
		if (!validated.ok) {
			const quarantined = file === void 0 ? void 0 : this.backups.quarantine(file);
			return {
				ok: false,
				reason: validated.reason,
				message: quarantined === void 0 ? validated.message : `${validated.message}; the unusable file was moved aside, renamed beside itself for evidence`,
				...quarantined === void 0 ? {} : { quarantined }
			};
		}
		const at = this.now();
		let displaced;
		try {
			displaced = this.backups.write(this.serializeDocument("pre-restore", at), "pre-restore", at);
		} catch (error) {
			return {
				ok: false,
				reason: "restore-not-saved",
				message: `the current board could not be kept as a snapshot (${messageOf$1(error)}), so nothing was restored`
			};
		}
		this.document = {
			...validated.document,
			revision: this.document.revision
		};
		this.commit();
		if (validated.unknownFields.length > 0) console.warn(`[dsh-plugin-ideas-manager] restore kept ${this.document.ideas.length} idea(s) from ${label} but dropped field(s) this build does not know: ${validated.unknownFields.join(", ")}`);
		return {
			ok: true,
			revision: this.document.revision,
			ideas: this.document.ideas.length,
			source: label,
			displaced,
			unknownFields: validated.unknownFields
		};
	}
	/**
	* Serialize the document exactly as it is persisted, plus the snapshot stamp
	* that says what the file is. The stamp is additive and ignored by the
	* validator, so a snapshot stays a faithful copy of the live document — the
	* same bytes an export moves between machines.
	*/
	serializeDocument(reason, at) {
		const stamp = {
			version: 1,
			createdAt: at,
			reason,
			ideas: this.document.ideas.length,
			revision: this.document.revision
		};
		return `${JSON.stringify({
			...this.document,
			snapshot: stamp
		}, null, 2)}\n`;
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		this.releaseLock();
	}
	/**
	* Apply one action with request-id dedupe: the same requestId replayed with
	* the same action returns the current state without mutating. The cache is
	* persisted with every commit, so a Host restart cannot replay a mutation.
	*
	* `audit` is the activity-log provenance of this mutation: the
	* asserted envelope initiator becomes `agent:<initiator>`, its absence means
	* `human`, and the explicit `run` override marks a transition the Host itself
	* writes (the launch settle opening the review gate). It is NOT part of the
	* dedupe fingerprint on purpose: replaying a request id re-records nothing.
	*/
	applyRequest(requestId, action, audit) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const fingerprint = createHash("sha256").update(JSON.stringify(action)).digest("hex");
		const cached = this.requestCache.get(requestId);
		if (cached !== void 0) {
			if (cached !== fingerprint) throw new Error("request id was reused with a different action");
			return {
				state: this.snapshot(),
				replayed: true
			};
		}
		this.requestCache.set(requestId, fingerprint);
		while (this.requestCache.size > MAX_REQUEST_CACHE) this.requestCache.delete(this.requestCache.keys().next().value);
		try {
			const result = this.apply(action, ideaEventActor(audit?.initiator, audit?.actor));
			result.state = this.snapshot();
			return result;
		} catch (error) {
			this.requestCache.delete(requestId);
			throw error;
		}
	}
	/**
	* Host-internal activity entry: the transitions that never pass
	* through an action verb — a launch accepted, a run settled, a harvested
	* delivery note — are exactly the ones a reader most wants in the timeline.
	* Same system-field discipline as `bindTaskBoardId` and the same
	* no-op-on-unchanged rule, so an idle poll cannot churn the revision.
	*
	* @returns true when the document changed and was committed.
	*/
	recordEvent(ideaId, verb, summary) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const entry = ideaEvent(this.now(), verb, "run", summary);
		if (entry.summary === "") return false;
		if (this.document.ideas.find((idea) => idea.id === ideaId) === void 0) return false;
		this.document.ideas = this.document.ideas.map((idea) => idea.id === ideaId ? {
			...idea,
			events: appendIdeaEvent(idea.events, entry)
		} : idea);
		this.commit();
		return true;
	}
	/**
	* Host-internal association written only by the TaskBoard mirror: records
	* the mirrored card id on an idea. `taskBoardId` is a system field — the
	* protocol gate never accepts it from the wire — so this path bypasses
	* `applyRequest` while keeping the same commit + notify discipline (it
	* bumps the revision and re-parses the document like any mutation).
	* @returns true when the document changed and was committed.
	*/
	bindTaskBoardId(ideaId, taskBoardId) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const trimmed = taskBoardId.trim();
		if (trimmed === "") return false;
		if (!this.document.ideas.some((idea) => idea.id === ideaId)) return false;
		const before = this.document.ideas;
		this.document.ideas = this.document.ideas.map((idea) => idea.id === ideaId ? {
			...idea,
			taskBoardId: trimmed
		} : idea);
		if (this.document.ideas === before) return false;
		this.commit();
		return true;
	}
	/**
	* Host-internal mirrored-task STATUS (follow-up work): records the last
	* status observed by the under-review poll so a card whose TaskBoard task
	* failed can show a badge while the idea stays in the backlog. Same
	* system-field discipline as `bindTaskBoardId` (never accepted from the
	* idea verbs), same commit + notify, and a no-op when the observation did
	* not change (the 30 s poll must not churn the revision while idle).
	* @returns true when the document changed and was committed.
	*/
	setTaskBoardStatus(ideaId, status) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const next = normalizeTaskBoardStatus(status);
		const current = this.document.ideas.find((idea) => idea.id === ideaId);
		if (current === void 0) return false;
		if (current.taskBoardStatus === next) return false;
		this.document.ideas = this.document.ideas.map((idea) => idea.id === ideaId ? {
			...idea,
			taskBoardStatus: next
		} : idea);
		this.commit();
		return true;
	}
	/**
	* Host-internal LAUNCH-LIFECYCLE stamp: `running` is written by
	* the launch route the moment the execution is accepted, the settled state by
	* the run poll. Same system-field discipline as `bindTaskBoardId` (the
	* protocol gate never accepts `runStatus` from the wire) and the same
	* no-op-on-unchanged rule, so an idle poll cannot churn the revision.
	*
	* `undefined` CLEARS the stamp (a card observed outside a run, e.g. back in
	* `backlog`): the JSON persist/clone drops the key entirely, exactly like a
	* cleared `taskBoardStatus`.
	*
	* @returns true when the document changed and was committed.
	*/
	setRunStatus(ideaId, status) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const current = this.document.ideas.find((idea) => idea.id === ideaId);
		if (current === void 0) return false;
		if (current.runStatus === status) return false;
		this.document.ideas = this.document.ideas.map((idea) => idea.id === ideaId ? {
			...idea,
			runStatus: status
		} : idea);
		this.commit();
		return true;
	}
	/**
	* Host-internal SESSION id of the latest run: written with the
	* `running` stamp by a direct-session launch, stamped from the mirrored card's
	* own executions by the run poll, and deliberately KEPT when the run settles
	* so the card keeps a way back into the chat it was worked on. Same
	* system-field discipline as `bindTaskBoardId`.
	*
	* Its other job is RESTART SAFETY: the in-memory run tracker is empty after a
	* Host restart, so the poll re-attaches to a run still in flight from the
	* `running` + `runSessionId` pair. Without it a restart mid-run would freeze
	* the idea on `running` forever. That re-attachment also requires the
	* `running` status, so a retained id is inert there.
	*
	* @returns true when the document changed and was committed.
	*/
	setRunSession(ideaId, sessionId) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const current = this.document.ideas.find((idea) => idea.id === ideaId);
		if (current === void 0) return false;
		const next = sessionId === void 0 || sessionId === "" ? void 0 : sessionId;
		if (current.runSessionId === next) return false;
		this.document.ideas = this.document.ideas.map((idea) => idea.id === ideaId ? {
			...idea,
			runSessionId: next
		} : idea);
		this.commit();
		return true;
	}
	/**
	* Host-internal DELIVERY NOTE of the latest finished run: the
	* text harvested off the run at settle time, bounded to
	* {@link DELIVERY_NOTE_MAX_BYTES}. Same system-field discipline as
	* `bindTaskBoardId` (the wire gate never accepts `deliveryNote` from
	* `update`) and the same no-op-on-unchanged rule, so a re-harvest of the
	* same answer cannot churn the revision.
	*
	* `undefined` CLEARS the stamp, exactly like the run fields: the JSON
	* persist/clone drops the key entirely.
	*
	* @returns true when the document changed and was committed.
	*/
	setDeliveryNote(ideaId, note) {
		if (this.disposed) throw new Error("ideas ledger is disposed");
		const current = this.document.ideas.find((idea) => idea.id === ideaId);
		if (current === void 0) return false;
		const next = normalizeDeliveryNote(note);
		if (current.deliveryNote === next) return false;
		this.document.ideas = this.document.ideas.map((idea) => idea.id === ideaId ? {
			...idea,
			deliveryNote: next
		} : idea);
		this.commit();
		return true;
	}
	apply(action, actor) {
		const now = this.now();
		const beforeIdeas = this.document.ideas;
		const recorded = [];
		switch (action.kind) {
			case "create": {
				if (this.document.ideas.some((idea) => idea.id === action.id)) throw new Error("idea id already exists");
				let idea = createIdea(action.input, now, action.id);
				if (idea.title.trim() === "") throw new Error("title is required");
				this.document.ideaSequence += 1;
				idea = {
					...idea,
					ideaNumber: this.document.ideaSequence
				};
				this.document.ideas = [...this.document.ideas, idea];
				recorded.push({
					ideaId: idea.id,
					verb: "create",
					summary: `Captured as #${this.document.ideaSequence}${idea.workspaceId === void 0 ? "" : ` in ${idea.workspaceId}`}${idea.rank === void 0 ? "" : ` at rank ${idea.rank}`}`
				});
				break;
			}
			case "update":
				if (this.document.ideas.find((item) => item.id === action.ideaId) === void 0) throw new Error("idea not found");
				if (action.patch.title !== void 0 && action.patch.title !== null) {
					if (action.patch.title.trim() === "") throw new Error("title is required");
				}
				this.document.ideas = applyPatch(this.document.ideas, action.ideaId, action.patch, this.now());
				recorded.push({
					ideaId: action.ideaId,
					verb: "update",
					summary: describePatch(action.patch)
				});
				break;
			case "move": {
				const idea = this.document.ideas.find((item) => item.id === action.ideaId);
				if (idea === void 0) throw new Error("idea not found");
				if (action.status === idea.status) break;
				const archivedAt = action.status === "archived" ? now : void 0;
				this.document.ideas = this.document.ideas.map((item) => item.id === action.ideaId ? {
					...withStatus(item, action.status, now),
					...archivedAt === void 0 ? {} : { archivedAt }
				} : item);
				recorded.push({
					ideaId: action.ideaId,
					verb: "move",
					summary: `Moved ${idea.status} → ${action.status}`
				});
				break;
			}
			case "decline": {
				const idea = this.document.ideas.find((item) => item.id === action.ideaId);
				if (idea === void 0) throw new Error("idea not found");
				if (idea.status !== "declined") {
					const decision = action.decision === void 0 ? void 0 : blankToUndefined(action.decision);
					this.document.ideas = this.document.ideas.map((item) => item.id === action.ideaId ? {
						...withStatus(item, "declined", now),
						archivedAt: now,
						...decision === void 0 ? {} : { decision }
					} : item);
					recorded.push({
						ideaId: action.ideaId,
						verb: "decline",
						summary: `Declined${decision === void 0 ? "" : ` — ${decision}`}`
					});
				}
				break;
			}
			case "deliver": {
				const idea = this.document.ideas.find((item) => item.id === action.ideaId);
				if (idea === void 0) throw new Error("idea not found");
				if (idea.status !== "open" && idea.status !== "underReview") break;
				this.document.ideas = this.document.ideas.map((item) => item.id === action.ideaId ? {
					...withStatus(item, "archived", now),
					archivedAt: now,
					deliveredAt: now
				} : item);
				recorded.push({
					ideaId: action.ideaId,
					verb: "deliver",
					summary: "Delivered — accepted, archived and stamped"
				});
				break;
			}
			case "triage": {
				const idea = this.document.ideas.find((item) => item.id === action.ideaId);
				if (idea === void 0) throw new Error("idea not found");
				let next = {
					...idea,
					updatedAt: now
				};
				if (action.patch.value !== void 0) next.value = action.patch.value;
				if (action.patch.effort !== void 0) next.effort = action.patch.effort;
				if (action.patch.rationale !== void 0) {
					const rationale = action.patch.rationale.trim();
					next.rationale = rationale === "" ? void 0 : rationale;
				}
				let ideas = this.document.ideas.map((item) => item.id === action.ideaId ? next : item);
				if (idea.status === "open" && action.patch.rank !== void 0) {
					const ordered = triageOrderedIds(ideas, action.ideaId, action.patch.rank);
					const rankById = new Map(ordered.map((id, index) => [id, index + 1]));
					ideas = ideas.map((item) => ({
						...item,
						rank: rankById.get(item.id) ?? item.rank
					}));
				}
				this.document.ideas = ideas;
				const finalRank = action.patch.rank === void 0 ? void 0 : ideas.find((item) => item.id === action.ideaId)?.rank;
				recorded.push({
					ideaId: action.ideaId,
					verb: "triage",
					summary: `Priority opinion recorded${formatLevel("value", next.value)}${formatLevel("effort", next.effort)}${finalRank === void 0 ? "" : ` · rank ${finalRank} in its workspace group`}`
				});
				break;
			}
			case "followUp": {
				const parent = this.document.ideas.find((item) => item.id === action.ideaId);
				if (parent === void 0) throw new Error("idea not found");
				if (parent.status !== "underReview") throw new Error("follow-up requires an under-review idea");
				if ((blankToUndefined(action.input.title) ?? "").trim() === "") throw new Error("title is required");
				const childId = randomUUID();
				this.document.ideaSequence += 1;
				const child = {
					...createIdea({
						title: action.input.title,
						body: action.input.body,
						...parent.workspaceId === void 0 ? {} : { workspaceId: parent.workspaceId }
					}, now, childId),
					ideaNumber: this.document.ideaSequence,
					followUpOfId: parent.id
				};
				this.document.ideas = [...this.document.ideas.map((item) => item.id === parent.id ? {
					...withStatus(item, "archived", now),
					archivedAt: now
				} : item), child];
				const parentNumber = parent.ideaNumber === void 0 ? "" : `#${parent.ideaNumber}`;
				recorded.push({
					ideaId: parent.id,
					verb: "review",
					summary: `Review asked for a follow-up — archived in favour of #${this.document.ideaSequence}`
				});
				recorded.push({
					ideaId: childId,
					verb: "create",
					summary: `Created as the follow-up of ${parentNumber === "" ? "its parent" : parentNumber}`
				});
				break;
			}
			case "merge": {
				const loser = this.document.ideas.find((item) => item.id === action.sourceId);
				if (loser === void 0) throw new Error("source idea not found");
				const survivor = this.document.ideas.find((item) => item.id === action.targetId);
				if (survivor === void 0) throw new Error("target idea not found");
				if (loser.id === survivor.id) throw new Error("merge requires two distinct ideas");
				if ((loser.workspaceId ?? "") !== (survivor.workspaceId ?? "")) throw new Error("merge requires both ideas in the same workspace");
				const tags = mergedIdeaTags(survivor, loser);
				const inheritedParent = survivor.followUpOfId !== void 0 || loser.followUpOfId === void 0 || loser.followUpOfId === survivor.id ? void 0 : loser.followUpOfId;
				const decision = `Merged as a duplicate of ${survivor.ideaNumber === void 0 ? survivor.title : `#${survivor.ideaNumber} ${survivor.title}`}`.slice(0, 320);
				this.document.ideas = this.document.ideas.map((item) => {
					if (item.id === survivor.id) return {
						...item,
						...tags === void 0 ? {} : { tags },
						...inheritedParent === void 0 ? {} : { followUpOfId: inheritedParent },
						updatedAt: now
					};
					if (item.id === loser.id) return {
						...item,
						status: "archived",
						archivedAt: now,
						decision,
						updatedAt: now
					};
					if (item.followUpOfId === loser.id) return {
						...item,
						followUpOfId: survivor.id,
						updatedAt: now
					};
					return item;
				});
				this.document.ideas = this.document.ideas.map((item) => withRepointedRelations(item, loser.id, survivor.id));
				const survivorAfter = this.document.ideas.find((item) => item.id === survivor.id);
				const loserAfter = this.document.ideas.find((item) => item.id === loser.id);
				if (survivorAfter !== void 0 && loserAfter !== void 0) {
					const inherited = mergedIdeaRelations(survivorAfter, loserAfter);
					this.document.ideas = this.document.ideas.map((item) => item.id === survivor.id ? {
						...item,
						...inherited,
						updatedAt: now
					} : item);
				}
				const reconciled = reconcileRelations(this.document.ideas);
				this.document.ideas = reconciled.ideas;
				if (reconciled.dropped > 0) {
					const suffix = ` — ${reconciled.dropped} relation edge${reconciled.dropped === 1 ? "" : "s"} could not follow the merge`;
					this.document.ideas = this.document.ideas.map((item) => item.id === loser.id ? {
						...item,
						decision: `${decision}${suffix}`.slice(0, 320)
					} : item);
				}
				if (action.mode === "takeSourceRank" && survivor.status === "open" && loser.rank !== void 0) {
					const ordered = triageOrderedIds(this.document.ideas, survivor.id, loser.rank);
					const rankById = new Map(ordered.map((id, index) => [id, index + 1]));
					this.document.ideas = this.document.ideas.map((item) => ({
						...item,
						rank: rankById.get(item.id) ?? item.rank
					}));
				}
				const survivorRef = survivor.ideaNumber === void 0 ? "the surviving idea" : `#${survivor.ideaNumber}`;
				const loserRef = loser.ideaNumber === void 0 ? "another idea" : `#${loser.ideaNumber}`;
				recorded.push({
					ideaId: loser.id,
					verb: "merge",
					summary: `Merged into ${survivorRef} — archived as a duplicate`
				});
				recorded.push({
					ideaId: survivor.id,
					verb: "merge",
					summary: `Took in ${loserRef} as a duplicate${action.mode === "takeSourceRank" ? ", re-ranked at its position" : ""}`
				});
				break;
			}
			case "restore": {
				const idea = this.document.ideas.find((item) => item.id === action.ideaId);
				if (idea === void 0) throw new Error("idea not found");
				if (idea.status === "open") break;
				this.document.ideas = this.document.ideas.map((item) => item.id === action.ideaId ? {
					...withStatus(item, "open", now),
					archivedAt: void 0
				} : item);
				recorded.push({
					ideaId: action.ideaId,
					verb: "restore",
					summary: `Restored from ${idea.status} to the open backlog`
				});
				break;
			}
			case "delete":
				if (this.document.ideas.find((item) => item.id === action.ideaId) === void 0) throw new Error("idea not found");
				this.document.ideas = this.document.ideas.filter((item) => item.id !== action.ideaId).map((item) => withoutRelationTarget(item, action.ideaId));
				break;
			case "reanalyze": {
				const idea = this.document.ideas.find((item) => item.id === action.ideaId);
				if (idea === void 0) throw new Error("idea not found");
				const audit = {
					at: now,
					title: idea.title,
					body: idea.body,
					...idea.summary === void 0 ? {} : { summary: idea.summary },
					...idea.tags === void 0 ? {} : { tags: idea.tags },
					...idea.value === void 0 ? {} : { value: idea.value },
					...idea.effort === void 0 ? {} : { effort: idea.effort },
					...idea.rationale === void 0 ? {} : { rationale: idea.rationale }
				};
				this.document.ideas = this.document.ideas.map((item) => item.id === action.ideaId ? {
					...item,
					reanalyzeAt: now,
					analysisAudit: audit,
					updatedAt: now
				} : item);
				recorded.push({
					ideaId: action.ideaId,
					verb: "reanalyze",
					summary: "AI re-analysis started — the previous analysis is kept"
				});
				break;
			}
			case "reorder": {
				const present = new Set(this.document.ideas.map((idea) => idea.id));
				const ordered = action.orderedIds.filter((id) => present.has(id));
				const byId = new Map(this.document.ideas.map((idea) => [idea.id, idea]));
				const counters = /* @__PURE__ */ new Map();
				const rankById = /* @__PURE__ */ new Map();
				for (const id of ordered) {
					const item = byId.get(id);
					if (item === void 0) continue;
					const key = rankGroupKey(item.status, item.workspaceId);
					const next = (counters.get(key) ?? 0) + 1;
					counters.set(key, next);
					rankById.set(id, next);
				}
				this.document.ideas = this.document.ideas.map((idea) => ({
					...idea,
					rank: rankById.get(idea.id) ?? idea.rank
				}));
				break;
			}
			case "import": {
				if (this.document.importedSources.includes(action.sourceId)) return { state: this.snapshot() };
				const merged = new Map(this.document.ideas.map((idea) => [idea.id, idea]));
				let maxImportedNumber = 0;
				for (const idea of parseHostIdeas(action.ideas)) {
					if (typeof idea.ideaNumber === "number" && idea.ideaNumber > maxImportedNumber) maxImportedNumber = idea.ideaNumber;
					merged.set(idea.id, merged.has(idea.id) ? {
						...merged.get(idea.id),
						...idea,
						updatedAt: now
					} : idea);
				}
				this.document.ideas = [...merged.values()];
				this.document.ideas = reconcileRelations(this.document.ideas).ideas;
				if (maxImportedNumber > this.document.ideaSequence) this.document.ideaSequence = maxImportedNumber;
				this.document.importedSources = [...this.document.importedSources, action.sourceId];
				break;
			}
			case "export": return {
				state: this.snapshot(),
				export: buildIdeasExport(this.document.ideas, action.workspaceId)
			};
		}
		if (recorded.length > 0) {
			const stamped = this.now();
			const byId = new Map(recorded.map((entry) => [entry.ideaId, entry]));
			this.document.ideas = this.document.ideas.map((idea) => {
				const entry = byId.get(idea.id);
				if (entry === void 0) return idea;
				return {
					...idea,
					events: appendIdeaEvent(idea.events, ideaEvent(stamped, entry.verb, actor, entry.summary))
				};
			});
		}
		if (this.document.ideas !== beforeIdeas) this.commit();
		return { state: this.snapshot() };
	}
	acquireLock() {
		mkdirSync(this.dir, { recursive: true });
		const candidate = {
			token: this.lockToken,
			pid: process.pid,
			startedAt: this.now()
		};
		for (let attempt = 0; attempt < 4; attempt += 1) try {
			mkdirSync(this.lockDir);
			try {
				writeFileSync(this.lockOwnerFile, `${JSON.stringify(candidate)}\n`);
			} catch {}
			return;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const owner = this.readLockOwner();
			const pid = typeof owner?.pid === "number" ? owner.pid : void 0;
			if (pid !== void 0 && processIsAlive(pid)) throw new Error(`ideas ledger is already owned by process ${pid}; if this PID was reused after a crash and no other DSH host is running, remove ${this.lockDir} manually and retry`);
			try {
				unlinkSync(this.lockOwnerFile);
			} catch {}
			try {
				rmdirSync(this.lockDir);
			} catch {}
		}
		throw new Error(`ideas ledger lock could not be acquired: ${this.lockDir}`);
	}
	readLockOwner() {
		try {
			return JSON.parse(readFileSync(this.lockOwnerFile, "utf8"));
		} catch {
			return;
		}
	}
	releaseLock() {
		try {
			if (!existsSync(this.lockDir)) return;
			const owner = this.readLockOwner();
			if (owner === void 0 || owner.token === this.lockToken) {
				try {
					unlinkSync(this.lockOwnerFile);
				} catch {}
				try {
					rmdirSync(this.lockDir);
				} catch {}
			}
		} catch {}
	}
	load() {
		const existed = existsSync(this.file);
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			return this.recoverCorrupt(existed, error);
		}
		try {
			if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.ideas)) throw new Error("unsupported ledger schema");
			return this.normalizeDocument(parsed);
		} catch (error) {
			return this.recoverCorrupt(existed, error);
		}
	}
	normalizeDocument(parsed) {
		return normalizeParsedDocument(parsed);
	}
	/**
	* Start from an empty ledger after a failed load.
	*
	* Two very different situations share this path and MUST NOT read the same in
	* the log: a document that existed and could not be parsed (something is wrong
	* and the file is set aside), and no document at all (the normal first boot of
	* a fresh install, where `readFileSync` throws ENOENT). Reporting the second as
	* "corrupt ledger quarantined" trains the reader to ignore the first, so the
	* genuinely alarming case arrives on a log full of harmless ones.
	*/
	recoverCorrupt(existed, error) {
		if (existed) {
			const quarantineName = `${this.file}.corrupt-${this.now()}-${process.pid}-${randomUUID()}`;
			try {
				renameSync(this.file, quarantineName);
			} catch {}
		}
		const document = {
			schemaVersion: 1,
			revision: 0,
			ideas: [],
			importedSources: [],
			recentRequests: [],
			ideaSequence: 0
		};
		try {
			this.writeAtomic(document);
		} catch {}
		const reason = error instanceof Error ? error.message : String(error);
		if (existed) console.error(`[dsh-plugin-ideas-manager] unreadable ideas ledger quarantined, starting empty: ${reason}`);
		else console.info(`[dsh-plugin-ideas-manager] no ideas ledger yet, created an empty one at ${this.file}`);
		return document;
	}
	/**
	* Atomic tmp+rename write; the tmp path never survives a successful commit.
	*
	* Windows fallback: a transient EPERM on `renameSync` (an AV scanner or an
	* indexer holding the destination for a few ms) would otherwise fail the
	* user's whole action with a 400. When the rename fails we write the very
	* same bytes straight to the final file and drop the tmp - the same
	* mitigation the settings store already applies (host-settings.persist,
	* "Windows EPERM rename flake"). The window without atomicity is one write
	* on a file the single-writer lock already protects, and the reader
	* quarantines an unparsable document on the next boot if the process dies
	* mid-write - the discipline the whole file system relies on.
	*/
	writeAtomic(document) {
		const tmpFile = `${this.file}.tmp-${process.pid}`;
		const text = `${JSON.stringify(document, null, 2)}\n`;
		writeFileSync(tmpFile, text);
		try {
			renameSync(tmpFile, this.file);
		} catch {
			try {
				writeFileSync(this.file, text);
			} finally {
				try {
					unlinkSync(tmpFile);
				} catch {}
			}
		}
	}
	/** Persist a mutation and its request-cache snapshot in one atomic write. */
	commit() {
		this.document.revision += 1;
		this.document.recentRequests = [...this.requestCache].map(([requestId, fingerprint]) => ({
			requestId,
			fingerprint
		})).slice(-256);
		this.writeAtomic(this.document);
		this.document = JSON.parse(JSON.stringify(this.document));
		this.notify();
	}
	notify() {
		for (const listener of [...this.listeners]) listener();
	}
};
/**
* Apply one update patch to the document (a null `tags` clears the label set).
*
* The patch is row-scoped for every text/score field and DOCUMENT-scoped for
* the relation keys: `relatesTo` is symmetric and `blocks` is checked against
* the whole graph, so neither can be applied to a single row in isolation.
*/
function applyPatch(ideas, ideaId, patch, now) {
	return applyRelationPatch(ideas.map((item) => item.id === ideaId ? patchRow(item, patch, now) : item), ideaId, patch);
}
/** Apply one update patch to ONE idea (a null `tags` clears the label set). */
function patchRow(idea, patch, now) {
	const next = {
		...idea,
		updatedAt: now
	};
	if (patch.title !== void 0 && patch.title !== null) next.title = patch.title.trim();
	if (patch.body !== void 0 && patch.body !== null) next.body = patch.body.trim();
	if (patch.summary !== void 0) next.summary = patch.summary === null ? void 0 : normalizeSummary(patch.summary);
	if (patch.workspaceId !== void 0 && patch.workspaceId !== null) {
		const workspaceId = patch.workspaceId.trim();
		next.workspaceId = workspaceId === "" ? void 0 : workspaceId;
	} else if (patch.workspaceId === null) next.workspaceId = void 0;
	if (patch.rank !== void 0) next.rank = patch.rank;
	if (patch.value !== void 0) next.value = patch.value;
	if (patch.effort !== void 0) next.effort = patch.effort;
	if (patch.rationale !== void 0) {
		const rationale = patch.rationale.trim();
		next.rationale = rationale === "" ? void 0 : rationale;
	}
	if (patch.tags !== void 0) next.tags = patch.tags === null ? void 0 : normalizeTags(patch.tags);
	return next;
}
/**
* Resolve the target ids of one relation list and refuse what cannot be true:
* an unknown id (the edge would be dangling the moment it is written, which is
* what would make a later `delete` unable to sweep it) and the row itself.
*/
function resolveRelationTargets(ideas, ideaId, raw) {
	const known = new Set(ideas.map((idea) => idea.id));
	const targets = normalizeRelationIds(raw) ?? [];
	for (const target of targets) {
		if (target === ideaId) throw new Error("a relation cannot point at the idea itself");
		if (!known.has(target)) throw new Error(`relation target not found: ${target}`);
	}
	return targets;
}
/** Set or clear one relation list, leaving the other untouched. */
function withRelationList(idea, key, ids) {
	const next = { ...idea };
	if (ids === void 0 || ids.length === 0) delete next[key];
	else next[key] = [...ids];
	return next;
}
/** Whether two relation lists hold the same ids in the same order. */
function sameRelationList(a, b) {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((id, index) => id === right[index]);
}
/**
* Apply the relation half of an `update` patch across the document.
*
* `relatesTo` is symmetric, so one statement writes TWO rows — the edited idea
* and every idea it names — in the same commit. That is what keeps "A relates to
* B" a single fact instead of two that can disagree, and it is why the mirror
* rows stay silent in the activity log: the author's act happened once, on the
* idea they clicked. `blocks` is one-directional, so only the edited row moves.
*
* @throws when a target does not exist, is the row itself, or would close a
*   cycle. The cycle is refused WITH ITS CHAIN, because "invalid relation"
*   tells a human nothing while "#12 → #13 → #14" names the edges to undo.
*/
function applyRelationPatch(ideas, ideaId, patch) {
	if (patch.relatesTo === void 0 && patch.blocks === void 0) return [...ideas];
	let next = [...ideas];
	if (patch.relatesTo !== void 0) {
		const targets = resolveRelationTargets(next, ideaId, patch.relatesTo);
		next = next.map((item) => item.id === ideaId ? withRelationList(item, "relatesTo", targets) : item);
		next = next.map((item) => {
			if (item.id === ideaId) return item;
			const current = item.relatesTo ?? [];
			const kept = current.filter((id) => id !== ideaId);
			const relatesTo = normalizeRelationIds(targets.includes(item.id) ? [...kept, ideaId] : kept);
			return sameRelationList(current, relatesTo) ? item : withRelationList(item, "relatesTo", relatesTo);
		});
	}
	if (patch.blocks !== void 0) {
		const targets = resolveRelationTargets(next, ideaId, patch.blocks);
		const graph = blocksGraphOf(next.map((item) => item.id === ideaId ? withRelationList(item, "blocks", void 0) : item));
		const references = new Map(next.map((item) => [item.id, ideaReference(item)]));
		for (const target of targets) {
			const path = blockCyclePath(graph, ideaId, target);
			if (path === void 0) continue;
			throw new Error(`this would close a cycle: ${path.map((id) => references.get(id) ?? id).join(" → ")}`);
		}
		next = next.map((item) => item.id === ideaId ? withRelationList(item, "blocks", targets) : item);
	}
	return next;
}
/** Re-point every relation edge that named the merge loser at the survivor. */
function withRepointedRelations(idea, loserId, survivorId) {
	return withRelationList(withRelationList(idea, "relatesTo", repointedRelationIds(idea.relatesTo, idea.id, loserId, survivorId)), "blocks", repointedRelationIds(idea.blocks, idea.id, loserId, survivorId));
}
/** Drop one removed idea from every relation list (the `delete` sweep). */
function withoutRelationTarget(idea, targetId) {
	if (idea.relatesTo?.includes(targetId) !== true && idea.blocks?.includes(targetId) !== true) return idea;
	return withRelationList(withRelationList(idea, "relatesTo", normalizeRelationIds((idea.relatesTo ?? []).filter((id) => id !== targetId))), "blocks", normalizeRelationIds((idea.blocks ?? []).filter((id) => id !== targetId)));
}
/** Trim to undefined when blank (the wire keeps rationale/decision optional). */
function blankToUndefined(value) {
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* One-line summary of an `update` patch: the field names the caller actually
* changed. Deliberately names fields, never values — a summary is a breadcrumb
* back to the idea, and the timeline must never become a second copy of a body
* (or quietly store the very content an update meant to replace).
*/
function describePatch(patch) {
	const fields = [];
	if (patch.title !== void 0 && patch.title !== null) fields.push("title");
	if (patch.body !== void 0 && patch.body !== null) fields.push("description");
	if (patch.summary !== void 0 && patch.summary !== null) fields.push("summary");
	if (patch.tags !== void 0) fields.push(patch.tags === null ? "tags cleared" : "tags");
	if (patch.workspaceId !== void 0) fields.push("workspace");
	if (patch.value !== void 0) fields.push("value");
	if (patch.effort !== void 0) fields.push("effort");
	if (patch.rationale !== void 0) fields.push("rationale");
	if (patch.rank !== void 0) fields.push("rank");
	if (patch.relatesTo !== void 0) fields.push(patch.relatesTo === null || patch.relatesTo.length === 0 ? "relations cleared" : "related ideas");
	if (patch.blocks !== void 0) fields.push(patch.blocks === null || patch.blocks.length === 0 ? "blocking cleared" : "blocking");
	if (fields.length === 0) return "Edited (no field changed)";
	return `Edited ${fields.join(", ")}`;
}
/** Render one triage level, or nothing when the patch left it alone. */
function formatLevel(label, level) {
	return level === void 0 ? "" : ` · ${label} ${level}`;
}
/** Helper of `apply`: rank-sorted rows (unranked last). */
function rankOrdered(ideas) {
	return [...ideas].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
}
/**
* New rank order of the MOVED IDEA'S OWN WORKSPACE GROUP after inserting
* `movedId` at `rank` (1-based) inside the open ideas of that group.
*
* Only the group's ids are returned: the triage caller maps `rankById` over the
* whole document and keeps every other group's rank untouched (`?? item.rank`).
* Other workspace groups and the closed columns are never re-ranked by a triage.
*
* A missing `rank` appends, and the ONE caller that may still pass one is the
* `merge` verb (the survivor takes the loser's place, at the end when the loser
* had none). The triage verb no longer does: it re-ranks only when the patch
* carries a rank, so an opinion recorded without a position cannot move a card.
*
* @param rank - the requested 1-based position; undefined appends.
*/
function triageOrderedIds(ideas, movedId, rank) {
	const moved = ideas.find((idea) => idea.id === movedId);
	if (moved === void 0) return [];
	const groupKey = rankGroupKey("open", moved.workspaceId);
	const openOthers = rankOrdered(ideas.filter((idea) => idea.status === "open" && idea.id !== movedId && rankGroupKey("open", idea.workspaceId) === groupKey)).map((idea) => idea.id);
	const maxRank = openOthers.length + 1;
	const position = rank === void 0 ? maxRank : Math.min(Math.max(1, Math.trunc(rank)), maxRank);
	openOthers.splice(position - 1, 0, movedId);
	return openOthers;
}
//#endregion
//#region src/delivery-note.ts
/**
* Delivery-note extraction.
*
* A finished run settles into `underReview` and the reviewer is left with a
* column and a verdict — the one thing the board never showed them was what
* the run actually said. This module turns the raw journal of a run into that
* missing sentence, and nothing else: it never summarizes, never asks a model,
* never invents. A run with no assistant answer yields no note, and the board
* says so in the review gate instead of filling the gap.
*
* Pure and framework-free on purpose (same rule as core/ideas.ts): the wire
* shape it reads is duck-typed, so it is unit-testable without a Host, and a
* Host that changes its journal shape degrades to "no note" instead of
* throwing inside a settle.
*/
/**
* The visible text of one assistant message: its `text` blocks, in order,
* joined by a blank line. Reasoning blocks, tool calls and tool results are
* deliberately NOT included — a delivery note is what the run reported, not
* what it thought about or which tools it called.
*/
function assistantTextOf(message) {
	if (typeof message !== "object" || message === null) return void 0;
	const content = message.content;
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const row = block;
		if (row.type !== "text" || typeof row.text !== "string") continue;
		const text = row.text.trim();
		if (text !== "") parts.push(text);
	}
	return parts.length === 0 ? void 0 : parts.join("\n\n");
}
/**
* The delivery note carried by one `session/page` record list: the text of the
* LAST `assistant/message` event in it.
*
* The records arrive oldest-first, and "last" is the run's conclusion — an
* earlier assistant message is a mid-run remark ("let me check the schema")
* that would be actively misleading as a delivery note. Returns undefined for
* an empty page, a page with no assistant turn, or any shape the host has since
* changed: an unreadable journal means no note, never a guess.
*/
function deliveryNoteOfRecords(records) {
	if (!Array.isArray(records)) return void 0;
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (typeof record !== "object" || record === null) continue;
		const event = record.event ?? record;
		if (typeof event !== "object" || event === null) continue;
		const row = event;
		if (row.type !== "assistant/message") continue;
		const data = row.data;
		if (typeof data !== "object" || data === null) continue;
		const text = assistantTextOf(data.message);
		if (text === void 0) continue;
		const note = normalizeDeliveryNote(text);
		if (note !== void 0) return note;
	}
}
/**
* The session id of a TaskBoard card's last execution, read off the board
* snapshot the under-review poll already holds (card backend).
*
* The mirrored card does not own a session the ideas plugin can read; what it
* owns is the pointer to the one its runner used. The task-board records one
* `executions[]` entry per attempt (`{sessionId, startedAt, endedAt, result}`)
* and keeps the latest first-to-last, so the LAST entry is the run that just
* settled. Returns undefined when the board exposes no such field — an older
* board, a hand-built ledger, a card that never ran — and the caller then
* leaves the note empty and says so in the UI.
*/
function cardSessionOf(task) {
	if (task === void 0) return void 0;
	const executions = task["executions"];
	if (!Array.isArray(executions)) return void 0;
	for (let index = executions.length - 1; index >= 0; index -= 1) {
		const entry = executions[index];
		if (typeof entry !== "object" || entry === null) continue;
		const sessionId = entry.sessionId;
		if (typeof sessionId === "string" && sessionId.trim() !== "") return sessionId.trim();
	}
}
//#endregion
//#region src/run-prompt.ts
/**
* The executable prompt = the tag prompt lines, one per line; when no tag
* carries a prompt line, a mission prompt derived from the card itself.
* The fallback is mandatory: Task Board launches a run with
* `task.prompt !== '' ? task.prompt : task.title` (the description is never
* injected into the session), so an empty prompt would ship the card's bare
* TITLE to the launched agent — unexploitable for the common idea whose tags
* are all plain names. The body is the captured spec, so it becomes the run
* instruction instead.
*/
function runPromptOf(idea) {
	if (idea.tags !== void 0) {
		const lines = idea.tags.map((tag) => tag.promptPrefix?.trim() ?? "").filter((line) => line !== "");
		if (lines.length > 0) return lines.join("\n");
	}
	return `You are implementing the idea below${idea.ideaNumber === void 0 ? "" : ` #${String(idea.ideaNumber)}`} — "${idea.title}" — from the DSH Ideas board. Work in the current workspace directory.\n\nThe idea's spec (Body):\n${idea.body}`;
}
//#endregion
//#region src/taskboard-bridge.ts
/**
* P2 TaskBoard bridge: OPTIONAL one-way mirror from the ideas ledger to the
* dsh-task-board plugin, discovered at runtime — never a hard import. The
* ideas Host calls its OWN origin's /api/task-board routes over loopback with
* the family same-origin markers, exactly like a browser tab would, so the
* bridge works whenever the task-board plugin is registered on the same
* process and degrades to silent no-ops when it is not.
*
* Mapping (frozen design decision): idea create -> task create + move to
* `backlog` (the card carries the DEPLOYMENT's own session default, clamped to
* `workspace-write` — see mirrorPermissionFor, never a hard-coded level, so a
* mirrored card never outranks the default and never trips the task-board's
* confirmation gate); idea update -> task update; idea
* decline / move-to-archived -> task archive; idea restore -> task restore;
* idea delete -> no-op (the card outlives the idea). Every failure is logged
* and the ideas ledger stays the source of truth: the mirror never rolls back
* a committed idea mutation. `done` is RUNNER-OWNED, and added the
* one verb that reaches it: a launch is an explicit human action
* (`launchTask`), never a side effect of an idea mutation.
*
* Duplicate guard ("update must never mean create"): card ids are
* DETERMINISTIC (`idea-` + idea.id, see mirrorCardIdFor), a bound idea is
* only ever re-created when a NON-EMPTY snapshot proves the card gone, and
* every ensureTask decision is logged with ideaId + binding + snapshot size +
* branch. A transiently empty/unreadable snapshot therefore keeps the binding
* and attempts the patch instead of minting a second card, and re-running any
* path re-touches the same card id instead of duplicating it.
*
* Weight contract: the card DESCRIPTION carries the idea's <= 300-char
* `summary` (analyst-produced, derived excerpt otherwise) while the full
* analysis rides the card PROMPT — the body is never stored twice in the
* snapshot (see summaryDescriptionOf).
*/
const TASK_BOARD_API_PREFIX = "/api/task-board";
/** The permission presets a card accepts, in authority order. */
const TASK_PERMISSIONS = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
/** Authority rank — the same ladder the task-board compares with. */
const PERMISSION_RANK = {
	"read-only": 0,
	"workspace-write": 1,
	"danger-full-access": 2
};
/**
* The most a mirrored card ever asks for. The deployment default is the
* ceiling that keeps the confirmation gate silent; this one is the ceiling
* that keeps an idea card from ever escaping its workspace.
*/
const MIRROR_PERMISSION_CEILING = "workspace-write";
/** Used when the board reports no usable default (older board, odd snapshot). */
const MIRROR_PERMISSION_FALLBACK = "read-only";
/** Whether an unknown wire value is a known permission preset id. */
function isTaskPermission(value) {
	return typeof value === "string" && TASK_PERMISSIONS.includes(value);
}
/**
* The permission a mirrored card is stamped with: the board's own
* `sessionDefaultPermission` clamped to {@link MIRROR_PERMISSION_CEILING}, or
* `read-only` when the board reports nothing usable.
*
* Two rules, one function:
*
*  - **Never above the deployment default.** The task-board refuses to run a
*    card whose permission outranks the session default until a human confirms
*    the binding (`confirmation-required`). A mirrored card stamped above that
*    default turns every launch into a trip to the board — confirm, come back,
*    resume. Following the default instead makes the gate structurally silent
*    on every install: whatever the deployment is configured with is what idea
*    cards get, with no second lever to keep in sync and no hard-coded
*    constant to contradict the deployment.
*  - **Never above `workspace-write`,** whatever the default says: an idea
*    card is a workspace-scoped implementation brief, never a whole-machine
*    pass. `danger-full-access` stays a deliberate, human-granted elevation.
*/
function mirrorPermissionFor(boardDefault) {
	if (!isTaskPermission(boardDefault)) return MIRROR_PERMISSION_FALLBACK;
	return PERMISSION_RANK[boardDefault] <= PERMISSION_RANK[MIRROR_PERMISSION_CEILING] ? boardDefault : MIRROR_PERMISSION_CEILING;
}
/** How often a failed/negative availability probe is retried. */
const PROBE_RETRY_MS = 3e4;
/** Per-self-request timeout; the mirror is best-effort and must not hang. */
const TRANSPORT_TIMEOUT_MS = 1e4;
/**
* Cap on mirror response bodies — BOTH routes answer a full task-board
* SNAPSHOT (every card's description + prompt), so the size grows with the
* board: the production board measured 190,947 bytes once the
* rewritten card landed and its task ran, past the former 128 KiB ceiling.
* Crossing the cap used to `res.destroy()` WITHOUT settling the promise:
* every snapshot read hung silently (no log line — a pending promise never
* throws), the under-review poll stopped moving ideas to `underReview`, and
* bound-idea mirror updates stalled with it. 16 MiB sits far above any real
* board, and the overflow path now REJECTS (see HttpTaskBoardTransport), so
* a cap can degrade a read but never hang a caller again.
*/
const RESPONSE_CAP_BYTES = 16 * 1024 * 1024;
/**
* Deterministic TaskBoard card id for an idea: `idea-` + idea.id.
*
* Idempotence: re-running any mirror path targets the SAME card id
* instead of minting a fresh `idea-${randomUUID()}` on every re-execution —
* a re-analyze or a lost binding can no longer produce a second card. The
* task-board host ledger REFUSES `create` of an existing id (HTTP 400
* `task id already exists`), so callers pair this id with get-before-create:
* consult the snapshot first and adopt an already-present card rather than
* issuing the create.
*/
function mirrorCardIdFor(idea) {
	return `idea-${idea.id}`;
}
/**
* The TaskBoard card DESCRIPTION for an idea: the analyst's `summary`
* (<= 300 chars) when present, otherwise a derived excerpt of the body.
*
* Weight contract (why this exists): the snapshot serves every card's
* description AND prompt, and the prompt already carries the full body as the
* run instruction — shipping the body again as the description DOUBLED the
* state payload (190,947 bytes on production before this rule, 90% of it
* description+prompt). The full analysis stays in the ledger (source of
* truth) and in the prompt; the description becomes a readable blurb.
*/
function summaryDescriptionOf(idea) {
	const summary = idea.summary === void 0 ? void 0 : idea.summary.trim();
	if (summary !== void 0 && summary !== "") return summary.slice(0, 300);
	return deriveSummary(idea.body);
}
/**
* Derived <= 300-char excerpt of an idea body: the first paragraph holding
* actual content (pure heading blocks like a lone "## Context" are skipped),
* markdown heading markers stripped, whitespace collapsed, cut at a word
* boundary with an ASCII ellipsis when too long.
*/
function deriveSummary(body) {
	const flattened = (body.split(/\n\s*\n/).map((chunk) => chunk.trim()).filter((chunk) => chunk !== "").find((chunk) => chunk.split("\n").some((line) => {
		const trimmed = line.trim();
		return trimmed !== "" && !/^#{1,6}\s/.test(trimmed);
	})) ?? "").split("\n").map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim()).filter((line) => line !== "").join(" ").replace(/\s+/g, " ").trim();
	if (flattened.length <= 300) return flattened;
	const window = flattened.slice(0, 299);
	const boundary = window.lastIndexOf(" ");
	return `${(boundary > 40 ? window.slice(0, boundary) : window).trimEnd()}...`;
}
/**
* Real transport: one loopback self-request per call to the Host's own
* origin, carrying the browser same-origin markers so the task-board route
* fence (socket + Host + Origin equality) accepts it without a token.
*/
var HttpTaskBoardTransport = class {
	getBase;
	maxResponseBytes;
	timeoutMs;
	/**
	* @param getBase - lazily resolved origin (http://127.0.0.1:port); the
	*   listen port is only known once the web server has bound its socket.
	* @param limits - test seams for the response cap and request timeout.
	*/
	constructor(getBase, limits = {}) {
		this.getBase = getBase;
		this.maxResponseBytes = limits.maxResponseBytes ?? RESPONSE_CAP_BYTES;
		this.timeoutMs = limits.timeoutMs ?? TRANSPORT_TIMEOUT_MS;
	}
	getState() {
		return this.exchange("GET", `${TASK_BOARD_API_PREFIX}/state`);
	}
	postAction(envelope) {
		return this.exchange("POST", `${TASK_BOARD_API_PREFIX}/action`, JSON.stringify(envelope));
	}
	/**
	* One self-request. The promise SETTLES ON EVERY PATH — resolved with the
	* parsed reply, or rejected on overflow, early close, socket error, or
	* timeout. The former implementation destroyed an oversized response
	* without settling, which hung the caller forever and silently stalled the
	* under-review poll once the production snapshot passed 128 KiB.
	*/
	async exchange(method, path, body) {
		const base = this.getBase().replace(/\/$/, "");
		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (error) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			};
			const succeed = (result) => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
			};
			const url = new URL(base + path);
			const headers = {
				origin: base,
				"sec-fetch-site": "same-origin",
				...body === void 0 ? {} : { "content-type": "application/json" }
			};
			const outgoing = request({
				hostname: url.hostname,
				port: Number(url.port),
				path: url.pathname,
				method,
				headers
			}, (res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (chunk) => {
					if (settled) return;
					size += chunk.length;
					if (size > this.maxResponseBytes) {
						res.destroy();
						outgoing.destroy();
						fail(/* @__PURE__ */ new Error(`task-board response too large (> ${this.maxResponseBytes} bytes)`));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					if (settled) return;
					const raw = Buffer.concat(chunks).toString("utf8");
					let parsed;
					try {
						parsed = raw === "" ? void 0 : JSON.parse(raw);
					} catch {
						parsed = raw;
					}
					succeed({
						status: res.statusCode ?? 0,
						...parsed === void 0 ? {} : { body: parsed }
					});
				});
				res.on("error", (error) => fail(error));
				res.on("close", () => {
					fail(/* @__PURE__ */ new Error("task-board response closed before completion"));
				});
			});
			outgoing.setTimeout(this.timeoutMs);
			outgoing.on("timeout", () => {
				outgoing.destroy(/* @__PURE__ */ new Error(`task-board request timed out after ${this.timeoutMs} ms`));
			});
			outgoing.on("error", (error) => fail(error));
			if (body !== void 0) outgoing.write(body);
			outgoing.end();
		});
	}
};
/**
* The one-way mirror. Availability is feature-detected on first use and
* re-probed after a failure/absence with a bounded backoff. All methods throw
* on transport failure — the service catches, logs, and never rolls back.
*/
var TaskBoardMirror = class {
	options;
	log;
	now;
	available = false;
	lastProbeAt = 0;
	/** The unavailability already reported to the log; unset while healthy. */
	unavailableReport;
	/** Board default read from the last snapshot; unset until one lands. */
	boardDefaultPermission;
	/** Task rows of the last snapshot, read by the launch-time alignment. */
	snapshotTasks;
	constructor(options) {
		this.options = options;
		this.log = options.log ?? ((message) => {
			console.error(`[dsh-plugin-ideas-manager] mirror: ${message}`);
		});
		this.now = options.now ?? Date.now;
	}
	/**
	* Feature-detect the task-board plugin. Positive probes are cached; a
	* failure is retried at most once per backoff window.
	*
	* An unavailability is REPORTED, not repeated: the probe keeps its 30 s
	* cadence (so a task-board installed later is still picked up), but a state
	* that has not changed says nothing new. On a host without the task-board
	* plugin the old shape printed the same line every 30 s for the whole life
	* of the process — about 200 identical lines per 90-minute test session,
	* which buries every other line the plugin has. Silence is the correct
	* output for "still down"; a CHANGED status or a return to health is an
	* event and is logged once.
	*/
	async availableNow() {
		if (this.available) return true;
		if (this.now() - this.lastProbeAt < PROBE_RETRY_MS) return false;
		this.lastProbeAt = this.now();
		try {
			const result = await this.options.transport.getState();
			if (result.status === 200) {
				this.available = true;
				if (this.unavailableReport !== void 0) {
					this.log(`task-board available again after ${this.unavailableReport}; mirror active`);
					this.unavailableReport = void 0;
				}
				this.rememberSnapshot(result.body);
				return true;
			}
			this.reportUnavailable(`status-${result.status}`, `task-board unavailable (GET ${TASK_BOARD_API_PREFIX}/state -> ${result.status}); mirror inactive`);
			return false;
		} catch (error) {
			this.reportUnavailable("probe-failed", `task-board probe failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
	/**
	* Log an unavailability once per STATE rather than once per probe. The key
	* is the reason, so a status that CHANGES (401 while the workspace
	* controller boots, then 404 because the plugin is gone) is still reported:
	* the second is not the same fact as the first.
	*/
	reportUnavailable(reason, line) {
		if (this.unavailableReport === reason) return;
		this.unavailableReport = reason;
		this.log(line);
	}
	/**
	* Resolve the task id a mirror operation must target; the caller rebinds
	* the idea to the returned id. Decision ladder ("update must
	* never mean create"), logged with ideaId + binding + snapshot size +
	* branch on every path so a duplicate can be discriminated after the fact:
	*
	* Bound idea:
	*  - snapshot unknown (task-board absent / malformed body) or EMPTY ->
	*    keep the binding and target it. An empty or unreadable snapshot never
	*    proves a deletion; the patch attempt that follows fails into the
	*    service log instead of being "healed" by a create. This closes the
	*    transient-snapshot duplicate factory.
	*  - bound id present -> patch it (the normal path).
	*  - bound id absent from a NON-EMPTY snapshot -> the card was deleted
	*    out-of-band: the sanctioned rebuild, using the DETERMINISTIC id and
	*    logged as a visible event (recreating an already-bound idea is never
	*    silent again).
	*
	* Unbound idea (fresh create, or a binding never written):
	*  - get-before-create: adopt the deterministic card when the snapshot
	*    already holds it (a previous create whose bind did not land), only
	*    otherwise create it. Self-heal of the legacy orphan case, no duplicate.
	*
	* @returns the task id to bind on the idea.
	*/
	async ensureTask(idea) {
		if (!await this.availableNow()) throw new TaskBoardUnavailableError();
		const cardId = mirrorCardIdFor(idea);
		const bound = idea.taskBoardId === void 0 || idea.taskBoardId === "" ? void 0 : idea.taskBoardId;
		const statuses = await this.fetchTaskStatuses();
		const tasks = statuses === void 0 ? "?" : String(statuses.size);
		if (bound !== void 0) {
			if (statuses === void 0) {
				this.decision(idea, bound, tasks, "trust-binding-snapshot-unknown");
				return bound;
			}
			if (statuses.size === 0) {
				this.decision(idea, bound, tasks, "trust-binding-snapshot-empty");
				return bound;
			}
			if (statuses.has(bound)) {
				this.decision(idea, bound, tasks, "patch-bound-card");
				return bound;
			}
			if (statuses.has(cardId)) {
				this.decision(idea, bound, tasks, "adopt-deterministic-card");
				return cardId;
			}
			this.decision(idea, bound, tasks, "recreate-deleted-card");
			return this.createCard(idea, cardId);
		}
		if (statuses !== void 0 && statuses.size > 0 && statuses.has(cardId)) {
			this.decision(idea, void 0, tasks, "adopt-existing-card");
			return cardId;
		}
		this.decision(idea, void 0, tasks, "create-card");
		return this.createCard(idea, cardId);
	}
	/**
	* Read the current status of every task card: task id -> status. Returns
	* undefined when the task-board is absent or the snapshot is malformed —
	* the under-review poll treats that as "nothing to do" (best-effort, like
	* the rest of the bridge).
	*/
	async fetchTaskStatuses() {
		if (!await this.availableNow()) return void 0;
		const result = await this.options.transport.getState();
		if (result.status !== 200 || typeof result.body !== "object" || result.body === null) return void 0;
		this.rememberSnapshot(result.body);
		const tasks = result.body.tasks;
		if (!Array.isArray(tasks)) return void 0;
		const byId = /* @__PURE__ */ new Map();
		for (const task of tasks) {
			if (typeof task !== "object" || task === null) continue;
			const row = task;
			if (typeof row.id === "string" && typeof row.status === "string") byId.set(row.id, row.status);
		}
		return byId;
	}
	/**
	* Idea create -> task create (at the deployment's own permission, backlog) +
	* move to backlog. Routed through ensureTask so a create re-executed after a
	* lost bind adopts the card already on the board instead of duplicating it.
	*/
	async mirrorCreate(idea) {
		if (!await this.availableNow()) throw new TaskBoardUnavailableError();
		return this.ensureTask(idea);
	}
	/** Idea update -> task update; self-heals an unbound idea by creating it first. */
	async mirrorUpdate(idea) {
		const taskId = await this.ensureTask(idea);
		await this.post({
			kind: "update",
			taskId,
			patch: this.taskPatch(idea)
		});
		return taskId;
	}
	/** Idea decline / move-to-archived -> task archive. */
	async mirrorArchive(idea) {
		const taskId = await this.ensureTask(idea);
		await this.post({
			kind: "archive",
			taskId
		});
		return taskId;
	}
	/** Idea restore -> task restore (no-op when the idea was never bound). */
	async mirrorRestore(idea) {
		if (idea.taskBoardId === void 0 || idea.taskBoardId === "") return;
		await this.post({
			kind: "restore",
			taskId: idea.taskBoardId
		});
	}
	/**
	* Launch the idea's execution on its TaskBoard card: the human
	* trigger turns the board into a starting point of execution, not only a
	* capture target.
	*
	* Two writes, in this exact order and on the caller's serialized chain:
	*  1. `ensureTask` — reuses the whole duplicate guard, so the card is the
	*     deterministic `idea-<id>` one and is (re)created when it was deleted
	*     out-of-band. A launch is never a second card.
	*  2. `update{model?, permission?}` — a NON-CONTENT patch, and only when
	*     something actually has to change. Never `taskPatch()`: that sends
	*     title/description/prompt, which the task-board rejects with `task has
	*     already been executed` on any card that already ran. The permission is
	*     raised to the deployment default when the card was minted under an
	*     older, lower one (the cards 0.7.x created as `read-only`); a card the
	*     human deliberately raised is left alone, and an unreadable one is
	*     never written to. Nothing is raised above the deployment default, so
	*     the task-board's confirmation gate stays silent and the run starts on
	*     the first click.
	*  3. `run` — the bare envelope; the task-board pins the model on the fresh
	*     session and queues the shared run prompt.
	*
	* Throws `TaskBoardUnavailableError` when the plugin is absent and a plain
	* Error carrying the task-board's own `body.error` message on a gate refusal
	* (`task is already running or missing`, `archived task is read-only`,
	* `confirmation-required: ...`, `task board is disabled`) — the caller
	* surfaces it instead of swallowing it.
	*
	* @returns the launched task id.
	*/
	async launchTask(idea, model) {
		const taskId = await this.ensureTask(idea);
		const patch = {};
		const chosen = model?.trim();
		if (chosen !== void 0 && chosen !== "") patch.model = chosen;
		const current = this.cardPermissionOf(taskId);
		const wanted = this.mirrorPermission();
		if (current !== void 0 && PERMISSION_RANK[current] < PERMISSION_RANK[wanted]) {
			patch.permission = wanted;
			this.log(`launchTask idea=${idea.id} card=${taskId} permission ${current} -> ${wanted}`);
		}
		if (Object.keys(patch).length > 0) await this.post({
			kind: "update",
			taskId,
			patch
		});
		await this.post({
			kind: "run",
			taskId
		});
		return taskId;
	}
	/** The task-board plugin is not registered or did not answer. */
	get isUnavailable() {
		return !this.available;
	}
	/**
	* The session id of a card's last execution, as of the snapshot the run poll
	* already read. Zero extra requests: the poll calls
	* {@link fetchTaskStatuses} once per tick and every read lands in
	* `rememberSnapshot`, so the pointer to the run's own output is already in
	* memory here.
	*
	* This is the card backend's half of the delivery note: the mirrored card
	* does not own a session this plugin can read, only the id of the one its
	* runner used, and the session backend then harvests from it. undefined
	* when the board exposes no such field (an older board, a card that never
	* ran) — the caller leaves the note empty rather than inventing one.
	*/
	cardSessionOf(taskId) {
		for (const row of this.snapshotTasks ?? []) {
			if (row["id"] !== taskId) continue;
			return cardSessionOf(row);
		}
	}
	/**
	* Keep the two facts a create/launch needs out of the last snapshot: the
	* board's own session default (the level a mirrored card must never outrank)
	* and the per-card permission (to align a card minted under an older
	* default). Best-effort — a partial or unexpected body simply leaves the
	* fields unset, and every reader degrades to the conservative fallback.
	*/
	rememberSnapshot(body) {
		if (typeof body !== "object" || body === null) return;
		const board = body.board;
		if (typeof board === "object" && board !== null) {
			const value = board.sessionDefaultPermission;
			if (isTaskPermission(value)) this.boardDefaultPermission = value;
		}
		const tasks = body.tasks;
		if (Array.isArray(tasks)) this.snapshotTasks = tasks;
	}
	/** The permission a card created right now would carry. */
	mirrorPermission() {
		return mirrorPermissionFor(this.boardDefaultPermission);
	}
	/**
	* A card's own permission as of the snapshot just read, or undefined when
	* the card is absent from it or carries something unrecognised. Callers must
	* treat undefined as "do not touch" — an unreadable card is never a reason
	* to write to it.
	*/
	cardPermissionOf(taskId) {
		for (const row of this.snapshotTasks ?? []) {
			if (row["id"] !== taskId) continue;
			const value = row["permission"];
			return isTaskPermission(value) ? value : void 0;
		}
	}
	/** One ensureTask decision, always visible in the service log. */
	decision(idea, bound, tasks, branch) {
		this.log(`ensureTask idea=${idea.id} bound=${bound ?? "-"} tasks=${tasks} branch=${branch}`);
	}
	/**
	* The executable prompt, shared with the direct-session launch backend
	* (see src/run-prompt.ts). `model` is intentionally NOT part of the card
	* content: the card is created with no model, so the run starts on the
	* session default unless a launch re-pins it through a model-only patch.
	* `permission` IS stamped, at the deployment default clamped to
	* `workspace-write` (see {@link mirrorPermissionFor}) — never a constant, so
	* the card can run at whatever the deployment is configured with.
	*/
	async createCard(idea, taskId) {
		await this.post({
			kind: "create",
			id: taskId,
			input: {
				title: idea.title,
				description: summaryDescriptionOf(idea),
				prompt: runPromptOf(idea),
				permission: this.mirrorPermission(),
				...idea.workspaceId === void 0 ? {} : { workspaceId: idea.workspaceId },
				...idea.tags === void 0 || idea.tags.length === 0 ? {} : { tags: idea.tags }
			}
		});
		await this.post({
			kind: "move",
			taskId,
			status: "backlog"
		});
		return taskId;
	}
	taskPatch(idea) {
		return {
			title: idea.title,
			description: summaryDescriptionOf(idea),
			prompt: runPromptOf(idea),
			workspaceId: idea.workspaceId,
			...idea.tags === void 0 || idea.tags.length === 0 ? {} : { tags: idea.tags }
		};
	}
	/**
	* Post one action envelope and surface the task-board's own refusal.
	*
	* Error relay: the reply body used to be dropped and only the
	* status line read, which made every run gate opaque (`400 task is already
	* running or missing` looked exactly like a malformed request). The body
	* carries `{error}` and sometimes `{code}`; both are folded into the thrown
	* message so the launch route can hand a readable reason to the board.
	*/
	async post(action) {
		const requestId = `ideas-mirror-${randomUUID()}`;
		const result = await this.options.transport.postAction({
			requestId,
			action
		});
		if (result.status < 200 || result.status >= 300) {
			const detail = actionErrorOf(result.body);
			throw new Error(`task-board ${action.kind} -> ${result.status}${detail === void 0 ? "" : `: ${detail}`}`);
		}
	}
};
/**
* Extract a readable reason from a rejected task-board reply: `{error}` first
* (the human message the gates throw), then `{code}`; a body that is a bare
* string is used as-is. Anything else (snapshot objects, empty bodies) yields
* undefined so the caller keeps the status-only message.
*/
function actionErrorOf(body) {
	if (typeof body === "string") return body.trim() === "" ? void 0 : body.trim();
	if (typeof body !== "object" || body === null) return void 0;
	const row = body;
	if (typeof row.error === "string" && row.error.trim() !== "") return row.error.trim();
	if (typeof row.code === "string" && row.code.trim() !== "") return row.code.trim();
}
/** Thrown when the task-board plugin is absent; the service logs and moves on. */
var TaskBoardUnavailableError = class extends Error {
	constructor() {
		super("task-board plugin is not available");
	}
};
//#endregion
//#region src/host-service.ts
/**
* Ideas host service: owns the ledger and fans its change notifications out to
* the SSE route, and (P2) schedules the optional one-way TaskBoard mirror.
* The board is a passive Host-authoritative store (unlike the task board's
* execution runner) — the only timer is the run poll, which watches for
* mirrored task cards passing `done` and moves the linked idea to
* `underReview` (the review gate). No other background work runs.
*
* Launch: the mirror is also an EXECUTION entry point, but only on
* an explicit human request (`launchIdea` / POST /api/ideas/launch) — the
* passivity above is unchanged: no idea mutation ever starts a run, and `done`
* stays runner-owned. Two execution backends share that one entry point: the
* mirrored card when the task-board plugin is present, otherwise a FRESH direct
* session (v2) started through the Host `typertGateway`. Both settle from this
* service's run poll, so a launch keeps going — and keeps being observed — when
* the browser tab is closed.
*
* Mirror discipline (frozen design decision): the mirror is best-effort and
* asynchronous — committed ideas never roll back, a failed mirror only logs,
* and a replayed request id never re-mirrors. Mirror operations are
* SERIALIZED PER IDEA ID (one promise chain per idea): a create followed by
* an update runs one at a time in submission order, and each op re-reads the
* fresh ledger state at execution time, so a queued link can never race its
* predecessor into seeing "unbound" and minting a second card.
* The bound card id is persisted on the idea through the ledger's internal
* `bindTaskBoardId` path (the wire gate never accepts taskBoardId).
*/
/** How often the run poll re-reads the task-board card statuses. */
const UNDER_REVIEW_POLL_MS = 3e4;
/** How long a launch request id replays its first outcome. */
const LAUNCH_DEDUPE_TTL_MS = 6e4;
/** Bounded launch replay cache (the ledger action cache is NOT reused: a launch is not a ledger mutation). */
const MAX_LAUNCH_CACHE = 64;
var IdeasHostService = class {
	ledger;
	listeners = /* @__PURE__ */ new Set();
	mirror;
	autoMirror;
	sessions;
	/**
	* Settings reader (late-bound; see {@link setSettingsReader}). Every launch
	* decision that depends on a preference reads it AT LAUNCH TIME.
	*/
	settings;
	pendingMirrors = [];
	/** Per-idea mirror chains: ops for one idea id run in order. */
	mirrorChains = /* @__PURE__ */ new Map();
	/** Launch replays: requestId -> {at, result} (in-memory only). */
	launchCache = /* @__PURE__ */ new Map();
	/** Direct-session runs in flight: sessionId -> ideaId. */
	sessionRuns = /* @__PURE__ */ new Map();
	/** Set once the poll re-attached to a persisted in-flight run. */
	sessionRunsReattached = false;
	active = true;
	disposed = false;
	reviewPoll;
	constructor(options = {}) {
		this.ledger = options.ledger ?? new IdeasHostLedger(options.dir === void 0 ? {} : { dir: options.dir });
		this.mirror = options.mirror;
		this.autoMirror = options.autoMirror ?? true;
		this.sessions = options.sessions;
		this.ledger.subscribe(() => {
			this.emit();
		});
	}
	setActive(active) {
		this.active = active;
		this.emit();
	}
	/**
	* Live master switch. Exposed so the agent-tool registration reads the SAME
	* flag the write path enforces: a disabled board answers no tool call, and
	* that is only true if both sides look at one value.
	*/
	isActive() {
		return this.active;
	}
	snapshot() {
		const state = this.ledger.snapshot();
		return {
			schemaVersion: 1,
			revision: state.revision,
			ideas: state.ideas
		};
	}
	/** One full record for the deferred-body read; undefined when absent. */
	idea(id) {
		return this.ledger.idea(id);
	}
	/** SSE frame payload; deliberately skips the ideas deep-clone of {@link snapshot}. */
	eventPayload() {
		return this.ledger.summary();
	}
	/**
	* The bounded backlog-health aggregate, served by
	* `GET /api/ideas/state?view=stats`.
	*
	* Deliberately NOT built on {@link snapshot}: the aggregate reads counters
	* out of the rows and keeps nothing, so the deep clone that every reader
	* pays would buy a megabyte of work to produce a few kilobytes of answer.
	* `ledger.statsSource` is the read-only seam that makes this cheap, and the
	* numbers themselves come from `core/ideas-stats.ts` — the single definition
	* every surface of this plugin shares.
	*
	* A READ: it mutates nothing, consumes no request id, and is never part of
	* the board's 2.5 s poll.
	*/
	ideasStats(options = {}) {
		return buildIdeasStats(this.ledger.statsSource(), options);
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	apply(requestId, action, initiator) {
		if (!this.active) throw new Error("ideas plugin is disabled");
		const result = this.ledger.applyRequest(requestId, action, initiator === void 0 || initiator.trim() === "" ? void 0 : { initiator });
		if (!result.replayed) this.scheduleMirror(action, result.state.ideas);
		const state = result.state;
		return {
			state: {
				schemaVersion: 1,
				revision: state.revision,
				ideas: state.ideas
			},
			...result.export === void 0 ? {} : { export: result.export }
		};
	}
	/** Snapshot folder view (GET /api/ideas/backup).
	*
	* The list is built from file names and sizes — never by parsing a snapshot —
	* so opening the settings section costs a directory read whatever the board
	* weighs. `running` is reported up front so the panel can say why a restore
	* would be refused instead of letting the human click into that answer.
	*/
	backupsView() {
		if (!this.active) throw new Error("ideas plugin is disabled");
		return {
			ok: true,
			dir: this.ledger.backupDir(),
			retention: 10,
			snapshots: this.ledger.snapshots().map(snapshotInfoOf),
			running: this.ledger.runningIdeas().length
		};
	}
	/**
	* Take a snapshot of the whole board. Additive and outside the action wire:
	* a snapshot writes a FILE, not the ledger, so it must not consume the
	* persisted request-id dedupe cache (the same reason the launch route is a
	* dedicated endpoint).
	*/
	takeSnapshot(reason = "manual") {
		if (!this.active) throw new Error("ideas plugin is disabled");
		const result = this.ledger.takeSnapshot(reason);
		return {
			ok: true,
			snapshot: snapshotInfoOf(result.snapshot),
			ideas: result.ideas,
			pruned: result.pruned
		};
	}
	/** Raw snapshot document for the download route (export); undefined when absent. */
	snapshotContent(name) {
		if (!this.active) throw new Error("ideas plugin is disabled");
		const read = this.ledger.readSnapshot(name);
		return read.ok ? read.text : void 0;
	}
	/**
	* Restore the board from a snapshot or from an imported document. A refusal
	* (a run in flight, a broken file) is an ordinary answer carrying the Host's
	* own sentence, never an exception: the panel renders the reason and the live
	* board is untouched in every refusal case.
	*/
	restoreBoard(request) {
		if (!this.active) throw new Error("ideas plugin is disabled");
		const source = request.name !== void 0 ? { name: request.name } : { document: request.document ?? "" };
		const result = this.ledger.restore(source);
		if (!result.ok) return {
			ok: false,
			error: result.reason,
			message: result.message,
			...result.running === void 0 ? {} : { running: result.running.map((idea) => ({
				id: idea.id,
				...idea.ideaNumber === void 0 ? {} : { ideaNumber: idea.ideaNumber },
				title: idea.title
			})) }
		};
		return {
			ok: true,
			revision: result.revision,
			ideas: result.ideas,
			source: result.source,
			displaced: snapshotInfoOf(result.displaced),
			unknownFields: result.unknownFields
		};
	}
	/**
	* Test seam: wait for every scheduled mirror op to settle. The production
	* path never awaits mirrors (they are fire-and-forget), so this blocks only
	* when a test calls it.
	*/
	async flushMirror() {
		while (this.pendingMirrors.length > 0) {
			const batch = this.pendingMirrors.splice(0);
			await Promise.allSettled(batch);
		}
	}
	/**
	* Start the run poll: every `intervalMs` the mirror's task-card statuses are
	* read, the LAST OBSERVED status of every open idea's linked card is recorded
	* on the idea (a `failed` task leaves the idea in the backlog behind a "Task
	* failed" badge), the generic `runStatus` follows that same observation, and
	* any open idea whose card is `done` moves to `underReview` (the review
	* gate). No-op when the mirror is absent or autoMirror is off.
	*/
	/**
	* Arm the run poll. It is the ONE background timer of the service and it
	* serves both execution backends: the card statuses (mirror on) and the
	* session roster (gateway present). It stays disarmed when neither backend
	* exists, so a deployment with neither runs no timer at all.
	*/
	startUnderReviewPoll(intervalMs = UNDER_REVIEW_POLL_MS) {
		if (this.reviewPoll !== void 0 || this.disposed) return;
		if ((this.mirror === void 0 || !this.autoMirror) && this.sessions === void 0) return;
		this.reviewPoll = setInterval(() => {
			this.pollRunTransitions();
		}, intervalMs);
	}
	/**
	* Attach the direct-session backend LATE (the `typertGateway` is an injected
	* service, so it can appear after the plugin applied) and arm the poll if it
	* was waiting for this. Safe to call with the same runner twice.
	*/
	attachSessions(sessions) {
		if (this.disposed) return;
		this.sessions = sessions;
		this.startUnderReviewPoll();
	}
	/**
	* Bind the reader the launch path resolves its settings through (the
	* direct-launch permission, the per-workspace default model).
	*
	* One reader for the whole settings VALUE, late-bound on purpose: the port
	* can appear after the plugin applied, and a deployment with no settings
	* service yields undefined, which leaves every setting at its documented
	* default. Reading the value twice (once per launch decision) rather than
	* caching it at apply time is deliberate — a settings write takes effect on
	* the very next launch, with no restart and no stale snapshot.
	*/
	setSettingsReader(read) {
		this.settings = read;
	}
	/**
	* One poll pass (exposed for tests): each backend settles from its own
	* single read, and a backend that is absent simply does nothing.
	*/
	async pollRunTransitions() {
		if (this.disposed) return;
		await this.pollCardRuns();
		await this.pollSessionRuns();
	}
	/**
	* Card-backed runs. Three jobs on the SAME status read:
	*  - record the last observed status of every open idea's linked card
	*    (follow-up work: the "Task failed" badge; the setter is a no-op on
	*    an unchanged observation, so the 30 s poll never churns the revision;
	*    a card missing from one probe keeps its last observation because the
	*    mirror self-heals a dangling link on the next write);
	*  - feed the backend-neutral `runStatus` from that observation:
	*    `running` / `done` / `failed` map straight across, and a card observed
	*    OUTSIDE a run (back in `backlog`/`todo`) clears the stamp. Both setters
	*    are no-ops on an unchanged value, so the idle poll stays free;
	*  - move an open idea whose card is `done` to `underReview` (the review
	*    gate - unchanged behavior).
	*
	* A run IN FLIGHT is always followed, even on an idea that has left the
	* backlog: a launch started while the idea was already under review (or
	* archived) used to leave its `runStatus: 'running'` forever, because the
	* observation scope below is the OPEN column. Tracking starts on `open`
	* only, and stops only when the stamp clears, so a non-open idea is never
	* newly watched (no churn on the closed columns).
	*
	* Best-effort: any failure is ignored.
	*/
	async pollCardRuns() {
		if (this.mirror === void 0 || !this.autoMirror) return;
		let statuses;
		try {
			statuses = await this.mirror.fetchTaskStatuses();
		} catch (error) {
			console.error(`[dsh-plugin-ideas-manager] run poll failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (statuses === void 0) return;
		for (const idea of this.ledger.snapshot().ideas) {
			if (idea.taskBoardId === void 0) continue;
			const observed = statuses.get(idea.taskBoardId);
			const cardSession = this.mirror.cardSessionOf(idea.taskBoardId);
			if (cardSession !== void 0 && cardSession !== idea.runSessionId) try {
				this.ledger.setRunSession(idea.id, cardSession);
			} catch (error) {
				console.error(`[dsh-plugin-ideas-manager] session pointer sync failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const tracking = idea.status === "open" || idea.runStatus !== void 0;
			if (idea.status === "open" && observed !== void 0 && observed !== idea.taskBoardStatus) try {
				this.ledger.setTaskBoardStatus(idea.id, observed);
			} catch (error) {
				console.error(`[dsh-plugin-ideas-manager] task status sync failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (tracking && observed !== void 0 && observed !== idea.runStatus) try {
				this.ledger.setRunStatus(idea.id, runStatusOf(observed));
			} catch (error) {
				console.error(`[dsh-plugin-ideas-manager] run status sync failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (idea.status !== "open" || observed !== "done") continue;
			try {
				this.settleRun(idea.id, "done", this.mirror.cardSessionOf(idea.taskBoardId));
			} catch (error) {
				console.error(`[dsh-plugin-ideas-manager] under-review transition failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	/**
	* Launch the idea's execution through the resolved execution
	* backend: the mirrored card whenever the task-board plugin is present (the
	* card is created when the idea has none yet), otherwise a FRESH direct
	* session — the Host-serves-no-task-board case. Both paths are AWAITED,
	* ordered writes: they run on the idea's mirror chain (so a queued
	* create/update can never interleave between the model patch and the run),
	* and the caller gets the outcome instead of a fire-and-forget log line. The
	* response contract is identical for both, so the browser and the write
	* channel cannot tell which one ran.
	*
	* @param model - an explicit `provider/model` for THIS run. Absent is not
	*   "no model": the workspace default applies, then the backend's own
	*   default (see {@link workspaceLaunchModel}).
	*
	* @throws when the plugin is disabled, no backend is available, the idea is
	*   unknown, or the backend refuses the run (the message carries its own
	*   reason: `task is already running or missing`, `workspace not found`,
	*   `session selectModel rejected: ...`).
	*/
	async launchIdea(ideaId, model, requestId) {
		if (!this.active) throw new Error("ideas plugin is disabled");
		const captured = this.ledger.idea(ideaId);
		if (captured === void 0) throw new Error("idea not found");
		if (requestId !== void 0) {
			const replay = this.launchCache.get(requestId);
			if (replay !== void 0) {
				if (Date.now() - replay.at <= LAUNCH_DEDUPE_TTL_MS) return replay.result;
				this.launchCache.delete(requestId);
			}
		}
		const idea = this.ledger.idea(ideaId) ?? captured;
		const viaCard = this.mirror !== void 0 && this.autoMirror;
		if (!viaCard && this.sessions === void 0) throw new TaskBoardMirrorDisabledError();
		const outcome = await this.enqueueChain(ideaId, async () => {
			const fresh = this.ledger.idea(ideaId) ?? idea;
			const explicit = model?.trim();
			const target = explicit === void 0 || explicit === "" ? this.workspaceLaunchModel(fresh) : explicit;
			if (!viaCard) return await this.launchInSession(fresh, target);
			try {
				const taskId = await this.mirror.launchTask(fresh, target);
				this.ledger.bindTaskBoardId(ideaId, taskId);
				this.ledger.setRunStatus(ideaId, "running");
				return {
					runId: taskId,
					taskId
				};
			} catch (error) {
				if (this.sessions === void 0 || !(error instanceof TaskBoardUnavailableError)) throw error;
				return await this.launchInSession(fresh, target);
			}
		});
		const result = {
			ok: true,
			runId: outcome.runId,
			runStatus: "running"
		};
		if (outcome.taskId !== void 0) result.taskId = outcome.taskId;
		if (requestId !== void 0) this.rememberLaunch(requestId, result);
		this.recordRunEvent(ideaId, `Execution started on the ${outcome.taskId === void 0 ? "fresh session" : "task card"}`);
		return result;
	}
	/**
	* The default launch model of the idea's workspace, or
	* undefined when the workspace carries none — which is what leaves a run on
	* whatever its backend defaults to, exactly as before the field existed.
	*
	* Three cases answer undefined on purpose:
	*  - an idea with no workspace cannot be launched at all (both backends
	*    refuse it), so there is nothing to look a default up for;
	*  - a deployment with no settings service, or one still loading its port,
	*    has no map to read;
	*  - a workspace that no longer exists still HOLDS its default (the map is
	*    keyed by a stable id, and nothing prunes it: a workspace the Host has
	*    forgotten is not a reason to forget a preference). Ideas re-homed out
	*    of it simply resolve to another workspace's entry or to none.
	*/
	workspaceLaunchModel(idea) {
		const workspaceId = idea.workspaceId;
		if (workspaceId === void 0 || workspaceId === "") return void 0;
		const target = this.settings?.()?.launchModelByWorkspace[workspaceId];
		return typeof target === "string" && target.trim() !== "" ? target.trim() : void 0;
	}
	/**
	* Direct-session launch: create the session, stamp the run, and register it
	* for settling. `runSessionId` is written with the stamp so a restarted Host
	* re-attaches (see {@link pollSessionRuns}).
	*/
	async launchInSession(idea, model) {
		const sessionId = await this.sessions.launchIdea(idea, model, this.settings?.()?.directRunPermission);
		this.ledger.setRunStatus(idea.id, "running");
		this.ledger.setRunSession(idea.id, sessionId);
		this.sessionRuns.set(sessionId, idea.id);
		this.sessionRunsReattached = true;
		return { runId: sessionId };
	}
	/**
	* Settle the direct-session runs in flight, from ONE roster read per tick.
	* A session that stops running settles `done`; one that disappeared settles
	* `failed` (the Host closed it under us — the closest observable there is to
	* a cancelled run). An unknown roster (booting or unavailable runtime)
	* settles nothing: the run stays `running` rather than being invented as
	* finished. Card-backed runs never come through here.
	*
	* On the first tick after a restart, the in-memory tracker is re-seeded from
	* the ledger (`runStatus: 'running'` + `runSessionId`), which is what makes a
	* direct run survive the Host restarting mid-execution.
	*/
	async pollSessionRuns() {
		if (this.sessions === void 0 || this.disposed) return;
		if (!this.sessionRunsReattached) {
			this.sessionRunsReattached = true;
			for (const idea of this.ledger.snapshot().ideas) if (idea.runStatus === "running" && idea.runSessionId !== void 0) this.sessionRuns.set(idea.runSessionId, idea.id);
		}
		if (this.sessionRuns.size === 0) return;
		let roster;
		try {
			roster = await this.sessions.listRunning();
		} catch (error) {
			console.error(`[dsh-plugin-ideas-manager] session roster read failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		for (const [sessionId, ideaId] of [...this.sessionRuns]) {
			const running = roster.get(sessionId);
			if (running === true) continue;
			this.sessionRuns.delete(sessionId);
			try {
				this.settleRun(ideaId, running === false ? "done" : "failed", sessionId);
			} catch (error) {
				console.error(`[dsh-plugin-ideas-manager] run settle failed for ${ideaId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	/**
	* Write a settled run and, for a finished one, open the review gate. Shared
	* by both backends: a direct run that completes is finished work, so on a
	* card-less board the idea must still reach `underReview` for the human —
	* otherwise the review gate would silently depend on the task-board plugin.
	*
	* `sessionId` is the run's own session, resolved by the caller: for the
	* session backend that is the tracked session, for the card backend it is the
	* id the mirrored card's last execution recorded. It is passed in rather than
	* re-read so the harvest never has to guess which run it is describing, and it
	* is also stamped on the card so the "Open session" link keeps working after
	* the run. undefined is a first-class case — it simply means "no note" (see
	* {@link harvestNote}) and leaves any previous pointer alone.
	*/
	settleRun(ideaId, status, sessionId) {
		this.ledger.setRunStatus(ideaId, status);
		if (sessionId !== void 0 && sessionId !== "") this.ledger.setRunSession(ideaId, sessionId);
		if (status !== "done") {
			this.recordRunEvent(ideaId, "The run failed — the idea stays in the backlog");
			return;
		}
		this.harvestNote(ideaId, sessionId);
		if (this.ledger.idea(ideaId)?.status !== "open") {
			this.recordRunEvent(ideaId, "The run finished — the delivery note is on the card");
			return;
		}
		this.ledger.applyRequest(`under-review-${ideaId}-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
			kind: "move",
			ideaId,
			status: "underReview"
		}, { actor: "run" });
	}
	/**
	* Append one Host-transition entry to an idea's activity log.
	* Best-effort like every other mirror/poll write: a ledger that refuses the
	* append must not take the settle down with it.
	*/
	recordRunEvent(ideaId, summary) {
		try {
			this.ledger.recordEvent(ideaId, "run", summary);
		} catch (error) {
			console.error(`[dsh-plugin-ideas-manager] activity log append failed for ${ideaId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Harvest the delivery note of a finished run and store it as the
	* idea's host-written `deliveryNote`.
	*
	* Strictly AFTER the review gate opens, and deliberately not awaited: the
	* settle is a ledger write the reviewer is waiting on, the note is a bonus
	* read that must never delay it or fail it. Everything about this call is
	* best-effort — a missing gateway, a refused RPC, an unreadable journal all
	* land on "no note", which the review gate renders as a quiet line rather
	* than a blank space. The one thing it will not do is invent a note.
	*/
	harvestNote(ideaId, sessionId) {
		if (this.sessions === void 0 || sessionId === void 0 || sessionId === "") return;
		(async () => {
			try {
				const note = await this.sessions.readDeliveryNote(sessionId);
				if (note === void 0) return;
				this.ledger.setDeliveryNote(ideaId, note);
			} catch (error) {
				console.error(`[dsh-plugin-ideas-manager] delivery note harvest failed for ${ideaId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.reviewPoll !== void 0) {
			clearInterval(this.reviewPoll);
			this.reviewPoll = void 0;
		}
		this.ledger.dispose();
		this.listeners.clear();
		this.launchCache.clear();
		this.sessionRuns.clear();
	}
	emit() {
		for (const listener of [...this.listeners]) listener();
	}
	/** Record a launch outcome for replay, bounded by TTL and entry count. */
	rememberLaunch(requestId, result) {
		const now = Date.now();
		this.launchCache.set(requestId, {
			at: now,
			result
		});
		for (const [key, entry] of this.launchCache) if (now - entry.at > LAUNCH_DEDUPE_TTL_MS) this.launchCache.delete(key);
		while (this.launchCache.size > MAX_LAUNCH_CACHE) this.launchCache.delete(this.launchCache.keys().next().value);
	}
	/**
	* Schedule the mirror for one applied action. The affected idea is read from
	* the POST-commit snapshot; the mirror op runs on that idea's chain (see
	* enqueueMirror) and binds the resolved card id when the idea is not yet
	* bound (covers both the create path and the bridge-activated-later
	* self-heal).
	*/
	scheduleMirror(action, ideas) {
		if (!this.autoMirror || this.mirror === void 0) return;
		if (action.kind === "followUp") {
			const child = ideas.find((item) => item.followUpOfId === action.ideaId);
			if (child === void 0) return;
			this.enqueueMirror(child.id, "create", child);
			return;
		}
		if (action.kind === "merge") {
			const survivor = ideas.find((item) => item.id === action.targetId);
			if (survivor !== void 0) this.enqueueMirror(survivor.id, "update", survivor);
			const loser = ideas.find((item) => item.id === action.sourceId);
			if (loser !== void 0) this.enqueueMirror(loser.id, "archive", loser);
			return;
		}
		const kind = mirrorKindOf(action);
		if (kind === void 0) return;
		const ideaId = actionIdeaId(action);
		const idea = ideas.find((item) => item.id === ideaId);
		if (idea === void 0) return;
		this.enqueueMirror(idea.id, kind, idea);
	}
	/**
	* Queue one mirror op on its idea's chain: ops for the SAME idea
	* id run strictly in submission order — a create always completes (and
	* binds) before a following update even starts — while ops for different
	* ideas still run concurrently. `runMirror` never rejects, so a failed link
	* cannot wedge the chain; `run` is tracked from schedule time so
	* flushMirror waits for the whole chain, not just its tail link.
	*/
	enqueueMirror(ideaId, kind, idea) {
		this.enqueueChain(ideaId, async () => {
			await this.runMirror(kind, idea);
		});
	}
	/**
	* Queue one operation on its idea's chain: ops for the SAME idea
	* id run strictly in submission order — a create always completes (and
	* binds) before a following update even starts — while ops for different
	* ideas still run concurrently. Mirror ops never reject (`runMirror`); a
	* launch DOES, and its rejection travels back to the awaiting route. `run`
	* is tracked from schedule time so flushMirror waits for the whole chain,
	* not just its tail link.
	*
	* The cleanup is attached with `then(cleanup, cleanup)` on purpose: a
	* `.finally()` copy of a rejected launch promise would itself be an unhandled
	* rejection.
	*/
	enqueueChain(ideaId, run) {
		const chained = (this.mirrorChains.get(ideaId) ?? Promise.resolve()).catch(() => void 0).then(run);
		const chainTail = chained.then(() => void 0, () => void 0);
		this.mirrorChains.set(ideaId, chainTail);
		this.pendingMirrors.push(chainTail);
		const cleanup = () => {
			const index = this.pendingMirrors.indexOf(chainTail);
			if (index >= 0) this.pendingMirrors.splice(index, 1);
			if (this.mirrorChains.get(ideaId) === chainTail) this.mirrorChains.delete(ideaId);
		};
		chainTail.then(cleanup, cleanup);
		return chained;
	}
	runMirror(kind, captured) {
		return (async () => {
			const idea = this.ledger.snapshot().ideas.find((item) => item.id === captured.id) ?? captured;
			try {
				switch (kind) {
					case "create": {
						const taskId = await this.mirror.mirrorCreate(idea);
						this.ledger.bindTaskBoardId(idea.id, taskId);
						return;
					}
					case "update": {
						const taskId = await this.mirror.mirrorUpdate(idea);
						this.ledger.bindTaskBoardId(idea.id, taskId);
						return;
					}
					case "archive": {
						const taskId = await this.mirror.mirrorArchive(idea);
						this.ledger.bindTaskBoardId(idea.id, taskId);
						return;
					}
					case "restore": await this.mirror.mirrorRestore(idea);
				}
			} catch (error) {
				if (this.mirror.isUnavailable) return;
				console.error(`[dsh-plugin-ideas-manager] mirror ${kind} failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	}
};
function mirrorKindOf(action) {
	switch (action.kind) {
		case "create": return "create";
		case "update": {
			const keys = Object.keys(action.patch);
			return keys.length > 0 && keys.every((key) => key === "relatesTo" || key === "blocks") ? void 0 : "update";
		}
		case "move": return action.status === "archived" ? "archive" : action.status === "open" ? "restore" : void 0;
		case "decline":
		case "deliver": return "archive";
		case "restore": return "restore";
		case "followUp": return;
		case "merge": return;
		case "delete":
		case "reorder":
		case "triage":
		case "reanalyze":
		case "import":
		case "export": return;
	}
}
/** Wire projection of one snapshot file (the absolute path stays host-side). */
function snapshotInfoOf(file) {
	return {
		name: file.name,
		createdAt: file.createdAt,
		bytes: file.bytes,
		reason: file.reason,
		foreign: !file.managed
	};
}
/**
* The TaskBoard mirror cannot launch because it is not installed in this
* process, or because auto-mirror is off: a 409 the board renders as
* "TaskBoard integration is off", distinct from a 503 (the plugin is absent or
* stopped answering) so the human knows whether to fix a setting or install
* something.
*/
var TaskBoardMirrorDisabledError = class extends Error {
	constructor() {
		super("task-board mirror is disabled");
	}
};
/**
* Map a raw task-board status observation onto the backend-neutral run
* lifecycle. The three RUNNING/DONE/FAILED values map one-to-one; a
* card sitting outside a run (backlog/todo/archived) means "no run in flight",
* which CLEARS the stamp so a re-armed card does not keep a stale `running`.
*/
function runStatusOf(observed) {
	if (observed === "running" || observed === "done" || observed === "failed") return observed;
}
/** The mirrored idea of an action, for the POST-commit lookup. */
function actionIdeaId(action) {
	switch (action.kind) {
		case "create": return action.id;
		case "update":
		case "move":
		case "decline":
		case "deliver":
		case "triage":
		case "followUp":
		case "restore":
		case "delete":
		case "reanalyze": return action.ideaId;
		case "reorder":
		case "import":
		case "export":
		case "merge": return;
	}
}
//#endregion
//#region src/agent-tools.ts
/**
* The initiator the tools stamp on every write. It is what makes an agent's
* write readable as one in the idea's own activity log ("an agent did this"),
* exactly like the analyst sessions' `ai-capture` / `ai-reanalyze` labels.
*/
const IDEAS_TOOL_INITIATOR = "plugin:ideas-manager:agent-tool";
/** Model-facing JSON rendering shared by every tool. */
function renderJson(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
/** Mark an already JSON-safe projection as the tool's canonical value. */
function json(value) {
	return value;
}
/** A domain refusal the model is expected to read and act on. */
function refused(code, message) {
	return json({
		ok: false,
		code,
		message
	});
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** A fresh replay key for one write (the ledger dedupes; a tool call never replays). */
function newRequestId() {
	return globalThis.crypto.randomUUID();
}
/** Read one named string argument (blank collapses to undefined). */
function readString(args, key) {
	const value = args[key];
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/** Read one named number argument (finite only). */
function readNumber(args, key) {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* Read a list of tag NAMES. The tool speaks names only: a prompt prefix is a
* board-level decision an agent has no business making by accident, and the
* wire tag object stays one shape away.
*/
function readTagNames(args) {
	const value = args.tags;
	if (!Array.isArray(value)) return void 0;
	const names = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const name = entry.trim();
		if (name !== "" && !names.includes(name)) names.push(name);
	}
	return names.length === 0 ? void 0 : names;
}
/**
* Host-written system fields: an idea verb NEVER accepts them from a caller,
* so the tools never build one and never forward one.
*/
const FORBIDDEN_SYSTEM_FIELDS = [
	"runStatus",
	"runSessionId",
	"taskBoardId"
];
/**
* Whether an action the tools are about to submit carries a host-written system
* field. Belt and braces over the wire gate: if the gate is ever relaxed, this
* stays the reason an agent cannot forge a run stamp or claim a card.
* @param action - the action object about to be submitted.
*/
function carriesSystemField(action) {
	if (typeof action !== "object" || action === null) return false;
	const seen = /* @__PURE__ */ new Set();
	const walk = (value) => {
		if (typeof value !== "object" || value === null || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry);
			return;
		}
		for (const [key, entry] of Object.entries(value)) {
			if (FORBIDDEN_SYSTEM_FIELDS.includes(key)) throw new Error(`field ${key} is host-written`);
			walk(entry);
		}
	};
	try {
		walk(action);
		return false;
	} catch {
		return true;
	}
}
/**
* Submit one action through the EXACT wire gate the HTTP route uses. The
* envelope is built, parsed and only then applied, so an invalid action is
* refused identically whichever surface asked for it.
* @param host - the Host service face.
* @param action - the action object to submit.
* @returns the Host answer, or a readable refusal.
*/
function submitAction(host, action) {
	if (carriesSystemField(action)) return refused("forbidden-field", "runStatus, runSessionId and taskBoardId are written by the Host, never by a caller");
	const envelope = parseActionEnvelope({
		requestId: newRequestId(),
		action,
		initiator: IDEAS_TOOL_INITIATOR
	});
	if (envelope === void 0) return refused("invalid-action", "the action envelope was refused by the wire gate");
	try {
		host.apply(envelope.requestId, envelope.action, envelope.initiator);
		return json({ ok: true });
	} catch (error) {
		return refused("refused", messageOf(error));
	}
}
/**
* Compact idea row for the model: identity, column, opinion, lineage, runs, and
* the three relation lines.
*
* `blockedBy` is DERIVED — it exists on no row and rides no wire field — so it
* is computed here from the whole snapshot ({@link ideaBlockedBy}). That is why
* the snapshot is a REQUIRED argument: a summary that silently answered "nothing
* waits on this card" because the caller passed no peers would be a confident
* lie, and "which idea am I blocked by?" is the question this projection exists
* to answer.
*
* @param idea - the row to project.
* @param ideas - the whole snapshot, used to derive `blockedBy`.
*/
function ideaSummary(idea, ideas) {
	return {
		id: idea.id,
		...idea.ideaNumber === void 0 ? {} : { number: `#${idea.ideaNumber}` },
		title: idea.title,
		status: idea.status,
		...idea.summary === void 0 ? {} : { summary: idea.summary },
		...idea.workspaceId === void 0 ? {} : { workspaceId: idea.workspaceId },
		...idea.tags === void 0 ? {} : { tags: idea.tags.map((tag) => tag.name) },
		...idea.value === void 0 ? {} : { value: idea.value },
		...idea.effort === void 0 ? {} : { effort: idea.effort },
		...idea.rank === void 0 ? {} : { rank: idea.rank },
		...idea.rationale === void 0 ? {} : { rationale: idea.rationale },
		...idea.taskBoardId === void 0 ? {} : { taskBoardId: idea.taskBoardId },
		...idea.runStatus === void 0 ? {} : { runStatus: idea.runStatus },
		...idea.followUpOfId === void 0 ? {} : { followUpOfId: idea.followUpOfId },
		...idea.deliveredAt === void 0 ? {} : { deliveredAt: idea.deliveredAt },
		...idea.decision === void 0 ? {} : { decision: idea.decision },
		...idea.relatesTo === void 0 ? {} : { relatesTo: idea.relatesTo },
		...idea.blocks === void 0 ? {} : { blocks: idea.blocks },
		...ideas.length === 0 ? {} : { blockedBy: ideaBlockedBy(ideas, idea.id) },
		...idea.events === void 0 ? {} : { activity: idea.events }
	};
}
/**
* The three relation lines of one idea, every target resolved to its `#N` and
* title while the board still knows it.
*
* A bare id is what made the edge look unopenable: an agent reporting "blocks
* the mirror card" needs the number, and an unresolved target is reported as
* such rather than as a confident empty label.
*
* @param ideas - the whole snapshot (relations are cross-row).
* @param idea - the idea whose lines are projected.
*/
function relationViewsOf(ideas, idea) {
	const byId = new Map(ideas.map((item) => [item.id, item]));
	const targets = (ids) => ids.map((id) => {
		const target = byId.get(id);
		if (target === void 0) return { id };
		return {
			id,
			...target.ideaNumber === void 0 ? {} : { number: `#${target.ideaNumber}` },
			title: target.title
		};
	});
	return {
		relatesTo: targets(idea.relatesTo ?? []),
		blocks: targets(idea.blocks ?? []),
		blockedBy: targets(ideaBlockedBy(ideas, idea.id))
	};
}
/**
* The inverse of the stored `blocks` for every idea at once, in one pass.
*
* Built once per read for the same reason the board builds its relation index
* once per paint: `blockedBy` is derived from the other rows, so asking per row
* would be O(rows²) on every page.
*
* @param ideas - the whole snapshot.
* @returns target id -> the ids of the ideas that block it.
*/
function blockedByIndexOf(ideas) {
	const index = /* @__PURE__ */ new Map();
	for (const idea of ideas) for (const target of idea.blocks ?? []) {
		const blockers = index.get(target);
		if (blockers === void 0) index.set(target, [idea.id]);
		else blockers.push(idea.id);
	}
	return index;
}
/**
* The declared dependencies ONE idea contradicts, in either direction, resolved
* to the same `#N Title` shape every other view prints.
*
* A triage and a relation write are the only two things that can put a card
* above its own blocker, so the two answers carry the verdict instead of leaving
* the caller to compare ranks by hand. Advisory, never a refusal: see
* `rankBlockConflicts`.
*
* @param ideas - the whole snapshot (the scan compares across it).
* @param ideaId - the card the caller just wrote.
* @returns the conflicts naming that card, `blocked` and `blocker` resolved.
*/
function rankConflictsIn(ideas, ideaId) {
	const byId = new Map(ideas.map((idea) => [idea.id, idea]));
	return rankBlockConflicts(ideas).filter((pair) => pair.blockedId === ideaId || pair.blockerId === ideaId).map((pair) => ({
		role: pair.blockedId === ideaId ? "blocked" : "blocker",
		blocked: ideaRefOf(byId.get(pair.blockedId)),
		blocker: ideaRefOf(byId.get(pair.blockerId))
	}));
}
/** `#12 Fix the poll`, or the bare id for a row the ledger has not numbered. */
function ideaRefOf(idea) {
	if (idea === void 0) return { id: "unknown" };
	return {
		id: idea.id,
		...idea.ideaNumber === void 0 ? {} : { number: `#${idea.ideaNumber}` },
		title: idea.title
	};
}
/**
* The OPEN ideas one idea waits for, resolved to `#N Title`.
*
* Only open ones: a delivered or archived blocker is satisfied in practice, and
* an answer that keeps naming it long after it landed teaches the model to skip
* the field. This is the launch context — reported, never enforced.
*
* @param ideas - the whole snapshot (a blocker may sit outside any filter).
* @param ideaId - the idea being launched.
* @returns the blockers, in the board's own order.
*/
function openBlockersIn(ideas, ideaId) {
	const byId = new Map(ideas.map((idea) => [idea.id, idea]));
	return ideaBlockedBy(ideas, ideaId).map((id) => byId.get(id)).filter((idea) => idea !== void 0 && idea.status === "open").map(ideaRefOf);
}
/** The recorded activity of an idea, oldest first, as one timeline. */
function activityOf(idea) {
	return (idea.events ?? []).map((entry) => ({
		at: entry.at,
		verb: entry.verb,
		actor: entry.actor,
		summary: entry.summary
	}));
}
/**
* Field list of the bounded list projection the tools read through.
*
* `relatesTo` and `blocks` are SELECTED rather than fetched: they are lists of
* ids, not bodies, so a page of 200 rows pays a few hundred bytes for the whole
* relation graph — the difference between an agent that can answer "what does
* this workspace wait on?" and one that has to fetch every card to find out.
*/
const LIST_FIELDS = [
	"summary",
	"rank",
	"value",
	"effort",
	"rationale",
	"tags",
	"workspaceId",
	"taskBoardId",
	"taskBoardStatus",
	"runStatus",
	"deliveryNote",
	"followUpOfId",
	"deliveredAt",
	"decision",
	"relatesTo",
	"blocks"
];
/** Split a comma-separated status list, keeping only the closed union members. */
function readStatuses(args) {
	const raw = readString(args, "status");
	if (raw === void 0) return [];
	return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}
function buildListTool(host) {
	return {
		name: "ideas_list",
		description: [
			"Read the Ideas board: one bounded, filtered page of idea rows.",
			"Returns metadata only — title, column, tags, priority opinion, run state, lineage, relations — never the descriptions; call ideas_get for one idea in full.",
			"Relations ride on every row: relatesTo and blocks are the stored lists, and blockedBy is DERIVED from the other cards' blocks, so \"what is this card waiting on?\" and \"what waits on it?\" are both answered here.",
			"The workspaceId, status (a comma-separated subset of open/underReview/archived/declined), tag and query filters are conjunctive.",
			"Follow meta.nextOffset while it is set to walk the whole match.",
			"Triggers: 想法, ideas, backlog, idees, 想法板, 看板, list ideas, what ideas do we have."
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				workspaceId: {
					type: "string",
					description: "Restrict to one workspace (omit for every workspace, including the generic one)."
				},
				status: {
					type: "string",
					description: "Comma-separated columns: open, underReview, archived, declined."
				},
				tag: {
					type: "string",
					description: "Keep only ideas carrying this tag name."
				},
				query: {
					type: "string",
					description: "Case-insensitive substring over title, summary and description excerpt."
				},
				limit: {
					type: "integer",
					description: `Rows in this page (default 100, maximum 200).`
				},
				offset: {
					type: "integer",
					description: "Zero-based offset into the matched set."
				}
			},
			required: []
		},
		output: {
			schema: {},
			render: renderJson
		},
		async execute(args) {
			const raw = typeof args === "object" && args !== null ? args : {};
			const snapshot = host.snapshot();
			const workspaceId = readString(raw, "workspaceId");
			const query = readString(raw, "query")?.toLowerCase();
			const tag = readString(raw, "tag")?.toLowerCase();
			const statuses = readStatuses(raw);
			const matched = snapshot.ideas.filter((idea) => {
				if (workspaceId !== void 0 && idea.workspaceId !== workspaceId) return false;
				if (statuses.length > 0 && !statuses.includes(idea.status)) return false;
				if (tag !== void 0 && !(idea.tags ?? []).some((entry) => entry.name.toLowerCase() === tag)) return false;
				if (query !== void 0) {
					if (!`${idea.title}\n${idea.summary ?? ""}\n${idea.body}`.toLowerCase().includes(query)) return false;
				}
				return true;
			});
			const limit = Math.min(Math.max(1, readNumber(raw, "limit") ?? 100), 200);
			const offset = Math.max(0, readNumber(raw, "offset") ?? 0);
			const page = buildIdeasReadSnapshot({
				...snapshot,
				ideas: matched
			}, {
				fields: LIST_FIELDS,
				limit,
				offset
			});
			const blockers = blockedByIndexOf(snapshot.ideas);
			return json({
				ok: true,
				revision: page.revision,
				matched: page.meta.matched,
				returned: page.ideas.length,
				nextOffset: page.meta.nextOffset,
				ideas: page.ideas.map((row) => ({
					...row,
					blockedBy: blockers.get(row.id) ?? []
				}))
			});
		}
	};
}
function buildGetTool(host) {
	return {
		name: "ideas_get",
		description: [
			"Read ONE idea in full: its complete description, its priority opinion, its relations, and its activity log (who did what, when — bounded to the last 50 entries).",
			"Relations come as the three lines a human reads on the card: related to, waits for (blocks), and is waited for (blockedBy, derived from the other cards).",
			"Also returns the compact rows of the follow-up ideas raised from this one.",
			"Triggers: 读取想法, 打开想法, idea detail, read idea, what happened to this idea."
		].join(" "),
		parameters: {
			type: "object",
			properties: { ideaId: {
				type: "string",
				description: "Idea id, as reported by ideas_list or ideas_capture."
			} },
			required: ["ideaId"]
		},
		output: {
			schema: {},
			render: renderJson
		},
		async execute(args) {
			const ideaId = readString(typeof args === "object" && args !== null ? args : {}, "ideaId");
			if (ideaId === void 0) return refused("invalid-arguments", "ideaId is required");
			const idea = host.idea(ideaId);
			if (idea === void 0) return refused("idea-not-found", `no idea with id ${ideaId}`);
			const ideas = host.snapshot().ideas;
			const followUps = ideas.filter((entry) => entry.followUpOfId === ideaId).map((entry) => ideaSummary(entry, ideas));
			return json({
				ok: true,
				idea: {
					...idea,
					blockedBy: ideaBlockedBy(ideas, ideaId),
					activity: activityOf(idea)
				},
				relations: relationViewsOf(ideas, idea),
				followUps
			});
		}
	};
}
function buildCaptureTool(host) {
	return {
		name: "ideas_capture",
		description: [
			"Capture an idea into the ledger: a title (required) plus the analysis as markdown in the body.",
			"Record a priority opinion at the same time: value, effort, rationale and a suggested rank. The rank is the position in the OPEN BACKLOG OF THAT WORKSPACE; passing one re-ranks that backlog, it never appends blindly.",
			"Duplicates are your call: list the workspace first and capture into an existing idea with a triage instead of creating a second card.",
			"Triggers: 捕获想法, 记录想法, 记下来, capture idea, new idea, backlog idea, 想法板."
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "One clear sentence naming the idea."
				},
				body: {
					type: "string",
					description: "The analysis as markdown (context, value, effort, first steps, risks)."
				},
				summary: {
					type: "string",
					description: "Compact abstract the card and the list show instead of the body."
				},
				workspaceId: {
					type: "string",
					description: "Workspace this idea belongs to (omit for the generic backlog)."
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Tag NAMES (max 8, 32 chars each). No prompt lines."
				},
				value: {
					type: "number",
					description: "Value score (1..3 by house convention)."
				},
				effort: {
					type: "number",
					description: "Effort score (1..3 by house convention)."
				},
				rationale: {
					type: "string",
					description: "Why this ranking, in one or two sentences."
				},
				rank: {
					type: "integer",
					description: "1-based position inside this workspace open backlog (appends when omitted)."
				}
			},
			required: ["title"]
		},
		output: {
			schema: {},
			render: renderJson
		},
		async execute(args) {
			const raw = typeof args === "object" && args !== null ? args : {};
			const title = readString(raw, "title");
			if (title === void 0) return refused("invalid-arguments", "title is required");
			const id = newRequestId();
			const workspaceId = readString(raw, "workspaceId");
			const rank = readNumber(raw, "rank");
			const value = readNumber(raw, "value");
			const effort = readNumber(raw, "effort");
			const rationale = readString(raw, "rationale");
			const summary = readString(raw, "summary");
			const tagNames = readTagNames(raw);
			const answer = submitAction(host, {
				kind: "create",
				id,
				input: {
					title,
					body: typeof raw.body === "string" ? raw.body : "",
					...summary === void 0 ? {} : { summary },
					...workspaceId === void 0 ? {} : { workspaceId },
					...rank === void 0 ? {} : { rank },
					...value === void 0 ? {} : { value },
					...effort === void 0 ? {} : { effort },
					...rationale === void 0 ? {} : { rationale },
					...tagNames === void 0 ? {} : { tags: tagNames.map((name) => ({ name })) }
				}
			});
			if (typeof answer === "object" && answer !== null && answer.ok !== true) return answer;
			const idea = host.idea(id);
			if (idea === void 0) return refused("not-found", "the idea was accepted but could not be read back");
			const ideas = host.snapshot().ideas;
			const groupSize = ideas.filter((entry) => entry.status === "open" && entry.workspaceId === idea.workspaceId).length;
			return json({
				ok: true,
				idea: ideaSummary(idea, ideas),
				workspaceOpenBacklog: groupSize,
				nextStep: "Re-rank the workspace open backlog on any material change (ideas_triage on the ideas whose position actually moved); ranks stay advisory."
			});
		}
	};
}
function buildTriageTool(host) {
	return {
		name: "ideas_triage",
		description: [
			"Record a priority opinion on an OPEN idea: value, effort, rationale and/or a suggested rank, applied in one transaction.",
			"The rank is a position inside the open backlog of that idea workspace (1 = highest). Passing a rank re-ranks the whole group; omitting it keeps the current position and only records the opinion.",
			"Returns the resulting group ordering so the model sees the effect instead of guessing it.",
			"Triggers: 优先级, 排序, triage, re-rank, priority opinion, 想法排名."
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				ideaId: {
					type: "string",
					description: "Idea id to triage."
				},
				value: {
					type: "number",
					description: "Value score (1..3 by house convention)."
				},
				effort: {
					type: "number",
					description: "Effort score (1..3 by house convention)."
				},
				rationale: {
					type: "string",
					description: "Why this ranking, in one or two sentences. An empty string clears it."
				},
				rank: {
					type: "integer",
					description: "1-based position inside this workspace open backlog."
				}
			},
			required: ["ideaId"]
		},
		output: {
			schema: {},
			render: renderJson
		},
		async execute(args) {
			const raw = typeof args === "object" && args !== null ? args : {};
			const ideaId = readString(raw, "ideaId");
			if (ideaId === void 0) return refused("invalid-arguments", "ideaId is required");
			if (host.idea(ideaId) === void 0) return refused("idea-not-found", `no idea with id ${ideaId}`);
			const patch = {};
			const value = readNumber(raw, "value");
			const effort = readNumber(raw, "effort");
			const rank = readNumber(raw, "rank");
			if (value !== void 0) patch.value = value;
			if (effort !== void 0) patch.effort = effort;
			if (raw.rationale !== void 0) patch.rationale = typeof raw.rationale === "string" ? raw.rationale : "";
			if (rank !== void 0) patch.rank = rank;
			if (Object.keys(patch).length === 0) return refused("nothing-to-record", "pass value, effort, rationale and/or rank");
			const answer = submitAction(host, {
				kind: "triage",
				ideaId,
				patch
			});
			if (typeof answer === "object" && answer !== null && answer.ok !== true) return answer;
			const after = host.idea(ideaId);
			if (after === void 0) return refused("not-found", "the triage was accepted but the idea could not be read back");
			const ideas = host.snapshot().ideas;
			const ordering = ideas.filter((entry) => entry.status === "open" && entry.workspaceId === after.workspaceId).sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)).slice(0, 200).map((entry, index) => ({
				rank: entry.rank ?? index + 1,
				id: entry.id,
				title: entry.title
			}));
			return json({
				ok: true,
				idea: ideaSummary(after, ideas),
				groupOrdering: ordering,
				rankConflicts: rankConflictsIn(ideas, ideaId)
			});
		}
	};
}
/**
* Read a list of relation TARGET ids: strings only, trimmed, de-duplicated. A
* non-string entry is dropped rather than refused, exactly like a tag name, so a
* model that mixes numbers into the list still gets the edges it spelled right.
*
* @param args - the raw tool arguments.
* @param key - the argument name to read.
* @returns the target ids, in the order they were given.
*/
function readRelationIds(args, key) {
	const value = args[key];
	if (!Array.isArray(value)) return [];
	const ids = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const id = entry.trim();
		if (id !== "" && !ids.includes(id)) ids.push(id);
	}
	return ids;
}
/**
* Whether a relation list would change. Order is NOT a change, for the reason
* `relationListChanged` gives on the client side: the ledger appends and
* re-points edges, so the same set in another order is the same statement, and
* treating it as a change would spend a revision and a log line on nothing.
*
* @param before - the stored list (absent = no edge of this kind).
* @param next - the list the tool computed.
* @returns true when the two hold the same ids.
*/
function sameRelationSet(before, next) {
	const left = [...before ?? []].sort();
	const right = [...next].sort();
	return left.length === right.length && left.every((id, index) => id === right[index]);
}
function buildRelateTool(host) {
	return {
		name: "ideas_relate",
		description: [
			"Declare or remove the relations between ideas — the two kinds the board has, and the only two.",
			"relatesTo: \"adjacent, read the other one too\" (stored symmetrically, so both cards record it). blocks: THIS card cannot land before that one — the direction is the whole point, so to say \"this card waits for X\", call this on X with addBlocks: [this card].",
			"There is no blockedBy argument: it is the derived inverse of the other cards' blocks, it rides on every read, and the wire gate refuses it in a patch.",
			"The lists are edited as ADDS and REMOVES, never as replacements: an edge you do not name survives the call, and a call that changes nothing writes nothing.",
			"State a relation you can justify from the two cards' own text; a wrong edge misleads every later reader, and an empty relation graph is a normal state.",
			"Answers with the card's three relation lines, every target resolved to its number and title.",
			"Triggers: relates to, related ideas, blocked by, blocks, blocking, depends on, link ideas, relation, 关联, 相关, 阻塞, 被阻塞, 依赖, 关联想法."
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				ideaId: {
					type: "string",
					description: "The card the relation is declared ON. Every other id is the TARGET."
				},
				addRelatesTo: {
					type: "array",
					items: { type: "string" },
					description: `Target idea ids to declare this one adjacent to (writes "relatesTo"; max 20 edges).`
				},
				removeRelatesTo: {
					type: "array",
					items: { type: "string" },
					description: "Target idea ids to undeclare from \"relatesTo\"."
				},
				addBlocks: {
					type: "array",
					items: { type: "string" },
					description: `Target idea ids this card CANNOT LAND BEFORE (writes "blocks" on THIS card; max 20 edges).`
				},
				removeBlocks: {
					type: "array",
					items: { type: "string" },
					description: "Target idea ids this card stops waiting for."
				}
			},
			required: ["ideaId"]
		},
		output: {
			schema: {},
			render: renderJson
		},
		async execute(args) {
			const raw = typeof args === "object" && args !== null ? args : {};
			const ideaId = readString(raw, "ideaId");
			if (ideaId === void 0) return refused("invalid-arguments", "ideaId is required");
			const before = host.idea(ideaId);
			if (before === void 0) return refused("idea-not-found", `no idea with id ${ideaId}`);
			const edits = {
				relatesTo: {
					add: readRelationIds(raw, "addRelatesTo"),
					remove: readRelationIds(raw, "removeRelatesTo")
				},
				blocks: {
					add: readRelationIds(raw, "addBlocks"),
					remove: readRelationIds(raw, "removeBlocks")
				}
			};
			const touched = ["relatesTo", "blocks"].filter((key) => edits[key].add.length > 0 || edits[key].remove.length > 0);
			if (touched.length === 0) return refused("nothing-to-record", "pass addRelatesTo / removeRelatesTo and/or addBlocks / removeBlocks");
			const patch = {};
			for (const key of touched) {
				const { add, remove } = edits[key];
				const kept = [.../* @__PURE__ */ new Set([...(before[key] ?? []).filter((id) => !remove.includes(id)), ...add])];
				if (kept.length > 20) return refused("relation-limit", `a relation list holds at most 20 ids, this edit would make ${kept.length}`);
				if (sameRelationSet(before[key], kept)) continue;
				patch[key] = normalizeRelationIds(kept) ?? [];
			}
			if (Object.keys(patch).length === 0) {
				const ideas = host.snapshot().ideas;
				return json({
					ok: true,
					changed: false,
					idea: ideaSummary(before, ideas),
					relations: relationViewsOf(ideas, before),
					message: "the named relation is already the stored one; nothing was written"
				});
			}
			const answer = submitAction(host, {
				kind: "update",
				ideaId,
				patch
			});
			if (!isOk(answer)) return answer;
			const ideas = host.snapshot().ideas;
			const after = host.idea(ideaId) ?? before;
			return json({
				ok: true,
				changed: true,
				idea: ideaSummary(after, ideas),
				relations: relationViewsOf(ideas, after),
				rankConflicts: rankConflictsIn(ideas, ideaId)
			});
		}
	};
}
function buildLaunchTool(host) {
	return {
		name: "ideas_launch",
		description: [
			"Start an execution of an idea: the Host resolves the backend — the mirrored TaskBoard card when the task-board plugin is present, otherwise a fresh session — and the run keeps going after this call returns.",
			"A finished run moves the idea to the review gate automatically; nothing polls from the tool side.",
			"A declared dependency is REPORTED, never enforced: the answer names the open ideas this one waits for, and marks the ones the ranking schedules below it. A run is never refused for that — tell the human instead.",
			"A domain refusal (disabled mirror, board absent, unknown model) comes back as ok:false with its own reason.",
			"Triggers: 启动执行, 运行想法, launch idea, run this idea, 实现这个想法."
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				ideaId: {
					type: "string",
					description: "Idea id to run."
				},
				model: {
					type: "string",
					description: "Model target as \"provider/model\" for THIS run. Omit it and the run takes the workspace's default launch model, then the session default — the same order the board itself uses."
				}
			},
			required: ["ideaId"]
		},
		output: {
			schema: {},
			render: renderJson
		},
		async execute(args) {
			const raw = typeof args === "object" && args !== null ? args : {};
			const ideaId = readString(raw, "ideaId");
			if (ideaId === void 0) return refused("invalid-arguments", "ideaId is required");
			const body = parseLaunchBody({
				ideaId,
				model: readString(raw, "model"),
				requestId: newRequestId()
			});
			if (body === void 0) return refused("invalid-arguments", "ideaId is required and model must be a string");
			try {
				return json({
					ok: true,
					...await host.launchIdea(body.ideaId, body.model, body.requestId),
					blockedBy: openBlockersIn(host.snapshot().ideas, body.ideaId),
					rankConflicts: rankConflictsIn(host.snapshot().ideas, body.ideaId)
				});
			} catch (error) {
				return refused("refused", messageOf(error));
			}
		}
	};
}
/** The three review-gate verdicts, in the vocabulary the board itself uses. */
const REVIEW_VERDICTS = [
	"approve",
	"followUp",
	"decline"
];
function buildReviewTool(host) {
	return {
		name: "ideas_review",
		description: [
			"Decide the review gate of an idea that finished its work.",
			"approve delivers it (archived and stamped). followUp archives it and creates a linked OPEN child whose body carries the parent summary plus your justification. decline refuses it outright and records the decision.",
			"Record the commits, the verification and anything the next reader needs in the child body or the decision text — the board stores them verbatim.",
			"Triggers: 验收, 通过, 拒绝, 需要跟进, review, approve, follow-up, decline, 想法验收."
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				ideaId: {
					type: "string",
					description: "The under-review idea id."
				},
				verdict: {
					type: "string",
					enum: [...REVIEW_VERDICTS],
					description: "approve, followUp or decline."
				},
				decision: {
					type: "string",
					description: "Decision note (decline reads it as the reason)."
				},
				childTitle: {
					type: "string",
					description: "Title of the follow-up idea (followUp only)."
				},
				childBody: {
					type: "string",
					description: "Body of the follow-up idea (followUp only): parent summary + justification."
				}
			},
			required: ["ideaId", "verdict"]
		},
		output: {
			schema: {},
			render: renderJson
		},
		async execute(args) {
			const raw = typeof args === "object" && args !== null ? args : {};
			const ideaId = readString(raw, "ideaId");
			if (ideaId === void 0) return refused("invalid-arguments", "ideaId is required");
			const verdict = readString(raw, "verdict");
			if (verdict === void 0 || !REVIEW_VERDICTS.includes(verdict)) return refused("invalid-arguments", `verdict must be one of ${REVIEW_VERDICTS.join(", ")}`);
			const before = host.idea(ideaId);
			if (before === void 0) return refused("idea-not-found", `no idea with id ${ideaId}`);
			const decision = readString(raw, "decision");
			const committed = (fallback) => {
				const all = host.snapshot().ideas;
				return {
					idea: ideaSummary(all.find((entry) => entry.id === ideaId) ?? fallback, all),
					all
				};
			};
			if (verdict === "approve") {
				const answer = submitAction(host, {
					kind: "deliver",
					ideaId
				});
				if (!isOk(answer)) return answer;
				return json({
					ok: true,
					verdict,
					idea: committed(before).idea
				});
			}
			if (verdict === "decline") {
				const answer = submitAction(host, {
					kind: "decline",
					ideaId,
					...decision === void 0 ? {} : { decision }
				});
				if (!isOk(answer)) return answer;
				return json({
					ok: true,
					verdict,
					idea: committed(before).idea
				});
			}
			const childTitle = readString(raw, "childTitle");
			if (childTitle === void 0) return refused("invalid-arguments", "a follow-up needs a childTitle");
			const answer = submitAction(host, {
				kind: "followUp",
				ideaId,
				input: {
					title: childTitle,
					body: typeof raw.childBody === "string" ? raw.childBody : ""
				}
			});
			if (!isOk(answer)) return answer;
			const after = committed(before);
			const child = after.all.find((entry) => entry.followUpOfId === ideaId);
			return json({
				ok: true,
				verdict,
				idea: after.idea,
				...child === void 0 ? {} : { followUp: ideaSummary(child, after.all) }
			});
		}
	};
}
/** Whether a submission answered `{ok:true}`. */
function isOk(answer) {
	return typeof answer === "object" && answer !== null && !Array.isArray(answer) && answer.ok === true;
}
/**
* Build the seven ideas tools for one Host service.
* @param host - the Host service face (satisfied by `IdeasHostService`).
* @returns the tool definitions, in {@link IDEAS_TOOL_NAMES} order.
*/
function buildIdeasTools(host) {
	return [
		buildListTool(host),
		buildGetTool(host),
		buildCaptureTool(host),
		buildTriageTool(host),
		buildRelateTool(host),
		buildLaunchTool(host),
		buildReviewTool(host)
	];
}
/**
* Resolve the optional agent-tool registry. The board deliberately does not
* INJECT it: a deployment whose runtime serves no tools service must still
* mount the whole board and lose only the agent-tool surface — the same
* tolerance the optional session gateway gets.
* @param ctx - the plugin context.
* @returns the registry, or undefined when this deployment serves none.
*/
function resolveToolRegistry(ctx) {
	try {
		const tools = ctx.get("tools");
		return tools !== void 0 && typeof tools.register === "function" ? tools : void 0;
	} catch {
		return;
	}
}
/**
* Register the six `ideas_*` tools, and only when the board is enabled.
*
* Registration is idempotent per registry and disposed with the fiber that owns
* it: a `tools` service that activates (or is replaced) after this row is
* followed through scoped injection where the runtime serves one, and a
* capture-only context registers through the direct resolution. A missing
* registry is a downgrade to "no agent tools", never a boot failure — the board
* and its routes keep working exactly as before.
*
* @param ctx - the plugin context.
* @param host - the Host service face the tools drive.
* @param isEnabled - live master switch; a disabled board answers no tool call.
*/
function installIdeasAgentTools(ctx, host, isEnabled) {
	let disposeTools;
	const setToolsEnabled = (active) => {
		if (!active) {
			disposeTools?.();
			disposeTools = void 0;
			return;
		}
		if (disposeTools !== void 0) return;
		const registry = resolveToolRegistry(ctx);
		if (registry === void 0) return;
		let tools;
		try {
			tools = buildIdeasTools(host);
		} catch (error) {
			console.error(`[dsh-plugin-ideas-manager] agent tools could not be built: ${messageOf(error)}`);
			return;
		}
		const disposers = [];
		for (const tool of tools) try {
			disposers.push(registry.register(tool));
		} catch (error) {
			console.error(`[dsh-plugin-ideas-manager] agent tool ${tool.name} could not be registered: ${messageOf(error)}`);
		}
		disposeTools = () => {
			for (const dispose of disposers.splice(0)) dispose();
		};
	};
	setToolsEnabled(isEnabled());
	const scopedInject = ctx.inject;
	if (typeof scopedInject === "function") scopedInject.call(ctx, ["tools"], () => {
		setToolsEnabled(isEnabled());
		return () => {
			disposeTools?.();
			disposeTools = void 0;
		};
	});
	else if (typeof ctx.inject === "function") ctx.inject(["tools"], () => {
		setToolsEnabled(isEnabled());
		return () => {
			disposeTools?.();
			disposeTools = void 0;
		};
	});
}
//#endregion
//#region src/command-dispatch.ts
/**
* Build the dispatcher from whatever faces the shell served, or `undefined` when
* it served none it can use. `undefined` is a legitimate answer — the caller then
* leaves direct sessions at the Host's own default permission — but the caller
* is expected to SAY so, because a launch that silently runs fenced is worse
* than one that refuses.
*/
function createCommandDispatcher(agents, commands) {
	const agentFace = agents;
	const commandFace = commands;
	const agentGet = agentFace?.get;
	const commandExecute = commandFace?.execute;
	if (typeof agentGet !== "function" || typeof commandExecute !== "function") return void 0;
	const signal = new AbortController().signal;
	return async (sessionId, line) => {
		const agent = agentGet.call(agentFace, sessionId);
		if (agent === void 0) throw new Error("execution session is not available");
		return (await commandExecute.call(commandFace, agent, line, [], signal))?.result;
	};
}
//#endregion
//#region src/session-runner.ts
/** Raised when the Host answers but the session could not be started. */
var SessionLaunchError = class extends Error {
	sessionId;
	constructor(message, sessionId) {
		super(message);
		this.sessionId = sessionId;
		this.name = "SessionLaunchError";
	}
};
/**
* Wire-shape quirk of the DSH RPC surface: `session/list` declares its
* argument under `_request` while every other method used here declares it
* under `request`. Getting this wrong fails at runtime with an opaque
* "invalid request", so it lives in one place.
*/
function invokeWireArgs(namespace, method, request) {
	if (namespace === "session" && method === "list") return { _request: request };
	return { request };
}
/** The readable part of a gateway failure, so the modal can show what refused. */
function sessionErrorOf(error) {
	if (typeof error === "object" && error !== null) {
		const record = error;
		if (typeof record.message === "string" && record.message.trim() !== "") return record.message.trim();
		if (typeof record.code === "string" && record.code.trim() !== "") return record.code.trim();
	}
	if (typeof error === "string" && error.trim() !== "") return error.trim();
	return "session request failed";
}
var SessionRunner = class {
	gateway;
	dispatch;
	constructor(gateway, dispatch) {
		this.gateway = gateway;
		this.dispatch = dispatch;
	}
	invoke(namespace, method, request) {
		return this.gateway.invoke({
			namespace,
			method,
			args: invokeWireArgs(namespace, method, request)
		});
	}
	/**
	* Start the idea's execution in a FRESH session of its workspace: create,
	* name it after the idea, pin the chosen model, queue the run prompt.
	* Returns the session id the run executes in.
	*
	* @throws {SessionLaunchError} when the Host refuses any step. The message
	*   is the Host's own, so the modal shows what actually refused.
	*/
	async launchIdea(idea, model, permission) {
		const workspaceId = idea.workspaceId;
		if (workspaceId === void 0 || workspaceId === "") throw new SessionLaunchError("idea has no workspace to run in", void 0);
		let sessionId;
		try {
			const resolved = (await this.invoke("session", "create", { workspaceId }))?.sessionId;
			if (typeof resolved !== "string" || resolved === "") throw new Error("the host returned no session id");
			sessionId = resolved;
		} catch (error) {
			throw new SessionLaunchError(`session create failed: ${sessionErrorOf(error)}`, void 0);
		}
		try {
			await this.invoke("session", "rename", {
				sessionId,
				title: idea.title
			});
			const level = permission?.trim();
			if (level !== void 0 && level !== "" && this.dispatch !== void 0) try {
				await this.dispatch(sessionId, `/permission ${level}`);
			} catch (error) {
				throw new SessionLaunchError(`session permission failed: ${sessionErrorOf(error)}`, sessionId);
			}
			const target = model?.trim();
			if (target !== void 0 && target !== "") {
				const slash = target.indexOf("/");
				const provider = slash >= 0 ? target.slice(0, slash).trim() : void 0;
				const modelId = slash >= 0 ? target.slice(slash + 1).trim() : target;
				await this.invoke("session", "selectModel", {
					sessionId,
					...provider === void 0 || provider === "" ? {} : { provider },
					model: modelId
				});
			}
			await this.invoke("session", "prompt", {
				sessionId,
				requestId: `ideas-${crypto.randomUUID()}`,
				mode: "queue",
				content: [{
					type: "text",
					text: runPromptOf(idea)
				}]
			});
		} catch (error) {
			if (error instanceof SessionLaunchError) throw error;
			throw new SessionLaunchError(`session run failed: ${sessionErrorOf(error)}`, sessionId);
		}
		return sessionId;
	}
	/**
	* The session roster as `sessionId -> running`. One RPC per settle tick,
	* shared by every tracked run, exactly like the card backend reads the card
	* statuses in one call. Throws when the roster is unknown (a booting or
	* unavailable runtime): the caller then keeps the runs `running` rather than
	* inventing a settle.
	*/
	async listRunning() {
		const items = (await this.invoke("session", "list", {}))?.items;
		if (!Array.isArray(items)) return /* @__PURE__ */ new Map();
		const roster = /* @__PURE__ */ new Map();
		for (const item of items) {
			if (typeof item?.sessionId !== "string" || item.sessionId === "") continue;
			roster.set(item.sessionId, item.running === true);
		}
		return roster;
	}
	/**
	* The delivery note of a finished run: the text of the session's
	* LAST assistant message, read back through the same `session` RPC surface
	* this backend already speaks.
	*
	* Two calls, because the history page is cursor-addressed and the cursor is
	* the projection watermark:
	*  1. `session/projections` — a non-activating read whose `asOfSeq` is the
	*     session's last committed event sequence;
	*  2. `session/page` at that sequence, one bounded window of the tail.
	*
	* Deliberately two steps and not a follow stream: a harvest must not hold a
	* live subscription open on the settle path of a run that already finished.
	*
	* Returns undefined — never a guess — when the session is gone, has no
	* assistant turn, or answers a shape this reader does not recognise. Throws
	* only on a transport refusal, which the caller catches: a harvest failure
	* must never fail the settle.
	*
	* @param sessionId - the session the run executed in.
	*/
	async readDeliveryNote(sessionId) {
		if (sessionId.trim() === "") return void 0;
		const asOfSeq = (await this.invoke("session", "projections", { sessionId }))?.asOfSeq;
		if (typeof asOfSeq !== "number" || !Number.isSafeInteger(asOfSeq) || asOfSeq < 0) return void 0;
		const page = await this.invoke("session", "page", {
			address: {
				kind: "session",
				sessionId
			},
			throughSeq: asOfSeq,
			maxMessages: 24
		});
		return deliveryNoteOfRecords(Array.isArray(page?.records) ? page.records : void 0);
	}
};
//#endregion
//#region src/skills/ideas-analyst.ts
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
* literal, so backticks are structurally impossible here — the code
* examples below use 4-space indentation instead of ``` fences. Keep it that
* way; a stray backtick breaks the build (TS1005).
*/
/** Skill name (also the install directory name, kebab-case per the DSH skill grammar). */
const IDEAS_ANALYST_SKILL_NAME = "ideas-analyst";
/** Install-directory relative name of the skill file (the discoverer looks for SKILL.md). */
const IDEAS_ANALYST_SKILL_FILE = "SKILL.md";
/** Full SKILL.md content installed by the Host. */
const IDEAS_ANALYST_SKILL_CONTENT = `---
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
   The five headings above are mandatory and keep that order. ONE more heading
   is allowed - the optional "Deferred ideas" section of the one-run-one-card
   rule below - and only when the analysis surfaced independent ideas.
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

   A tag may also carry "promptPrefix", the line shown to the human before each
   launch; the summary projection returns it per tag. The patch replaces the
   WHOLE tag list, so a tag you keep must be sent back with the promptPrefix it
   already had - dropping it here silently erases an instruction the human wrote.
   Never invent one, and never rewrite one: copy it verbatim, and send
   { "name": "..." } only for a tag that has none.

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

## Bounded context loading (ideas #64 and #65)

The board can contain long analyses. Context loading is summary-first and the
analyst MUST follow this order:

1. GET <origin>/api/ideas/state?view=summary with the narrowest selectors. For
   a capture, add workspaceId=<capture-workspace>, status=open, and
   status=archived. For re-analysis, add id=<target-id>. The summary projection
   contains the stable id and idea number, title, status, workspace, tags,
   summary, TaskBoard link, and direct follow-up lineage, but no body.
2. Inspect the response revision and meta. If meta.rowTruncated is true, follow
   meta.nextOffset with the same filters until that page is complete. Respect
   meta.omittedFields and never infer that an omitted optional field is empty.
   Resolve the target by exact id when supplied, otherwise by workspace plus
   draft intent. Dedupe using summary metadata for open AND archived ideas in
   that workspace only. Never compare against another workspace or the generic
   group.
3. Fetch the complete body with GET <origin>/api/ideas/idea?id=<target-id>.
   This target body is mandatory: fully analyze it before writing anything.
4. From the summary rows, select only direct follow-ups where followUpOfId
   points to the target (and the target's own parent when followUpOfId is
   present). Fetch each selected full body with the same single-idea endpoint.
   Do not load the full /state snapshot and do not fetch unrelated bodies.
5. A caller that only needs a bounded body preview may use
   GET <origin>/api/ideas/state?view=detail&id=<target-id>&fields=body&bodyLimit=4096.
   Its max body slice is 4096 UTF-8 bytes and meta.bodyTruncated reports
   shortening. This preview NEVER replaces the mandatory complete single-idea
   read above.
6. Follow only file/doc paths explicitly cited by the target or selected
   follow-ups. Read selectively, record the path, and stop when the evidence
   needed for the decision is established. Do not crawl the workspace.

Escalate explicitly and auditably when the target cannot be resolved, a fetched
body conflicts with the list metadata, the body is missing, or required evidence
needs broad/unbounded loading. In the final report, state ESCALATED, the exact
check that failed, the identifiers/paths inspected, what remains unresolved, and
the smallest safe next action. Do not guess or write a partial analysis.

## Sub-agent fan-out (bounded, still one card)

A broad subject is normally an either/or: one shallow card, or N sibling
cards. Take the depth instead. If your tool catalog offers a delegation tool
(the Host ships one, named subagent by default, and a deployment may rename
or restrict it), you may split the ANALYSIS of that single card across at most
3 sub-agents, start them together in one message, and reassemble what comes
back into the SAME body. Fan-out buys depth; it never buys another card.

Delegate ONLY when one of these two thresholds is met:

1. The draft cites at least 2 DISTINCT subsystems of this project, and the
   bounded discipline above cannot read both in the same pass.
2. Checking one reference taken from the draft requires reading files outside
   the paths the draft already cites. This is a deliberate, narrow exception
   to the cited-paths-only rule of the bounded section: the delegated scope
   stays CLOSED, as the brief below requires, so it is never the unbounded
   loading that section asks you to escalate.

Never delegate on a vague trigger such as "this is a big subject", "this
looks complex" or "sub-agents would help": a fuzzy trigger is exactly how an
uncontrolled fan-out starts.

Each sub-agent receives a written brief and nothing else:

- exactly ONE question, answerable by reading files - never a question about
  opinion, priority, feasibility or wording;
- a closed file scope (an explicit path list, or one path prefix), so it
  cannot crawl the workspace;
- a return of 2-3 KiB at most, containing the answer, the paths it actually
  inspected as evidence, and the questions it could not settle;
- a stop rule: on a contradiction it cannot resolve, it reports it instead
  of picking a side.

Then you, the principal analyst, alone:

- Never paste a sub-agent return verbatim. Synthesize it into the section it
  concerns, and note the inspected path next to the claim it supports - a
  claim without a path is a claim nobody verified.
- Treat the returns as working material, not as body text. The body budget
  stays ~32 KiB; three 3 KiB returns do not become three quoted appendices.
- You are the only writer on the channel. A sub-agent NEVER emits create,
  update or triage, and never opens the write channel itself: distributed
  writing is precisely what would break the one-run-one-card guarantee below.
- A sub-agent NEVER launches an analyst, a re-analysis, or another
  sub-agent. The existing no-recursion rule holds all the way down.
- If a sub-agent fails, returns nothing usable, or contradicts what you read
  yourself, continue solo and report the disagreement. Do not average it and
  do not retry the same brief more than once.

Degraded mode is the expected mode, not a failure. When the tool catalog
exposes no delegation tool - the Host registers one only while its provider
is loaded, and a tool restriction can remove it - run solo and say so in one
clause of the final report (for example: no delegation tool, analysis run
solo). Never invent, stub or simulate a sub-agent to satisfy this section.

## The write channel

The launch prompt tells you the exact server origin. The full, backward-
compatible GET <origin>/api/ideas/state contract remains available for backups
and tooling, but the analyst MUST use view=summary, its explicit truncation
metadata, and single-idea reads as described above.

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

RELATIONS (only when an explicit relation is established, see the section below):
  { "kind": "update", "ideaId": "<id>", "patch": {
      "relatesTo": [ "<other stable id>" ], "blocks": [ "<blocked id>" ] } }
  Both lists REPLACE what is stored, so send the COMPLETE list: what the card
  already had, plus the new entry. An omitted key changes nothing; an empty
  array clears the list. NEVER send "blockedBy" - it is derived on read from the
  other cards' "blocks" and is refused by the wire gate.

TRIAGE:
  { "kind": "triage", "ideaId": "<id>", "patch": {
      "value": <1|2|3>, "effort": <1|2|3>, "rank": <position>, "rationale": "<one or two sentences>" } }
  Omit rank when the idea is not open.

Procedure:

1. Load filtered summary metadata, follow nextOffset when the bounded page is
   truncated, resolve/dedupe, then fetch the target and only direct follow-up
   bodies. Fully analyze the resolved target before any write.
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
- "runStatus" and "runSessionId" are HOST-WRITTEN system fields: they describe a
  launched execution and the wire gate rejects them in a patch or an
  import. Never send them, and never set them to make a card look launched.
- "blockedBy" is DERIVED from the other cards' "blocks" and is refused in a
  patch: write "blocks" with the direction you mean, or write nothing.

## Relations: relatesTo and blocks

A card can name the ideas it is connected to. Two relations exist and they are
not symmetric:

- "relatesTo": same subsystem, same constraint, same conversation - the other
  card stays independently valuable.
- "blocks": THIS card blocks the OTHER one. The direction is the whole point:
  a card that depends on this one blocks nothing, it is blocked BY it. The board
  derives "blockedBy" from the other cards' "blocks", so you write "blocks" and
  NEVER "blockedBy" - the wire gate refuses it.

Rules, in order of importance:

1. **Only EXPLICIT relations.** Write one when the human draft states it, when
   the analysis proves it from the fetched bodies, or when a card's own text
   already names the dependency. A relation you infer from two similar titles is
   speculation, and a wrong edge on a board is worse than a missing one: it
   misleads every later reader.
2. **Both endpoints must exist and be resolved.** Use the stable ids from the
   summary rows you already loaded, never a title, a number or a guessed id. The
   gate drops ids it cannot resolve, and a silently dropped edge is invisible.
3. **Same workspace only**, like every other read and write on this channel.
4. **At most 3 relations per run**, related to the analyzed card.
5. **Send the complete list** when you add one: the patch replaces the stored
   list, so the entries already there must be included or they are erased.
6. **Never on a capture of a fresh idea with no analysed neighbour**, and never
   invented to look thorough. An empty relation graph is a normal, correct state.

If you add a relation, name it in the final report as one line ("related to #12
- same permission boundary", "blocks #15 - the mirror cannot land without it").

## One run, one card (anti-multi-CREATE)

A run ends in AT MOST ONE card. A sibling card is a duplicate, not a deeper
analysis, and a fresh requestId is what makes a second create succeed - so
the count is your responsibility, not the channel's:

- A capture run emits exactly ONE create verb, for the analyzed idea. Never
  a second create with a fresh requestId in the same run.
- A re-analysis run emits NO create verb at all; it updates the named id.
- create then triage, or update then triage, is not duplication: both verbs
  target the SAME idea id. Keep it that way.
- A relations update targets the SAME idea id too, so it is not a fourth card:
  it is part of writing that card.
- The follow-up verb stays reserved for a failed run reviewed by a human: it
  requires an underReview parent and archives that parent. It is never the
  way to split a broad subject across cards.

Genuinely INDEPENDENT ideas you notice while analyzing do not become cards
in this run. Record them inside the body, in the one OPTIONAL section the
structure above allows beyond the five mandatory headings:

    ## Deferred ideas

    - <short title> - <one sentence: what it is> - <the one check that would
      scope it>

Write the heading in English like the five others (Context, Value, Effort,
First steps, Risks) and the entries in the language of the human's draft. The
section is optional: omit it entirely when the analysis surfaced no
independent idea, and keep it under ~2 KiB. When present it comes AFTER
Risks, and it never replaces or shortens any of the five. On a re-analysis
the target body you already had to read carries the previous entries: keep
them, re-checked against today's evidence, rather than dropping them.

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
- The launch prompt carries the idea's ACTIVITY LOG: what the board recorded
  happening to it, with actor and date. That is the real history, so read it
  before writing and never contradict it - an idea that was declined,
  delivered, or archived and restored already has a story, and re-proposing
  what was refused is a failed re-analysis. When the log contradicts the
  current body, trust the log and say so in the analysis.

## Duplicates: the merge verb

Two captures can describe the same work. When you judge that one idea
duplicates another ALREADY IN THE LEDGER, reconcile them with one merge verb
instead of leaving two cards that both claim the same value:

    { "kind": "merge", "sourceId": "<the duplicate>", "targetId": "<the survivor>", "mode": "keepTargetRank" }

- sourceId is the idea that FOLDS IN and gets archived; targetId is the one
  that SURVIVES. Pick the survivor deliberately: the better-analysed, more
  complete card wins, not the newer one.
- BOTH ids must sit in the SAME workspace. The Host refuses a cross-workspace
  merge with a reason, so re-home one idea explicitly first if you really mean
  to move work between projects.
- mode is how the loser's rank settles onto the survivor: keepTargetRank (the
  survivor stays where it is, the default and the safe choice) or
  takeSourceRank (the survivor takes the position the duplicate held, and the
  open backlog of that workspace re-ranks around it).
- The merge reconciles the loser's TAGS (unioned onto the survivor) and its
  follow-up lineage (the survivor inherits the place in the chain, and the
  loser's children are re-pointed at the survivor), then archives the loser
  with a decision note naming the survivor. One commit, so there is no window
  in which both cards are open.
- The merge NEVER rewrites the survivor's title, body, summary or analysis,
  and never touches its run state or its TaskBoard binding: a duplicate
  contributes labels, lineage and position, never a second body. If the
  duplicate genuinely carries better analysis, say so in your report and let
  the human decide; do not merge to smuggle content across.
- Use a FRESH requestId for every merge call: a replayed id returns the
  cached first outcome without re-executing.

## Find similar runs (find-similar action)

When the launch prompt is a FIND SIMILAR run, this is a COMPARISON, not an
analysis. The overrides in that prompt take precedence over everything above:

- Write NOTHING: no create, no update, no triage, and above all NEVER the merge
  verb. A merge is the human's decision; this run reports a recommendation the
  human acts on.
- Compare ONLY the candidates the prompt lists. Do not go looking for more:
  that bounded list is the whole scope of the question.
- The candidate scores are a CHEAP SIGNAL (normalized title overlap plus tag
  overlap), not a judgement. Distrust them in both directions and read each
  candidate's real body before you say anything about it.
- The prompt names how many open ideas of the workspace were compared and how
  many were kept. Say so in your report when the number kept is small relative
  to the number compared, so the human knows the answer is bounded.
- Report one line per candidate you weighed - its number, its title, then
  DUPLICATE, RELATED BUT DISTINCT or UNRELATED with the reason - and close with
  a single merge RECOMMENDATION. Report and stop.

## Final report (≤ 4 sentences, in the requester's language)

End your reply with a short report stating: the idea number and final title
(say explicitly if you RENAMED it), created or merged into an existing idea,
the workspace, the retained value/effort, the retained rank "x/y" over this
workspace's open backlog, and the one-sentence rationale. Write it in the
language the requester used for the idea title/draft, or English by default —
never a hard-coded language.
`;
//#endregion
//#region src/skill-install.ts
/**
* Skill installation for the ideas Host half (Phase 3 refinement): on
* activation the plugin installs the `ideas-analyst` skill as a real file at
* `<dshHome>/skills/ideas-analyst/SKILL.md` — the user-dsh skill root (rank
* 400) that the dsh-skill-filesystem discoverer reads for EVERY session,
* whatever the workspace/cwd. The launched Phase 3 session therefore finds
* the skill in its catalog and loads it instead of receiving the full
* methodology inline.
*
* **The bundled prompt always wins, and the previous file is never lost.** The
* rules before it were both wrong in the same way — first-wins kept an
* installation stranded on a months-old PROMPT after every upgrade, so the
* features this plugin advertises went unused by the analyst with no symptom;
* "upgrade only what we recognise" fixed that but needed a digest list to
* maintain and still left the author with no way to get their text back.
*
* So: the file on disk is replaced, whatever it is, and a copy of what was
* there is kept beside it (`SKILL.md.<stamp>.bak`, newest
* {@link SKILL_BACKUPS_KEPT} kept) BEFORE the write. Nothing is destroyed, the
* prompt in use is always the one this plugin ships, and restoring the author's
* version is a file copy away — which the start-up log names, because silently
* replacing a hand-written file would be its own kind of dishonesty.
*
* Best-effort by design — a filesystem failure (e.g. a read-only home) must
* never break plugin boot.
*/
/** Directory under the DSH home holding user-installed skills (user-dsh root). */
const DSH_SKILLS_DIR = "skills";
/** Suffix of the kept copies of a replaced prompt. */
const SKILL_BACKUP_SUFFIX = ".bak";
/**
* Default target directory for the installed skill: `<dshHome>/skills`.
* @param home - DSH home override (test seam; default = the live home).
*/
function skillRoot(home = dshHome()) {
	return join(home, DSH_SKILLS_DIR);
}
/** Absolute SKILL.md path for the plugin-installed skill under `home`. */
function installedSkillPath(home = dshHome()) {
	return join(skillRoot(home), IDEAS_ANALYST_SKILL_NAME, IDEAS_ANALYST_SKILL_FILE);
}
function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
/** `YYYYMMDD-HHMMSS` in local time: when a replaced prompt was seen. */
function stamp(at) {
	const two = (value) => String(value).padStart(2, "0");
	return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}
/** The kept copies beside `target`, newest first. */
function existingBackups(target) {
	const dir = dirname(target);
	const prefix = `${basename(target)}.`;
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).map((name) => join(dir, name)).sort((left, right) => {
		try {
			return statSync(right).mtimeMs - statSync(left).mtimeMs;
		} catch {
			return right.localeCompare(left);
		}
	});
}
/**
* Keep what is about to be replaced, and return where it now lives.
*
* Idempotent on content: a second install of the same previous version reuses
* the copy already taken instead of littering the folder, and the retention
* drops the oldest beyond {@link SKILL_BACKUPS_KEPT}.
*
* @returns the backup path, or undefined when the copy could not be kept (the
*   caller still installs: a missing courtesy copy must not strand the prompt).
*/
function keepPrevious(target, previous, at) {
	const digest = sha256(previous);
	try {
		for (const path of existingBackups(target)) if (sha256(readFileSync(path, "utf8")) === digest) return path;
		const path = `${target}.${stamp(at)}${SKILL_BACKUP_SUFFIX}`;
		writeFileSync(path, previous, "utf8");
		for (const old of existingBackups(target).slice(5)) try {
			unlinkSync(old);
		} catch {}
		return path;
	} catch {
		return;
	}
}
/**
* Install the bundled ideas-analyst skill (always the bundled prompt; the
* replaced file is kept beside it).
* @param options - `home` DSH home override; `log` journaling seam;
*   `now` clock seam for the backup stamp.
* @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
*/
function installIdeasAnalystSkill(options = {}) {
	const log = options.log ?? ((line) => {
		console.log(`[dsh-plugin-ideas-manager] ${line}`);
	});
	const target = installedSkillPath(options.home);
	try {
		if (existsSync(target)) {
			const existing = readFileSync(target, "utf8");
			if (existing === IDEAS_ANALYST_SKILL_CONTENT) return {
				path: target,
				synced: true,
				status: "matched"
			};
			const backup = keepPrevious(target, existing, options.now ?? /* @__PURE__ */ new Date());
			writeFileSync(target, IDEAS_ANALYST_SKILL_CONTENT, "utf8");
			log(`skill "${IDEAS_ANALYST_SKILL_NAME}" at ${target} was replaced by this version's prompt` + (backup === void 0 ? " (the previous copy could NOT be kept beside it)" : `; the previous copy is kept at ${backup} if you want it back`) + ".");
			return {
				path: target,
				synced: true,
				status: "upgraded",
				...backup === void 0 ? {} : { backup }
			};
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, IDEAS_ANALYST_SKILL_CONTENT, "utf8");
		return {
			path: target,
			synced: true,
			status: "created"
		};
	} catch (error) {
		log(`failed to install skill "${IDEAS_ANALYST_SKILL_NAME}" at ${target}: ${error instanceof Error ? error.message : String(error)} (best-effort, launch prompt keeps an inline fallback)`);
		return {
			path: target,
			synced: false,
			status: "kept-existing"
		};
	}
}
//#endregion
//#region src/http.ts
/** Default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/**
* Decode an inbound JSON request body to a string, then parse it.
*
* RFC 8259 mandates UTF-8 for JSON exchanged outside a closed ecosystem, and
* the browser (the usual caller of /api/ideas) always sends UTF-8. The
* ideas-analyst agent, however, is launched through PowerShell 5.1 on Windows:
* PS 5.1 sends a `-Body <string>` in the system ANSI codepage (windows-1252 on
* Western/European locales) unless the caller explicitly passes
* `[Text.Encoding]::UTF8.GetBytes(...)` bytes. A single accented byte (e.g.
* e-acute = 0xE9) is an invalid UTF-8 lead byte, so Node's lenient
* `Buffer.toString('utf8')` replaces it with U+FFFD -- and that replacement is
* LOSSY: the original byte is irrecoverable, so the corruption is persisted
* into the ledger as a mojibake card and surfaces on every read.
*
* The fix lives at the source-of-truth boundary (the moment the agent's bytes
* become canonical ledger text) so both storage and display are protected:
*
*   1. If the bytes are valid UTF-8 (the common case, including CJK), decode
*      as UTF-8 -- byte-for-byte identical to the previous behavior, so no
*      regression for correct clients.
*   2. Otherwise the stream is a raw ANSI codepage (the PowerShell 5.1 trap):
*      decode as windows-1252. This recovers the Latin-1 accented letters
*      (e-acute, e-grave, a-circumflex, c-cedilla, ...) AND the CP1252
*      printable characters in 0x80..0x9F that the analyst emits constantly
*      (curly apostrophes/quotes, o-ligature, euro). Every byte is defined in
*      windows-1252, so there is never an unknown byte.
*
* Conservative: valid UTF-8 is never reinterpreted (no false repair of correct
* text); only genuinely-invalid UTF-8 is re-decoded, and that can only happen
* for single-byte codepage streams (the corruption mode documented above).
*/
function decodeRequestBody(buffer) {
	const asUtf8 = buffer.toString("utf8");
	if (Buffer.from(asUtf8, "utf8").equals(buffer)) return asUtf8;
	return decodeAsWindows1252(buffer);
}
/**
* windows-1252 fallback decoder: `toString('latin1')` already maps every byte
* 0xA0..0xFF to the correct code point (identical to windows-1252 in that
* range), so only the C1 range 0x80..0x9F needs a lookup table -- that is where
* windows-1252 defines printable glyphs (euro, curly quotes, o-ligature) that
* latin1 leaves as control characters. The table is ASCII-only in source
* (unicode escapes) so the file survives the write tool's double-encoding.
*/
function decodeAsWindows1252(buffer) {
	const CP1252_C1 = {
		128: "€",
		130: "‚",
		131: "ƒ",
		132: "„",
		133: "…",
		134: "†",
		135: "‡",
		136: "ˆ",
		137: "‰",
		138: "Š",
		139: "‹",
		140: "Œ",
		142: "Ž",
		145: "‘",
		146: "’",
		147: "“",
		148: "”",
		149: "•",
		150: "–",
		151: "—",
		152: "˜",
		153: "™",
		154: "š",
		155: "›",
		156: "œ",
		158: "ž",
		159: "Ÿ"
	};
	const latin1 = buffer.toString("latin1");
	let out = "";
	for (const ch of latin1) {
		const code = ch.charCodeAt(0);
		out += code >= 128 && code <= 159 && CP1252_C1[code] !== void 0 ? CP1252_C1[code] : ch;
	}
	return out;
}
/**
* Write one JSON response. Default headers are the family defaults
* (content-type and referrer-policy); caller headers are appended or
* override them.
*/
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(payload);
}
//#endregion
//#region src/loopback.ts
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/**
* Request-level trust fence: a loopback socket address AND a loopback Host
* header, plus browser same-origin markers.
*/
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/host-routes.ts
const ACTION_LIMIT = 64 * 1024;
const IMPORT_LIMIT = 2 * 1024 * 1024;
const HEARTBEAT_MS = 15e3;
/**
* Harness browser-auth cookie prefix (dsh-client-connection): the
* authority-bound signed cookie the Host mints in exchange for its launch
* token. dsh-web's remote channel redeems that token before re-issuing paired
* traffic to 127.0.0.1 (packages/dsh-remote-web-ui/src/inner-auth.ts), and the
* official DSH Desktop shell keeps its own copy from the same exchange and
* attaches it to every request it forwards for the dsh-app://app/ page. The
* two constants describe one fact and move together.
*/
const BROWSER_AUTH_COOKIE_PREFIX = "dsh-auth-";
/**
* Whether a Cookie header carries the Host's browser-auth credential. Only an
* application on this machine can hold it: the desktop shell never lets it
* reach the page's cookie jar, and SameSite=Strict keeps a cross-site page
* from attaching it.
* @param header - the raw Cookie header value.
*/
function carriesBrowserAuthCookie(header) {
	if (header === void 0) return false;
	return header.split(";").some((segment) => segment.trim().startsWith(BROWSER_AUTH_COOKIE_PREFIX));
}
/**
* Browser-signal tripwire, NOT an authority check: a bare curl sends neither
* header and is refused, but a curl with a forged Origin passes this too.
* The real boundary is the loopback socket + Host + origin-equality checks in
* isTrustedIdeasRequest below; do not rely on this marker alone.
*
* A first-party client that presents NEITHER header must still pass. The DSH
* Desktop shell serves the Web GUI from dsh-app://app/ and forwards that
* page's Host requests itself, deleting origin and sec-fetch-site on the
* way (dsh-desktop-host's forwardWebRequest), so the board's own fetch
* arrives marker-less and every route behind this guard answered 403 - which
* the board renders as its hostError message. The shell does attach the
* Host's browser-auth cookie, redeemed from the Host's launch URL at startup
* and deliberately withheld from the page. That credential, not a header the
* shell strips, is the browser signal of an application on this machine; a
* marker-less, credential-less request stays refused.
*/
function browserSameOriginMarker(req) {
	if (req.headers["sec-fetch-site"] === "same-origin") return true;
	if (typeof req.headers.origin === "string") return true;
	return carriesBrowserAuthCookie(req.headers.cookie);
}
/**
* Ideas route fence. Direct desktop access uses the loopback socket + Host
* guard and additionally requires a browser same-origin marker: a bare local
* curl without any browser signal cannot exercise the agent control plane.
*/
function isTrustedIdeasRequest(req) {
	if (!browserSameOriginMarker(req)) return false;
	return isLoopbackRequest(req);
}
/**
* Read and decode the request body. The decode is robust (see
* {@link decodeRequestBody}): a valid UTF-8 body is decoded byte-for-byte as
* before, while a raw ANSI-codepage body (the PowerShell 5.1 string-body trap)
* is re-decoded as windows-1252 instead of being corrupted to U+FFFD. The
* received byte count is returned so the caller can cap on wire bytes rather
* than the (re-encoded) length of the decoded text.
*/
async function readBody(req, limit = IMPORT_LIMIT) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > limit) throw new Error("body-too-large");
		chunks.push(buffer);
	}
	const raw = decodeRequestBody(Buffer.concat(chunks));
	return {
		raw,
		value: JSON.parse(raw),
		byteLength: size
	};
}
function makeIdeasRoutes(service, configPort) {
	const guard = (req, res) => {
		if (isTrustedIdeasRequest(req)) return true;
		writeJson(res, 403, {
			ok: false,
			error: "forbidden"
		}, { "cache-control": "no-store" });
		return false;
	};
	const state = {
		kind: "exact",
		path: `${IDEAS_API_PREFIX}/state`,
		handler: (req, res) => {
			if (req.method !== "GET") return writeJson(res, 405, {
				ok: false,
				error: "method-not-allowed"
			}, { "cache-control": "no-store" });
			if (!guard(req, res)) return;
			const params = new URL(req.url ?? "/", "http://loopback").searchParams;
			const view = params.get("view");
			if (view === "stats") {
				const query = parseIdeasStatsQuery(params);
				if (query === void 0) {
					writeJson(res, 400, {
						ok: false,
						error: "invalid-query"
					}, { "cache-control": "no-store" });
					return;
				}
				writeJson(res, 200, service.ideasStats({ workspaceId: query.workspaceId }), { "cache-control": "no-store" });
				return;
			}
			if (view === "summary" || view === "detail") {
				const query = parseIdeasReadQuery(params);
				if (query === void 0) {
					writeJson(res, 400, {
						ok: false,
						error: "invalid-query"
					}, { "cache-control": "no-store" });
					return;
				}
				writeJson(res, 200, buildIdeasReadSnapshot(service.snapshot(), query), { "cache-control": "no-store" });
				return;
			}
			writeJson(res, 200, view === "list" ? toListSnapshot(service.snapshot()) : service.snapshot(), { "cache-control": "no-store" });
		}
	};
	const ideaBody = {
		kind: "exact",
		path: `${IDEAS_API_PREFIX}/idea`,
		handler: (req, res) => {
			if (req.method !== "GET") return writeJson(res, 405, {
				ok: false,
				error: "method-not-allowed"
			}, { "cache-control": "no-store" });
			if (!guard(req, res)) return;
			const id = new URL(req.url ?? "/", "http://loopback").searchParams.get("id");
			if (id === null || id === "") return writeJson(res, 400, {
				ok: false,
				error: "id-required"
			}, { "cache-control": "no-store" });
			const record = service.idea(id);
			if (record === void 0) return writeJson(res, 404, {
				ok: false,
				error: "not-found"
			}, { "cache-control": "no-store" });
			writeJson(res, 200, record, { "cache-control": "no-store" });
		}
	};
	const action = {
		kind: "exact",
		path: `${IDEAS_API_PREFIX}/action`,
		handler: async (req, res) => {
			if (req.method !== "POST") return writeJson(res, 405, {
				ok: false,
				error: "method-not-allowed"
			}, { "cache-control": "no-store" });
			if (!guard(req, res)) return;
			if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return writeJson(res, 415, {
				ok: false,
				error: "json-required"
			}, { "cache-control": "no-store" });
			try {
				const body = await readBody(req);
				const parsed = parseActionEnvelope(body.value);
				if (parsed === void 0) return writeJson(res, 400, {
					ok: false,
					error: "invalid-action"
				}, { "cache-control": "no-store" });
				if (parsed.action.kind !== "import" && body.byteLength > ACTION_LIMIT) return writeJson(res, 413, {
					ok: false,
					error: "body-too-large"
				}, { "cache-control": "no-store" });
				const result = service.apply(parsed.requestId, parsed.action, parsed.initiator);
				writeJson(res, 200, result.export === void 0 ? result.state : {
					ok: true,
					export: result.export
				}, { "cache-control": "no-store" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				writeJson(res, message === "body-too-large" ? 413 : 400, {
					ok: false,
					error: message
				}, { "cache-control": "no-store" });
			}
		}
	};
	const events = {
		kind: "exact",
		path: `${IDEAS_API_PREFIX}/events`,
		handler: (req, res) => {
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (!guard(req, res)) return;
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive"
			});
			const push = () => {
				const payload = service.eventPayload();
				res.write(`data: ${JSON.stringify(payload)}\n\n`);
			};
			const unsubscribe = service.subscribe(push);
			const heartbeat = setInterval(() => {
				res.write(": ping\n\n");
			}, HEARTBEAT_MS);
			const close = () => {
				clearInterval(heartbeat);
				unsubscribe();
			};
			req.once("close", close);
			res.once("close", close);
			push();
		}
	};
	const config = {
		kind: "exact",
		path: `${IDEAS_API_PREFIX}/config`,
		handler: async (req, res) => {
			const deny = (status, error) => {
				writeJson(res, status, {
					ok: false,
					error
				}, { "cache-control": "no-store" });
			};
			if (req.method !== "GET" && req.method !== "POST") return deny(405, "method-not-allowed");
			if (!guard(req, res)) return;
			const port = configPort?.();
			if (req.method === "GET") {
				writeJson(res, 200, port?.read() ?? {
					available: false,
					value: IDEAS_SETTINGS_DEFAULTS
				}, { "cache-control": "no-store" });
				return;
			}
			if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return deny(415, "json-required");
			let body;
			try {
				body = await readBody(req);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return deny(message === "body-too-large" ? 413 : 400, message);
			}
			if (body.byteLength > ACTION_LIMIT) return deny(413, "body-too-large");
			const parsed = parseSettingsBody(body.value);
			if (parsed === void 0) return deny(400, "invalid-patch");
			if (port === void 0) return deny(503, "settings-unavailable");
			try {
				writeJson(res, 200, await port.write(parsed.patch, parsed.expectedRevision), { "cache-control": "no-store" });
			} catch (error) {
				const conflict = typeof error === "object" && error !== null && error.code === "SETTINGS_CONFLICT";
				const message = error instanceof Error ? error.message : String(error);
				deny(conflict ? 409 : 400, conflict ? "settings-conflict" : message);
			}
		}
	};
	/**
	* Launch the idea's execution. A DEDICATED route, not an
	* `IdeasAction` verb (decision D1): a launch is not a ledger mutation — it
	* must not consume the persisted action dedupe cache, and its answer is a
	* small `{ok, runId, runStatus}` instead of a whole board snapshot. The
	* requestId is still accepted and honours a replay inside a short window.
	*
	* Status mapping (every failure is visible, never swallowed — the run gates
	* are the interesting part of this flow):
	*  400 invalid-launch / the backend's own refusal message,
	*  404 not-found, 409 taskboard-mirror-disabled, 413/415/405 discipline.
	*/
	const launch = {
		kind: "exact",
		path: `${IDEAS_API_PREFIX}/launch`,
		handler: async (req, res) => {
			const deny = (status, error) => {
				writeJson(res, status, {
					ok: false,
					error
				}, { "cache-control": "no-store" });
			};
			if (req.method !== "POST") return deny(405, "method-not-allowed");
			if (!guard(req, res)) return;
			if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return deny(415, "json-required");
			let body;
			try {
				body = await readBody(req);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return deny(message === "body-too-large" ? 413 : 400, message);
			}
			if (body.byteLength > ACTION_LIMIT) return deny(413, "body-too-large");
			const parsed = parseLaunchBody(body.value);
			if (parsed === void 0) return deny(400, "invalid-launch");
			if (parsed.model !== void 0 && parsed.model.length > 256) return deny(400, "model-too-long");
			try {
				writeJson(res, 200, await service.launchIdea(parsed.ideaId, parsed.model, parsed.requestId), { "cache-control": "no-store" });
			} catch (error) {
				if (error instanceof TaskBoardMirrorDisabledError) return deny(409, "taskboard-mirror-disabled");
				if (error instanceof TaskBoardUnavailableError) return deny(503, "taskboard-unavailable");
				const message = error instanceof Error ? error.message : String(error);
				if (message === "idea not found") return deny(404, "not-found");
				deny(message === "ideas plugin is disabled" ? 409 : 400, message);
			}
		}
	};
	/** Error text of an unknown throwable (every refusal carries its own reason). */
	function messageOf(error) {
		return error instanceof Error ? error.message : String(error);
	}
	/**
	* The snapshot reason a caller may choose. The only meaningful choice is
	* `export` (a copy taken to be carried to another machine); everything else —
	* including an unknown value — is a plain `manual` snapshot. The `pre-restore`
	* stamp is written by the restore itself and can never be asserted from the
	* wire, so a displaced ledger can never be filed as a routine snapshot.
	*/
	function parseSnapshotReason(value) {
		return (value === null || typeof value !== "object" || Array.isArray(value) ? void 0 : value)?.reason === "export" ? "export" : "manual";
	}
	return [
		state,
		ideaBody,
		action,
		events,
		config,
		launch,
		{
			kind: "exact",
			path: `${IDEAS_API_PREFIX}/backup`,
			handler: async (req, res) => {
				const deny = (status, error) => {
					writeJson(res, status, {
						ok: false,
						error
					}, { "cache-control": "no-store" });
				};
				if (req.method !== "GET" && req.method !== "POST") return deny(405, "method-not-allowed");
				if (!guard(req, res)) return;
				if (req.method === "GET") {
					try {
						writeJson(res, 200, service.backupsView(), { "cache-control": "no-store" });
					} catch (error) {
						deny(messageOf(error) === "ideas plugin is disabled" ? 409 : 500, messageOf(error));
					}
					return;
				}
				if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return deny(415, "json-required");
				let body;
				try {
					body = await readBody(req, ACTION_LIMIT);
				} catch (error) {
					const message = messageOf(error);
					return deny(message === "body-too-large" ? 413 : 400, message);
				}
				const reason = parseSnapshotReason(body.value);
				try {
					writeJson(res, 200, service.takeSnapshot(reason), { "cache-control": "no-store" });
				} catch (error) {
					const message = messageOf(error);
					deny(message === "ideas plugin is disabled" ? 409 : 500, message);
				}
			}
		},
		{
			kind: "exact",
			path: `${IDEAS_API_PREFIX}/backup/content`,
			handler: (req, res) => {
				if (req.method !== "GET") return writeJson(res, 405, {
					ok: false,
					error: "method-not-allowed"
				}, { "cache-control": "no-store" });
				if (!guard(req, res)) return;
				const name = new URL(req.url ?? "/", "http://loopback").searchParams.get("name");
				if (name === null || name === "") return writeJson(res, 400, {
					ok: false,
					error: "name-required"
				}, { "cache-control": "no-store" });
				let text;
				try {
					text = service.snapshotContent(name);
				} catch (error) {
					const message = messageOf(error);
					return writeJson(res, message === "ideas plugin is disabled" ? 409 : 500, {
						ok: false,
						error: message
					}, { "cache-control": "no-store" });
				}
				if (text === void 0) return writeJson(res, 404, {
					ok: false,
					error: "not-found"
				}, { "cache-control": "no-store" });
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"content-length": String(Buffer.byteLength(text)),
					"content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
					"cache-control": "no-store"
				});
				res.end(text);
			}
		},
		{
			kind: "exact",
			path: `${IDEAS_API_PREFIX}/backup/restore`,
			handler: async (req, res) => {
				const answer = (status, body) => {
					writeJson(res, status, body, { "cache-control": "no-store" });
				};
				if (req.method !== "POST") return answer(405, {
					ok: false,
					error: "method-not-allowed"
				});
				if (!guard(req, res)) return;
				if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return answer(415, {
					ok: false,
					error: "json-required"
				});
				let body;
				try {
					body = await readBody(req, IDEAS_RESTORE_LIMIT);
				} catch (error) {
					const message = messageOf(error);
					return answer(message === "body-too-large" ? 413 : 400, {
						ok: false,
						error: message,
						message
					});
				}
				const request = parseRestoreRequest(body.value);
				if (request === void 0) return answer(400, {
					ok: false,
					error: "invalid-restore"
				});
				try {
					const outcome = service.restoreBoard(request);
					if (outcome.ok) return answer(200, outcome);
					answer(outcome.error === "snapshot-not-found" ? 404 : IDEAS_RESTORE_CONFLICT.has(outcome.error) ? 409 : 400, outcome);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					answer(message === "ideas plugin is disabled" ? 409 : 400, {
						ok: false,
						error: message,
						message
					});
				}
			}
		}
	];
}
//#endregion
//#region src/host-settings.ts
/**
* Display-settings wiring across the two host settings contracts.
*
* DSH <= 0.1.5 exposes the legacy namespace API:
*
*   ctx.settings.register(ns, schema, { applies: 'live' })
*   ctx.settings.describe({ redactSecrets: true })  // descriptors keyed by .ns
*   ctx.settings.update(ns, patch, expectedRevision)
*
* DSH >= 0.1.7 replaced that service with SettingsForms (@deepseek-ai/
* dsh-settings): editable forms are derived from the plugin's Config schema,
* `register` no longer exists, and `describe`/`update` are keyed by profile
* entry id. The legacy call therefore throws
* `TypeError: settings.register is not a function` at boot on 0.1.7.
*
* v0.3.4 strategy (the dsh-permissions 2.0.0 precedent):
* - legacy contract detected at runtime (`typeof settings.register ===
*   'function'`) -> the 0.3.3 code path runs UNCHANGED, so production on
*   0.1.5 stays byte-identical (including the registration-failure log and
*   the fact that no plugin file is ever touched on that host);
* - no `register` (0.1.7+) -> the plugin owns its state in a small versioned
*   document under DSH_HOME with an incrementing revision fence, so the
*   /api/ideas/config contract (read / write with expectedRevision, 409 on a
*   stale revision) is unchanged for the browser half on every host.
*
* Neither path touches the refactored contract: the plugin renders its OWN
* settings section, so it never needs the host's form projection.
* @module dsh-plugin-ideas-manager/host-settings
*/
/**
* Settings namespace registered with the legacy host settings service. Spelled
* here rather than imported from the host entry: the browser half spells the
* same value and must not depend on a Host package.
*/
const IDEAS_SETTINGS_NAMESPACE = "ideas";
/** Format version of the plugin-owned document. */
const STORE_VERSION = 1;
/**
* One default launch model per workspace, keyed by the stable
* workspace id — the schema half of the setting `IdeasHostService` resolves a
* launch against.
*
* Annotated rather than inferred, and that is a BUILD constraint, not
* decoration: `z.dict` types its result with cosmokit's `Dict`, a TRANSITIVE
* package, so an inferred type naming it cannot be written to `lib/types`
* without degrading into a `.pnpm/cosmokit@…` path (TS2742). Pinning the one
* leaking field keeps the enclosing object's inferred type precise AND
* portable. The shape is not lost by the annotation — it is the same map
* `sanitizeLaunchModelByWorkspace` produces on every read, and the bounds
* live there (protocol.ts) rather than in a schema range, which would reject
* a hand-edited section at REGISTRATION and brick the namespace.
*/
const launchModelByWorkspaceSchema = z.dict(z.string());
/**
* Display-settings schema: permissive types (clamped/sanitized at every
* boundary — a ranged schema would reject a bad stored section AT
* REGISTRATION and brick the namespace; see sanitizeSettings).
*/
const IdeasSettingsSchema = z.object({
	tagRows: z.number().default(IDEAS_SETTINGS_DEFAULTS.tagRows),
	defaultTab: z.string().default(IDEAS_SETTINGS_DEFAULTS.defaultTab),
	renderMarkdown: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.renderMarkdown),
	rememberWorkspaceScope: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.rememberWorkspaceScope),
	workspaceScope: z.string().default(IDEAS_SETTINGS_DEFAULTS.workspaceScope),
	confirmLifecycle: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.confirmLifecycle),
	hideDeclinedColumn: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.hideDeclinedColumn),
	cardDensity: z.string().default(IDEAS_SETTINGS_DEFAULTS.cardDensity),
	language: z.string().default(IDEAS_SETTINGS_DEFAULTS.language),
	openOrdering: z.string().default(IDEAS_SETTINGS_DEFAULTS.openOrdering),
	runningFirst: z.boolean().default(IDEAS_SETTINGS_DEFAULTS.runningFirst),
	directRunPermission: z.string().default(IDEAS_SETTINGS_DEFAULTS.directRunPermission),
	staleAfterDays: z.number().default(IDEAS_SETTINGS_DEFAULTS.staleAfterDays),
	launchModelByWorkspace: launchModelByWorkspaceSchema.default(IDEAS_SETTINGS_DEFAULTS.launchModelByWorkspace)
});
/**
* Refusal raised by the plugin-owned store when the caller's revision fence is
* stale. Carries the same stable `code` the config route maps to
* 409 `settings-conflict`, mirroring the host's own SettingsConflictError.
*/
var IdeasSettingsConflictError = class extends Error {
	/** Stable machine code the HTTP layer maps to 409 settings-conflict. */
	code = "SETTINGS_CONFLICT";
	/** Revision the caller expected. */
	expected;
	/** Revision the document actually stands at (undefined = no document yet). */
	actual;
	constructor(expected, actual) {
		super(`settings revision moved: expected ${expected ?? "none"}, actual ${actual ?? "none"}`);
		this.name = "IdeasSettingsConflictError";
		this.expected = expected;
		this.actual = actual;
	}
};
/**
* Plugin-owned settings document: a versioned JSON file with an incrementing
* revision, serving the exact {@link IdeasConfigPort} contract the config
* route already speaks.
*
* Reads always answer (a missing document yields the spelled defaults with no
* fence — same view the legacy path serves when the namespace holds no
* descriptor yet), so the section is editable on any host. An unreadable
* document is quarantined beside itself (renamed, never deleted — the ledger's
* corrupt-document discipline) and the defaults take over: settings are a
* nicety and must never brick the board.
*
* Every operation is synchronous inside the process, so two writes can never
* interleave between the revision check and the commit.
*/
var IdeasSettingsStore = class {
	/** Absolute path of the versioned document. */
	file;
	/** Whether the corrupt-document report already ran for this instance. */
	reported = false;
	constructor(options = {}) {
		this.file = options.file ?? join(dshHome(), "ideas-manager-settings.json");
	}
	read() {
		const state = this.load();
		if (state.kind === "valid") return {
			available: true,
			value: state.document.value,
			revision: state.document.revision
		};
		if (state.kind === "corrupt") this.quarantine();
		return {
			available: true,
			value: IDEAS_SETTINGS_DEFAULTS
		};
	}
	async write(patch, expectedRevision) {
		const state = this.load();
		if (state.kind === "corrupt") this.quarantine();
		const current = state.kind === "valid" ? state.document : void 0;
		const currentRevision = current?.revision;
		if (expectedRevision !== void 0 && expectedRevision !== currentRevision) throw new IdeasSettingsConflictError(expectedRevision, currentRevision);
		const value = sanitizeSettings({
			...IDEAS_SETTINGS_DEFAULTS,
			...current?.value ?? {},
			...patch
		});
		const revision = (currentRevision ?? 0) + 1;
		this.persist({
			version: STORE_VERSION,
			revision,
			value
		});
		return {
			available: true,
			value,
			revision
		};
	}
	/** Missing / corrupt / parsed-and-sanitized document. */
	load() {
		let raw;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return { kind: "missing" };
			return { kind: "corrupt" };
		}
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "corrupt" };
			const row = parsed;
			const revision = row.revision;
			if (row.version !== STORE_VERSION || typeof revision !== "number" || !Number.isFinite(revision) || revision < 0) return { kind: "corrupt" };
			return {
				kind: "valid",
				document: {
					version: STORE_VERSION,
					revision,
					value: sanitizeSettings(row.value)
				}
			};
		} catch {
			return { kind: "corrupt" };
		}
	}
	/**
	* Move an unreadable document aside (renamed, evidence kept) and report it
	* once per instance; a failed rename is reported, never thrown — the read
	* or write that found the document carries on with the defaults.
	*/
	quarantine() {
		if (this.reported) return;
		this.reported = true;
		const target = `${this.file}.corrupt-${Date.now()}`;
		try {
			renameSync(this.file, target);
			console.warn(`[dsh-plugin-ideas-manager] unreadable settings document moved to ${target}; defaults apply`);
		} catch (error) {
			console.warn("[dsh-plugin-ideas-manager] unreadable settings document; defaults apply", error);
		}
	}
	/** Atomic tmp+rename commit with a direct-write fallback (Windows EPERM rename flake, host-ledger lesson). */
	persist(document) {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmpFile = `${this.file}.tmp-${process.pid}`;
		const text = `${JSON.stringify(document, null, 2)}\n`;
		try {
			writeFileSync(tmpFile, text);
		} catch (error) {
			try {
				unlinkSync(tmpFile);
			} catch {}
			throw error;
		}
		try {
			renameSync(tmpFile, this.file);
		} catch {
			try {
				writeFileSync(this.file, text);
			} catch (error) {
				try {
					unlinkSync(tmpFile);
				} catch {}
				throw error;
			}
			try {
				unlinkSync(tmpFile);
			} catch {}
		}
	}
};
/**
* Build the config port GET/POST /api/ideas/config serves, choosing the
* contract the running host exposes.
*
* - `settings` absent -> no port: the route keeps answering `available: false`
*   and 503 `settings-unavailable`, exactly like a deployment without a
*   settings service (the client keeps the spelled defaults).
* - `settings.register` present (host <= 0.1.5) -> the legacy namespace port,
*   byte-identical to 0.3.3, including the caught-and-logged registration
*   failure that leaves the port unset.
* - otherwise (host >= 0.1.7, SettingsForms refactor) -> the plugin-owned
*   {@link IdeasSettingsStore}; nothing is registered and no refactored method
*   is called, so boot logs stay clean.
*
* @param settings - the injected `settings` service (any shape).
* @param options - port options (store document path).
* @returns the port to serve, or undefined when the deployment has none.
*/
function createIdeasConfigPort(settings, options = {}) {
	const face = settings;
	if (face === void 0 || face === null) return void 0;
	if (typeof face.register !== "function") return new IdeasSettingsStore(options.file === void 0 ? {} : { file: options.file });
	const legacy = face;
	const ns = IDEAS_SETTINGS_NAMESPACE;
	try {
		legacy.register(ns, IdeasSettingsSchema, { applies: "live" });
	} catch (error) {
		console.error("[dsh-plugin-ideas-manager] settings namespace registration failed", error);
		return;
	}
	const viewOf = () => {
		const descriptor = legacy.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
		if (descriptor === void 0) return {
			available: true,
			value: IDEAS_SETTINGS_DEFAULTS
		};
		return {
			available: true,
			value: sanitizeSettings(descriptor.value),
			revision: descriptor.revision
		};
	};
	return {
		read: viewOf,
		write: async (patch, expectedRevision) => {
			await legacy.update(ns, patch, expectedRevision);
			return viewOf();
		}
	};
}
//#endregion
//#region src/mount-once.ts
/**
* Host single-instance guard, following the dsh-task-board family discipline.
* A standalone install of the package registers exactly once per process even
* when another bundle layer (e.g. an aggregate) also mounts the same package:
* without this guard the second instance would re-register the same webserver
* routes and system-prompt sections and fail the boot. The registry rides a
* global symbol so two module instances of the same package (npm copy vs
* repository link) still share one verdict.
*
* cordis `ctx.effect` runs its callback immediately and treats the callback's
* return value as the fiber disposer, so the unmarker is returned, not run.
*/
const MOUNTED = Symbol.for("dsh-web.mounted-plugins");
function mountedSet() {
	const registry = globalThis;
	return registry[MOUNTED] ??= /* @__PURE__ */ new Set();
}
/**
* Wrap a cordis plugin apply so the package runs at most once per process.
* The first mount registers normally and unmarks when its fiber disposes;
* any later mount of the same package name is a no-op.
* @param packageName - npm package identity shared by every install source.
* @param fn - the original plugin apply.
* @returns an apply of the same shape.
*/
function mountOnce(packageName, fn) {
	return ((...args) => {
		const mounted = mountedSet();
		if (mounted.has(packageName)) return;
		mounted.add(packageName);
		args[0]?.effect?.(() => () => {
			mounted.delete(packageName);
		});
		return fn(...args);
	});
}
//#endregion
//#region src/index.ts
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210;
const inject = ["webServer", "systemPrompt"];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const IDEAS_GUIDANCE = `dsh-plugin-ideas-manager is installed (generic idea manager, "Ideas" board in the sidebar under New Session): a Host-authoritative /api/ideas ledger, one idea record per workspace (workspaceId; absent = generic), rendered as a 4-column kanban (open / under review / archived / declined) with an Overview tab and a ranked Priorities tab. The ledger is the SOURCE OF TRUTH for ideas — it replaces any IDEAS.md / IDEAS-ARCHIVE.md file convention; the markdown export is a generated view only (ledger -> IDEAS.md / IDEAS-ARCHIVE.md), never parsed back. When the user mentions ideas / backlog / idees / notes, collaborate through this board.

Workflow: (1) CAPTURE into the ledger, never into a markdown file: title + a body holding the analysis as markdown (context, value, effort, first-step sketch / execution info, risks). (2) On capture, record a PRIORITY OPINION: set value + effort levels and suggest a rank. (3) RE-RANK the whole open backlog against the current project state on every material change (new idea, delivery, scope change): the Priorities ranking stays the current best ordering, never a plain append; re-rank only on material change and ranks stay advisory (scheduling is the author's call). (4) LIFECYCLE: finished work moves to UNDER REVIEW (the review gate; automatically when its task-board card reaches done); an approved review delivers the idea (archived, stamped), a rejected review raises a linked follow-up idea (child, open) and archives the parent, or declines it. (5) TaskBoard mirror (when the task-board plugin is present; one-way, best-effort): capture -> backlog card, updates -> card update, decline -> archive; delivered cards are closed by the author's closure run (done is runner-owned — never automate idea -> done from here). The board is autonomous without the task-board plugin.

TOOLS (when this deployment serves them): prefer the ideas_* tools over hand-building an /api/ideas envelope — ideas_list and ideas_get to read (ideas_get also returns the idea's activity log and its relations), ideas_capture to capture with a priority opinion, ideas_triage to record value/effort/rationale/rank and re-rank a workspace group (send rank to move the card; omit it to record the opinion where it stands), ideas_relate to declare or drop the relations between ideas (addRelatesTo/removeRelatesTo, addBlocks/removeBlocks; blockedBy is derived on every read and never written), ideas_launch to start the execution (its answer names the open ideas the card waits for and any rank contradiction, but never refuses a run for them), ideas_review to settle the gate (approve / followUp / decline). They drive the same ledger, so a board written from a tool is immediately visible in the GUI, and every write it makes shows up in the idea's activity log under your own initiator label. If the tools are absent this deployment only serves the HTTP channel.`;
const Config = z.object({
	enabled: z.boolean().default(true),
	announceToAgent: z.boolean().default(false),
	autoMirror: z.boolean().default(true)
});
/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = false;
/**
* Register the ideas host: ledger + routes, plus the announcement section
* gated on the composition entry's `announceToAgent`.
* @param ctx - the plugin context (webServer + systemPrompt injected).
* @param config - resolved plugin config (schema defaults applied by the loader).
*/
const apply = mountOnce("dsh-plugin-ideas-manager", applyImpl);
function applyImpl(ctx, config) {
	installIdeasAnalystSkill();
	const host = new IdeasHostService({
		mirror: new TaskBoardMirror({ transport: new HttpTaskBoardTransport(() => `http://127.0.0.1:${ctx.webServer.port}`) }),
		autoMirror: config?.autoMirror ?? true
	});
	host.setActive(config?.enabled ?? true);
	host.startUnderReviewPoll();
	ctx.inject(["typertGateway"], (gatewayCtx) => {
		const gateway = gatewayCtx.typertGateway;
		if (typeof gateway !== "object" || gateway === null || typeof gateway.invoke !== "function") return;
		host.attachSessions(new SessionRunner(gateway, (sessionId, line) => {
			if (directDispatch === void 0) throw new Error("the host serves no command service");
			return directDispatch(sessionId, line);
		}));
	});
	let directDispatch;
	ctx.inject(["agents", "commands"], (cmdCtx) => {
		directDispatch = createCommandDispatcher(cmdCtx.agents, cmdCtx.commands);
		if (directDispatch === void 0) console.warn("[dsh-plugin-ideas-manager] the host serves no agents/commands service: a direct launch will keep the session default permission");
	});
	ctx.effect(() => {
		const disposers = [];
		try {
			for (const route of makeIdeasRoutes(host, () => configPort)) disposers.push(ctx.webServer.register(route));
		} catch (error) {
			for (const dispose of disposers) dispose();
			host.dispose();
			throw error;
		}
		return () => {
			for (const dispose of disposers) dispose();
			host.dispose();
		};
	}, "ideas: host ledger and routes");
	installIdeasAgentTools(ctx, host, () => host.isActive());
	let configPort;
	ctx.inject(["settings"], (sctx) => {
		const settings = sctx.settings;
		configPort = createIdeasConfigPort(settings);
		return () => {
			configPort = void 0;
		};
	});
	host.setSettingsReader(() => {
		try {
			return configPort?.read().value;
		} catch {
			return;
		}
	});
	let current = () => config ?? {};
	let disposeSection;
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		const active = current().enabled ?? true;
		host.setActive(active);
		if (!active) return;
		if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === false) return;
		disposeSection = ctx.systemPrompt.section({
			name: "plugin:ideas",
			order: SECTION_ORDER,
			text: IDEAS_GUIDANCE
		});
	};
	sync();
}
//#endregion
export { Config, IDEAS_API_PREFIX, IDEAS_GUIDANCE, IDEAS_READ_DEFAULT_LIMIT, IDEAS_READ_MAX_BODY_BYTES, IDEAS_READ_MAX_LIMIT, IDEAS_READ_MAX_RESPONSE_BYTES, IDEAS_SETTINGS_NAMESPACE, apply, buildIdeasReadSnapshot, ideasReadSearchParams, inject, parseIdeasReadQuery };
