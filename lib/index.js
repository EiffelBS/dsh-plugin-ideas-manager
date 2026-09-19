import z from "schemastery";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
* Open ideas go to the main document; archived/declined ideas go to the
* archive document.
*/
function buildIdeasExport(ideas, workspaceId) {
	const filter = workspaceId === void 0 ? void 0 : (idea) => idea.workspaceId === workspaceId;
	const open = ideas.filter((idea) => idea.status === "open" && (filter === void 0 || filter(idea)));
	const closed = ideas.filter((idea) => idea.status !== "open" && (filter === void 0 || filter(idea)));
	return {
		ideasMd: ideasToMarkdown(open, "IDEAS", "open ideas"),
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
			return action.status === "open" || action.status === "archived" ? {
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
				if (idea.status !== "open") break;
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
				const rankById = new Map(ordered.map((id, index) => [id, index + 1]));
				this.document.ideas = this.document.ideas.map((idea) => ({
					...idea,
					rank: rankById.get(idea.id) ?? idea.rank
				}));
				break;
			}
			case "import": {
				if (this.document.importedSources.includes(action.sourceId)) return { state: this.snapshot() };
				const merged = new Map(this.document.ideas.map((idea) => [idea.id, idea]));
				for (const idea of parseHostIdeas(action.ideas)) merged.set(idea.id, merged.has(idea.id) ? {
					...merged.get(idea.id),
					...idea,
					updatedAt: now
				} : idea);
				this.document.ideas = [...merged.values()];
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
* Column-major order after inserting `movedId` at `rank` (1-based) inside the
* open backlog; a missing rank appends. Closed columns keep their order.
*/
function triageOrderedIds(ideas, movedId, rank) {
	const openOthers = rankOrdered(ideas.filter((idea) => idea.status === "open" && idea.id !== movedId)).map((idea) => idea.id);
	const maxRank = openOthers.length + 1;
	const position = rank === void 0 ? maxRank : Math.min(Math.max(1, Math.trunc(rank)), maxRank);
	openOthers.splice(position - 1, 0, movedId);
	const closed = rankOrdered(ideas.filter((idea) => idea.status !== "open")).map((idea) => idea.id);
	return [...openOthers, ...closed];
}
//#endregion
//#region src/host-service.ts
/**
* Ideas host service: owns the ledger and fans its change notifications out to
* the SSE route, and (P2) schedules the optional one-way TaskBoard mirror.
* No timers, no sessions — the ideas board is a passive Host-authoritative
* store (unlike the task board's execution runner).
*
* Mirror discipline (frozen in HANDOVER §2.3): the mirror is best-effort and
* asynchronous — committed ideas never roll back, a failed mirror only logs,
* and a replayed request id never re-mirrors. The bound card id is persisted
* on the idea through the ledger's internal `bindTaskBoardId` path (the wire
* gate never accepts taskBoardId).
*/
var IdeasHostService = class {
	ledger;
	listeners = /* @__PURE__ */ new Set();
	mirror;
	autoMirror;
	pendingMirrors = [];
	active = true;
	disposed = false;
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
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
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
		case "move": return action.status === "archived" ? "archive" : "restore";
		case "decline":
		case "deliver": return "archive";
		case "restore": return "restore";
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
		case "restore":
		case "delete": return action.ideaId;
		case "reorder":
		case "import":
		case "export": return;
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
* Mapping (frozen in HANDOVER §2.3): idea create -> task create + move to
* `backlog` (the card is `read-only`); idea update -> task update; idea
* decline / move-to-archived -> task archive; idea restore -> task restore;
* idea delete -> no-op (the card outlives the idea — closing the loop to
* `done` is a manual run, never automated). Every failure is logged and the
* ideas ledger stays the source of truth: the mirror never rolls back a
* committed idea mutation.
*/
const TASK_BOARD_API_PREFIX = "/api/task-board";
/** Read-only permission stamped on every mirrored card (HANDOVER §1). */
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
		if (idea.taskBoardId !== void 0 && idea.taskBoardId !== "") return idea.taskBoardId;
		return this.createCard(idea);
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
	/** The executable prompt = the tag prompt lines, one per line. */
	taskPrompt(idea) {
		if (idea.tags === void 0) return "";
		return idea.tags.map((tag) => tag.promptPrefix?.trim() ?? "").filter((line) => line !== "").join("\n");
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
const IDEAS_GUIDANCE = `dsh-plugin-ideas-manager is installed (generic idea manager, "Ideas" board in the sidebar under New Session): a Host-authoritative /api/ideas ledger, one idea record per workspace (workspaceId; absent = generic), rendered as a 3-column kanban (open / archived / declined) with an Overview tab and a ranked Priorities tab. The ledger is the SOURCE OF TRUTH for ideas — it replaces any IDEAS.md / IDEAS-ARCHIVE.md file convention; the markdown export is a generated view only (ledger -> IDEAS.md / IDEAS-ARCHIVE.md), never parsed back. When the user mentions ideas / backlog / idees / notes, collaborate through this board.

Workflow: (1) CAPTURE into the ledger, never into a markdown file: title + a body holding the analysis as markdown (context, value, effort, first-step sketch / execution info, risks). (2) On capture, record a PRIORITY OPINION: set value + effort levels and suggest a rank. (3) RE-RANK the whole open backlog against the current project state on every material change (new idea, delivery, scope change): the Priorities ranking stays the current best ordering, never a plain append; re-rank only on material change and ranks stay advisory (scheduling is the author's call). (4) LIFECYCLE: delivered ideas leave the open backlog with a record of the delivery; declined ideas leave with a decision note. (5) TaskBoard mirror (when the task-board plugin is present; one-way, best-effort): capture -> backlog card, updates -> card update, decline -> archive; delivered cards are closed by the author's closure run (done is runner-owned — never automate idea -> done from here). The board is autonomous without the task-board plugin.`;
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
	const host = new IdeasHostService({
		mirror: new TaskBoardMirror({ transport: new HttpTaskBoardTransport(() => `http://127.0.0.1:${ctx.webServer.port}`) }),
		autoMirror: config?.autoMirror ?? true
	});
	host.setActive(config?.enabled ?? true);
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
