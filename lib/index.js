import z from "schemastery";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";
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
/** Normalize one optional target string: trim; blank collapses to undefined. */
function normalizeOptionalId$1(value) {
	const trimmed = value?.trim();
	return trimmed === void 0 || trimmed === "" ? void 0 : trimmed;
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
/** Normalize an unknown persisted status back into the closed status union. */
function normalizeStatus(status) {
	return isIdeaStatus(status) ? status : "open";
}
/** Create an idea from user input (starts 'open'). */
function createIdea(input, now, id) {
	const tags = normalizeTags(input.tags);
	const rationale = input.rationale?.trim();
	return {
		id,
		title: input.title.trim().slice(0, 200),
		body: input.body.trim(),
		status: "open",
		createdAt: now,
		updatedAt: now,
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
	lines.push(bullet("created", iso(idea.createdAt)));
	lines.push(bullet("updated", iso(idea.updatedAt)));
	if (idea.deliveredAt !== void 0) lines.push(bullet("delivered", iso(idea.deliveredAt)));
	if (idea.archivedAt !== void 0) lines.push(bullet("archived", iso(idea.archivedAt)));
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
//#endregion
//#region src/protocol.ts
/**
* /api/ideas wire protocol: prefix, envelope types, and the strict exactKeys
* action parser. Follows the dsh-task-board discipline (bounded requestId,
* closed `kind` unions, exactKeys on every object, forbidden executable
* fields on the import path) so the ideas API behaves identically to the
* sibling families without importing any of their code.
*/
const IDEAS_API_PREFIX = "/api/ideas";
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
	if (row.archivedAt !== void 0 && row.archivedAt !== null && typeof row.archivedAt !== "number") return void 0;
	if (row.followUpOfId !== void 0 && row.followUpOfId !== null && typeof row.followUpOfId !== "string") return void 0;
	return {
		id: row.id,
		title: row.title,
		body: row.body,
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
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
		...typeof row.followUpOfId === "string" ? { followUpOfId: row.followUpOfId } : {},
		...typeof row.archivedAt === "number" ? { archivedAt: row.archivedAt } : {}
	};
}
function createInput(value) {
	const input = record(value);
	if (input === void 0 || !exactKeys(input, [
		"title",
		"body",
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
	if (!optionalFiniteNumber(input.rank) || !optionalFiniteNumber(input.value) || !optionalFiniteNumber(input.effort)) return false;
	return input.tags === void 0 || isIdeaTagList(input.tags);
}
function updatePatch(value) {
	const patch = record(value);
	if (patch === void 0 || !exactKeys(patch, [
		"title",
		"body",
		"rank",
		"value",
		"effort",
		"rationale",
		"tags",
		"workspaceId"
	])) return false;
	for (const key of [
		"title",
		"body",
		"workspaceId",
		"rationale"
	]) if (!optionalString(patch[key])) return false;
	for (const key of [
		"rank",
		"value",
		"effort"
	]) if (patch[key] !== void 0 && (typeof patch[key] !== "number" || !Number.isFinite(patch[key]))) return false;
	if (patch.tags !== void 0 && patch.tags !== null && !isIdeaTagList(patch.tags)) return false;
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
function reorderList(value) {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "");
}
function parseActionEnvelope(value) {
	const envelope = record(value);
	if (envelope === void 0 || !exactKeys(envelope, [
		"requestId",
		"action",
		"initiator"
	])) return void 0;
	if (typeof envelope.requestId !== "string" || envelope.requestId.trim() === "" || envelope.requestId.length > 256) return void 0;
	if (envelope.initiator !== void 0 && (typeof envelope.initiator !== "string" || envelope.initiator.trim() === "" || envelope.initiator.length > 256)) return void 0;
	const action = record(envelope.action);
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
				return ideas.every((idea) => idea !== void 0) ? {
					requestId: envelope.requestId,
					action: {
						kind: "import",
						sourceId: action.sourceId,
						ideas
					}
				} : void 0;
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
			return {
				requestId: envelope.requestId,
				action: {
					kind: "create",
					id: action.id,
					input: sanitized
				}
			};
		}
		case "update":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"patch"
			])) return void 0;
			if (ideaId === void 0 || !updatePatch(action.patch)) return void 0;
			return {
				requestId: envelope.requestId,
				action: {
					kind: "update",
					ideaId,
					patch: action.patch
				}
			};
		case "move":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"status"
			])) return void 0;
			if (ideaId === void 0) return void 0;
			return action.status === "open" || action.status === "underReview" || action.status === "archived" ? {
				requestId: envelope.requestId,
				action: {
					kind: "move",
					ideaId,
					status: action.status
				}
			} : void 0;
		case "decline":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"decision"
			])) return void 0;
			if (ideaId === void 0 || !optionalString(action.decision)) return void 0;
			return action.decision === void 0 ? {
				requestId: envelope.requestId,
				action: {
					kind: "decline",
					ideaId
				}
			} : {
				requestId: envelope.requestId,
				action: {
					kind: "decline",
					ideaId,
					decision: action.decision
				}
			};
		case "deliver":
			if (!exactKeys(action, ["kind", "ideaId"])) return void 0;
			return ideaId === void 0 ? void 0 : {
				requestId: envelope.requestId,
				action: {
					kind: "deliver",
					ideaId
				}
			};
		case "triage":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"patch"
			])) return void 0;
			if (ideaId === void 0 || !triagePatch(action.patch)) return void 0;
			return {
				requestId: envelope.requestId,
				action: {
					kind: "triage",
					ideaId,
					patch: action.patch
				}
			};
		case "followUp":
			if (!exactKeys(action, [
				"kind",
				"ideaId",
				"input"
			])) return void 0;
			if (ideaId === void 0 || !followUpInput(action.input)) return void 0;
			return {
				requestId: envelope.requestId,
				action: {
					kind: "followUp",
					ideaId,
					input: action.input
				}
			};
		case "restore":
		case "delete":
			if (!exactKeys(action, ["kind", "ideaId"])) return void 0;
			return ideaId === void 0 ? void 0 : {
				requestId: envelope.requestId,
				action: {
					kind: action.kind,
					ideaId
				}
			};
		case "reorder":
			if (!exactKeys(action, ["kind", "orderedIds"])) return void 0;
			return reorderList(action.orderedIds) ? {
				requestId: envelope.requestId,
				action: {
					kind: "reorder",
					orderedIds: action.orderedIds
				}
			} : void 0;
		case "export":
			if (!exactKeys(action, ["kind", "workspaceId"])) return void 0;
			return action.workspaceId === void 0 || typeof action.workspaceId === "string" ? {
				requestId: envelope.requestId,
				action: {
					kind: "export",
					...action.workspaceId === void 0 ? {} : { workspaceId: action.workspaceId }
				}
			} : void 0;
		default: return;
	}
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
/** Structural repair of a persisted idea list (mirrors the import repair). */
function parseHostIdeas(rows) {
	const ideas = [];
	for (const value of rows) {
		if (typeof value !== "object" || value === null) continue;
		const row = value;
		if (typeof row.id !== "string" || row.id === "" || typeof row.title !== "string" || row.title.trim() === "") continue;
		const idea = {
			id: row.id,
			title: row.title.trim(),
			body: typeof row.body === "string" ? row.body.trim() : "",
			status: normalizeStatus(row.status),
			createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
			updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now()
		};
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
		const tags = normalizeTags(row.tags);
		if (tags !== void 0) idea.tags = tags;
		ideas.push(idea);
	}
	return ideas;
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
	disposed = false;
	constructor(options = {}) {
		this.now = options.now ?? Date.now;
		this.dir = options.dir ?? join(dshHome(), "ideas");
		this.file = join(this.dir, IDEAS_LEDGER_FILE_NAME);
		this.lockDir = join(this.dir, IDEAS_LOCK_FILE_NAME);
		this.lockOwnerFile = join(this.lockDir, LOCK_OWNER_FILE);
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
	*/
	applyRequest(requestId, action) {
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
			const result = this.apply(action);
			result.state = this.snapshot();
			return result;
		} catch (error) {
			this.requestCache.delete(requestId);
			throw error;
		}
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
	apply(action) {
		const now = this.now();
		const beforeIdeas = this.document.ideas;
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
				break;
			}
			case "update":
				if (this.document.ideas.find((item) => item.id === action.ideaId) === void 0) throw new Error("idea not found");
				if (action.patch.title !== void 0 && action.patch.title !== null) {
					if (action.patch.title.trim() === "") throw new Error("title is required");
				}
				this.document.ideas = this.document.ideas.map((item) => item.id === action.ideaId ? applyPatch(item, action.patch, this.now()) : item);
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
				if (idea.status === "open") {
					const ordered = triageOrderedIds(ideas, action.ideaId, action.patch.rank);
					const rankById = new Map(ordered.map((id, index) => [id, index + 1]));
					ideas = ideas.map((item) => ({
						...item,
						rank: rankById.get(item.id) ?? item.rank
					}));
				}
				this.document.ideas = ideas;
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
				break;
			}
			case "delete":
				if (this.document.ideas.find((item) => item.id === action.ideaId) === void 0) throw new Error("idea not found");
				this.document.ideas = this.document.ideas.filter((item) => item.id !== action.ideaId);
				break;
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
				if (maxImportedNumber > this.document.ideaSequence) this.document.ideaSequence = maxImportedNumber;
				this.document.importedSources = [...this.document.importedSources, action.sourceId];
				break;
			}
			case "export": return {
				state: this.snapshot(),
				export: buildIdeasExport(this.document.ideas, action.workspaceId)
			};
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
		return {
			schemaVersion: 1,
			revision: Number.isSafeInteger(parsed.revision) && (parsed.revision ?? -1) >= 0 ? parsed.revision : 0,
			ideas: parseHostIdeas(Array.isArray(parsed.ideas) ? parsed.ideas : []),
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
	/** Quarantine an unreadable document and start from an empty ledger. */
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
		console.error(`[dsh-plugin-ideas-manager] corrupt ideas ledger was quarantined: ${error instanceof Error ? error.message : String(error)}`);
		return document;
	}
	/** Atomic tmp+rename write; the tmp path never survives a successful commit. */
	writeAtomic(document) {
		const tmpFile = `${this.file}.tmp-${process.pid}`;
		writeFileSync(tmpFile, `${JSON.stringify(document, null, 2)}\n`);
		renameSync(tmpFile, this.file);
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
/** Apply one update patch to an idea (a null `tags` clears the label set). */
function applyPatch(idea, patch, now) {
	const next = {
		...idea,
		updatedAt: now
	};
	if (patch.title !== void 0 && patch.title !== null) next.title = patch.title.trim();
	if (patch.body !== void 0 && patch.body !== null) next.body = patch.body.trim();
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
/** Trim to undefined when blank (the wire keeps rationale/decision optional). */
function blankToUndefined(value) {
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/** Helper of `apply`: rank-sorted rows (unranked last). */
function rankOrdered(ideas) {
	return [...ideas].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
}
/**
* New rank order of the MOVED IDEA'S OWN WORKSPACE GROUP after inserting
* `movedId` at `rank` (1-based) inside the open ideas of that group; a missing
* rank appends. Only the group's ids are returned: the triage caller maps
* `rankById` over the whole document and keeps every other group's rank
* untouched (`?? item.rank`). Other workspace groups and the closed columns
* are never re-ranked by a triage.
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
//#region src/host-service.ts
/**
* Ideas host service: owns the ledger and fans its change notifications out to
* the SSE route, and (P2) schedules the optional one-way TaskBoard mirror.
* The board is a passive Host-authoritative store (unlike the task board's
* execution runner) — the only timer is the under-review poll, which watches
* for mirrored task cards passing `done` and moves the linked idea to
* `underReview` (the recette gate). No other background work runs.
*
* Mirror discipline (frozen design decision): the mirror is best-effort and
* asynchronous — committed ideas never roll back, a failed mirror only logs,
* and a replayed request id never re-mirrors. The bound card id is persisted
* on the idea through the ledger's internal `bindTaskBoardId` path (the wire
* gate never accepts taskBoardId).
*/
/** How often the under-review poll re-reads the task-board card statuses. */
const UNDER_REVIEW_POLL_MS = 3e4;
var IdeasHostService = class {
	ledger;
	listeners = /* @__PURE__ */ new Set();
	mirror;
	autoMirror;
	pendingMirrors = [];
	active = true;
	disposed = false;
	reviewPoll;
	constructor(options = {}) {
		this.ledger = options.ledger ?? new IdeasHostLedger(options.dir === void 0 ? {} : { dir: options.dir });
		this.mirror = options.mirror;
		this.autoMirror = options.autoMirror ?? true;
		this.ledger.subscribe(() => {
			this.emit();
		});
	}
	setActive(active) {
		this.active = active;
		this.emit();
	}
	snapshot() {
		const state = this.ledger.snapshot();
		return {
			schemaVersion: 1,
			revision: state.revision,
			ideas: state.ideas
		};
	}
	/** SSE frame payload; deliberately skips the ideas deep-clone of {@link snapshot}. */
	eventPayload() {
		return this.ledger.summary();
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	apply(requestId, action, initiator) {
		if (!this.active) throw new Error("ideas plugin is disabled");
		const result = this.ledger.applyRequest(requestId, action);
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
	* Start the under-review poll: every `intervalMs` the mirror's task-card
	* statuses are read and any open idea whose linked card is `done` moves to
	* `underReview` (the recette gate — the task is finished, human acceptance
	* still pending). No-op when the mirror is absent or autoMirror is off.
	*/
	startUnderReviewPoll(intervalMs = UNDER_REVIEW_POLL_MS) {
		if (this.reviewPoll !== void 0 || this.mirror === void 0 || !this.autoMirror) return;
		this.reviewPoll = setInterval(() => {
			this.pollUnderReviewTransitions();
		}, intervalMs);
	}
	/** One poll pass (exposed for tests). Best-effort: any failure is ignored. */
	async pollUnderReviewTransitions() {
		if (this.mirror === void 0 || !this.autoMirror || this.disposed) return;
		let statuses;
		try {
			statuses = await this.mirror.fetchTaskStatuses();
		} catch (error) {
			console.error(`[dsh-plugin-ideas-manager] under-review poll failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (statuses === void 0) return;
		for (const idea of this.ledger.snapshot().ideas) {
			if (idea.status !== "open" || idea.taskBoardId === void 0) continue;
			if (statuses.get(idea.taskBoardId) !== "done") continue;
			try {
				this.ledger.applyRequest(`under-review-${idea.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
					kind: "move",
					ideaId: idea.id,
					status: "underReview"
				});
			} catch (error) {
				console.error(`[dsh-plugin-ideas-manager] under-review transition failed for ${idea.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
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
	}
	emit() {
		for (const listener of [...this.listeners]) listener();
	}
	/**
	* Schedule the mirror for one applied action. The affected idea is read from
	* the POST-commit snapshot; the mirror op runs in the background and binds
	* the resolved card id when the idea is not yet bound (covers both the
	* create path and the bridge-activated-later self-heal).
	*/
	scheduleMirror(action, ideas) {
		if (!this.autoMirror || this.mirror === void 0) return;
		if (action.kind === "followUp") {
			const child = ideas.find((item) => item.followUpOfId === action.ideaId);
			if (child === void 0) return;
			const run = this.runMirror("create", child);
			this.pendingMirrors.push(run);
			run.finally(() => {
				const index = this.pendingMirrors.indexOf(run);
				if (index >= 0) this.pendingMirrors.splice(index, 1);
			});
			return;
		}
		const kind = mirrorKindOf(action);
		if (kind === void 0) return;
		const ideaId = actionIdeaId(action);
		const idea = ideas.find((item) => item.id === ideaId);
		if (idea === void 0) return;
		const run = this.runMirror(kind, idea);
		this.pendingMirrors.push(run);
		run.finally(() => {
			const index = this.pendingMirrors.indexOf(run);
			if (index >= 0) this.pendingMirrors.splice(index, 1);
		});
	}
	runMirror(kind, idea) {
		return (async () => {
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
		case "update": return "update";
		case "move": return action.status === "archived" ? "archive" : action.status === "open" ? "restore" : void 0;
		case "decline":
		case "deliver": return "archive";
		case "restore": return "restore";
		case "followUp": return;
		case "delete":
		case "reorder":
		case "triage":
		case "import":
		case "export": return;
	}
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
		case "delete": return action.ideaId;
		case "reorder":
		case "import":
		case "export": return;
	}
}
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
* literal, so backticks are structurally impossible here — the two code
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
* Installation is first-wins, mirroring the runtime registries' duplicate
* rule: an existing SKILL.md is never overwritten (a hand-edited copy stays
* the author's), only a missing file is written; a divergent present file is
* logged so the author knows the plugin ships a newer default. Delete the
* installed file to restore the bundled version. Best-effort by design — a
* filesystem failure (e.g. a read-only home) must never break plugin boot.
*/
/** Directory under the DSH home holding user-installed skills (user-dsh root). */
const DSH_SKILLS_DIR = "skills";
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
/**
* Install the bundled ideas-analyst skill (best-effort, first-wins).
* @param options - `home` DSH home override; `log` journaling seam.
* @returns the outcome; never throws (errors degrade to kept-existing/synced=false).
*/
function installIdeasAnalystSkill(options = {}) {
	const log = options.log ?? ((line) => {
		console.log(`[dsh-plugin-ideas-manager] ${line}`);
	});
	const target = installedSkillPath(options.home);
	try {
		if (existsSync(target)) {
			if (readFileSync(target, "utf8") === IDEAS_ANALYST_SKILL_CONTENT) return {
				path: target,
				synced: true,
				status: "matched"
			};
			log(`skill "${IDEAS_ANALYST_SKILL_NAME}" exists at ${target} and differs from the bundled copy; keeping the present file (first-wins). Delete it to restore the plugin default.`);
			return {
				path: target,
				synced: false,
				status: "kept-existing"
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
* `backlog` (the card is `read-only`); idea update -> task update; idea
* decline / move-to-archived -> task archive; idea restore -> task restore;
* idea delete -> no-op (the card outlives the idea — closing the loop to
* `done` is a manual run, never automated). Every failure is logged and the
* ideas ledger stays the source of truth: the mirror never rolls back a
* committed idea mutation.
*/
const TASK_BOARD_API_PREFIX = "/api/task-board";
/** Read-only permission stamped on every mirrored card. */
const MIRROR_TASK_PERMISSION = "read-only";
/** How often a failed/negative availability probe is retried. */
const PROBE_RETRY_MS = 3e4;
/** Per-self-request timeout; the mirror is best-effort and must not hang. */
const TRANSPORT_TIMEOUT_MS = 1e4;
/** Cap on mirror response bodies (a snapshot could be large; we only read status). */
const RESPONSE_CAP_BYTES = 128 * 1024;
/**
* Real transport: one loopback self-request per call to the Host's own
* origin, carrying the browser same-origin markers so the task-board route
* fence (socket + Host + Origin equality) accepts it without a token.
*/
var HttpTaskBoardTransport = class {
	getBase;
	/**
	* @param getBase - lazily resolved origin (http://127.0.0.1:port); the
	*   listen port is only known once the web server has bound its socket.
	*/
	constructor(getBase) {
		this.getBase = getBase;
	}
	getState() {
		return this.exchange("GET", `${TASK_BOARD_API_PREFIX}/state`);
	}
	postAction(envelope) {
		return this.exchange("POST", `${TASK_BOARD_API_PREFIX}/action`, JSON.stringify(envelope));
	}
	async exchange(method, path, body) {
		const base = this.getBase().replace(/\/$/, "");
		return new Promise((resolve, reject) => {
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
					size += chunk.length;
					if (size > RESPONSE_CAP_BYTES) {
						res.destroy();
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf8");
					let parsed;
					try {
						parsed = raw === "" ? void 0 : JSON.parse(raw);
					} catch {
						parsed = raw;
					}
					resolve({
						status: res.statusCode ?? 0,
						...parsed === void 0 ? {} : { body: parsed }
					});
				});
				res.on("error", (error) => reject(error));
			});
			outgoing.setTimeout(TRANSPORT_TIMEOUT_MS);
			outgoing.on("error", (error) => reject(error));
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
	*/
	async availableNow() {
		if (this.available) return true;
		if (this.now() - this.lastProbeAt < PROBE_RETRY_MS) return false;
		this.lastProbeAt = this.now();
		try {
			const result = await this.options.transport.getState();
			if (result.status === 200) {
				this.available = true;
				return true;
			}
			this.log(`task-board unavailable (GET ${TASK_BOARD_API_PREFIX}/state -> ${result.status}); mirror inactive`);
			return false;
		} catch (error) {
			this.log(`task-board probe failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
	/**
	* Resolve the bound task id, creating + moving the card to backlog when the
	* idea is not yet mirrored (the ladder used by update/decline too, so a
	* bridge activated after an idea's creation still catches it up).
	* @returns the task id to bind on the idea.
	*/
	async ensureTask(idea) {
		if (!await this.availableNow()) throw new TaskBoardUnavailableError();
		if (idea.taskBoardId !== void 0 && idea.taskBoardId !== "") {
			const statuses = await this.fetchTaskStatuses();
			if (statuses === void 0 || statuses.has(idea.taskBoardId)) return idea.taskBoardId;
		}
		return this.createCard(idea);
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
	/** Idea create -> task create (read-only, backlog) + move to backlog. */
	async mirrorCreate(idea) {
		if (!await this.availableNow()) throw new TaskBoardUnavailableError();
		return this.createCard(idea);
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
	/** The task-board plugin is not registered or did not answer. */
	get isUnavailable() {
		return !this.available;
	}
	async createCard(idea) {
		const taskId = `idea-${randomUUID()}`;
		await this.post({
			kind: "create",
			id: taskId,
			input: {
				title: idea.title,
				description: idea.body,
				prompt: this.taskPrompt(idea),
				permission: MIRROR_TASK_PERMISSION,
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
			description: idea.body,
			prompt: this.taskPrompt(idea),
			workspaceId: idea.workspaceId,
			...idea.tags === void 0 || idea.tags.length === 0 ? {} : { tags: idea.tags }
		};
	}
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
	taskPrompt(idea) {
		if (idea.tags !== void 0) {
			const lines = idea.tags.map((tag) => tag.promptPrefix?.trim() ?? "").filter((line) => line !== "");
			if (lines.length > 0) return lines.join("\n");
		}
		return `You are implementing the idea below${idea.ideaNumber === void 0 ? "" : ` #${String(idea.ideaNumber)}`} — "${idea.title}" — from the DSH Ideas board. Work in the current workspace directory.\n\nThe idea's spec (Body):\n${idea.body}`;
	}
	async post(action) {
		const requestId = `ideas-mirror-${randomUUID()}`;
		const result = await this.options.transport.postAction({
			requestId,
			action
		});
		if (result.status < 200 || result.status >= 300) throw new Error(`task-board ${action.kind} -> ${result.status}`);
	}
};
/** Thrown when the task-board plugin is absent; the service logs and moves on. */
var TaskBoardUnavailableError = class extends Error {
	constructor() {
		super("task-board plugin is not available");
	}
};
//#endregion
//#region src/http.ts
/** Default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
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
* Browser-signal tripwire, NOT an authority check: a bare curl sends neither
* header and is refused, but a curl with a forged Origin passes this too.
* The real boundary is the loopback socket + Host + origin-equality checks in
* isTrustedIdeasRequest below; do not rely on this marker alone.
*/
function browserSameOriginMarker(req) {
	return req.headers["sec-fetch-site"] === "same-origin" || typeof req.headers.origin === "string";
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
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > IMPORT_LIMIT) throw new Error("body-too-large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	return {
		raw,
		value: JSON.parse(raw)
	};
}
function makeIdeasRoutes(service) {
	const guard = (req, res) => {
		if (isTrustedIdeasRequest(req)) return true;
		writeJson(res, 403, {
			ok: false,
			error: "forbidden"
		}, { "cache-control": "no-store" });
		return false;
	};
	return [
		{
			kind: "exact",
			path: `${IDEAS_API_PREFIX}/state`,
			handler: (req, res) => {
				if (req.method !== "GET") return writeJson(res, 405, {
					ok: false,
					error: "method-not-allowed"
				}, { "cache-control": "no-store" });
				if (!guard(req, res)) return;
				writeJson(res, 200, service.snapshot(), { "cache-control": "no-store" });
			}
		},
		{
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
					if (parsed.action.kind !== "import" && Buffer.byteLength(body.raw) > ACTION_LIMIT) return writeJson(res, 413, {
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
		},
		{
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
		}
	];
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

Workflow: (1) CAPTURE into the ledger, never into a markdown file: title + a body holding the analysis as markdown (context, value, effort, first-step sketch / execution info, risks). (2) On capture, record a PRIORITY OPINION: set value + effort levels and suggest a rank. (3) RE-RANK the whole open backlog against the current project state on every material change (new idea, delivery, scope change): the Priorities ranking stays the current best ordering, never a plain append; re-rank only on material change and ranks stay advisory (scheduling is the author's call). (4) LIFECYCLE: finished work moves to UNDER REVIEW (the recette gate; automatically when its task-board card reaches done); a recette OK delivers the idea (archived, stamped), a recette NOK raises a linked follow-up idea (child, open) and archives the parent, or declines it. (5) TaskBoard mirror (when the task-board plugin is present; one-way, best-effort): capture -> backlog card, updates -> card update, decline -> archive; delivered cards are closed by the author's closure run (done is runner-owned — never automate idea -> done from here). The board is autonomous without the task-board plugin.`;
/**
* Settings namespace of the ideas announcement capability — the section the
* web settings surface will edit (P1). Spelled here rather than imported: the
* browser half spells the same value and must not depend on a Host package.
*/
const IDEAS_SETTINGS_NAMESPACE = "ideas";
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
	if (config?.autoMirror ?? true) host.startUnderReviewPoll();
	ctx.effect(() => {
		const disposers = [];
		try {
			for (const route of makeIdeasRoutes(host)) disposers.push(ctx.webServer.register(route));
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
export { Config, IDEAS_GUIDANCE, IDEAS_SETTINGS_NAMESPACE, apply, inject };
