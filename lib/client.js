window.__ModuleLoader__.load({
	id: "dsh-plugin-ideas-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_dom_client = require("react-dom/client");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/core/ideas.ts
		/** The kanban columns in display order (underReview sits between open and archived). */
		const IDEA_COLUMNS = [
			"open",
			"underReview",
			"archived",
			"declined"
		];
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
		//#endregion
		//#region src/protocol.ts
		const IDEAS_API_PREFIX = "/api/ideas";
		function record(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		/**
		* Panel tabs, mirror of BOARD_TABS (src/client/tabs.ts): spelled here so the
		* host bundle never pulls the client model — same discipline as the defaults.
		*/
		const IDEAS_TABS = [
			"overview",
			"priorities",
			"delivered"
		];
		/** Card densities offered by the settings row. */
		const IDEAS_DENSITIES = ["comfortable", "compact"];
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
			cardDensity: "comfortable"
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
				cardDensity: oneOf(row.cardDensity, IDEAS_DENSITIES, IDEAS_SETTINGS_DEFAULTS.cardDensity)
			};
		}
		//#endregion
		//#region src/client/ideas-client.ts
		function uuid$1() {
			return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		}
		var IdeasClient = class {
			transport;
			boardOpen = false;
			snapshot;
			error;
			pending = false;
			/** Display settings (tag rows ...); the spelled defaults until the config route answers. */
			config = {
				available: false,
				value: IDEAS_SETTINGS_DEFAULTS
			};
			/** Last config write failure verbatim ('settings-conflict' | wire message); cleared on success. */
			configError;
			/** Whether a config write is in flight (the settings row disables its input). */
			configPending = false;
			/** Whether the first config load has SETTLED (available or not) — the board
			*  applies persisted preferences once, guarded on this flag. */
			configLoaded = false;
			/**
			* Phase 3: optional "Start AI analysis and create the idea" launcher,
			* resolved from the DSH session controller. Undefined keeps the plain
			* manual Create for workspace-targeted captures.
			*/
			sessionLauncher;
			listeners = /* @__PURE__ */ new Set();
			unsubscribeEvents;
			workspaces = [];
			workspacesSource;
			activeWorkspaceSource;
			unsubscribeWorkspaces;
			unsubscribeActive;
			constructor(transport, workspacesSource, activeWorkspaceSource) {
				this.transport = transport;
				this.workspacesSource = workspacesSource;
				this.activeWorkspaceSource = activeWorkspaceSource;
				if (this.workspacesSource !== void 0 || this.activeWorkspaceSource !== void 0) {
					this.syncWorkspaces();
					this.unsubscribeWorkspaces = this.workspacesSource?.subscribe(() => {
						this.syncWorkspaces();
					});
					this.unsubscribeActive = this.activeWorkspaceSource?.subscribe(() => {
						this.syncWorkspaces();
					});
				}
			}
			/** The workspace of the current session (undefined when unknown). */
			get activeWorkspace() {
				return this.activeWorkspaceSource?.current();
			}
			/** Current DSH registry rows (id + label); empty when the service is absent. */
			get workspaceOptions() {
				return this.workspaces;
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			toggleBoard() {
				const wasOpen = this.boardOpen;
				this.boardOpen = !this.boardOpen;
				if (!wasOpen && this.boardOpen) this.refresh();
				this.emit();
			}
			closeBoard() {
				if (!this.boardOpen) return;
				this.boardOpen = false;
				this.emit();
			}
			/** Initial load + short-poll refresh while the board is open. */
			start() {
				this.refresh();
				this.loadConfig();
				try {
					this.unsubscribeEvents = this.transport.subscribe(() => {
						this.refresh();
					}, () => this.boardOpen);
				} catch (error) {
					console.error("[dsh-plugin-ideas-manager] event subscription failed", error);
				}
			}
			dispose() {
				this.unsubscribeEvents?.();
				this.unsubscribeWorkspaces?.();
				this.unsubscribeActive?.();
				this.workspacesSource?.dispose();
				this.activeWorkspaceSource?.dispose();
				this.listeners.clear();
			}
			async refresh() {
				try {
					this.snapshot = await this.transport.state();
					this.error = void 0;
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
				}
				this.emit();
			}
			/**
			* Load the display settings once at start(). A transport without the
			* capability, an older Host (404), or a fence refusal all land on the same
			* graceful outcome: `available: false` and the spelled defaults — the board
			* must never depend on the settings surface.
			*/
			async loadConfig() {
				if (this.transport.config === void 0) {
					this.config = {
						available: false,
						value: IDEAS_SETTINGS_DEFAULTS
					};
					this.configLoaded = true;
					this.emit();
					return;
				}
				try {
					const view = await this.transport.config();
					this.config = {
						...view,
						value: sanitizeSettings(view.value)
					};
					this.configError = void 0;
				} catch (error) {
					console.warn("[dsh-plugin-ideas-manager] settings load failed", error);
					this.config = {
						available: false,
						value: IDEAS_SETTINGS_DEFAULTS
					};
				}
				this.configLoaded = true;
				this.emit();
			}
			/**
			* Persist a settings patch (revision-fenced by the view the client holds).
			* Failures surface verbatim as `configError` ('settings-conflict' and
			* 'settings-unavailable' are wire codes the section localizes); the stored
			* value only moves on success, so the settings row reverts for free.
			*/
			async saveConfig(patch) {
				if (this.transport.saveConfig === void 0 || !this.config.available) {
					this.configError = "settings-unavailable";
					this.emit();
					return;
				}
				this.configPending = true;
				this.configError = void 0;
				this.emit();
				try {
					this.config = await this.transport.saveConfig(patch, this.config.revision);
					this.configError = void 0;
				} catch (error) {
					this.configError = error instanceof Error ? error.message : String(error);
				} finally {
					this.configPending = false;
					this.emit();
				}
			}
			async createIdea(input) {
				const tags = tagNames(input.tags).map((name) => ({ name }));
				await this.run({
					kind: "create",
					id: uuid$1(),
					input: {
						title: input.title,
						body: input.body,
						...input.value === void 0 ? {} : { value: input.value },
						...input.effort === void 0 ? {} : { effort: input.effort },
						...input.rationale === void 0 || input.rationale === "" ? {} : { rationale: input.rationale },
						...input.rank === void 0 ? {} : { rank: input.rank },
						...input.workspaceId === void 0 || input.workspaceId === "" ? {} : { workspaceId: input.workspaceId },
						...tags.length === 0 ? {} : { tags }
					}
				});
			}
			async updateIdea(ideaId, patch) {
				const tags = patch.tags === void 0 ? void 0 : tagNames(patch.tags);
				await this.run({
					kind: "update",
					ideaId,
					patch: {
						...patch.title === void 0 ? {} : { title: patch.title },
						...patch.body === void 0 ? {} : { body: patch.body },
						...patch.value === void 0 ? {} : { value: patch.value },
						...patch.effort === void 0 ? {} : { effort: patch.effort },
						...patch.rationale === void 0 ? {} : { rationale: patch.rationale },
						...patch.workspaceId === void 0 ? {} : { workspaceId: patch.workspaceId },
						...tags === void 0 ? {} : { tags: tags.length === 0 ? null : tags.map((name) => ({ name })) }
					}
				});
			}
			async moveIdea(ideaId, status) {
				await this.run({
					kind: "move",
					ideaId,
					status
				});
			}
			async declineIdea(ideaId, decision) {
				const note = decision?.trim();
				await this.run(note === void 0 || note === "" ? {
					kind: "decline",
					ideaId
				} : {
					kind: "decline",
					ideaId,
					decision: note
				});
			}
			/** Mark an open idea delivered: archived + deliveredAt, card mirror archived. */
			async deliverIdea(ideaId) {
				await this.run({
					kind: "deliver",
					ideaId
				});
			}
			/**
			* Record the priority opinion (value/effort/rationale) and re-insert the
			* idea at the suggested rank inside the open backlog (transactional re-rank).
			*/
			async triageIdea(ideaId, patch) {
				await this.run({
					kind: "triage",
					ideaId,
					patch: {
						...patch.value === void 0 ? {} : { value: patch.value },
						...patch.effort === void 0 ? {} : { effort: patch.effort },
						...patch.rationale === void 0 ? {} : { rationale: patch.rationale },
						...patch.rank === void 0 ? {} : { rank: patch.rank }
					}
				});
			}
			/**
			* Recette NOK: create a child follow-up idea (linked to `ideaId` and
			* carrying the summary + justification) and archive the parent — one atomic
			* commit. The parent must currently be under review.
			*/
			async followUpIdea(ideaId, input) {
				await this.run({
					kind: "followUp",
					ideaId,
					input
				});
			}
			async restoreIdea(ideaId) {
				await this.run({
					kind: "restore",
					ideaId
				});
			}
			/**
			* Start an analyst re-run on an existing idea (human-triggered): the Host
			* stamps the cycle and preserves the current content as the prior-analysis
			* audit trail; the caller then launches a fresh analyst session whose
			* update+triage overwrite the card.
			*/
			async reanalyzeIdea(ideaId) {
				await this.run({
					kind: "reanalyze",
					ideaId
				});
			}
			async deleteIdea(ideaId) {
				await this.run({
					kind: "delete",
					ideaId
				});
			}
			async reorderIdea(orderedIds) {
				await this.run({
					kind: "reorder",
					orderedIds
				});
			}
			/** Republish the DSH registry rows and wake the board (catalog refresh). */
			syncWorkspaces() {
				this.workspaces = this.workspacesSource?.list() ?? [];
				this.emit();
			}
			/** Post one action, adopt the Host snapshot, and expose errors. */
			async run(action) {
				this.pending = true;
				this.emit();
				try {
					this.snapshot = await this.transport.action(action);
					this.error = void 0;
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
					throw error;
				} finally {
					this.pending = false;
					this.emit();
				}
			}
			emit() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		/** Trim a comma-separated input into clean tag names. */
		function tagNames(raw) {
			return (raw ?? []).flatMap((line) => line.split(",")).map((tag) => tag.trim()).filter((tag) => tag !== "");
		}
		//#endregion
		//#region src/client/host-api.ts
		/**
		* Browser transport for the /api/ideas Host API. Same-origin fetch with the
		* loopback guards (the Host fence requires browser same-origin markers, which
		* plain fetch sends automatically), plus a short-poll subscription standing
		* in for the former SSE stream (see `subscribe` for the connection-pool
		* rationale). Mirrors the dsh-task-board host-api discipline.
		*/
		const REQUEST_TIMEOUT_MS = 15e3;
		/** Poll cadence replacing the SSE subscription (see subscribe doc). */
		const SUBSCRIBE_POLL_MS = 2500;
		function uuid() {
			return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		}
		async function readJson(response) {
			const body = await response.json();
			if (!response.ok) throw new Error(body.error ?? `ideas request failed: ${response.status}`);
			return body;
		}
		var HttpIdeasHostTransport = class {
			async state() {
				return await this.request(`${IDEAS_API_PREFIX}/state`, { cache: "no-store" });
			}
			async action(action, initiator) {
				return await this.post(uuid(), action, initiator);
			}
			async config() {
				return await this.request(`${IDEAS_API_PREFIX}/config`, { cache: "no-store" });
			}
			async saveConfig(patch, expectedRevision) {
				return await this.request(`${IDEAS_API_PREFIX}/config`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						patch,
						...expectedRevision === void 0 ? {} : { expectedRevision }
					})
				});
			}
			async post(requestId, action, initiator) {
				const envelope = {
					requestId,
					action,
					...initiator === void 0 || initiator === "" ? {} : { initiator }
				};
				return await this.request(`${IDEAS_API_PREFIX}/action`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(envelope)
				});
			}
			async request(url, init) {
				const controller = new AbortController();
				const timeout = globalThis.setTimeout(() => {
					controller.abort();
				}, REQUEST_TIMEOUT_MS);
				try {
					return await readJson(await fetch(url, {
						...init,
						signal: controller.signal
					}));
				} catch (error) {
					if (controller.signal.aborted) throw new Error(`ideas Host request timed out after ${REQUEST_TIMEOUT_MS / 1e3}s`);
					throw error;
				} finally {
					globalThis.clearTimeout(timeout);
				}
			}
			/**
			* Poll `state` instead of holding an EventSource. Rationale: the browser
			* caps HTTP/1.1 connections per origin (~6) across ALL tabs; each ongoing
			* SSE (ours, task-board's, the shell HMR's) pins one slot forever, so two
			* tabs exhaust the pool and a page reload starves every fetch — surfacing
			* as "Host request timed out after 15s" in a refresh loop. Polling keeps
			* every request short-lived and returns its slot to the pool.
			* @param listener - called whenever a refresh opportunity arrives.
			* @param isActive - when given, polls only while it returns true (board
			*   open); a closed board consumes no connections and no traffic.
			*/
			subscribe(listener, isActive) {
				let running = true;
				const tick = () => {
					if (!running) return;
					if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
					if (isActive !== void 0 && !isActive()) return;
					listener();
				};
				const timer = globalThis.setInterval(tick, SUBSCRIBE_POLL_MS);
				const onVisible = () => {
					if (running && typeof document !== "undefined" && document.visibilityState === "visible") tick();
				};
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
				return () => {
					running = false;
					globalThis.clearInterval(timer);
					if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
				};
			}
		};
		//#endregion
		//#region src/client/body-mutations.ts
		/** Cross-bundle registry key; `Symbol.for` so every module copy agrees. */
		const HUB_KEY = Symbol.for("dsh-web.body-mutation-hub");
		const INVALIDATION_ONLY = Symbol.for("dsh-web.body-mutation-invalidation");
		function needsRecords(subscribers) {
			for (const listener of subscribers) if (!listener[INVALIDATION_ONLY]) return true;
			return false;
		}
		/**
		* Subscribe to a coalesced DOM re-check without retaining mutation records.
		*/
		function subscribeBodyInvalidations(subscriber) {
			const listener = () => {
				subscriber();
			};
			listener[INVALIDATION_ONLY] = true;
			return subscribeBodyMutations(listener);
		}
		/**
		* Subscribe to body-level childList mutations.
		* @param subscriber - called at most once per animation frame with the records
		*   collected since the previous flush; must be safe to run repeatedly.
		* @returns the disposer removing this subscriber (and the observer when it was
		*   the last one).
		*/
		function subscribeBodyMutations(subscriber) {
			if (typeof globalThis === "undefined" || typeof document === "undefined") return () => {};
			if (typeof MutationObserver !== "function") return () => {};
			const registry = globalThis;
			let hub = registry[HUB_KEY];
			if (hub === void 0) {
				const subscribers = /* @__PURE__ */ new Set();
				const created = {
					observer: void 0,
					subscribers,
					pending: [],
					scheduled: false
				};
				const flush = () => {
					created.frame = void 0;
					created.scheduled = false;
					const batch = created.pending;
					created.pending = [];
					for (const listener of [...subscribers]) {
						if (!subscribers.has(listener)) continue;
						try {
							listener(batch);
						} catch {}
					}
				};
				const schedule = () => {
					if (created.scheduled) return;
					created.scheduled = true;
					if (typeof requestAnimationFrame === "function") created.frame = requestAnimationFrame(flush);
					else flush();
				};
				created.observer = new MutationObserver((records) => {
					if (needsRecords(subscribers)) for (const record of records) created.pending.push(record);
					schedule();
				});
				created.observer.observe(document.body ?? document.documentElement, {
					childList: true,
					subtree: true
				});
				registry[HUB_KEY] = created;
				hub = created;
			}
			const active = hub;
			active.subscribers.add(subscriber);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				active.subscribers.delete(subscriber);
				if (!needsRecords(active.subscribers)) active.pending = [];
				if (active.subscribers.size === 0 && registry[HUB_KEY] === active) {
					active.observer.disconnect();
					if (active.frame !== void 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(active.frame);
					active.frame = void 0;
					active.pending = [];
					active.scheduled = false;
					delete registry[HUB_KEY];
				}
			};
		}
		//#endregion
		//#region src/client/panel-mount-core.ts
		/**
		* Center-column panel takeover lifecycle (same discipline as the
		* dsh-task-board / dsh-ssh family).
		*
		* The `conversation` slot is single-occupant and external plugins cannot
		* declare slots, so a family panel takes over the center column at the DOM
		* level: a container is appended inside the center column as an extra
		* trailing child React never manages, and a stylesheet rule hides the
		* conversation content while the panel is active. Toggling is a data
		* attribute on <html> — no React involvement, so the conversation subtree
		* underneath stays mounted and stateful.
		*/
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"]";
		/** Cross-plugin activation event; detail is the activating panel name. */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
		/** Find the center column, or undefined while the frame is not mounted. */
		function conversationColumn() {
			return document.querySelector(CONVERSATION_COLUMN_SELECTOR) ?? void 0;
		}
		/**
		* Mount a family panel into the center column and bind its visibility to the
		* owning controller's open state.
		* @returns disposer unmounting the tree and restoring the column.
		*/
		function mountCenterPanel(options) {
			let broadcasting = false;
			let root;
			let container;
			const ensure = () => {
				if (container !== void 0 && !container.isConnected) {
					root?.unmount();
					root = void 0;
					container.remove();
					container = void 0;
				}
				if (container === void 0) {
					const column = conversationColumn();
					if (column === void 0) return;
					container = document.createElement("div");
					container.dataset[options.viewDatasetKey] = "";
					container.dataset.dshPlugin = options.pluginName;
					container.className = options.viewClassName;
					column.appendChild(container);
				}
				if (root !== void 0 || !options.isOpen()) return;
				root = (0, react_dom_client.createRoot)(container);
				options.render(root);
			};
			const unsubscribeBody = subscribeBodyInvalidations(() => {
				ensure();
			});
			const applyActive = () => {
				if (options.isOpen()) {
					ensure();
					for (const attribute of options.siblingActiveAttributes) document.documentElement.removeAttribute(attribute);
					document.documentElement.setAttribute(options.activeAttribute, "");
					broadcasting = true;
					try {
						for (const detail of [options.panelName, ...options.evictDetails ?? []]) document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail }));
					} finally {
						broadcasting = false;
					}
				} else document.documentElement.removeAttribute(options.activeAttribute);
			};
			const onOtherActivate = (event) => {
				if (broadcasting) return;
				const detail = event.detail;
				if (detail !== void 0 && options.siblingPanelNames.includes(detail) && options.isOpen()) options.close();
			};
			const onClickSidebarRow = (event) => {
				if (!options.isOpen()) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) options.close();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			const unsubscribe = options.subscribe(applyActive);
			applyActive();
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				unsubscribeBody();
				unsubscribe();
				document.documentElement.removeAttribute(options.activeAttribute);
				root?.unmount();
				root = void 0;
				container?.remove();
				container = void 0;
			};
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Ideas board copy: per-document-language dictionary (`fr` and `en`) with an
		* English default. Kept dependency-free (no dsh locale service) so the
		* DOM-injected entry row and the standalone board tree share one lookup.
		*/
		const fr = {
			"entry.label": "Idées",
			"entry.tooltip": "Tableau des idées",
			"board.title": "Idées",
			"board.close": "Retour au chat",
			"board.new": "Nouvelle idée",
			"board.search": "Filtrer les idées…",
			"board.revision": "révision {revision}",
			"board.status.open": "Ouvertes",
			"board.status.archived": "Archivées",
			"board.status.declined": "Refusées",
			"board.empty": "Aucune idée ici",
			"board.emptyFiltered": "Aucune idée ne correspond au filtre",
			"board.hostError": "Échec de l'opération Host : {error}",
			"board.retryHost": "Réessayer la connexion Host",
			"board.tagFilter": "Filtre :",
			"board.tagFilterSearch": "Rechercher une étiquette…",
			"board.tagFilterNoMatch": "Aucune étiquette correspondante",
			"board.tagFilterClear": "Effacer le filtre",
			"settings.nav": "Tableau des idées",
			"settings.title": "Options du tableau des idées",
			"settings.intro": "Préférences d’affichage du panneau Idées, enregistrées dans les réglages de ce profil DSH et appliquées immédiatement (sans redémarrage).",
			"settings.group": "Affichage du panneau",
			"settings.tagRows": "Lignes de filtre d’étiquettes visibles",
			"settings.tagRowsDesc": "Nombre total de lignes de tags avant que la zone ne défile : de 1 à 5, 3 par défaut. La première ligne partage l’espace avec la recherche et le bouton « Effacer le filtre » ; les tags restent accessibles en défilant.",
			"settings.loading": "Chargement des réglages…",
			"settings.unavailable": "Réglages indisponibles dans ce déploiement : la valeur par défaut s’applique.",
			"settings.saveFailed": "Échec de l’enregistrement : ",
			"settings.conflict": "Les réglages ont changé ailleurs — réessayez.",
			"settings.groupBehavior": "Comportement du panneau",
			"settings.defaultTab": "Onglet affiché à l’ouverture",
			"settings.defaultTabDesc": "Section du tableau ouverte au démarrage du panneau : Aperçu, Priorités ou Livraisons. Changer d’onglet en cours de session reste libre et sert de repli si les réglages sont indisponibles.",
			"settings.renderMarkdown": "Descriptions en Markdown par défaut",
			"settings.renderMarkdownDesc": "Affiche le corps des cartes en Markdown rendu dès l’ouverture ; le bouton MD/Texte de l’en-tête bascule librement en cours de session. Activé par défaut.",
			"settings.rememberScope": "Mémoriser le périmètre workspace",
			"settings.rememberScopeDesc": "Quand c’est activé, le panneau rouvre sur le dernier espace de travail sélectionné au lieu de revenir à Tous les espaces. Désactivé par défaut.",
			"settings.confirmLifecycle": "Confirmer Livrer et Refuser",
			"settings.confirmLifecycleDesc": "Demande une confirmation en place (Oui/Non) avant Livrer ou Refuser, comme pour Supprimer. Désactivé par défaut : ces actions s’appliquent en un clic.",
			"settings.hideDeclined": "Masquer la colonne Refusées",
			"settings.hideDeclinedDesc": "N’affiche pas la colonne Refusées du tableau (gain de place). Les idées refusées quittent la vue kanban : elles restent dans le ledger et l’export markdown. Désactivé par défaut.",
			"settings.cardDensity": "Densité des cartes",
			"settings.cardDensityDesc": "Confortable : rendu complet. Compacte : les cartes de l’Aperçu ET les lignes de Priorités/Livraisons masquent les étiquettes, la description, la date et le workspace, avec des espacements réduits — titre et badges valeur/effort restent.",
			"settings.densityComfortable": "Confortable",
			"settings.densityCompact": "Compacte",
			"card.confirmLifecycle": "Confirmer cette action ?",
			"board.dragHint": "Glissez les cartes entre Ouvertes et Archivées (poignée ⠿ en haut du titre)",
			"board.mdToggleLabel": "Affichage des descriptions",
			"board.mdView": "MD",
			"board.textView": "Texte",
			"board.workspace": "Espace de travail",
			"board.allWorkspaces": "Tous les espaces",
			"board.noWorkspace": "— sans espace —",
			"board.workspaceHint": "Restreindre le tableau à un espace de travail",
			"board.settings": "Ouvrir les options du tableau des idées",
			"tab.label": "Sections du tableau des idées",
			"tab.overview": "Aperçu",
			"tab.priorities": "Priorités",
			"tab.delivered": "Livraisons",
			"delivered.hint": "Journal des idées sorties du backlog (archivées) — estampille verte pour les livrées, neutre pour les archivées manuellement",
			"delivered.empty": "Aucune idée archivée pour l’instant",
			"delivered.deliverAt": "livrée {date}",
			"delivered.archivedAt": "archivée {date}",
			"delivered.archivedHint": "Idée archivée (abandonnée) — restaurer pour la rouvrir",
			"priorities.hint": "Classement suggéré du backlog ouvert, relatif dans chaque groupe d'espace de travail (les idées sans espace se classent ensemble) — utilisez les flèches ou glissez-déposez pour ajuster",
			"priorities.empty": "Aucune idée ouverte à classer",
			"priorities.moveUp": "Monter d’un rang",
			"priorities.moveDown": "Descendre d’un rang",
			"priorities.rationale": "Justificatif :",
			"new.title": "Titre",
			"new.titlePlaceholder": "Une phrase qui résume l'idée",
			"new.body": "Description",
			"new.bodyPlaceholder": "Contexte, valeur, effort, acceptation (optionnel)",
			"new.tags": "Étiquettes (optionnelles)",
			"new.tagsPlaceholder": "séparées par des virgules",
			"new.rationale": "Justificatif de priorité (optionnel)",
			"new.rationalePlaceholder": "Pourquoi ce rang ? (valeur, effort, dépendances, état du projet)",
			"new.rank": "Rang suggéré (optionnel)",
			"new.rankValueEffortHint": "Priorité relative au backlog ouvert de l'espace de travail de l'idée : rang = position (triage insère et réordonne les rangs existants), valeur/effort = 1 faible, 2 moyen, 3 élevé",
			"new.rankInvalid": "Le rang doit être un entier positif (1 = premier du backlog ouvert de l'espace de travail de l'idée)",
			"new.value": "Valeur",
			"new.effort": "Effort",
			"new.levelNone": "— non défini —",
			"new.submit": "Créer",
			"new.submitAi": "Lancer l'analyse IA et créer l'idée",
			"new.aiCaptureHint": "Une nouvelle session analysera l'idée, la créera dans le backlog de cet espace (ou fusionnera un doublon) et vous fera un rapport du classement retenu.",
			"new.cancel": "Annuler",
			"new.required": "Le titre est requis",
			"new.workspace": "Espace de travail",
			"new.workspaceNone": "— sans espace —",
			"new.model": "Modèle pour l'analyse",
			"new.modelProvider": "Provider",
			"new.modelFilterPlaceholder": "Rechercher un modèle…",
			"new.modelSessionDefault": "Hériter de la session (défaut)",
			"new.modelHint": "Présélectionné avec le modèle de votre session ; choisissez un provider puis un modèle pour en forcer un autre, ou laissez « Hériter de la session » pour que la session d'analyse garde son modèle par défaut",
			"new.sessionWorkspaceHint": "Espace de la session courante — modifiable",
			"card.drag": "Faire glisser",
			"card.clickToEdit": "Cliquer pour modifier",
			"card.value": "Valeur {level}",
			"card.effort": "Effort {level}",
			"card.updated": "màj {date}",
			"card.edit": "Modifier",
			"card.archive": "Archiver",
			"card.decline": "Refuser",
			"card.deliver": "Livrer",
			"card.deliverHint": "Marquer comme livrée (archivée + estampillée à la date du jour)",
			"card.delivered": "Livrée {date}",
			"card.deliveredHint": "Idée livrée — cliquer pour modifier ou restaurer",
			"card.restore": "Restaurer",
			"card.delete": "Supprimer",
			"card.confirmDelete": "Confirmer la suppression ?",
			"card.deleteYes": "Oui",
			"card.deleteNo": "Non",
			"card.workspaceHint": "Espace {workspace} — cliquer pour filtrer",
			"edit.title": "Modifier l'idée",
			"edit.save": "Enregistrer",
			"edit.preview": "Aperçu MD",
			"edit.previewOff": "Texte brut",
			"edit.workspaceUnknown": "(inconnu)",
			"level.low": "Faible",
			"level.medium": "Moyen",
			"level.high": "Élevé",
			"board.status.underReview": "En recette",
			"card.underReviewHint": "Travail terminé, en attente de recette humaine",
			"card.reviewOk": "Recette OK",
			"card.reviewOkHint": "Recette confirmée : livrer l'idée (archivée + estampillée)",
			"card.followUp": "Suivi requis…",
			"card.followUpHint": "Recette NOK : créer une idée de suivi et archiver celle-ci",
			"card.followUpOf": "suivi de #{number}",
			"card.followUpOfHint": "Idée créée suite à une recette NOK",
			"card.reanalyze": "Ré-analyser (IA)",
			"card.reanalyzeHint": "Relancer l'analyse IA sur cette idée ouverte : une nouvelle session réécrira l'analyse et l'opinion de priorité ; l'analyse précédente reste conservée sur la carte",
			"reanalyze.title": "Ré-analyser avec IA",
			"reanalyze.hint": "Une nouvelle session d'analyse va réécrire le titre, l'analyse, les étiquettes et l'opinion de priorité de cette idée ouverte (espace {workspace}) ; l'analyse précédente reste conservée sur la carte.",
			"reanalyze.submit": "Lancer l'analyse",
			"reanalyze.cancel": "Annuler",
			"followUp.title": "Suivi requis",
			"followUp.parent": "Pour : {title}",
			"followUp.childTitle": "Titre de la nouvelle idée",
			"followUp.childTitlePlaceholder": "Follow-up de #{number} — {title}",
			"followUp.justification": "Justification de la demande (reprise dans le corps de la nouvelle idée)",
			"followUp.summaryLabel": "Résumé de la carte d’origine",
			"followUp.submit": "Créer le suivi",
			"followUp.cancel": "Annuler",
			"followUp.required": "Le titre du suivi est requis"
		};
		const en = {
			"entry.label": "Ideas",
			"entry.tooltip": "Ideas board",
			"board.title": "Ideas",
			"board.close": "Back to chat",
			"board.new": "New idea",
			"board.search": "Filter ideas…",
			"board.revision": "revision {revision}",
			"board.status.open": "Open",
			"board.status.archived": "Archived",
			"board.status.declined": "Declined",
			"board.empty": "No ideas here yet",
			"board.emptyFiltered": "No ideas match the filter",
			"board.hostError": "Host operation failed: {error}",
			"board.retryHost": "Retry Host connection",
			"board.tagFilter": "Filter:",
			"board.tagFilterSearch": "Search tags…",
			"board.tagFilterNoMatch": "No matching tags",
			"board.tagFilterClear": "Clear filter",
			"settings.nav": "Ideas board",
			"settings.title": "Ideas board options",
			"settings.intro": "Display preferences for the Ideas panel, stored in this DSH profile's settings and applied immediately (no restart).",
			"settings.group": "Panel display",
			"settings.tagRows": "Visible tag-filter lines",
			"settings.tagRowsDesc": "Total rows of tags shown before the zone scrolls: 1 to 5, default 3. The first row shares its space with the search and the Clear filter button; the remaining tags stay reachable by scrolling.",
			"settings.loading": "Loading settings…",
			"settings.unavailable": "Settings are not available in this deployment: the default value applies.",
			"settings.saveFailed": "Save failed: ",
			"settings.conflict": "The settings changed elsewhere — please retry.",
			"settings.groupBehavior": "Panel behaviour",
			"settings.defaultTab": "Tab opened at start",
			"settings.defaultTabDesc": "The board section opened when the panel starts: Overview, Priorities or Delivered. Switching tabs during a session stays free and is kept as the fallback when settings are unavailable.",
			"settings.renderMarkdown": "Render descriptions as Markdown by default",
			"settings.renderMarkdownDesc": "Show card bodies as rendered markdown when the panel opens; the MD/Text header toggle still switches freely per session. On by default.",
			"settings.rememberScope": "Remember the workspace scope",
			"settings.rememberScopeDesc": "When on, the panel reopens on the last selected workspace instead of All workspaces. Off by default.",
			"settings.confirmLifecycle": "Confirm Deliver and Decline",
			"settings.confirmLifecycleDesc": "Ask for an in-place confirmation (Yes/No) before Deliver or Decline, like Delete does. Off by default: those actions apply in one click.",
			"settings.hideDeclined": "Hide the Declined column",
			"settings.hideDeclinedDesc": "Do not show the board Declined column (saves space). Declined ideas leave the kanban view: they stay in the ledger and the markdown export. Off by default.",
			"settings.cardDensity": "Card density",
			"settings.cardDensityDesc": "Comfortable: full rendering. Compact: the Overview cards AND the Priorities/Delivered rows hide their tags, description, date and workspace, with tighter spacing too — title and value/effort badges stay.",
			"settings.densityComfortable": "Comfortable",
			"settings.densityCompact": "Compact",
			"card.confirmLifecycle": "Confirm this action?",
			"board.dragHint": "Drag cards between Open and Archived (use the ⠿ grip on the title row)",
			"board.mdToggleLabel": "Description rendering",
			"board.mdView": "MD",
			"board.textView": "Text",
			"board.workspace": "Workspace",
			"board.allWorkspaces": "All workspaces",
			"board.noWorkspace": "— no workspace —",
			"board.workspaceHint": "Scope the board to one workspace",
			"board.settings": "Open the Ideas board settings",
			"tab.label": "Ideas board sections",
			"tab.overview": "Overview",
			"tab.priorities": "Priorities",
			"tab.delivered": "Delivered",
			"delivered.hint": "Ideas that left the open backlog (archived) — green stamp for delivered, neutral for manually archived",
			"delivered.empty": "Nothing archived yet",
			"delivered.deliverAt": "delivered {date}",
			"delivered.archivedAt": "archived {date}",
			"delivered.archivedHint": "Archived (abandoned) idea — restore to reopen",
			"priorities.hint": "Suggested ranking of the open backlog, relative inside each workspace group (the workspace-less ideas rank together) — use the arrows or drag to adjust",
			"priorities.empty": "No open ideas to rank",
			"priorities.moveUp": "Move up one rank",
			"priorities.moveDown": "Move down one rank",
			"priorities.rationale": "Rationale:",
			"new.title": "Title",
			"new.titlePlaceholder": "One sentence summarizing the idea",
			"new.body": "Description",
			"new.bodyPlaceholder": "Context, value, effort, acceptance (optional)",
			"new.tags": "Tags (optional)",
			"new.tagsPlaceholder": "comma separated",
			"new.rationale": "Priority rationale (optional)",
			"new.rationalePlaceholder": "Why this rank? (value, effort, dependencies, project state)",
			"new.rank": "Suggested rank (optional)",
			"new.rankValueEffortHint": "Priority is relative to the idea's own workspace open backlog: rank = position (triage inserts and re-ranks the existing rows), value/effort = 1 low, 2 medium, 3 high",
			"new.rankInvalid": "Rank must be a positive integer (1 = first of the open backlog)",
			"new.value": "Value",
			"new.effort": "Effort",
			"new.levelNone": "— not set —",
			"new.workspace": "Workspace",
			"new.workspaceNone": "— no workspace —",
			"new.model": "Model for the analysis",
			"new.modelProvider": "Provider",
			"new.modelFilterPlaceholder": "Filter models…",
			"new.modelSessionDefault": "Inherit from session (default)",
			"new.modelHint": "Preselected from your session's model; pick a provider then a model to force another one, or leave «Inherit from session» for the analyzing session to keep its own default model",
			"new.sessionWorkspaceHint": "Current session workspace — change if needed",
			"new.submit": "Create",
			"new.submitAi": "Start AI analysis and create the idea",
			"new.aiCaptureHint": "A new session will analyze the idea, create it in this workspace's backlog (or merge a duplicate) and report the retained ranking to you.",
			"new.cancel": "Cancel",
			"new.required": "Title is required",
			"card.drag": "Drag to move",
			"card.clickToEdit": "Click to edit",
			"card.value": "Value {level}",
			"card.effort": "Effort {level}",
			"card.updated": "updated {date}",
			"card.edit": "Edit",
			"card.archive": "Archive",
			"card.decline": "Decline",
			"card.deliver": "Deliver",
			"card.deliverHint": "Mark as delivered (archived + date-stamped today)",
			"card.delivered": "Delivered {date}",
			"card.deliveredHint": "Delivered idea — click to edit or restore",
			"card.restore": "Restore",
			"card.delete": "Delete",
			"card.confirmDelete": "Confirm deletion?",
			"card.deleteYes": "Yes",
			"card.deleteNo": "No",
			"card.workspaceHint": "Workspace {workspace} — click to filter",
			"edit.title": "Edit idea",
			"edit.save": "Save",
			"edit.preview": "MD preview",
			"edit.previewOff": "Raw text",
			"edit.workspaceUnknown": "(unknown)",
			"level.low": "Low",
			"level.medium": "Medium",
			"level.high": "High",
			"board.status.underReview": "Under review",
			"card.underReviewHint": "Work done, human acceptance pending",
			"card.reviewOk": "Approve",
			"card.reviewOkHint": "Approved: deliver the idea (archived + date-stamped)",
			"card.followUp": "Follow-up needed…",
			"card.followUpHint": "Not approved: create a follow-up idea and archive this one",
			"card.followUpOf": "follow-up of #{number}",
			"card.followUpOfHint": "Idea created from a failed acceptance review",
			"card.reanalyze": "Re-analyze (AI)",
			"card.reanalyzeHint": "Run a fresh AI analysis on this open idea: a new session will rewrite the analysis and the priority opinion; the previous analysis is preserved on the card",
			"reanalyze.title": "Re-analyze with AI",
			"reanalyze.hint": "A fresh analyst session will rewrite the title, analysis, tags and priority opinion of this open idea (workspace {workspace}); the previous analysis is preserved on the card.",
			"reanalyze.submit": "Start analysis",
			"reanalyze.cancel": "Cancel",
			"followUp.title": "Follow-up needed",
			"followUp.parent": "For: {title}",
			"followUp.childTitle": "Title of the new idea",
			"followUp.childTitlePlaceholder": "Follow-up of #{number} — {title}",
			"followUp.justification": "Justification of the request (included in the new idea body)",
			"followUp.summaryLabel": "Summary of the original card",
			"followUp.submit": "Create follow-up",
			"followUp.cancel": "Cancel",
			"followUp.required": "Follow-up title is required"
		};
		const DICTIONARIES = {
			fr,
			en
		};
		function currentDictionary() {
			if (typeof document === "undefined") return en;
			const base = (document.documentElement.lang ?? "").split("-")[0].toLowerCase();
			return DICTIONARIES[base] ?? en;
		}
		/** Interpolate {placeholders} with the given params. */
		function translate(key, params) {
			let text = currentDictionary()[key];
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
			return text;
		}
		/** Short alias used across the board/entry code. */
		const t = translate;
		//#endregion
		//#region src/client/style.ts
		/**
		* Ideas board stylesheet (plain CSS, injected once per page) and the class
		* map consumed by the sidebar core and the React board. Scoped by the
		* plugin's own data attributes so nothing leaks into the rest of the GUI;
		* colors ride the dsh --dsw-* tokens so the board follows the active theme
		* (light/dark and skins).
		*/
		/** Stable style-tag identity (one tag per page, idempotent). */
		const STYLE_TAG_ID = "dsh-plugin-ideas-manager/style";
		/** The whole stylesheet (exported for the health test: balance + parse checks). */
		const CSS_TEXT = `/* --- center-column takeover (global rules, attribute-scoped) --- */

[data-pane='conversation'],
[class*='centerCol'] {
  position: relative;
}

/*
 * Theme fallback palette. The shell always provides the --dsw-alias-* tokens,
 * but a skin-center skin may only redefine a subset — and a background-enabled
 * skin defines them as semi-transparent rgba that resolves to see-through
 * (alpha 0 when --dsw-skin-scrim is 0), which a var() fallback never fixes
 * because the token exists. These hard values mirror the shell's own boot
 * palette (light/dark switched the same way the shell does) and live on body
 * — not on the plugin container — so the sidebar entry, the board takeover and
 * the fixed modals all inherit them regardless of where they are mounted.
 */
body {
  --dsh-ideas-fb-bg: #ffffff;
  --dsh-ideas-fb-layer1: #f2f3f5;
  --dsh-ideas-fb-layer2: #e9eaed;
  --dsh-ideas-fb-layer3: #e0e2e5;
  --dsh-ideas-fb-border: #d3d6da;
  --dsh-ideas-fb-fg: #0f1115;
  --dsh-ideas-fb-fg-soft: #61666b;
  --dsh-ideas-fb-accent: #0f6fbe;
  --dsh-ideas-fb-accent-fg: #ffffff;
  --dsh-ideas-fb-danger: #d04a4a;
}

body[data-ds-dark-theme] {
  --dsh-ideas-fb-bg: #151517;
  --dsh-ideas-fb-layer1: #1c1c1f;
  --dsh-ideas-fb-layer2: #232327;
  --dsh-ideas-fb-layer3: #2a2a2f;
  --dsh-ideas-fb-border: #3a3a40;
  --dsh-ideas-fb-fg: #f9fafb;
  --dsh-ideas-fb-fg-soft: #cfd3d6;
  --dsh-ideas-fb-accent: #3b82f6;
  --dsh-ideas-fb-accent-fg: #0f1115;
  --dsh-ideas-fb-danger: #e5484d;
}

/* The board container rides inside the conversation grid item as an extra
   trailing child; hidden unless the ideas panel is active. */
[data-dsh-ideas-view] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  /* The skin token on top (a background-enabled skin defines every
     --dsw-alias-bg-* token as semi-transparent rgba, so the var() fallback
     never fires), the fixed fallback base underneath. The base stays
     translucent (50 %) so a wallpaper-owning skin keeps its look through
     the panel while the opaque fallback palette keeps text readable. The
     board child is transparent — this container alone carries the surface. */
  background:
    linear-gradient(var(--dsw-alias-bg-base, transparent), var(--dsw-alias-bg-base, transparent)),
    color-mix(in srgb, var(--dsh-ideas-fb-bg) 50%, transparent);
}

/* The center column is single-occupant; the :not() guards keep the ideas and
   task-board panels from fighting over visibility. The ssh attribute is
   guarded too: the upstream ssh panel only guards against the task-board, so
   a transient ideas+ssh co-presence must resolve in ssh's favour (its rule
   wins) instead of blanking the column. */
html[data-dsh-ideas-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-dsh-ideas-view] {
  display: block;
}

/* While the ideas board is active, the conversation content underneath stays
   mounted but hidden. The !important is required: the dsh shell wraps the
   conversation view in a node with an inline \`display: contents\`, and inline
   styles beat a plain stylesheet rule. */
html[data-dsh-ideas-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([data-dsh-ideas-view]),
html[data-dsh-ideas-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not([data-dsh-ideas-view]) {
  display: none !important;
}

/* --- sidebar entry row --- */

.dsh-ideas-entry {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.dsh-ideas-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-entry[data-active] {
  background: var(--dsw-alias-interactive-bg-active, var(--dsh-ideas-fb-layer2));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-weight: 600;
}

.dsh-ideas-entry-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
}

.dsh-ideas-entry-icon svg {
  display: block;
  width: 18px;
  height: 18px;
}

.dsh-ideas-entry-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Collapsed rail: icon-only, centered, matching the shell's 56px rail. */
[data-dsh-frame][data-sidebar-collapsed] .dsh-ideas-entry,
[data-sidebar-collapsed] .dsh-ideas-entry {
  justify-content: center;
  padding: 0;
  width: 36px;
  height: 36px;
  margin: 0 auto 12px;
  border-radius: 50%;
}

[data-dsh-frame][data-sidebar-collapsed] .dsh-ideas-entry-label,
[data-sidebar-collapsed] .dsh-ideas-entry-label {
  display: none;
}

/* --- board frame --- */

.dsh-ideas-board-view {
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-family: var(--dsw-font-family);
  /* Native form controls (level combobox popups, scrollbars) follow the
     board theme instead of the OS scheme. */
  color-scheme: light dark;
}

.dsh-ideas-board {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 14px 16px 16px;
  gap: 12px;
  /* The container [data-dsh-ideas-view] already carries the surface; the
     board itself stays transparent so its background cannot stack an extra
     opaque layer on top (which would kill the panel translucency). */
  background: transparent;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-family: var(--dsw-font-family);
}

.dsh-ideas-board-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.dsh-ideas-board-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  white-space: nowrap;
}

/* Rest-state surface for the "back to chat" button. The compound selector
   outranks the plain .dsh-ideas-ghost-button rule below it, so the button
   never looks like bare text under a skin (same issue the "New idea"
   button had). */
.dsh-ideas-ghost-button.dsh-ideas-back-button {
  /* Skin voile over the opaque base (same pattern as the card action
     pills), so the button follows the active skin yet always has a
     visible surface. */
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer2);
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  border-radius: 8px;
}

.dsh-ideas-ghost-button.dsh-ideas-back-button:hover {
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer3);
}

.dsh-ideas-detail-meta {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
  white-space: nowrap;
}

.dsh-ideas-search {
  width: 200px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
}

/* Board header workspace scope selector (compact, fixed width so the header
   does not reflow when the selection label changes). The auto left margin
   keeps the whole right cluster (scope + search + actions) at the right edge
   on both tabs, like the SSH panel header. */
.dsh-ideas-workspace-select {
  box-sizing: border-box;
  width: 170px;
  max-width: 170px;
  margin-left: auto;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  flex: none;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Raw/MD description view toggle (segmented pair in the board header). */
.dsh-ideas-md-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  flex: none;
}

.dsh-ideas-md-toggle-button,
.dsh-ideas-md-toggle-active {
  padding: 3px 10px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-md-toggle-active {
  background: var(--dsw-alias-interactive-bg-active, var(--dsh-ideas-fb-layer2));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-weight: 600;
}

/* Level comboboxes (value/effort) share the input look. */
.dsh-ideas-select {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}

/* Modal preview: rendered markdown of the draft description, in a read-only
   box matching the textarea footprint — same fixed start height as the raw
   description textarea (toggling raw/MD never reflows the modal), same
   vertical resize grip, and a height cap so the modal never drowns under an
   over-grown box (overflow scrolls once the box is dragged taller). */
.dsh-ideas-preview {
  box-sizing: border-box;
  width: 100%;
  min-height: 90px;
  resize: vertical;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
}

/* Shared sizing of the DESCRIPTION editor in both views: a fixed COMPACT
   start height (~1.5x the 90px base start, so the modal keeps its buttons
   visible) that the author can grow with the vertical grip or scroll
   internally, capped so an over-grown box never pushes the actions away.
   field-sizing: fixed pins the height against content-driven auto-grow
   (Chromium field-sizing), which is what stretched the raw textarea to the
   full modal height on some skins. The rationale/follow-up textareas stay on
   the base rule below and are NOT affected. */
.dsh-ideas-body-textarea,
.dsh-ideas-preview {
  height: 140px;
  max-height: 45vh;
  field-sizing: fixed;
}

.dsh-ideas-field-row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dsh-ideas-primary-button,
.dsh-ideas-ghost-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: none;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.dsh-ideas-primary-button {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  color: var(--dsw-alias-label-primary-foreground, var(--dsh-ideas-fb-accent-fg));
  font-weight: 600;
}

.dsh-ideas-primary-button:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-ghost-button {
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-ghost-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

/* Icon-only ghost variant for the header settings gear (square hit area). */
.dsh-ideas-settings-gear {
  padding: 6px;
}

.dsh-ideas-error {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-danger-bg, color-mix(in srgb, var(--dsw-alias-state-error-primary, var(--dsh-ideas-fb-danger)) 12%, transparent));
  color: var(--dsw-alias-danger-fg, var(--dsw-alias-state-error-primary, var(--dsh-ideas-fb-danger)));
  font-size: 12px;
}

/* --- columns --- */

.dsh-ideas-columns {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}

.dsh-ideas-column {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 240px;
  max-width: 420px;
  min-height: 0;
  border-radius: 10px;
  background: var(--dsw-alias-bg-subtle, var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1)));
  padding: 10px;
  gap: 8px;
}

.dsh-ideas-column-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 0 4px;
}

.dsh-ideas-column-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-column-count {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

/* Quick capture row at the top of the Open column. */
.dsh-ideas-quick-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px dashed var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  font-size: 12px;
  cursor: pointer;
}

.dsh-ideas-quick-add:hover {
  border-color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
}

.dsh-ideas-column-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}

.dsh-ideas-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

/* --- cards --- */

.dsh-ideas-card {
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, var(--dsh-ideas-fb-border));
  /* Card surface: the skin card token over the opaque fallback layer. The
     base is stepped one tone DARKER than the column surface so cards read
     as raised slots (light shell shades the layer, dark shell pulls toward
     the darker page base — see the theme rules below). */
  background:
    linear-gradient(var(--dsw-alias-card-bg, var(--dsw-alias-bg-layer-2, transparent)), var(--dsw-alias-card-bg, var(--dsw-alias-bg-layer-2, transparent))),
    var(--dsh-ideas-fb-layer2);
  box-shadow: 0 1px 2px var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
}

/* Light shell: shade layer2 toward the (dark) foreground, roughly one step
   below layer1, so the card is a touch darker than its column. */
body:not([data-ds-dark-theme]) .dsh-ideas-card {
  background-color: color-mix(in srgb, var(--dsh-ideas-fb-layer2) 96%, var(--dsh-ideas-fb-fg));
}

/* Dark shell: elevation normally lightens upward, so pull the card DOWN
   toward the page base to make it darker than the column instead. */
body[data-ds-dark-theme] .dsh-ideas-card {
  background-color: color-mix(in srgb, var(--dsh-ideas-fb-layer2) 35%, var(--dsh-ideas-fb-bg));
}

/* Title row: the title grows, the drag grip stays put at the far right. */
.dsh-ideas-card-header {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.dsh-ideas-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  overflow-wrap: anywhere;
  flex: 1 1 0;
  min-width: 0;
}

/* Stable idea number shown before the card title (#N). Muted so the number
   reads as a reference key, never as part of the title. */
.dsh-ideas-card-number {
  display: inline-block;
  margin-right: 5px;
  font-family: var(--dsw-font-mono, monospace);
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
  white-space: nowrap;
}

/* Single click on the title opens the edit modal: the title reads as a
   link-like affordance on hover. */
.dsh-ideas-card-title {
  cursor: pointer;
  border-radius: 4px;
}

.dsh-ideas-card-title:hover {
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft)) 60%, transparent);
  text-underline-offset: 2px;
}

.dsh-ideas-card-title:focus-visible {
  outline: 2px solid var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  outline-offset: 1px;
}

/* Explicit drag grip: the only draggable zone of a card. The body stays
   selectable, so without a dedicated handle HTML5 drag would fight the text
   selection on mousedown. grab/grabbing follow the OS drag convention. */
.dsh-ideas-card-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}

.dsh-ideas-card-grip:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
}

.dsh-ideas-card-grip:active {
  cursor: grabbing;
}

.dsh-ideas-card-body {
  margin-top: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* Raw text view of the description: clicking the card body opens the editor.
   The pointer affordance mirrors the title (both are edit targets). */
.dsh-ideas-body-clickable {
  cursor: pointer;
  border-radius: 4px;
}

.dsh-ideas-body-clickable:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer1));
}

.dsh-ideas-body-clickable:focus-visible {
  outline: 2px solid var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  outline-offset: 1px;
}

/* Rendered markdown description on the card (kept compact like the raw
   view). Markdown typography is deliberately subdued so cards stay dense. */
.dsh-ideas-markdown-body {
  margin-top: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dsh-ideas-markdown-body > :first-child {
  margin-top: 0;
}

.dsh-ideas-markdown-body > :last-child {
  margin-bottom: 0;
}

.dsh-ideas-markdown-body p {
  margin: 4px 0;
}

.dsh-ideas-markdown-body h1,
.dsh-ideas-markdown-body h2,
.dsh-ideas-markdown-body h3,
.dsh-ideas-markdown-body h4,
.dsh-ideas-markdown-body h5,
.dsh-ideas-markdown-body h6 {
  margin: 6px 0 2px;
  font-size: 12px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  line-height: 1.3;
}

.dsh-ideas-markdown-body ul,
.dsh-ideas-markdown-body ol {
  margin: 4px 0;
  padding-left: 18px;
}

.dsh-ideas-markdown-body li {
  margin: 2px 0;
}

.dsh-ideas-markdown-body code {
  padding: 0 3px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  font-family: var(--dsw-font-mono, monospace);
  font-size: 11px;
}

.dsh-ideas-markdown-body pre {
  margin: 4px 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  overflow-x: auto;
}

.dsh-ideas-markdown-body pre code {
  padding: 0;
  background: transparent;
}

.dsh-ideas-markdown-body a {
  color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  text-decoration: underline;
  text-underline-offset: 2px;
}

.dsh-ideas-markdown-body a:hover {
  text-decoration-thickness: 2px;
}

/* Blockquotes, on the card and in the modal preview (shared rules). */
.dsh-ideas-markdown-body blockquote,
.dsh-ideas-preview blockquote {
  margin: 4px 0;
  padding: 2px 8px;
  border-left: 3px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-markdown-body blockquote > :first-child,
.dsh-ideas-preview blockquote > :first-child {
  margin-top: 0;
}

.dsh-ideas-markdown-body blockquote > :last-child,
.dsh-ideas-preview blockquote > :last-child {
  margin-bottom: 0;
}

.dsh-ideas-updated {
  white-space: nowrap;
}

.dsh-ideas-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-tag {
  /* Per-name hue arrives inline as --dsh-ideas-tag-hue; mixing it with the
     surface keeps the pill visible on the card in both light and dark
     shells, unlike the old interactive-bg-active token (often transparent). */
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 16%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 75% 48%) 75%, var(--dsh-ideas-fb-fg));
  border: 1px solid color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 75% 52%) 38%, transparent);
  font-size: 11px;
}

/* Value/effort level badge: a colored pill carrying a tiny axis icon (dollar
   = value, dumbbell = effort) and the level label. The hue arrives inline as
   --dsh-ideas-level-hue and always means "best": green = High value / Low
   effort, red = Low value / High effort (the component computes it per axis);
   the color-mix recipe keeps it readable in both light and dark shells. */
.dsh-ideas-score {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  background: color-mix(in srgb, hsl(var(--dsh-ideas-level-hue, 210) 70% 45%) 16%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(var(--dsh-ideas-level-hue, 210) 70% 45%) 78%, var(--dsh-ideas-fb-fg));
  border: 1px solid color-mix(in srgb, hsl(var(--dsh-ideas-level-hue, 210) 70% 50%) 40%, transparent);
}

.dsh-ideas-score-icon {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.dsh-ideas-score-icon svg {
  display: block;
}

/* Workspace chip on cards (the "All workspaces" view): neutral pill, distinct
   from the hued tag pills; clicking it scopes the whole board to that
   workspace. */
.dsh-ideas-workspace-chip {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  font-size: 11px;
  cursor: pointer;
}

.dsh-ideas-workspace-chip:hover {
  background: color-mix(in srgb, var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent))) 14%, var(--dsh-ideas-fb-layer3));
  color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

/* --- new-idea modal --- */

.dsh-ideas-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
}

.dsh-ideas-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(680px, 94vw);
  max-height: 85vh;
  overflow-y: auto;
  padding: 18px;
  border-radius: 12px;
  /* Fixed overlay over the whole page: same opaque-base treatment, so a
     translucent skin token never makes the form see-through. */
  background:
    linear-gradient(var(--dsw-alias-bg-layer-2, transparent), var(--dsw-alias-bg-layer-2, transparent)),
    var(--dsh-ideas-fb-layer2);
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.dsh-ideas-modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dsh-ideas-field-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-input,
.dsh-ideas-textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  font-family: inherit;
}

.dsh-ideas-textarea {
  min-height: 90px;
  resize: vertical;
}

.dsh-ideas-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Lifecycle action row in the edit modal (deliver / archive / decline /
   recette OK / follow-up / restore, by status): a quiet row above the form
   actions, separated by a hairline so it reads as part of the card, not of
   the form fields. */
.dsh-ideas-edit-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
}

.dsh-ideas-field-row {
  display: flex;
  gap: 10px;
}

.dsh-ideas-field-row > .dsh-ideas-field {
  flex: 1 1 0;
}

/* Model picker cascade: provider selector | search | model list in one row.
   The two selects share the row width with the search input. */
.dsh-ideas-model-row {
  display: grid;
  grid-template-columns: 1fr 1fr 2fr;
  gap: 8px;
  align-items: start;
}

/* Suggested rank + value + effort on ONE row: three equal columns so the
   three priority inputs sit side by side (no wasted vertical space). Each
   child is a full cell (the rank field and the two level selects). */
.dsh-ideas-rank-level-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  align-items: start;
}

.dsh-ideas-rank-level-row > .dsh-ideas-field {
  min-width: 0;
}

/* --- P1 CRUD: filter chips, card actions, drag affordance --- */

/* Shared tag filter block (idea #36): ONE scroll zone with a SINGLE
   flex-wrap container — the filter controls (label, tag search, clear) and
   every tag are CONSECUTIVE items of the same row: the first tag immediately
   follows the clear button (no sub-block competes for that first line), the
   rest wrap below. No sticky: the controls scroll with the tags (user call).
   The zone is capped at the tagRows budget with its own scrollbar, so a
   large label union can never push the panel content down. */
.dsh-ideas-tag-filter-row {
  display: block;
  flex: none;
  /* Row budget (settings option "tagRows", 1..5, default 3): N lines of
     27px TOTAL — the FIRST line is the shared control/tag line (label,
     search, clear and the first tags all live in it), so the controls do
     NOT add a line on top of the count: rows=1 shows that shared line
     alone, rows=3 shows it plus two more tag lines. The !important stands
     against a Skin Center sheet injected after this one; only the VARIABLE
     is user-reachable, so the zone can never grow unbounded. */
  max-height: calc(var(--dsh-ideas-tag-rows, 3) * 27px) !important;
  overflow-x: hidden;
  overflow-y: auto !important;
  overscroll-behavior: contain;
  padding-right: 2px;
}

/* The single flow: controls first, tags after, all wrapping together. */
.dsh-ideas-tag-filter-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  /* Lines pack at the top of the capped zone. */
  align-content: flex-start;
}

.dsh-ideas-tag-filter-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  /* A control keeps its size on the shared line. */
  flex: none;
}

/* Tag search (narrower + lighter than the card search .dsh-ideas-search):
   the two coexisting searches must read as distinct controls — this one
   narrows the TAGS, the header one narrows the CARDS. */
.dsh-ideas-tag-filter-search {
  box-sizing: border-box;
  flex: none;
  width: 170px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 12px;
}

/* The query matched no tag (and nothing is selected): explain instead of
   leaving a blank zone under the controls. */
.dsh-ideas-tag-filter-no-match {
  font-size: 11px;
  font-style: italic;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

/* --- Settings section (DSH Settings modal, registered by the client half) -
   Rows follow the settings recipe: title + description on the left, the
   control on the right, hairline-separated inside a card container. */
.dsh-ideas-settings-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}

.dsh-ideas-settings-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-settings-intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-settings-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2, var(--dsh-ideas-fb-border));
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  overflow: hidden;
}

.dsh-ideas-settings-group {
  padding: 10px 16px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 10px 16px 12px;
}

.dsh-ideas-settings-row + .dsh-ideas-settings-row {
  border-top: 1px solid var(--dsw-alias-border-l2, var(--dsh-ideas-fb-border));
}

.dsh-ideas-settings-row-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.dsh-ideas-settings-row-text-with-title-control {
  flex: 1 1 100%;
}

.dsh-ideas-settings-row-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.dsh-ideas-settings-row-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-settings-row-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-settings-number {
  box-sizing: border-box;
  width: 72px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  text-align: center;
}

.dsh-ideas-settings-error {
  font-size: 12px;
  color: var(--dsh-ideas-fb-danger);
}

.dsh-ideas-settings-note {
  font-size: 12px;
  font-style: italic;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-settings-select {
  box-sizing: border-box;
  max-width: 240px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  flex: none;
}

/* Boolean option rows: sliding switches on a real checkbox (native semantics,
   focus and AT support kept; only the appearance is custom). */
.dsh-ideas-settings-toggle {
  appearance: none;
  box-sizing: border-box;
  position: relative;
  width: 34px;
  height: 20px;
  margin: 0;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  cursor: pointer;
  flex: none;
  transition: background-color 120ms ease-out, border-color 120ms ease-out;
}

.dsh-ideas-settings-toggle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  transform: translateY(-50%);
  transition: left 120ms ease-out, background-color 120ms ease-out;
}

.dsh-ideas-settings-toggle:checked {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-settings-toggle:checked::after {
  left: calc(100% - 16px);
  background: var(--dsw-alias-label-primary-foreground, var(--dsh-ideas-fb-accent-fg));
}

.dsh-ideas-settings-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  outline-offset: 1px;
}

.dsh-ideas-settings-toggle:disabled {
  cursor: default;
  opacity: 0.5;
}

/* Card density (settings option cardDensity = compact): the kanban card HIDES
   its tags, description, updated date and workspace chip (title, #N, value/
   effort badges and actions stay) and tightens padding/gaps — a genuinely
   denser column. Scoped to .dsh-ideas-card only: the Priorities and
   Delivered rows keep their full meta, and card content is never reordered. */
[data-dsh-ideas-density='compact'] .dsh-ideas-column-body {
  gap: 4px;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-card {
  padding: 5px 8px;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-card-body,
[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-markdown-body {
  display: none;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-tag {
  display: none;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-workspace-chip {
  display: none;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-card .dsh-ideas-updated {
  display: none;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-card-actions {
  margin-top: 4px;
}

/* Same compact treatment for the Priorities and Delivered rows (the option
   covers every board view, not the Overview columns only): hide tags,
   description, date stamps and workspace, tighten the row chrome. The rank,
   title, rationale, value/effort badges and actions stay. */
[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row {
  gap: 4px;
  margin: 1px 0;
  padding: 4px 6px;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row .dsh-ideas-card-body,
[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row .dsh-ideas-markdown-body {
  display: none;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row .dsh-ideas-tag {
  display: none;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-priorities-row .dsh-ideas-workspace-chip {
  display: none;
}

[data-dsh-ideas-density='compact'] .dsh-ideas-delivered-stamp,
[data-dsh-ideas-density='compact'] .dsh-ideas-archived-stamp {
  display: none;
}

.dsh-ideas-filter-chip,
.dsh-ideas-filter-chip-active {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
  cursor: pointer;
  /* Each chip carries the hue of its tag (--dsh-ideas-tag-hue, injected per
     chip like on the cards): soft tinted rest state, matching the tag color
     family. The border is the activation indicator — see -active below. */
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 12%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 75% 48%) 78%, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-filter-chip:hover {
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 18%, var(--dsh-ideas-fb-layer2));
}

.dsh-ideas-filter-chip-active {
  /* Active filter: full hue outline + stronger tint so the state reads
     at a glance, same hue as the chip's tag on the cards. */
  border-color: hsl(var(--dsh-ideas-tag-hue, 210) 78% 55%);
  background: color-mix(in srgb, hsl(var(--dsh-ideas-tag-hue, 210) 72% 48%) 26%, var(--dsh-ideas-fb-layer2));
  color: hsl(var(--dsh-ideas-tag-hue, 210) 60% 30%);
  font-weight: 600;
}

body[data-ds-dark-theme] .dsh-ideas-filter-chip-active {
  color: hsl(var(--dsh-ideas-tag-hue, 210) 75% 72%);
}

.dsh-ideas-drag-hint {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-card-wrapper {
  /* Cards are drop targets (intra-column reorder); the drag source is the
     dedicated grip, which carries its own grab cursor. */
  cursor: default;
}

/* While dragging, the hovered card shows the insertion point as an accent
   line, exactly like the Priorities rows: above the card (drop before it,
   upper half) or below it (drop after it, lower half). The wrapper is
   transparent, so the shadow draws a clean separator in the column gap. */
.dsh-ideas-card-wrapper[data-drop-before] {
  box-shadow: 0 -2px 0 0 var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-card-wrapper[data-drop-after] {
  box-shadow: 0 2px 0 0 var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.dsh-ideas-action-button,
.dsh-ideas-danger-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: none;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
  /* Surface = the skin's interactive voile over the opaque fallback base.
     The --dsw-alias-interactive-bg-* tokens are translucent by design
     (shell + skins define them as rgba overlays), so on their own they are
     near-invisible; laid over the solid layer they tint the pill with the
     active skin/theme while keeping it readable. */
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer2);
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-action-button:hover {
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-active, transparent), var(--dsw-alias-interactive-bg-active, transparent)),
    var(--dsh-ideas-fb-layer3);
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-danger-button {
  color: var(--dsw-alias-state-error-primary, var(--dsh-ideas-fb-danger));
}

.dsh-ideas-danger-button:hover {
  /* The danger voile (also translucent) over the same opaque base. */
  background:
    linear-gradient(var(--dsw-alias-interactive-bg-hover-danger, transparent), var(--dsw-alias-interactive-bg-hover-danger, transparent)),
    var(--dsh-ideas-fb-layer2);
}

/* Action icons: fixed size, never squeezed by the label. */
.dsh-ideas-action-button svg,
.dsh-ideas-danger-button svg {
  flex: none;
}

.dsh-ideas-confirm-label {
  font-size: 11px;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-weight: 600;
}

/* Panel tab bar below the board header. SSH-panel presentation: the bar
   carries a bottom rule, the active tab an accent underline, tabs only take
   the width of their label (never stretched), hover gives the interactive
   voile. */
.dsh-ideas-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, var(--dsh-ideas-fb-border));
}

.dsh-ideas-tab,
.dsh-ideas-tab-active {
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  cursor: pointer;
  white-space: nowrap;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 6px 6px 0 0;
  padding: 7px 14px;
  font-size: 13px;
}

.dsh-ideas-tab:hover,
.dsh-ideas-tab-active:hover {
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  background: var(--dsw-alias-interactive-bg-hover, var(--dsh-ideas-fb-layer2));
}

.dsh-ideas-tab-active,
.dsh-ideas-tab[data-active] {
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  border-bottom-color: var(--dsw-alias-state-business-primary, var(--dsh-ideas-fb-fg));
  font-weight: 600;
}

/* Small count badge at the right end of a tab (how many ideas that view
   shows): a quiet pill that never outshines the label. */
.dsh-ideas-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

/* Priorities view: the ranked open backlog. The wrapper is a flex column
   pinned to the board's remaining height (flex: 1) so a long backlog scrolls
   inside the panel instead of overflowing it; the hint stays put at the top,
   the list owns the scroll area. Delivered shares the same wrapper. */
.dsh-ideas-priorities {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  margin-top: 4px;
}

.dsh-ideas-priorities-hint {
  flex: none;
  margin: 4px 0 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

/* "All workspaces" mode (the board wraps the view with
   data-dsh-ideas-grouped): the whole block is ONE scroll surface and the
   per-workspace group headers stay with their rows, so the per-list scroll
   area is disabled and every group renders at its natural height. */
.dsh-ideas-priorities[data-dsh-ideas-grouped] {
  overflow-y: auto;
}

.dsh-ideas-priorities-group {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  margin-bottom: 8px;
}

.dsh-ideas-priorities-group-title {
  margin: 10px 0 4px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-2, var(--dsh-ideas-fb-layer2));
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.dsh-ideas-priorities[data-dsh-ideas-grouped] .dsh-ideas-priorities-list {
  flex: none;
  min-height: 0;
  overflow: visible;
}

/* In the grouped ("all workspaces") layout the sections stack at their
   natural height and the wrapper block scrolls; without this the flex:1
   below would split the wrapper height between the sections. */
.dsh-ideas-priorities[data-dsh-ideas-grouped] .dsh-ideas-priorities-group {
  flex: none;
}

.dsh-ideas-priorities-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0 0 0 8px;
}

.dsh-ideas-priorities-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 2px 0;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
}

/* While dragging, the hovered row shows the insertion point as an accent
   line: above the row (drop before it, cursor in the upper half) or below
   it (drop after it, cursor in the lower half). The shadow bleeds outside
   the opaque row surface, so it reads as a clean separator line. */
.dsh-ideas-priorities-row[data-drop-before] {
  box-shadow: 0 -2px 0 0 var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-priorities-row[data-drop-after] {
  box-shadow: 0 2px 0 0 var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-priorities-rank {
  flex: none;
  min-width: 22px;
  margin-top: 4px;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-priorities-grow {
  flex: 1 1 auto;
  min-width: 0;
}

.dsh-ideas-priorities-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.dsh-ideas-priorities-rationale {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-priorities-rationale-label {
  flex: none;
  font-weight: 600;
  white-space: nowrap;
}

.dsh-ideas-priorities-rationale-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-ideas-priorities-actions {
  display: flex;
  gap: 4px;
  flex: none;
}

.dsh-ideas-priorities-move {
  min-width: 24px;
  padding: 2px 0;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: transparent;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 12px;
  cursor: pointer;
}

.dsh-ideas-priorities-move:disabled {
  opacity: 0.35;
  cursor: default;
}

/* Delivered stamp (Delivered log rows): a green delivery pill echoing the
   "status: DELIVERED YYYY-MM-DD" marker of the old IDEAS.md process. Green is
   a fixed hue (not the tag palette) so a delivery always reads as positive. */
.dsh-ideas-delivered-stamp {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, hsl(150 55% 40%) 38%, transparent);
  background: color-mix(in srgb, hsl(150 55% 40%) 14%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(150 50% 38%) 82%, var(--dsh-ideas-fb-fg));
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Neutral exit stamp: a manually archived (abandoned) idea in the log — same
   pill shape, muted so delivered rows keep the visual accent. */
.dsh-ideas-archived-stamp {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Delivered badge on an Archived kanban card: same green pill, so a
   delivered idea is visually distinct from a plain archived (abandoned) one.
   Rendered in the card header, to the right of the title. */
.dsh-ideas-delivered-badge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, hsl(150 55% 40%) 38%, transparent);
  background: color-mix(in srgb, hsl(150 55% 40%) 14%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(150 50% 38%) 82%, var(--dsh-ideas-fb-fg));
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Under-review badge on a kanban card: amber pill marking the recette gate
   (work finished, human acceptance pending). Rendered in the card header, to
   the right of the title. */
.dsh-ideas-review-badge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, hsl(38 92% 45%) 40%, transparent);
  background: color-mix(in srgb, hsl(38 92% 45%) 14%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(38 88% 40%) 85%, var(--dsh-ideas-fb-fg));
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Follow-up lineage chip on a child card: neutral pill referencing the parent
   idea the recette NOK created it from ("suivi de #N"). */
.dsh-ideas-followup-badge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, hsl(250 40% 55%) 35%, transparent);
  background: color-mix(in srgb, hsl(250 40% 55%) 12%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(250 45% 55%) 80%, var(--dsh-ideas-fb-fg));
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Small hint under a modal field (the suggested-rank explanation). */
.dsh-ideas-field-hint {
  margin-top: 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}
`;
		/** Class map consumed by the sidebar core and the board JSX. */
		const classes = {
			entry: "dsh-ideas-entry",
			entryIcon: "dsh-ideas-entry-icon",
			entryLabel: "dsh-ideas-entry-label",
			boardView: "dsh-ideas-board-view",
			board: "dsh-ideas-board",
			boardHeader: "dsh-ideas-board-header",
			boardTitle: "dsh-ideas-board-title",
			backButton: "dsh-ideas-back-button",
			detailMeta: "dsh-ideas-detail-meta",
			search: "dsh-ideas-search",
			workspaceSelect: "dsh-ideas-workspace-select",
			mdToggle: "dsh-ideas-md-toggle",
			mdToggleButton: "dsh-ideas-md-toggle-button",
			mdToggleActive: "dsh-ideas-md-toggle-active",
			primaryButton: "dsh-ideas-primary-button",
			ghostButton: "dsh-ideas-ghost-button",
			settingsGear: "dsh-ideas-settings-gear",
			error: "dsh-ideas-error",
			columns: "dsh-ideas-columns",
			column: "dsh-ideas-column",
			columnHeader: "dsh-ideas-column-header",
			columnTitle: "dsh-ideas-column-title",
			columnCount: "dsh-ideas-column-count",
			quickAdd: "dsh-ideas-quick-add",
			columnBody: "dsh-ideas-column-body",
			empty: "dsh-ideas-empty",
			card: "dsh-ideas-card",
			cardHeader: "dsh-ideas-card-header",
			cardTitle: "dsh-ideas-card-title",
			cardNumber: "dsh-ideas-card-number",
			cardGrip: "dsh-ideas-card-grip",
			cardBody: "dsh-ideas-card-body",
			bodyClickable: "dsh-ideas-body-clickable",
			markdownBody: "dsh-ideas-markdown-body",
			cardMeta: "dsh-ideas-card-meta",
			tag: "dsh-ideas-tag",
			score: "dsh-ideas-score",
			workspaceChip: "dsh-ideas-workspace-chip",
			updated: "dsh-ideas-updated",
			overlay: "dsh-ideas-overlay",
			modal: "dsh-ideas-modal",
			modalTitle: "dsh-ideas-modal-title",
			field: "dsh-ideas-field",
			fieldRow: "dsh-ideas-field-row",
			fieldRowBetween: "dsh-ideas-field-row-between",
			modelRow: "dsh-ideas-model-row",
			rankLevelRow: "dsh-ideas-rank-level-row",
			fieldLabel: "dsh-ideas-field-label",
			input: "dsh-ideas-input",
			textarea: "dsh-ideas-textarea",
			bodyTextarea: "dsh-ideas-body-textarea",
			select: "dsh-ideas-select",
			preview: "dsh-ideas-preview",
			modalActions: "dsh-ideas-modal-actions",
			editActions: "dsh-ideas-edit-actions",
			tagFilterRow: "dsh-ideas-tag-filter-row",
			tagFilterLabel: "dsh-ideas-tag-filter-label",
			tagFilterSearch: "dsh-ideas-tag-filter-search",
			tagFilterChips: "dsh-ideas-tag-filter-chips",
			tagFilterNoMatch: "dsh-ideas-tag-filter-no-match",
			settingsSection: "dsh-ideas-settings-section",
			settingsTitle: "dsh-ideas-settings-title",
			settingsIntro: "dsh-ideas-settings-intro",
			settingsCard: "dsh-ideas-settings-card",
			settingsGroup: "dsh-ideas-settings-group",
			settingsRow: "dsh-ideas-settings-row",
			settingsRowText: "dsh-ideas-settings-row-text",
			settingsRowTextWithTitleControl: "dsh-ideas-settings-row-text-with-title-control",
			settingsRowHeading: "dsh-ideas-settings-row-heading",
			settingsRowTitle: "dsh-ideas-settings-row-title",
			settingsRowDesc: "dsh-ideas-settings-row-desc",
			settingsNumber: "dsh-ideas-settings-number",
			settingsSelect: "dsh-ideas-settings-select",
			settingsToggle: "dsh-ideas-settings-toggle",
			settingsError: "dsh-ideas-settings-error",
			settingsNote: "dsh-ideas-settings-note",
			filterChip: "dsh-ideas-filter-chip",
			filterChipActive: "dsh-ideas-filter-chip-active",
			dragHint: "dsh-ideas-drag-hint",
			cardWrapper: "dsh-ideas-card-wrapper",
			cardActions: "dsh-ideas-card-actions",
			actionButton: "dsh-ideas-action-button",
			dangerButton: "dsh-ideas-danger-button",
			confirmLabel: "dsh-ideas-confirm-label",
			tabs: "dsh-ideas-tabs",
			tab: "dsh-ideas-tab",
			tabActive: "dsh-ideas-tab-active",
			priorities: "dsh-ideas-priorities",
			prioritiesHint: "dsh-ideas-priorities-hint",
			prioritiesGroup: "dsh-ideas-priorities-group",
			prioritiesGroupTitle: "dsh-ideas-priorities-group-title",
			prioritiesList: "dsh-ideas-priorities-list",
			prioritiesRow: "dsh-ideas-priorities-row",
			prioritiesRank: "dsh-ideas-priorities-rank",
			prioritiesGrow: "dsh-ideas-priorities-grow",
			prioritiesTitle: "dsh-ideas-priorities-title",
			prioritiesRationale: "dsh-ideas-priorities-rationale",
			prioritiesRationaleLabel: "dsh-ideas-priorities-rationale-label",
			prioritiesRationaleText: "dsh-ideas-priorities-rationale-text",
			prioritiesActions: "dsh-ideas-priorities-actions",
			prioritiesMove: "dsh-ideas-priorities-move",
			deliveredStamp: "dsh-ideas-delivered-stamp",
			deliveredBadge: "dsh-ideas-delivered-badge",
			archivedStamp: "dsh-ideas-archived-stamp",
			reviewBadge: "dsh-ideas-review-badge",
			followUpBadge: "dsh-ideas-followup-badge",
			tabCount: "dsh-ideas-tab-count",
			scoreIcon: "dsh-ideas-score-icon",
			fieldHint: "dsh-ideas-field-hint"
		};
		/** Inject the stylesheet once per page (idempotent, plugin-owned tag). */
		function ensureIdeasStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-ideas-manager";
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/markdown.ts
		/**
		* Markdown renderer for idea descriptions (safe subset).
		*
		* Idea bodies are stored as plain markdown but displayed inside the board, so
		* this module turns them into HTML. It is deliberately a small, framework-free
		* subset (headings, bold/italic, inline code, fenced code blocks, lists,
		* blockquotes, links, paragraphs with hard line breaks) that matches how
		* ideas are actually written — no full CommonMark dependency is pulled into
		* the client.
		*
		* Safety: HTML is escaped FIRST, then inline markers (backticks, *, _, link
		* brackets) are matched on the escaped text, and only http(s)/mailto link
		* destinations are emitted. The returned string is therefore safe to inject
		* via dangerouslySetInnerHTML. Pure function, unit-tested in Node.
		*/
		const ESCAPE = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"\"": "&quot;",
			"'": "&#39;"
		};
		function escapeHtml(text) {
			return text.replace(/[&<>"']/g, (ch) => ESCAPE[ch]);
		}
		/** Inline rendering: escape HTML first, then code, links, bold, italic. */
		function renderInline(text) {
			let out = escapeHtml(text);
			out = out.replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`);
			out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_match, label, url) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
			out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
			out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
			return out;
		}
		/**
		* Render markdown (safe subset) to HTML.
		* @param src - the raw markdown description.
		* @returns sanitized HTML; an empty/whitespace-only input yields ''.
		*/
		function renderMarkdown(src) {
			if (src.trim() === "") return "";
			const lines = src.replace(/\r\n?/g, "\n").split("\n");
			const blocks = [];
			let i = 0;
			while (i < lines.length) {
				const trimmed = lines[i].trim();
				if (trimmed === "") {
					i++;
					continue;
				}
				if (trimmed.startsWith("```")) {
					const buf = [];
					i++;
					while (i < lines.length) {
						if (lines[i].trim().startsWith("```")) {
							i++;
							break;
						}
						buf.push(lines[i]);
						i++;
					}
					blocks.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
					continue;
				}
				const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
				if (heading !== null) {
					const level = heading[1].length;
					blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
					i++;
					continue;
				}
				if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
					const ordered = /^\d+\.\s+/.test(trimmed);
					const items = [];
					while (i < lines.length) {
						const line = lines[i].trim();
						const ul = /^([-*+])\s+(.*)$/.exec(line);
						const ol = /^(\d+)\.\s+(.*)$/.exec(line);
						if (ordered && ol !== null) {
							items.push(renderInline(ol[2]));
							i++;
							continue;
						}
						if (!ordered && ul !== null) {
							items.push(renderInline(ul[2]));
							i++;
							continue;
						}
						break;
					}
					const tag = ordered ? "ol" : "ul";
					blocks.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
					continue;
				}
				if (trimmed.startsWith(">")) {
					const inner = [];
					while (i < lines.length) {
						const quote = /^\s*>( ?(.*))?$/.exec(lines[i]);
						if (quote === null) break;
						inner.push(quote[2] ?? "");
						i++;
					}
					blocks.push(`<blockquote>${renderMarkdown(inner.join("\n"))}</blockquote>`);
					continue;
				}
				const buf = [lines[i]];
				i++;
				while (i < lines.length) {
					const line = lines[i].trim();
					if (line === "" || /^(#{1,6})\s+/.test(line) || line.startsWith("```") || /^([-*+]|\d+\.)\s+/.test(line) || line.startsWith(">")) break;
					buf.push(lines[i]);
					i++;
				}
				blocks.push(`<p>${buf.map(renderInline).join("<br>")}</p>`);
			}
			return blocks.join("\n");
		}
		//#endregion
		//#region src/client/levels.ts
		/** Shared value/effort denominations (same scale for both axes). */
		const IDEA_LEVELS = [
			{
				value: 1,
				labelKey: "level.low"
			},
			{
				value: 2,
				labelKey: "level.medium"
			},
			{
				value: 3,
				labelKey: "level.high"
			}
		];
		/** Snap a stored number to the nearest defined level; undefined stays undefined. */
		function levelForValue(value) {
			if (value === void 0) return void 0;
			let best = IDEA_LEVELS[0];
			let bestDistance = Number.POSITIVE_INFINITY;
			for (const level of IDEA_LEVELS) {
				const distance = Math.abs(level.value - value);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = level;
				}
			}
			return best.value;
		}
		/** Translation key of the level a number belongs to (display on cards). */
		function levelLabelKey(value) {
			const snapped = levelForValue(value);
			return IDEA_LEVELS.find((level) => level.value === snapped)?.labelKey;
		}
		//#endregion
		//#region src/client/workspaces.ts
		/** Resolve the display label of one registry row: title, else path, else id. */
		function workspaceLabel(item) {
			if (item.title !== "") return item.title;
			if (item.path !== void 0 && item.path !== "") return item.path;
			return item.workspaceId;
		}
		/**
		* Merge the ledger's idea workspace ids with the DSH registry into one sorted
		* catalog. Registry rows win for a shared id (the app knows the label);
		* ledger-only ids keep the raw id as their label. Pure and unit-testable.
		*/
		function buildWorkspaceCatalog(ideas, dshWorkspaces) {
			const catalog = /* @__PURE__ */ new Map();
			for (const workspace of dshWorkspaces) catalog.set(workspace.workspaceId, {
				workspaceId: workspace.workspaceId,
				title: workspace.title,
				knownToApp: true
			});
			for (const idea of ideas) {
				const workspaceId = idea.workspaceId;
				if (workspaceId === void 0 || catalog.has(workspaceId)) continue;
				catalog.set(workspaceId, {
					workspaceId,
					title: workspaceId,
					knownToApp: false
				});
			}
			return [...catalog.values()].sort((a, b) => a.title.localeCompare(b.title));
		}
		/** Cordis service name exposing the Workspace Controller (dsh-api-workspace-controller). */
		const WORKSPACES_SERVICE = "workspaces";
		/** Optional DSH registry adapter: listens to the follow stream, degrades on any failure. */
		var DshWorkspacesSource = class {
			views = [];
			listeners = /* @__PURE__ */ new Set();
			unsubscribe;
			constructor(service) {
				const replace = () => {
					this.views.splice(0, this.views.length);
					for (const item of service.list.getSnapshot().items) this.views.push({
						workspaceId: item.workspaceId,
						title: workspaceLabel(item)
					});
					this.notify();
				};
				replace();
				try {
					this.unsubscribe = service.list.subscribe(replace);
				} catch {
					this.unsubscribe = void 0;
				}
			}
			list() {
				return this.views.map((workspace) => ({ ...workspace }));
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			dispose() {
				this.unsubscribe?.();
				this.listeners.clear();
			}
			notify() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		/**
		* Defensively resolve the cordis "workspaces" service from a client context.
		* Returns undefined when the service is absent or malformed, so callers keep
		* a fully functional ledger-only board.
		*/
		function resolveWorkspacesSource(ctx) {
			try {
				const service = ctx.get(WORKSPACES_SERVICE);
				if (typeof service !== "object" || service === null) return void 0;
				const list = service.list;
				if (typeof list !== "object" || list === null) return void 0;
				const face = list;
				if (typeof face.getSnapshot !== "function" || typeof face.subscribe !== "function") return void 0;
				return new DshWorkspacesSource(service);
			} catch {
				return;
			}
		}
		//#endregion
		//#region src/client/ordering.ts
		/**
		* Idea ordering helpers shared by the kanban (Overview) and the ranked
		* backlog (Priorities): rank-keyed sorting, the grouped rebuild used by
		* drag & drop, and the one-step move inside the open backlog used by the
		* Priorities move-up/move-down actions.
		*
		* Rank model (v2, "rank by workspace"): an idea's rank is a position RELATIVE
		* to the other ideas of the same (status, workspace) pair — see
		* rankGroupKey(). The workspace-less ideas form one generic group. Every
		* rebuild below emits a status-major, group-minor, rank-ordered id list, the
		* shape the host reorder consumes (it re-derives per-group ranks from the
		* appearance order, so each group's order in the wire list is what counts).
		* Pure and unit-testable in isolation.
		*/
		/**
		* Sentinel workspace-filter value: the generic ideas (no workspace assigned).
		* A real workspace id is a UUID, so a fixed unlikely string can never collide
		* with the registry; the board selector offers it alongside real workspaces.
		*/
		const NO_WORKSPACE_FILTER = "__no-workspace__";
		/** True when the idea belongs to the workspace scope: '' = all workspaces,
		*  NO_WORKSPACE_FILTER = the workspace-less ideas only, a concrete id =
		*  exact match. Single source for every board derivation that scopes to a
		*  workspace (Overview columns, Priorities, Delivered). */
		function matchesWorkspaceScope(idea, workspaceFilter) {
			if (workspaceFilter === "") return true;
			if (workspaceFilter === "__no-workspace__") return idea.workspaceId === void 0;
			return idea.workspaceId === workspaceFilter;
		}
		/** Ideas without a rank sort after every ranked idea. */
		function orderKey(idea) {
			return idea.rank ?? Number.MAX_SAFE_INTEGER;
		}
		/** Stable rank-sorted copy (ties keep their input order). */
		function orderIdeas(ideas) {
			return [...ideas].sort((a, b) => orderKey(a) - orderKey(b));
		}
		/**
		* Group key of an idea's own peer set inside one column: (status, workspace).
		* The workspace-less ideas share the generic group. (Re-exported from the
		* model so the client call sites read the wire/display semantics directly.)
		*/
		function groupKeyOf(idea) {
			return rankGroupKey(idea.status, idea.workspaceId);
		}
		/**
		* Build the canonical status-major, group-minor id order of the whole ledger:
		* for every column (open, archived, declined) the workspace groups appear in
		* a stable key order and every group is rank-sorted. `override` replaces the
		* id order of ONE group (the moved idea's target group) with the caller's
		* new order — every other group keeps its rank-sorted order, so a reorder
		* preserves their ranks.
		*/
		function groupedIdOrder(all, override) {
			const byGroup = /* @__PURE__ */ new Map();
			for (const idea of all) {
				const key = groupKeyOf(idea);
				const rows = byGroup.get(key);
				if (rows === void 0) byGroup.set(key, [idea]);
				else rows.push(idea);
			}
			const out = [];
			for (const status of IDEA_COLUMNS) {
				const overrideKey = override !== void 0 && override.key.startsWith(`${status}\u0000`) ? override.key : void 0;
				const keys = new Set(byGroup.keys());
				if (overrideKey !== void 0) keys.add(overrideKey);
				const sorted = [...keys].filter((key) => key.startsWith(`${status}\u0000`)).sort((a, b) => {
					const aGeneric = a.endsWith("\0");
					if (aGeneric !== b.endsWith("\0")) return aGeneric ? 1 : -1;
					return a < b ? -1 : a > b ? 1 : 0;
				});
				for (const key of sorted) {
					const rows = byGroup.get(key);
					if (override !== void 0 && override.key === key) out.push(...override.orderedIds);
					else if (rows !== void 0) out.push(...orderIdeas(rows).map((row) => row.id));
				}
			}
			return out;
		}
		/**
		* Rebuild the rank order with `movedId` placed at the drop position of its
		* target column: the moved idea joins its OWN workspace group of that column,
		* right before `beforeId` when the anchor belongs to the same group, else at
		* the group end (a cross-workspace drop cannot define a within-group
		* insertion point). Columns are always laid out open, archived, declined,
		* each workspace group rank-sorted.
		*/
		function rebuildOrder(all, movedId, targetStatus, beforeId) {
			const moved = all.find((idea) => idea.id === movedId);
			if (moved === void 0) return groupedIdOrder(all);
			const targetKey = rankGroupKey(targetStatus, moved.workspaceId);
			const targetIds = orderIdeas(all.filter((idea) => idea.id !== movedId && groupKeyOf(idea) === targetKey)).map((idea) => idea.id);
			let at = targetIds.length;
			if (beforeId !== void 0) {
				const before = all.find((idea) => idea.id === beforeId);
				if (before !== void 0 && before.status === targetStatus && rankGroupKey(before.status, before.workspaceId) === targetKey) {
					const index = targetIds.indexOf(beforeId);
					if (index >= 0) at = index;
				}
			}
			targetIds.splice(at, 0, movedId);
			return groupedIdOrder(all.filter((idea) => idea.id !== movedId), {
				key: targetKey,
				orderedIds: targetIds
			});
		}
		/**
		* Next rank order after moving `movedId` one step up or down INSIDE its own
		* workspace group of the open column (the Priorities ranking). Returns
		* undefined when the idea is not open or is already at the group's edge (a
		* no-op), so the caller skips the wire call.
		*/
		function moveIdeaInOpenBacklog(all, movedId, toward) {
			const moved = all.find((idea) => idea.id === movedId);
			if (moved === void 0 || moved.status !== "open") return void 0;
			const groupKey = rankGroupKey("open", moved.workspaceId);
			const openInGroup = orderIdeas(all.filter((idea) => idea.status === "open" && rankGroupKey("open", idea.workspaceId) === groupKey));
			const at = openInGroup.findIndex((idea) => idea.id === movedId);
			if (at < 0) return void 0;
			const last = openInGroup.length - 1;
			if (toward === "up" && at === 0 || toward === "down" && at === last) return void 0;
			const ids = openInGroup.map((idea) => idea.id);
			const swap = toward === "up" ? at - 1 : at + 1;
			const held = ids[at];
			ids[at] = ids[swap];
			ids[swap] = held;
			return groupedIdOrder(all, {
				key: groupKey,
				orderedIds: ids
			});
		}
		/**
		* Open ideas partitioned by workspace group for the Priorities "all
		* workspaces" view: one group per workspace plus the generic (workspace-less)
		* group LAST, each group rank-sorted (its own relative ranking). Groups with
		* a workspace id come first in a stable key order; the presentation layer
		* may re-order them by title.
		*/
		function groupOpenByWorkspace(openIdeas) {
			const byWorkspace = /* @__PURE__ */ new Map();
			const generic = [];
			for (const idea of openIdeas) if (idea.workspaceId === void 0) generic.push(idea);
			else {
				const rows = byWorkspace.get(idea.workspaceId);
				if (rows === void 0) byWorkspace.set(idea.workspaceId, [idea]);
				else rows.push(idea);
			}
			const groups = [...byWorkspace.keys()].sort().map((workspaceId) => ({
				workspaceId,
				ideas: orderIdeas(byWorkspace.get(workspaceId))
			}));
			if (generic.length > 0) groups.push({
				workspaceId: void 0,
				ideas: orderIdeas(generic)
			});
			return groups;
		}
		/** Display-order comparator of workspace groups: the named workspaces first
		*  (by registry title), the generic (workspace-less) group last regardless of
		*  its title. */
		function compareWorkspaceGroups(a, b, workspaceTitle) {
			if (a.workspaceId === void 0) return 1;
			if (b.workspaceId === void 0) return -1;
			return workspaceTitle(a.workspaceId).localeCompare(workspaceTitle(b.workspaceId));
		}
		/** Column order for the "all workspaces" board: every workspace group is
		*  contiguous (named by title, the generic group last) and rank-sorted inside
		*  itself — the "rank by workspace" presentation the Priorities view also
		*  uses. Under a single-workspace scope the plain rank sort is identical. */
		function orderByWorkspaceGroups(rows, workspaceTitle) {
			return groupOpenByWorkspace(rows).sort((a, b) => compareWorkspaceGroups(a, b, workspaceTitle)).flatMap((group) => group.ideas);
		}
		/**
		* Archived ideas of a workspace scope — the Delivered log contents. The
		* filter follows matchesWorkspaceScope: '' = all workspaces, a concrete id =
		* one workspace, NO_WORKSPACE_FILTER = the workspace-less ideas only. The
		* journal shows every idea that left the open backlog: delivered ones carry a
		* deliveredAt stamp, manually archived (abandoned) ones do not.
		*/
		function archivedIdeasOf(ideas, workspaceFilter) {
			return ideas.filter((idea) => idea.status === "archived" && matchesWorkspaceScope(idea, workspaceFilter));
		}
		//#endregion
		//#region src/client/drag.ts
		/** Id of the dragged idea: the transfer payload first, then the fallback. */
		function draggedIdFrom(event, fallback) {
			const transferId = event.dataTransfer.getData("text/plain");
			return transferId !== void 0 && transferId !== "" ? transferId : fallback;
		}
		/** True while the pointer sits in the upper half of `element`. */
		function beforeHalf(event, element) {
			const rect = element.getBoundingClientRect();
			return event.clientY - rect.top < rect.height / 2;
		}
		//#endregion
		//#region src/client/tags.ts
		/** Conjunctive tag filter: adding a label narrows the board. */
		function matchesTags(idea, selected) {
			if (selected.length === 0) return true;
			const names = new Set((idea.tags ?? []).map((tag) => tag.name));
			return selected.every((name) => names.has(name));
		}
		/** Every label in use across the ledger, sorted (for the filter chips). */
		function collectKnownTags(ideas) {
			const names = /* @__PURE__ */ new Set();
			for (const idea of ideas) for (const tag of idea.tags ?? []) names.add(tag.name);
			return [...names].sort((a, b) => a.localeCompare(b));
		}
		/**
		* Narrow the filter chips with the chip search box (idea #36): a
		* case-insensitive substring match on the label. Matched chips keep their
		* order; SELECTED chips are appended when the query (or nothing at all)
		* hides them, so an active filter never becomes an invisible filter — even
		* for a stale selection whose label left the ledger. A blank query is the
		* full list.
		*/
		function filterKnownTags(known, selected, query) {
			const needle = query.trim().toLowerCase();
			const matching = needle === "" ? [...known] : known.filter((entry) => entry.toLowerCase().includes(needle));
			const shown = new Set(matching);
			return [...matching, ...selected.filter((entry) => !shown.has(entry))];
		}
		/**
		* Deterministic per-name hue (0–359) so every tag keeps a stable,
		* distinct color on the cards. FNV-1a then maps onto 15 well-spaced hues.
		*/
		function tagHue(name) {
			let h = 2166136261;
			for (let i = 0; i < name.length; i++) {
				h ^= name.charCodeAt(i);
				h = Math.imul(h, 16777619);
			}
			return (h >>> 0) % 15 * 24;
		}
		//#endregion
		//#region src/client/autoscroll.ts
		/** Height/width of the scroll-trigger band at each edge, in px. */
		const EDGE_PX = 44;
		/** Max scroll distance per timer tick, in px. */
		const MAX_STEP = 16;
		/** Timer cadence while hovering an edge band, in ms. */
		const INTERVAL_MS = 16;
		let active = false;
		/** Scrollable surfaces under the pointer. Usually one, but the kanban drag
		*  hovers two: the columns wrapper (horizontal) and a column body (vertical).
		*  The tick scrolls each axis through the first candidate able to do it. */
		let containers = [];
		let pointer;
		let timer;
		function stopTimer() {
			if (timer !== void 0) {
				clearInterval(timer);
				timer = void 0;
			}
		}
		/** Scroll a candidate that can actually scroll on the given axis. */
		function axisStep(el, axis) {
			const rect = el.getBoundingClientRect();
			if (axis === "y") {
				if (el.scrollHeight <= el.clientHeight || pointer === void 0) return 0;
				const topIn = pointer.y - rect.top;
				const bottomIn = rect.bottom - pointer.y;
				if (topIn <= EDGE_PX) return -Math.min(MAX_STEP, Math.ceil((EDGE_PX - topIn) / 3));
				if (bottomIn <= EDGE_PX) return Math.min(MAX_STEP, Math.ceil((EDGE_PX - bottomIn) / 3));
				return 0;
			}
			if (el.scrollWidth <= el.clientWidth || pointer === void 0) return 0;
			const leftIn = pointer.x - rect.left;
			const rightIn = rect.right - pointer.x;
			if (leftIn <= EDGE_PX) return -Math.min(MAX_STEP, Math.ceil((EDGE_PX - leftIn) / 3));
			if (rightIn <= EDGE_PX) return Math.min(MAX_STEP, Math.ceil((EDGE_PX - rightIn) / 3));
			return 0;
		}
		/** How much to scroll now, per axis; cancels the timer when idle. */
		function tick() {
			if (!active || containers.length === 0 || pointer === void 0) return;
			let top = 0;
			let left = 0;
			let topEl;
			let leftEl;
			for (const el of containers) {
				const step = axisStep(el, "y");
				if (step !== 0) {
					top = step;
					topEl = el;
					break;
				}
			}
			for (const el of containers) {
				const step = axisStep(el, "x");
				if (step !== 0) {
					left = step;
					leftEl = el;
					break;
				}
			}
			if (top === 0 && left === 0) {
				stopTimer();
				return;
			}
			if (topEl !== void 0) topEl.scrollBy({
				top,
				left: 0,
				behavior: "auto"
			});
			if (leftEl !== void 0) leftEl.scrollBy({
				top: 0,
				left,
				behavior: "auto"
			});
		}
		/** Call when a drag starts to arm the auto-scroll state. */
		function dragAutoscrollBegin() {
			active = true;
		}
		/** Feed the latest pointer/containers state from an onDragOver handler. The
		*  containers are the scrollable surfaces under the pointer; whatever can
		*  scroll is scrolled (vertical bodies, horizontal columns wrapper, ...). */
		function dragAutoscrollTrack(event, ...els) {
			if (!active) return;
			containers = els.filter((el) => el !== null);
			pointer = {
				x: event.clientX,
				y: event.clientY
			};
			const inBand = els.some((el) => {
				const rect = el.getBoundingClientRect();
				return event.clientY - rect.top <= EDGE_PX || rect.bottom - event.clientY <= EDGE_PX || event.clientX - rect.left <= EDGE_PX || rect.right - event.clientX <= EDGE_PX;
			});
			if (inBand && timer === void 0) timer = setInterval(tick, INTERVAL_MS);
			else if (!inBand) stopTimer();
		}
		/** Call on drag end or drop to disarm and stop any running scroll. */
		function dragAutoscrollEnd() {
			active = false;
			containers = [];
			pointer = void 0;
			stopTimer();
		}
		//#endregion
		//#region src/client/session-queue.ts
		/** Cordis service name (same face the active-workspace hint already reads). */
		const SESSIONS_SERVICE$1 = "sessions";
		/** Origin the analysing session must address (the page's own server origin). */
		function pageOrigin() {
			if (typeof window !== "undefined") {
				const origin = window.location?.origin;
				if (typeof origin === "string" && origin !== "") return origin;
			}
			return "http://127.0.0.1";
		}
		/**
		* The Phase 3 launch prompt (minimal). Everything about how to analyze an idea
		* and how to write it back — the body structure, title policy, tag format,
		* per-workspace rank semantics, and the full write-channel contract (envelope,
		* verbs, limits, UTF-8) — lives in the `ideas-analyst` skill, which the
		* analysing session loads from its catalog itself.
		*
		* The prompt therefore carries only what the skill CANNOT know, because it is
		* per-capture or per-instance:
		*   - which workspace (title + id) the idea belongs to,
		*   - the human draft (title, body, suggested tags),
		*   - the optional priority hints,
		*   - the server **origin** (the address of the DSH web server hosting the
		*     board — it varies per instance, so only the prompt can supply it).
		*
		* This keeps the prompt tiny and free of duplication: the skill is the single
		* source of the contract.
		*/
		function buildAnalysisPrompt(input, origin) {
			const tagsHuman = input.tags.length === 0 ? "—" : input.tags.join(", ");
			const opinionFields = [
				`value: ${input.value === void 0 ? "not set (you decide)" : String(input.value)} (scale 1..3)`,
				`effort: ${input.effort === void 0 ? "not set (you decide)" : String(input.effort)} (scale 1..3)`,
				`rationale: ${input.rationale === void 0 ? "not set (you decide)" : input.rationale}`,
				`suggested rank: ${input.rank === void 0 ? "not set (you decide)" : String(input.rank)}`
			].join("\n");
			return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}).

A human captured a draft idea and asked you to analyze it and persist the full analysis as an idea card in the ledger. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog and follow it: it specifies the analysis methodology, the priority opinion and rank, the final report, AND the full write-channel contract. The only thing the skill does not know is the server origin — it is ${origin}. If the skill is not available, persist the idea through the write channel described by that origin and use your own judgement for the analysis and the report.

=== The human's draft ===
Title: ${input.title}
Body (draft — you replace it with your analysis):
${input.body}
Tags (human suggestion): ${tagsHuman}

=== The human's priority hints (adjust when your analysis justifies it, and justify the final choice) ===
${opinionFields}`;
		}
		/**
		* The RE-ANALYZE launch prompt (idea #30 flow). Same split as the capture
		* prompt: the skill carries the methodology and the write-channel contract;
		* this prompt carries only what the skill cannot know — the target idea, the
		* workspace, and the server origin — plus the re-analysis overrides (which
		* idea id to update, which initiator to use, the no-create / no-recursion /
		* rank-churn rules).
		*/
		function buildReanalysisPrompt(input, origin) {
			const tagsHuman = input.tags.length === 0 ? "—" : input.tags.join(", ");
			const opinion = [
				`value: ${input.value === void 0 ? "not set" : String(input.value)} (scale 1..3)`,
				`effort: ${input.effort === void 0 ? "not set" : String(input.effort)} (scale 1..3)`,
				`rationale: ${input.rationale ?? "not set"}`
			].join("\n");
			return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}). This is a RE-ANALYZE run: a human asked you to re-process an idea that ALREADY exists on the board. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog and follow it: it specifies the analysis methodology, the priority opinion and rank, the final report, AND the full write-channel contract. The only things the skill does not know are the server origin — it is ${origin} — and the re-analysis overrides below, which take precedence for this run.

=== Re-analysis overrides (precedence over the skill for this run) ===
- Envelope initiator: "plugin:ideas-manager:ai-reanalyze" (NOT ai-capture).
- NEVER use the create verb. The idea already exists.
- You MUST issue an update verb with ideaId ${input.ideaId} (your new title, your full markdown analysis body, your summary, your tags) and then a triage verb on the SAME ideaId.
- Only re-triage the rank when your analysis actually justifies a different position; an unjustified re-rank churns the backlog. The rank history matters: keep ideaNumber, createdAt and the existing rank unless the content justifies moving it.
- Do NOT re-analyze again or launch anything recursive: this run was explicitly triggered by a human; report and stop.

=== The idea as currently stored (#${input.ideaNumber ?? "?"}, ideaId ${input.ideaId}) ===
Title: ${input.title}
Body (the stored analysis — you replace it with your fresh one):
${input.body}
Tags (current): ${tagsHuman}

=== The stored priority opinion (re-decide them, and justify the final choice) ===
${opinion}`;
		}
		/**
		* Flatten the Host model catalog into unordered picker choices, one per model
		* in every provider group, labelled `provider · model`. Reflects the catalog
		* faithfully: when `modelCatalog()` is absent or fails, returns [] so the
		* board hides the model picker and the analysing session uses its default.
		*/
		function modelChoicesOf(controller) {
			if (typeof controller.modelCatalog !== "function") return Promise.resolve([]);
			return controller.modelCatalog().then((result) => {
				if (!result.ok || result.value === void 0) return [];
				const groupRows = [];
				for (const group of result.value.groups ?? []) for (const model of group.models ?? []) groupRows.push({
					provider: group.id,
					model: model.id,
					label: `${group.name} · ${model.name}`
				});
				return groupRows;
			}).catch(() => []);
		}
		/**
		* Read the CURRENT host session's model selection from its `modelSelection`
		* projection (the same source the shell's own selector reads: `faceOf`
		* snapshot with `next = pending ?? lastUsed`). Defensive throughout: any
		* missing face returns undefined, so the board's preselect logic degrades to
		* the explicit "inherit session default" choice instead of guessing.
		*/
		function currentSessionSelectionOf(controller) {
			try {
				const currentId = controller.list?.getSnapshot().current;
				if (typeof currentId !== "string" || currentId === "") return void 0;
				const bound = controller.binding?.(currentId);
				if (bound === void 0) return void 0;
				const face = bound.session?.projections?.faceOf("modelSelection");
				if (face === void 0) return void 0;
				const snapshot = face.getSnapshot?.();
				if (snapshot === void 0 || snapshot === null) return void 0;
				const projected = snapshot;
				const selection = projected.next ?? projected.lastUsed;
				if (selection === void 0 || selection === null) return void 0;
				if (typeof selection.provider !== "string" || selection.provider === "") return void 0;
				if (typeof selection.model !== "string" || selection.model === "") return void 0;
				return {
					provider: selection.provider,
					model: selection.model,
					...typeof selection.reasoningEffort === "string" && selection.reasoningEffort !== "" ? { reasoningEffort: selection.reasoningEffort } : {}
				};
			} catch {
				return;
			}
		}
		/**
		* Match a session selection against the picker's catalog choices so the board
		* can preselect the EXACT option the session runs on. The catalog choices are
		* keyed by provider+model; the label is the picker's `selModelKey`. Returns
		* undefined when the selection is unknown or not present in the catalog.
		*/
		function matchSessionSelection(selection, choices) {
			if (selection === void 0) return void 0;
			const matched = choices.find((choice) => choice.provider === selection.provider && choice.model === selection.model);
			if (matched === void 0) return void 0;
			return {
				...matched,
				...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
			};
		}
		/**
		* Shared session mechanics of both analyst launches (capture and re-analyze):
		* create the fresh session in the workspace, optionally install the selected
		* model, then queue the prompt. The Agent scope is reached Host-adaptively:
		* retained through `retainAgentScope` on Host >= 0.1.7 (where `scope(id)` is a
		* pure read), through the materializing `scope(id)` on Host <= 0.1.5 — and a
		* taken retention is ALWAYS released (missing face, prompt success or
		* failure). A model rejection is best-effort (the analyst still runs, on the
		* session default).
		*/
		async function launchAnalystSession(controller, modelSource, input, prompt) {
			const sessionId = await controller.create({ workspaceId: input.workspaceId });
			if (input.model !== void 0) {
				const select = modelSource?.selectModel;
				if (select !== void 0) try {
					const selected = await select({
						sessionId,
						provider: input.model.provider,
						model: input.model.model,
						...input.model.reasoningEffort === void 0 ? {} : { reasoningEffort: input.model.reasoningEffort }
					});
					if (selected.ok !== true) console.warn(`[dsh-plugin-ideas-manager] selectModel rejected: ${selected.error?.code ?? "unknown"}`);
				} catch (error) {
					console.warn("[dsh-plugin-ideas-manager] selectModel failed", error);
				}
			}
			let retained;
			try {
				if (typeof controller.retainAgentScope === "function") retained = controller.retainAgentScope(sessionId);
			} catch (error) {
				console.warn("[dsh-plugin-ideas-manager] retainAgentScope failed", error);
			}
			let scopeCtx = retained?.binding?.ctx;
			if (scopeCtx === void 0) scopeCtx = controller.scope(sessionId);
			const session = scopeCtx === void 0 ? void 0 : controller.sessionOf(scopeCtx);
			if (session === void 0) {
				retained?.release?.();
				throw new Error("session-face-unavailable");
			}
			let result;
			try {
				result = await session.prompt([{
					type: "text",
					text: prompt
				}], "queue");
			} finally {
				retained?.release?.();
			}
			if (result.ok !== true) throw new Error("session-prompt-rejected");
			return { accepted: true };
		}
		/**
		* Defensively resolve the session launcher from a client context. Returns
		* undefined when the "sessions" service is absent or does not expose the
		* create/scope/sessionOf surface — callers then keep the manual Create.
		*
		* The model picker is best-effort: the catalog and selection come from the
		* same `sessions` face when it also carries `modelCatalog`/`selectModel`,
		* otherwise from the generated `remote.session` namespace (the official
		* selector surface). When neither is available the picker hides and the
		* analysing session uses its Host default.
		*/
		function resolveSessionLauncher(ctx) {
			try {
				const service = ctx.get(SESSIONS_SERVICE$1);
				if (typeof service !== "object" || service === null) return void 0;
				const face = service;
				if (typeof face.create !== "function" || typeof face.scope !== "function" || typeof face.sessionOf !== "function") return;
				const controller = face;
				let remoteSession;
				try {
					remoteSession = ctx.remote?.session;
				} catch {
					remoteSession = void 0;
				}
				const hasModelRpcs = (candidate) => candidate !== void 0 && (typeof candidate.modelCatalog === "function" || typeof candidate.selectModel === "function");
				const modelSource = hasModelRpcs(controller) ? controller : hasModelRpcs(remoteSession) ? remoteSession : void 0;
				return {
					launch: async (input) => launchAnalystSession(controller, modelSource, input, buildAnalysisPrompt(input, pageOrigin())),
					launchReanalyze: async (input) => launchAnalystSession(controller, modelSource, input, buildReanalysisPrompt(input, pageOrigin())),
					listModels: () => modelSource === void 0 ? Promise.resolve([]) : modelChoicesOf(modelSource),
					currentModel: () => Promise.resolve(currentSessionSelectionOf(controller))
				};
			} catch {
				return;
			}
		}
		//#endregion
		//#region src/client/score-badge.tsx
		/**
		* Hue per level (1..3), green = the BEST level of the axis: for value that
		* is High (3, most valuable), for effort it is Low (1, least costly).
		*/
		function levelHue(axis, level) {
			return (axis === "value" ? [
				5,
				45,
				140
			] : [
				140,
				45,
				5
			])[level - 1] ?? 210;
		}
		const badgeIcon = {
			"aria-hidden": true,
			width: 10,
			height: 10,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2.2,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		};
		function IconDollar() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...badgeIcon,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 1v22" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" })]
			});
		}
		function IconDumbbell() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...badgeIcon,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.5 6.5v11" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M17.5 6.5v11" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3 9.5v5" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M21 9.5v5" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.5 12h11" })
				]
			});
		}
		function ScoreBadge({ axis, value }) {
			const level = levelForValue(value);
			const labelKey = levelLabelKey(value);
			if (level === void 0 || labelKey === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: classes.score,
				style: { "--dsh-ideas-level-hue": levelHue(axis, level) },
				title: t(axis === "value" ? "card.value" : "card.effort", { level: t(labelKey) }),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.scoreIcon,
					children: axis === "value" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDollar, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDumbbell, {})
				}), t(labelKey)]
			});
		}
		//#endregion
		//#region src/client/priorities-view.tsx
		/**
		* Priorities view: the suggested ranking of the open backlog — the current
		* best ordering of the open ideas. Each open idea is one ranked row (rank,
		* title, workspace chip, value/effort, description preview, rationale) with
		* move-up/move-down actions and drag & drop reordering of the open column.
		* During a drag an accent line shows the insertion point: before the hovered
		* row (upper half) or after it (lower half); dropping on the list surface
		* below the rows appends at the end of the dragged idea's workspace group.
		*
		* Ranking is PER WORKSPACE ("rank by workspace"): every workspace group (the
		* workspace-less ideas are one generic group) carries its own relative ranks.
		* When the board shows "all workspaces" (`grouped`) the rows are laid out in
		* headed sections — workspaces first in title order, the generic group last —
		* and a drag is only accepted inside the dragged idea's own group (a
		* cross-workspace drop has no within-group insertion point). When the board
		* is scoped to one workspace the grouped layout degrades to a single
		* unheaded list, identical to the pre-grouping behaviour. The wire call is
		* the same rank-write path the kanban uses.
		*/
		/** Normalized group discriminator of an idea ('' = the generic group), used
		*  to accept drags inside one group only. */
		function groupKeyOfIdea(idea) {
			return idea.workspaceId ?? "";
		}
		/** Display title of a Priorities group (generic group gets the no-workspace
		*  label), with null for a workspace that has no registry title. */
		function groupTitle(group, workspaceTitle) {
			return group.workspaceId === void 0 ? t("board.noWorkspace") : workspaceTitle(group.workspaceId);
		}
		/** Ranked backlog view (see module doc). */
		function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, grouped }) {
			const groups = groupOpenByWorkspace(openIdeas).sort((a, b) => compareWorkspaceGroups(a, b, workspaceTitle));
			const [dragId, setDragId] = (0, react.useState)(void 0);
			const [dropAt, setDropAt] = (0, react.useState)(void 0);
			const move = (idea, toward) => {
				const ordered = moveIdeaInOpenBacklog(allIdeas, idea.id, toward);
				if (ordered !== void 0) client.reorderIdea(ordered);
			};
			const startDrag = (event, idea) => {
				event.dataTransfer.setData("text/plain", idea.id);
				event.dataTransfer.effectAllowed = "move";
				setDragId(idea.id);
				dragAutoscrollBegin();
			};
			const endDrag = () => {
				setDragId(void 0);
				setDropAt(void 0);
				dragAutoscrollEnd();
			};
			const commitDrop = (draggedId, beforeId) => {
				if (draggedId === beforeId) return;
				const ordered = rebuildOrder(allIdeas, draggedId, "open", beforeId);
				client.reorderIdea(ordered);
				endDrag();
			};
			/** The dragged idea's own group key (undefined when the payload is stale). */
			const groupOfDrag = (draggedId) => {
				const dragged = openIdeas.find((idea) => idea.id === draggedId);
				return dragged === void 0 ? void 0 : groupKeyOfIdea(dragged);
			};
			/** Same-group check for a hover/drop on a row: cross-workspace drags are
			*  rejected (no insertion point exists between two different groups). */
			const sameGroupAsDrag = (draggedId, idea) => {
				const dragGroup = groupOfDrag(draggedId);
				return dragGroup !== void 0 && dragGroup === groupKeyOfIdea(idea);
			};
			const dropOnRow = (event, idea, index, groupRanked) => {
				event.preventDefault();
				event.stopPropagation();
				const draggedId = draggedIdFrom(event, dragId);
				if (draggedId === void 0 || draggedId === idea.id) return;
				if (!sameGroupAsDrag(draggedId, idea)) return;
				const beforeId = beforeHalf(event, event.currentTarget) ? idea.id : groupRanked[index + 1]?.id;
				commitDrop(draggedId, beforeId);
			};
			const listDragOver = (event, groupRanked) => {
				if (dragId === void 0 || groupOfDrag(dragId) === void 0) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				const scroller = event.currentTarget.closest("[data-dsh-list-scroll]");
				if (scroller !== null) dragAutoscrollTrack(event, scroller);
				if (event.target.closest("li") !== null) return;
				const last = groupRanked[groupRanked.length - 1];
				setDropAt(last === void 0 ? void 0 : {
					id: last.id,
					before: false
				});
			};
			const dropAtEnd = (event) => {
				if (event.target.closest("li") !== null) return;
				event.preventDefault();
				const draggedId = draggedIdFrom(event, dragId);
				if (draggedId !== void 0) commitDrop(draggedId, void 0);
			};
			const anyRows = openIdeas.length > 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.priorities,
				"data-dsh-ideas-priorities": "",
				"data-dsh-ideas-grouped": grouped ? "" : void 0,
				children: [
					"      ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.prioritiesHint,
						children: t("priorities.hint")
					}),
					!anyRows ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.empty,
						children: t("priorities.empty")
					}) : groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: classes.prioritiesGroup,
						"data-dsh-priorities-group": group.workspaceId ?? "",
						children: [grouped && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
							className: classes.prioritiesGroupTitle,
							children: groupTitle(group, workspaceTitle)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
							className: classes.prioritiesList,
							"data-dsh-list-scroll": "",
							onDragOver: (event) => {
								listDragOver(event, group.ideas);
							},
							onDrop: dropAtEnd,
							children: group.ideas.map((idea, index) => {
								const first = index === 0;
								const last = index === group.ideas.length - 1;
								const hovering = dragId !== void 0 && dragId !== idea.id && dropAt?.id === idea.id;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: classes.prioritiesRow,
									"data-dsh-idea-id": idea.id,
									"data-drop-before": hovering && dropAt.before ? "" : void 0,
									"data-drop-after": hovering && !dropAt.before ? "" : void 0,
									onDragOver: (event) => {
										if (dragId === void 0 || idea.id === dragId) return;
										if (!sameGroupAsDrag(dragId, idea)) return;
										event.preventDefault();
										event.dataTransfer.dropEffect = "move";
										const before = beforeHalf(event, event.currentTarget);
										setDropAt((current) => current !== void 0 && current.id === idea.id && current.before === before ? current : {
											id: idea.id,
											before
										});
									},
									onDrop: (event) => {
										dropOnRow(event, idea, index, group.ideas);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: classes.prioritiesRank,
											children: index + 1
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: classes.cardGrip,
											draggable: !client.pending,
											title: t("card.drag"),
											"aria-label": t("card.drag"),
											onDragStart: (event) => {
												startDrag(event, idea);
											},
											onDragEnd: endDrag,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												"aria-hidden": "true",
												children: "⠿"
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: classes.prioritiesGrow,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: classes.prioritiesTitle,
													role: "button",
													tabIndex: 0,
													title: t("card.clickToEdit"),
													onClick: () => {
														onEdit(idea);
													},
													onKeyDown: (event) => {
														if (event.key === "Enter" || event.key === " ") {
															event.preventDefault();
															onEdit(idea);
														}
													},
													children: idea.title
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: classes.cardMeta,
													children: [
														idea.workspaceId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: classes.workspaceChip,
															children: workspaceTitle(idea.workspaceId)
														}),
														idea.tags !== void 0 && idea.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: classes.tag,
															style: { "--dsh-ideas-tag-hue": tagHue(tag.name) },
															onClick: () => {
																onToggleTag(tag.name);
															},
															children: tag.name
														}, tag.name)),
														idea.value !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScoreBadge, {
															axis: "value",
															value: idea.value
														}),
														idea.effort !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScoreBadge, {
															axis: "effort",
															value: idea.effort
														})
													]
												}),
												idea.body.trim() !== "" && (mdMode ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: `${classes.markdownBody} ${classes.bodyClickable}`,
													tabIndex: 0,
													"data-dsh-ideas-md": "",
													dangerouslySetInnerHTML: { __html: renderMarkdown(idea.body) },
													onClick: (event) => {
														if (event.target.closest("a") !== null) return;
														onEdit(idea);
													},
													onKeyDown: (event) => {
														if (event.key === "Enter" || event.key === " ") {
															event.preventDefault();
															onEdit(idea);
														}
													}
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: `${classes.cardBody} ${classes.bodyClickable}`,
													role: "button",
													tabIndex: 0,
													title: t("card.clickToEdit"),
													onClick: () => {
														onEdit(idea);
													},
													onKeyDown: (event) => {
														if (event.key === "Enter" || event.key === " ") {
															event.preventDefault();
															onEdit(idea);
														}
													},
													children: idea.body
												})),
												idea.rationale !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: classes.prioritiesRationale,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: classes.prioritiesRationaleLabel,
														children: t("priorities.rationale")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: classes.prioritiesRationaleText,
														children: idea.rationale
													})]
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: classes.prioritiesActions,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: classes.prioritiesMove,
												disabled: client.pending || first,
												"aria-label": t("priorities.moveUp"),
												title: t("priorities.moveUp"),
												onClick: () => {
													move(idea, "up");
												},
												children: "↑"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: classes.prioritiesMove,
												disabled: client.pending || last,
												"aria-label": t("priorities.moveDown"),
												title: t("priorities.moveDown"),
												onClick: () => {
													move(idea, "down");
												},
												children: "↓"
											})]
										})
									]
								}, idea.id);
							})
						})]
					}, group.workspaceId ?? ""))
				]
			});
		}
		//#endregion
		//#region src/client/delivered-view.tsx
		/** Most recent exit first (deliveredAt for delivered, archivedAt otherwise). */
		function mostRecentFirst(ideas) {
			return [...ideas].sort((a, b) => exitAt(b) - exitAt(a));
		}
		/** The stamp date: the delivery date when delivered, the archive date else. */
		function exitAt(idea) {
			return idea.deliveredAt ?? idea.archivedAt ?? idea.updatedAt ?? idea.createdAt;
		}
		/** Compact ISO "YYYY-MM-DD" for the exit stamp (the delivered/archived date). */
		function isoDate(ms) {
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		}
		function DeliveredView({ client, archivedIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode }) {
			const rows = mostRecentFirst(archivedIdeas);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.priorities,
				"data-dsh-ideas-delivered": "",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: classes.prioritiesHint,
					children: t("delivered.hint")
				}), rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: classes.empty,
					children: t("delivered.empty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
					className: classes.prioritiesList,
					children: rows.map((idea) => {
						const workspaceId = idea.workspaceId;
						const delivered = idea.deliveredAt !== void 0;
						const stamp = delivered ? t("delivered.deliverAt", { date: isoDate(idea.deliveredAt) }) : t("delivered.archivedAt", { date: isoDate(exitAt(idea)) });
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: classes.prioritiesRow,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: delivered ? classes.deliveredStamp : classes.archivedStamp,
									title: delivered ? t("card.deliveredHint") : t("delivered.archivedHint"),
									children: stamp
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.prioritiesGrow,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: classes.prioritiesTitle,
											role: "button",
											tabIndex: 0,
											title: t("card.clickToEdit"),
											onClick: () => {
												onEdit(idea);
											},
											onKeyDown: (event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													onEdit(idea);
												}
											},
											children: idea.title
										}),
										(workspaceId !== void 0 || idea.tags !== void 0 || idea.value !== void 0 || idea.effort !== void 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: classes.cardMeta,
											children: [
												workspaceId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: classes.workspaceChip,
													children: workspaceTitle(workspaceId)
												}),
												idea.tags !== void 0 && idea.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: classes.tag,
													style: { "--dsh-ideas-tag-hue": tagHue(tag.name) },
													onClick: () => {
														onToggleTag(tag.name);
													},
													children: tag.name
												}, tag.name)),
												idea.value !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScoreBadge, {
													axis: "value",
													value: idea.value
												}),
												idea.effort !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScoreBadge, {
													axis: "effort",
													value: idea.effort
												})
											]
										}),
										idea.body.trim() !== "" && (mdMode ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: `${classes.markdownBody} ${classes.bodyClickable}`,
											tabIndex: 0,
											"data-dsh-ideas-md": "",
											dangerouslySetInnerHTML: { __html: renderMarkdown(idea.body) },
											title: t("card.clickToEdit"),
											onClick: (event) => {
												if (event.target.closest("a") !== null) return;
												onEdit(idea);
											},
											onKeyDown: (event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													onEdit(idea);
												}
											}
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: `${classes.cardBody} ${classes.bodyClickable}`,
											role: "button",
											tabIndex: 0,
											title: t("card.clickToEdit"),
											onClick: () => {
												onEdit(idea);
											},
											onKeyDown: (event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													onEdit(idea);
												}
											},
											children: idea.body
										}))
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.prioritiesActions,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										onClick: () => {
											onEdit(idea);
										},
										children: t("card.edit")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										title: t("card.restore"),
										onClick: () => {
											client.restoreIdea(idea.id);
										},
										children: t("card.restore")
									})]
								})
							]
						}, idea.id);
					})
				})]
			});
		}
		//#endregion
		//#region src/client/tabs.ts
		/**
		* Board tab model: the fixed tab set of the ideas panel and its persistence.
		* The active tab survives page reloads through a storage pair (localStorage on
		* the page, an injectable seam in tests). Anything wrong on the way back —
		* unknown tab, unreadable storage, non-parseable value — degrades to the
		* default tab without throwing.
		*/
		/** The panel tabs, in display order. */
		const BOARD_TABS = [
			"overview",
			"priorities",
			"delivered"
		];
		/** Default tab shown when nothing is persisted. */
		const DEFAULT_TAB = "overview";
		/** Storage key of the persisted active tab. */
		const ACTIVE_TAB_STORAGE_KEY = "dsh.ideas.activeTab";
		/** Narrow an unknown value to a board tab. */
		function isBoardTab(value) {
			return typeof value === "string" && BOARD_TABS.includes(value);
		}
		/** Read the persisted active tab; any hiccup falls back to the default. */
		function readActiveTab(storage) {
			if (storage === void 0) return DEFAULT_TAB;
			try {
				const raw = storage.getItem(ACTIVE_TAB_STORAGE_KEY);
				return raw !== null && isBoardTab(raw) ? raw : DEFAULT_TAB;
			} catch {
				return DEFAULT_TAB;
			}
		}
		/** Persist the active tab; storage failures are ignored (never throw). */
		function writeActiveTab(storage, tab) {
			if (storage === void 0) return;
			try {
				storage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
			} catch {}
		}
		//#endregion
		//#region src/client/board-view.tsx
		/**
		* Board view: the 4-column kanban (open / under review / archived / declined)
		* that replaces the center column while active. P1 scope: full CRUD — capture
		* and edit modals, per-card archive/restore/decline/delete, manual drag
		* between the move-verb columns (+ intra-column reorder), search and a
		* conjunctive tag filter. The under-review column is the recette gate: Recette
		* OK delivers, Follow-up raises a linked child idea and archives the parent,
		* Decline rejects.
		*
		* UI polish: markdown-rendered descriptions with a raw/MD toggle, value/effort
		* as named-level comboboxes, and a single click on a card title or body
		* opening the edit modal.
		*/
		const STATUS_LABEL = {
			open: "board.status.open",
			underReview: "board.status.underReview",
			archived: "board.status.archived",
			declined: "board.status.declined"
		};
		function matchesFilter(idea, filter) {
			if (filter.trim() === "") return true;
			const needle = filter.trim().toLowerCase();
			return [
				idea.title,
				idea.body,
				...(idea.tags ?? []).map((tag) => tag.name)
			].some((text) => text.toLowerCase().includes(needle));
		}
		function shortDate(epoch) {
			return new Date(epoch).toLocaleDateString(void 0, {
				day: "numeric",
				month: "short"
			});
		}
		const actionIcon = {
			"aria-hidden": true,
			width: 12,
			height: 12,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.6,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		};
		function IconEdit() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...actionIcon,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" })
			});
		}
		function IconArchive() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", { points: "21 8 21 21 3 21 3 8" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "1",
						y: "3",
						width: "22",
						height: "5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: "10",
						y1: "12",
						x2: "14",
						y2: "12"
					})
				]
			});
		}
		function IconDecline() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10 15v4a3 3 0 0 1-3 3l-4-9V2h11.28a2 2 0 0 1 2 1.7l1.38 9a2 2 0 0 1-2 2.3z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M7 22v-11" })]
			});
		}
		function IconRestore() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", { points: "1 4 1 10 7 10" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3.51 15a9 9 0 1 0 2.13-9.36L1 10" })]
			});
		}
		function IconDelete() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", { points: "3 6 5 6 21 6" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: "10",
						y1: "11",
						x2: "10",
						y2: "17"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: "14",
						y1: "11",
						x2: "14",
						y2: "17"
					})
				]
			});
		}
		function IconCheck() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...actionIcon,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", { points: "20 6 9 17 4 12" })
			});
		}
		function IconFollowUp() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", { points: "1 4 1 10 7 10" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3.51 15a9 9 0 1 0 2.13-9.36L1 10" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: "14",
						y1: "12",
						x2: "20",
						y2: "12"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: "17",
						y1: "9",
						x2: "17",
						y2: "15"
					})
				]
			});
		}
		/** Rotate-cw: the re-analyze affordance (a fresh analyst run over the card). */
		function IconReanalyze() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", { points: "23 4 23 10 17 10" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", { points: "1 20 1 14 7 14" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M1 14l4.64 4.36A9 9 0 0 0 20.49 15" })
				]
			});
		}
		/** Feather "settings": the header gear opening the DSH Settings modal on this plugin's section. */
		function IconSettings() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "3"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1.03 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1.03H2a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1.03-1.51V2a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.03 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1.03H22a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1.03z" })]
			});
		}
		function tagsText(idea) {
			return idea?.tags === void 0 ? "" : idea.tags.map((tag) => tag.name).join(", ");
		}
		/**
		* localStorage seam for the persisted active tab. Returns undefined when the
		* browser has no usable storage (probes the accessor once); the tab helpers
		* then keep the in-memory default and never throw.
		*/
		function activeTabStorage() {
			try {
				if (typeof localStorage === "undefined") return void 0;
				localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
				return localStorage;
			} catch {
				return;
			}
		}
		/** Named-level combobox options for value/effort plus the unset choice. */
		function LevelSelect({ id, label, value, onChange, disabled }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					className: classes.fieldLabel,
					htmlFor: id,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					id,
					className: classes.select,
					value,
					disabled,
					onChange: (event) => {
						onChange(event.target.value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						children: t("new.levelNone")
					}), IDEA_LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: String(level.value),
						children: t(level.labelKey)
					}, level.value))]
				})]
			});
		}
		/** Current 1-based position of an edited idea inside ITS workspace group of
		*  the open backlog ('' when the idea is not open or absent — the rank field
		*  then starts empty; the triage verb is the only path that re-ranks with a
		*  shift). Ranking is per workspace, so the peer set is the (open,
		*  workspace) group the idea belongs to, never the whole open column. */
		function currentOpenRank(idea, ideas) {
			if (idea === void 0 || idea.status !== "open") return "";
			const key = rankGroupKey("open", idea.workspaceId);
			const at = orderIdeas(ideas.filter((item) => item.status === "open" && rankGroupKey("open", item.workspaceId) === key)).findIndex((item) => item.id === idea.id);
			return at < 0 ? "" : String(at + 1);
		}
		/** Shared analyst model-picker state: the catalog is loaded once per open,
		*  preselected with the CURRENT host session's model (an untouched picker
		*  matches the session — never the catalog's first row); '' means no model is
		*  forced (the analyst session keeps its own default). Used by both the
		*  capture modal and the re-analyze confirm modal. */
		function useAnalystModelPicker(launcher) {
			const [modelChoices, setModelChoices] = (0, react.useState)([]);
			const [selProvider, setSelProvider] = (0, react.useState)("");
			const [modelQuery, setModelQuery] = (0, react.useState)("");
			const [selModelKey, setSelModelKey] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				let cancelled = false;
				if (launcher === void 0) return;
				launcher.listModels().then((choices) => {
					if (cancelled) return;
					setModelChoices(choices);
					launcher.currentModel().then((selection) => {
						if (cancelled) return;
						const current = matchSessionSelection(selection, choices);
						if (current !== void 0) {
							setSelProvider(current.provider);
							setSelModelKey(current.label);
						}
					});
				});
				return () => {
					cancelled = true;
				};
			}, [launcher]);
			const modelProviders = [];
			for (const choice of modelChoices) if (!modelProviders.includes(choice.provider)) modelProviders.push(choice.provider);
			const activeProviderChoices = modelChoices.filter((choice) => choice.provider === selProvider);
			const query = modelQuery.trim().toLowerCase();
			const filteredModelChoices = query === "" ? activeProviderChoices : activeProviderChoices.filter((choice) => choice.label.toLowerCase().includes(query));
			return {
				modelChoices,
				modelProviders,
				filteredModelChoices,
				selProvider,
				modelQuery,
				selModelKey,
				setSelProvider,
				setModelQuery,
				setSelModelKey,
				selectedModel: selModelKey === "" ? void 0 : filteredModelChoices.find((choice) => choice.label === selModelKey) ?? activeProviderChoices.find((choice) => choice.label === selModelKey)
			};
		}
		/** The model-picker field row (provider cascade + filter + model list), as
		*  rendered in the capture and re-analyze modals. Hidden by the caller when
		*  the catalog is empty. */
		function ModelPickerField({ picker, disabled }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: classes.fieldLabel,
						htmlFor: "dsh-ideas-model",
						children: t("new.model")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: `${classes.fieldRow} ${classes.modelRow}`,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								id: "dsh-ideas-model-provider",
								className: classes.select,
								value: picker.selProvider,
								disabled,
								title: t("new.modelProvider"),
								onChange: (event) => {
									picker.setSelProvider(event.target.value);
									picker.setModelQuery("");
									picker.setSelModelKey("");
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("new.modelSessionDefault")
								}), picker.modelProviders.map((provider) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: provider,
									children: provider
								}, provider))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "dsh-ideas-model-query",
								className: classes.input,
								type: "search",
								value: picker.modelQuery,
								placeholder: t("new.modelFilterPlaceholder"),
								disabled,
								onChange: (event) => {
									picker.setModelQuery(event.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								id: "dsh-ideas-model",
								className: classes.select,
								value: picker.selModelKey,
								disabled,
								onChange: (event) => {
									picker.setSelModelKey(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("new.modelSessionDefault")
								}), picker.filteredModelChoices.map((choice) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: choice.label,
									children: choice.label
								}, choice.label))]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.fieldHint,
						children: t("new.modelHint")
					})
				]
			});
		}
		/** Shared capture/edit modal. The lifecycle actions of the card are mirrored
		*  here per status (deliver / archive / decline / recette OK / follow-up /
		*  restore), so the author can move an idea without leaving the editor. */
		function IdeaModal({ client, initial, initialWorkspace, onClose, onFollowUp, onReanalyze }) {
			const [title, setTitle] = (0, react.useState)(initial?.title ?? "");
			const [body, setBody] = (0, react.useState)(initial?.body ?? "");
			const [valueLevel, setValueLevel] = (0, react.useState)(initial?.value === void 0 ? "" : String(levelForValue(initial.value)));
			const [effortLevel, setEffortLevel] = (0, react.useState)(initial?.effort === void 0 ? "" : String(levelForValue(initial.effort)));
			const [rationale, setRationale] = (0, react.useState)(initial?.rationale ?? "");
			const [tags, setTags] = (0, react.useState)(tagsText(initial));
			const sessionWorkspace = client.activeWorkspace?.workspaceId ?? "";
			const [workspace, setWorkspace] = (0, react.useState)((() => initial?.workspaceId ?? (initialWorkspace === void 0 || initialWorkspace === "" ? sessionWorkspace : initialWorkspace === "__no-workspace__" ? "" : initialWorkspace) ?? "")());
			const sessionDefaulted = initial === void 0 && workspace !== "" && workspace === sessionWorkspace && workspace !== initialWorkspace;
			const [rank, setRank] = (0, react.useState)(() => currentOpenRank(initial, client.snapshot?.ideas ?? []));
			const [error, setError] = (0, react.useState)(void 0);
			const [preview, setPreview] = (0, react.useState)(initial !== void 0);
			const catalog = buildWorkspaceCatalog(client.snapshot?.ideas ?? [], client.workspaceOptions);
			const editingUnknownWorkspace = initial?.workspaceId !== void 0 && initial.workspaceId !== "" && !catalog.some((entry) => entry.workspaceId === initial.workspaceId);
			const aiMode = initial === void 0 && workspace !== "" && client.sessionLauncher !== void 0 && catalog.some((entry) => entry.workspaceId === workspace && entry.knownToApp);
			const modelPicker = useAnalystModelPicker(client.sessionLauncher);
			const { modelChoices } = modelPicker;
			const { selectedModel } = modelPicker;
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				};
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
				};
			}, [onClose]);
			const submit = async (event) => {
				event.preventDefault();
				if (title.trim() === "") {
					setError(t("new.required"));
					return;
				}
				const value = valueLevel === "" ? void 0 : Number(valueLevel);
				const effort = effortLevel === "" ? void 0 : Number(effortLevel);
				const parsedRank = rank.trim() === "" ? void 0 : Number(rank);
				if (parsedRank !== void 0 && (!Number.isInteger(parsedRank) || parsedRank < 1)) {
					setError(t("new.rankInvalid"));
					return;
				}
				try {
					if (aiMode && client.sessionLauncher !== void 0) {
						const captured = {
							workspaceId: workspace,
							workspaceTitle: catalog.find((entry) => entry.workspaceId === workspace)?.title ?? workspace,
							title: title.trim(),
							body: body.trim(),
							tags: tags.split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""),
							...value === void 0 ? {} : { value },
							...effort === void 0 ? {} : { effort },
							rationale,
							...parsedRank === void 0 ? {} : { rank: parsedRank },
							...selectedModel === void 0 ? {} : { model: selectedModel }
						};
						onClose();
						client.sessionLauncher.launch(captured).catch((launchError) => {
							console.error("[dsh-plugin-ideas-manager] AI capture failed:", launchError);
						});
						return;
					}
					if (initial === void 0) await client.createIdea({
						title: title.trim(),
						body: body.trim(),
						tags: tags.split(","),
						...value === void 0 ? {} : { value },
						...effort === void 0 ? {} : { effort },
						rationale,
						workspaceId: workspace,
						...parsedRank === void 0 ? {} : { rank: parsedRank }
					});
					else if (initial.status === "open") {
						await client.updateIdea(initial.id, {
							title: title.trim(),
							body: body.trim(),
							tags: tags.split(","),
							workspaceId: workspace
						});
						await client.triageIdea(initial.id, {
							...value === void 0 ? {} : { value },
							...effort === void 0 ? {} : { effort },
							rationale,
							...parsedRank === void 0 ? {} : { rank: parsedRank }
						});
					} else {
						const patch = {
							title: title.trim(),
							body: body.trim(),
							...value === void 0 ? {} : { value },
							...effort === void 0 ? {} : { effort },
							rationale,
							tags: tags.split(","),
							workspaceId: workspace
						};
						await client.updateIdea(initial.id, patch);
					}
					onClose();
				} catch {}
			};
			/** One lifecycle action from the editor: run it, then close — the card
			*  leaves its column, so the edit form no longer applies. Follow-up opens
			*  its own modal instead (the parent stays put until the child is created). */
			const lifecycle = (action, followUp = false) => {
				if (followUp) {
					if (initial === void 0 || onFollowUp === void 0) return;
					onFollowUp(initial);
					onClose();
					return;
				}
				action().then(onClose, () => {});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.overlay,
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: classes.modal,
					onClick: (event) => {
						event.stopPropagation();
					},
					onSubmit: submit,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: classes.modalTitle,
							children: initial === void 0 ? t("board.new") : t("edit.title")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: classes.fieldLabel,
								htmlFor: "dsh-ideas-title",
								children: t("new.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "dsh-ideas-title",
								className: classes.input,
								type: "text",
								value: title,
								placeholder: t("new.titlePlaceholder"),
								autoFocus: true,
								onChange: (event) => {
									setTitle(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: classes.fieldLabel,
									htmlFor: "dsh-ideas-workspace",
									children: t("new.workspace")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									id: "dsh-ideas-workspace",
									className: classes.select,
									value: workspace,
									disabled: client.pending,
									onChange: (event) => {
										setWorkspace(event.target.value);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: t("new.workspaceNone")
										}),
										editingUnknownWorkspace && initial !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: initial.workspaceId,
											children: [
												initial.workspaceId,
												" ",
												t("edit.workspaceUnknown")
											]
										}),
										catalog.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: entry.workspaceId,
											children: [entry.title, entry.knownToApp ? "" : ` (${entry.workspaceId})`]
										}, entry.workspaceId))
									]
								}),
								sessionDefaulted && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									children: t("new.sessionWorkspaceHint")
								})
							]
						}),
						aiMode && modelChoices.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPickerField, {
							picker: modelPicker,
							disabled: client.pending
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: classes.fieldRowBetween,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: classes.fieldLabel,
										htmlFor: "dsh-ideas-body",
										children: t("new.body")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: classes.ghostButton,
										"aria-pressed": preview,
										onClick: () => {
											setPreview((current) => !current);
										},
										children: preview ? t("edit.previewOff") : t("edit.preview")
									})]
								}),
								preview ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.preview,
									"data-dsh-ideas-preview": "",
									dangerouslySetInnerHTML: { __html: renderMarkdown(body) }
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									id: "dsh-ideas-body",
									className: `${classes.textarea} ${classes.bodyTextarea}`,
									value: body,
									placeholder: t("new.bodyPlaceholder"),
									onChange: (event) => {
										setBody(event.target.value);
									}
								}),
								aiMode && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									children: t("new.aiCaptureHint")
								})
							]
						}),
						(initial === void 0 || initial.status === "open") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.rankLevelRow,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: classes.fieldLabel,
										htmlFor: "dsh-ideas-rank",
										children: t("new.rank")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "dsh-ideas-rank",
										className: classes.input,
										type: "number",
										min: 1,
										step: 1,
										value: rank,
										disabled: client.pending,
										onChange: (event) => {
											setRank(event.target.value);
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LevelSelect, {
									id: "dsh-ideas-value",
									label: t("new.value"),
									value: valueLevel,
									onChange: setValueLevel,
									disabled: client.pending
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LevelSelect, {
									id: "dsh-ideas-effort",
									label: t("new.effort"),
									value: effortLevel,
									onChange: setEffortLevel,
									disabled: client.pending
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.fieldHint,
							children: t("new.rankValueEffortHint")
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: classes.fieldLabel,
								htmlFor: "dsh-ideas-tags",
								children: t("new.tags")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "dsh-ideas-tags",
								className: classes.input,
								type: "text",
								value: tags,
								placeholder: t("new.tagsPlaceholder"),
								onChange: (event) => {
									setTags(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: classes.fieldLabel,
								htmlFor: "dsh-ideas-rationale",
								children: t("new.rationale")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								id: "dsh-ideas-rationale",
								className: classes.textarea,
								rows: 2,
								value: rationale,
								placeholder: t("new.rationalePlaceholder"),
								onChange: (event) => {
									setRationale(event.target.value);
								}
							})]
						}),
						initial !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.editActions,
							children: [
								initial.status === "open" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									onReanalyze !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										title: t("card.reanalyzeHint"),
										onClick: () => {
											onReanalyze(initial);
											onClose();
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconReanalyze, {}), t("card.reanalyze")]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										title: t("card.deliverHint"),
										onClick: () => {
											lifecycle(() => client.deliverIdea(initial.id));
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCheck, {}), t("card.deliver")]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										onClick: () => {
											lifecycle(() => client.moveIdea(initial.id, "archived"));
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconArchive, {}), t("card.archive")]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										onClick: () => {
											lifecycle(() => client.declineIdea(initial.id));
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDecline, {}), t("card.decline")]
									})
								] }),
								initial.status === "underReview" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										title: t("card.reviewOkHint"),
										onClick: () => {
											lifecycle(() => client.deliverIdea(initial.id));
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCheck, {}), t("card.reviewOk")]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										title: t("card.followUpHint"),
										onClick: () => {
											lifecycle(() => Promise.resolve(), true);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconFollowUp, {}), t("card.followUp")]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										onClick: () => {
											lifecycle(() => client.declineIdea(initial.id));
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDecline, {}), t("card.decline")]
									})
								] }),
								(initial.status === "archived" || initial.status === "declined") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: classes.actionButton,
									disabled: client.pending,
									onClick: () => {
										lifecycle(() => client.restoreIdea(initial.id));
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRestore, {}), t("card.restore")]
								})
							]
						}),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.error,
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.modalActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.ghostButton,
								onClick: onClose,
								children: t("new.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: classes.primaryButton,
								disabled: client.pending,
								children: aiMode ? t("new.submitAi") : initial === void 0 ? t("new.submit") : t("edit.save")
							})]
						})
					]
				})
			});
		}
		/**
		* Recette-NOK modal: raise a child follow-up idea that carries the parent
		* summary + the user's justification, and archive the parent — the atomic
		* `followUp` verb. The child title is prefilled from the parent (number +
		* title) so the lineage reads at a glance.
		*/
		function FollowUpModal({ client, parent, onClose }) {
			const [title, setTitle] = (0, react.useState)(() => t("followUp.childTitlePlaceholder", {
				number: parent.ideaNumber ?? "?",
				title: parent.title
			}));
			const [justification, setJustification] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				};
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
				};
			}, [onClose]);
			const submit = async (event) => {
				event.preventDefault();
				if (title.trim() === "") {
					setError(t("followUp.required"));
					return;
				}
				const summary = parent.body.trim();
				const parts = [...justification.trim() === "" ? [] : [justification.trim()], ...summary === "" ? [] : [`**${t("followUp.summaryLabel")}**\n\n${summary}`]];
				try {
					await client.followUpIdea(parent.id, {
						title: title.trim(),
						body: parts.join("\n\n---\n\n")
					});
					onClose();
				} catch {}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.overlay,
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: classes.modal,
					onClick: (event) => {
						event.stopPropagation();
					},
					onSubmit: submit,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: classes.modalTitle,
							children: t("followUp.title")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.field,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: classes.detailMeta,
								children: t("followUp.parent", { title: parent.title })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: classes.fieldLabel,
								htmlFor: "dsh-ideas-followup-title",
								children: t("followUp.childTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "dsh-ideas-followup-title",
								className: classes.input,
								type: "text",
								value: title,
								autoFocus: true,
								onChange: (event) => {
									setTitle(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: classes.fieldLabel,
								htmlFor: "dsh-ideas-followup-justification",
								children: t("followUp.justification")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								id: "dsh-ideas-followup-justification",
								className: classes.textarea,
								rows: 4,
								value: justification,
								placeholder: t("followUp.justification"),
								onChange: (event) => {
									setJustification(event.target.value);
								}
							})]
						}),
						parent.body.trim() !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: classes.fieldLabel,
								htmlFor: "dsh-ideas-followup-summary",
								children: t("followUp.summaryLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								id: "dsh-ideas-followup-summary",
								className: classes.preview,
								"data-dsh-ideas-preview": "",
								children: parent.body
							})]
						}),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.error,
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.modalActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.ghostButton,
								onClick: onClose,
								children: t("followUp.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: classes.primaryButton,
								disabled: client.pending,
								children: t("followUp.submit")
							})]
						})
					]
				})
			});
		}
		/**
		* Re-analyze confirm modal (idea #30 flow): the human trigger of an analyst
		* re-run, WITH the model choice — a fresh session will overwrite the card
		* (update + triage on the same idea id), so the launch is explicit and the
		* analysing model selectable (same cascade picker as the capture; '' keeps
		* the session default). The Host stamps the prior-analysis audit BEFORE the
		* session starts (see the board's reanalyzeIdea).
		*/
		function ReanalyzeModal({ client, idea, workspaceTitle, onLaunch, onClose }) {
			const picker = useAnalystModelPicker(client.sessionLauncher);
			const [pending, setPending] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				};
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
				};
			}, [onClose]);
			const start = () => {
				setPending(true);
				onLaunch(idea, picker.selectedModel);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.overlay,
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: classes.modal,
					onClick: (event) => {
						event.stopPropagation();
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: classes.modalTitle,
							children: t("reanalyze.title")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.field,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: classes.detailMeta,
								children: [idea.ideaNumber !== void 0 ? `#${idea.ideaNumber} — ` : "", idea.title]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.field,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.fieldHint,
								children: t("reanalyze.hint", { workspace: workspaceTitle })
							})
						}),
						picker.modelChoices.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPickerField, {
							picker,
							disabled: pending || client.pending
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.modalActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.ghostButton,
								onClick: onClose,
								children: t("reanalyze.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.primaryButton,
								disabled: pending || client.pending,
								onClick: start,
								children: t("reanalyze.submit")
							})]
						})
					]
				})
			});
		}
		/**
		* Shared tag-filter row (idea #36): ONE scroll zone with a SINGLE flex-wrap
		* container — the filter controls ("Filter:" label, tag search box, clear
		* button) are the FIRST items, immediately followed by every tag: the first
		* tag sits on the SAME line as the clear button (no sub-block competes for
		* that line), the rest wrap below inside the tagRows cap with the zone's own
		* scrollbar. The controls scroll WITH the tags (deliberately not sticky,
		* user call): the clear button is a normal flow item.
		*
		* The search narrows the TAGS only (the board-header search narrows the
		* CARDS: two controls, two behaviours, two labels) and never hides a
		* SELECTED tag — even a stale one whose label left the ledger — so the board
		* is never filtered by an invisible label. Clear resets both halves of the
		* filter (selection + query) and shows whenever either half is active.
		* Rendered above all three tabs (shared row).
		*/
		function TagFilterRow({ knownTags, selected, onToggle, onClear }) {
			const [query, setQuery] = (0, react.useState)("");
			const chips = filterKnownTags(knownTags, selected, query);
			const active = selected.length > 0 || query !== "";
			const clear = () => {
				setQuery("");
				onClear();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.tagFilterRow,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: classes.tagFilterChips,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: classes.tagFilterLabel,
							children: t("board.tagFilter")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: classes.tagFilterSearch,
							type: "search",
							placeholder: t("board.tagFilterSearch"),
							"aria-label": t("board.tagFilterSearch"),
							value: query,
							onChange: (event) => {
								setQuery(event.target.value);
							}
						}),
						active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: classes.ghostButton,
							onClick: clear,
							children: t("board.tagFilterClear")
						}),
						chips.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: classes.tagFilterNoMatch,
							children: t("board.tagFilterNoMatch")
						}) : chips.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: selected.includes(name) ? classes.filterChipActive : classes.filterChip,
							style: { "--dsh-ideas-tag-hue": tagHue(name) },
							"aria-pressed": selected.includes(name),
							onClick: () => {
								onToggle(name);
							},
							children: name
						}, name))
					]
				})
			});
		}
		/**
		* One lifecycle button with its optional in-place confirmation (settings
		* option confirmLifecycle). OFF: renders the plain action button; ON: the
		* first click swaps the button for "Confirm this action?" + Yes/No, mirroring
		* the existing delete confirmation recipe.
		*/
		function LifecycleAction({ confirming, pending, title, icon, label, onRun, onCancel }) {
			if (!confirming) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: classes.actionButton,
				disabled: pending,
				title,
				onClick: onRun,
				children: [icon, label]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.confirmLabel,
					children: t("card.confirmLifecycle")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: classes.actionButton,
					disabled: pending,
					onClick: onRun,
					children: [icon, t("card.deleteYes")]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: classes.ghostButton,
					onClick: onCancel,
					children: t("card.deleteNo")
				})
			] });
		}
		/** Find our "Ideas board" settings nav row inside an open dialog, or undefined. */
		function findIdeasSettingsNavRow() {
			const label = t("settings.nav");
			for (const dialog of Array.from(document.querySelectorAll("[role=\"dialog\"]"))) {
				if (!dialog.isConnected) continue;
				for (const button of Array.from(dialog.querySelectorAll("nav button"))) if ((button.textContent ?? "").trim() === label) return button;
			}
		}
		/** Find the host settings trigger button, or undefined when its label moved. */
		function findHostSettingsTrigger() {
			for (const button of Array.from(document.querySelectorAll("button[aria-haspopup=\"dialog\"]"))) {
				const label = button.getAttribute("aria-label") ?? "";
				if (label === "Settings" || label === "设置") return button;
			}
		}
		/**
		* Open the DSH Settings modal on this plugin's section: click our nav row
		* when a dialog is already open, otherwise click the host trigger and poll
		* (rAF, ~800 ms deadline) for the dialog to render before selecting. When
		* neither hook matches (a host build moved the trigger label), log and leave
		* the GUI untouched — graceful degradation, never a throw.
		*/
		function openIdeasSettingsSection() {
			const navRow = findIdeasSettingsNavRow();
			if (navRow !== void 0) {
				navRow.click();
				return;
			}
			const trigger = findHostSettingsTrigger();
			if (trigger === void 0) {
				console.warn("[dsh-plugin-ideas-manager] settings trigger not found: the host build may have moved its label (\"Settings\"/\"设置\")");
				return;
			}
			trigger.click();
			const deadline = performance.now() + 800;
			const selectSection = () => {
				const row = findIdeasSettingsNavRow();
				if (row !== void 0) {
					row.click();
					return;
				}
				if (performance.now() < deadline) requestAnimationFrame(selectSection);
				else console.warn("[dsh-plugin-ideas-manager] settings dialog did not render in time: section select skipped");
			};
			requestAnimationFrame(selectSection);
		}
		/** Board component; subscribes to the client snapshot. */
		function IdeasBoard({ client }) {
			const [snapshot, setSnapshot] = (0, react.useState)(client.snapshot);
			const [settings, setSettings] = (0, react.useState)(client.config);
			const [filter, setFilter] = (0, react.useState)("");
			const [tagFilter, setTagFilter] = (0, react.useState)([]);
			const [workspaceFilter, setWorkspaceFilter] = (0, react.useState)("");
			const [showNew, setShowNew] = (0, react.useState)(false);
			const [editing, setEditing] = (0, react.useState)(void 0);
			const [followUp, setFollowUp] = (0, react.useState)(void 0);
			const [reanalyzing, setReanalyzing] = (0, react.useState)(void 0);
			const [confirmId, setConfirmId] = (0, react.useState)(void 0);
			const [confirmVerb, setConfirmVerb] = (0, react.useState)(void 0);
			const [drag, setDrag] = (0, react.useState)(void 0);
			const [dragTarget, setDragTarget] = (0, react.useState)(void 0);
			const [mdMode, setMdMode] = (0, react.useState)(true);
			const [activeTab, setActiveTab] = (0, react.useState)(() => readActiveTab(activeTabStorage()));
			const switchTab = (tab) => {
				setActiveTab(tab);
				writeActiveTab(activeTabStorage(), tab);
			};
			(0, react.useEffect)(() => client.subscribe(() => {
				setSnapshot(client.snapshot);
				setSettings(client.config);
			}), [client]);
			const cfg = settings.value;
			const settingsApplied = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (settingsApplied.current || !client.configLoaded) return;
				settingsApplied.current = true;
				if (!settings.available) return;
				switchTab(cfg.defaultTab);
				setMdMode(cfg.renderMarkdown);
				if (cfg.rememberWorkspaceScope) setWorkspaceFilter(cfg.workspaceScope);
			}, [
				settings,
				client,
				cfg.defaultTab,
				cfg.renderMarkdown,
				cfg.rememberWorkspaceScope,
				cfg.workspaceScope
			]);
			const ideas = snapshot?.ideas ?? [];
			const revision = snapshot?.revision;
			const ideaById = new Map(ideas.map((idea) => [idea.id, idea]));
			const knownTags = collectKnownTags(ideas.filter((idea) => matchesWorkspaceScope(idea, workspaceFilter)));
			const catalog = buildWorkspaceCatalog(ideas, client.workspaceOptions);
			const workspaceTitle = (workspaceId) => catalog.find((entry) => entry.workspaceId === workspaceId)?.title ?? workspaceId;
			const filtering = filter.trim() !== "" || tagFilter.length > 0;
			const visible = ideas.filter((idea) => matchesWorkspaceScope(idea, workspaceFilter) && matchesFilter(idea, filter) && matchesTags(idea, tagFilter));
			const scopedOpen = ideas.filter((idea) => idea.status === "open" && matchesWorkspaceScope(idea, workspaceFilter) && matchesTags(idea, tagFilter));
			const archivedIdeas = archivedIdeasOf(ideas, workspaceFilter).filter((idea) => matchesTags(idea, tagFilter));
			const byStatus = (status) => {
				const rows = visible.filter((idea) => idea.status === status);
				return workspaceFilter === "" ? orderByWorkspaceGroups(rows, workspaceTitle) : orderIdeas(rows);
			};
			const toggleTag = (name) => {
				setTagFilter((current) => current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]);
			};
			/**
			* Lifecycle runner (settings option confirmLifecycle): with the option ON,
			* the first click ARMS the in-place Yes/No confirmation for (idea, verb)
			* and only the second click runs the verb; with it OFF every click runs
			* directly (today's behaviour). One armed state covers the four lifecycle
			* buttons (Deliver, Recette OK, Decline on open + under-review cards).
			*/
			const lifecycleConfirmOn = cfg.confirmLifecycle;
			const armedFor = (idea, verb) => confirmVerb?.id === idea.id && confirmVerb.verb === verb;
			const runLifecycle = (idea, verb, run) => {
				if (!lifecycleConfirmOn) {
					run();
					return;
				}
				if (armedFor(idea, verb)) {
					setConfirmVerb(void 0);
					run();
					return;
				}
				setConfirmVerb({
					id: idea.id,
					verb
				});
			};
			const cancelLifecycle = () => {
				setConfirmVerb(void 0);
			};
			const performDrop = async (event, status, beforeId) => {
				const draggedId = draggedIdFrom(event, drag?.id);
				if (draggedId === void 0 || drag === void 0) return;
				const source = drag.source;
				try {
					if (source !== status) if (status === "declined") await client.declineIdea(draggedId);
					else await client.moveIdea(draggedId, status);
					const ordered = rebuildOrder(client.snapshot?.ideas ?? [], draggedId, status, beforeId);
					await client.reorderIdea(ordered);
				} catch {}
				setDrag(void 0);
				setDragTarget(void 0);
				dragAutoscrollEnd();
			};
			/** Start an HTML5 drag carrying the idea id, exactly like the task-board family. */
			const startDrag = (idea) => {
				setDrag({
					id: idea.id,
					source: idea.status
				});
				dragAutoscrollBegin();
			};
			const openEdit = (idea) => {
				setConfirmId(void 0);
				setConfirmVerb(void 0);
				setEditing(idea);
			};
			/** Idea #30 flow: a Re-analyze affordance is offered on an open idea only
			*  when the analyst can actually run there — a session launcher resolved
			*  AND the idea's workspace known to the DSH app (a ledger-only workspace
			*  cannot host a session, exactly like the capture AI mode). */
			const canReanalyze = (idea) => idea.status === "open" && client.sessionLauncher !== void 0 && idea.workspaceId !== void 0 && catalog.some((entry) => entry.workspaceId === idea.workspaceId && entry.knownToApp);
			/** Stamp the audit cycle on the Host first (the prior analysis is preserved
			*  BEFORE the agent overwrites the card), then launch the fresh analyst
			*  session with the model picked in the confirm modal (undefined = session
			*  default). A failed stamp aborts the run; a failed launch leaves the
			*  stamped card untouched (the human can retry the run). */
			const reanalyzeIdea = (idea, model) => {
				const launcher = client.sessionLauncher;
				if (launcher === void 0 || idea.workspaceId === void 0) return;
				const run = async () => {
					await client.reanalyzeIdea(idea.id);
					const input = {
						workspaceId: idea.workspaceId,
						workspaceTitle: workspaceTitle(idea.workspaceId),
						ideaId: idea.id,
						...idea.ideaNumber !== void 0 ? { ideaNumber: idea.ideaNumber } : {},
						title: idea.title,
						body: idea.body,
						tags: (idea.tags ?? []).map((tag) => tag.name),
						...idea.value === void 0 ? {} : { value: idea.value },
						...idea.effort === void 0 ? {} : { effort: idea.effort },
						...idea.rationale === void 0 ? {} : { rationale: idea.rationale },
						...model === void 0 ? {} : { model }
					};
					launcher.launchReanalyze(input).catch((launchError) => {
						console.error("[dsh-plugin-ideas-manager] AI re-analyze failed:", launchError);
					});
				};
				run().catch((error) => {
					console.error("[dsh-plugin-ideas-manager] re-analyze stamp failed:", error);
				});
				setReanalyzing(void 0);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.board,
				"data-dsh-ideas-board": "",
				"data-dsh-plugin": "ideas",
				"data-dsh-ideas-density": cfg.cardDensity === "compact" ? "compact" : void 0,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: classes.boardHeader,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: `${classes.ghostButton} ${classes.backButton}`,
								"data-dsh-center-view-back": "",
								"aria-label": t("board.close"),
								onClick: () => {
									client.closeBoard();
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: "‹"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("board.close") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: classes.boardTitle,
								children: t("board.title")
							}),
							revision !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: classes.detailMeta,
								children: t("board.revision", { revision })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: classes.workspaceSelect,
								value: workspaceFilter,
								"aria-label": t("board.workspace"),
								title: t("board.workspaceHint"),
								onChange: (event) => {
									setWorkspaceFilter(event.target.value);
									if (cfg.rememberWorkspaceScope) client.saveConfig({ workspaceScope: event.target.value });
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t("board.allWorkspaces")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: NO_WORKSPACE_FILTER,
										children: t("board.noWorkspace")
									}),
									catalog.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: entry.workspaceId,
										children: [entry.title, entry.knownToApp ? "" : ` (${entry.workspaceId})`]
									}, entry.workspaceId))
								]
							}),
							activeTab === "overview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: classes.search,
								type: "search",
								placeholder: t("board.search"),
								value: filter,
								"aria-label": t("board.search"),
								onChange: (event) => {
									setFilter(event.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classes.mdToggle,
								role: "group",
								"aria-label": t("board.mdToggleLabel"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: mdMode ? classes.mdToggleActive : classes.mdToggleButton,
									"aria-pressed": mdMode,
									onClick: () => {
										setMdMode(true);
									},
									children: t("board.mdView")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: mdMode ? classes.mdToggleButton : classes.mdToggleActive,
									"aria-pressed": !mdMode,
									onClick: () => {
										setMdMode(false);
									},
									children: t("board.textView")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `${classes.ghostButton} ${classes.settingsGear}`,
								"aria-label": t("board.settings"),
								title: t("board.settings"),
								onClick: () => {
									openIdeasSettingsSection();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSettings, {})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.primaryButton,
								onClick: () => {
									setShowNew(true);
								},
								children: t("board.new")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
						className: classes.tabs,
						role: "tablist",
						"aria-label": t("tab.label"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "tab",
								className: activeTab === "overview" ? classes.tabActive : classes.tab,
								"data-active": activeTab === "overview" ? "" : void 0,
								"aria-selected": activeTab === "overview",
								onClick: () => {
									switchTab("overview");
								},
								children: [t("tab.overview"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.tabCount,
									children: visible.length
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "tab",
								className: activeTab === "priorities" ? classes.tabActive : classes.tab,
								"data-active": activeTab === "priorities" ? "" : void 0,
								"aria-selected": activeTab === "priorities",
								onClick: () => {
									switchTab("priorities");
								},
								children: [t("tab.priorities"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.tabCount,
									children: scopedOpen.length
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "tab",
								className: activeTab === "delivered" ? classes.tabActive : classes.tab,
								"data-active": activeTab === "delivered" ? "" : void 0,
								"aria-selected": activeTab === "delivered",
								onClick: () => {
									switchTab("delivered");
								},
								children: [t("tab.delivered"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.tabCount,
									children: archivedIdeas.length
								})]
							})
						]
					}),
					client.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.error,
						children: [
							t("board.hostError", { error: client.error }),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.ghostButton,
								onClick: () => {
									client.refresh();
								},
								children: t("board.retryHost")
							})
						]
					}),
					knownTags.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TagFilterRow, {
						knownTags,
						selected: tagFilter,
						onToggle: toggleTag,
						onClear: () => {
							setTagFilter([]);
						}
					}),
					activeTab === "overview" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.dragHint,
						children: t("board.dragHint")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.columns,
						"data-dsh-columns-scroll": "",
						children: IDEA_COLUMNS.filter((status) => !(status === "declined" && cfg.hideDeclinedColumn)).map((status) => {
							const columnIdeas = byStatus(status);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: classes.column,
								onDragEnter: () => {
									if (drag !== void 0) setDragTarget({ status });
								},
								onDragOver: (event) => {
									if (drag !== void 0) {
										event.preventDefault();
										event.dataTransfer.dropEffect = "move";
										const body = event.currentTarget.closest("[data-dsh-column-scroll]");
										const rows = event.currentTarget.closest("[data-dsh-columns-scroll]");
										const scrollers = [];
										if (body !== null) scrollers.push(body);
										if (rows !== null) scrollers.push(rows);
										dragAutoscrollTrack(event, ...scrollers);
										if (event.target.closest("[data-dsh-idea-id]") !== null) return;
										const last = columnIdeas[columnIdeas.length - 1];
										if (last === void 0) return;
										setDragTarget((current) => current !== void 0 && current.status === status && current.beforeId === void 0 && current.hoverId === last.id && current.half === "after" ? current : {
											status,
											beforeId: void 0,
											hoverId: last.id,
											half: "after"
										});
									}
								},
								onDrop: (event) => {
									event.preventDefault();
									performDrop(event, status, void 0);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.columnHeader,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: classes.columnTitle,
										children: t(STATUS_LABEL[status])
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: classes.columnCount,
										children: columnIdeas.length
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.columnBody,
									"data-dsh-column-scroll": "",
									children: [status === "open" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.quickAdd,
										onClick: () => {
											setShowNew(true);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											"aria-hidden": "true",
											children: "＋"
										}), t("board.new")]
									}), columnIdeas.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: classes.empty,
										children: t(filtering ? "board.emptyFiltered" : "board.empty")
									}) : columnIdeas.map((idea, index) => {
										const confirm = confirmId === idea.id;
										const workspaceId = idea.workspaceId;
										const dropBefore = dragTarget?.status === status && dragTarget?.hoverId === idea.id && dragTarget?.half === "before";
										const dropAfter = dragTarget?.status === status && dragTarget?.hoverId === idea.id && dragTarget?.half === "after";
										const dropNextId = columnIdeas[index + 1]?.id;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: classes.cardWrapper,
											"data-dsh-idea-id": idea.id,
											"data-drop-before": dropBefore ? "" : void 0,
											"data-drop-after": dropAfter ? "" : void 0,
											onDragEnter: (event) => {
												if (drag === void 0 || idea.id === drag.id) return;
												const before = beforeHalf(event, event.currentTarget);
												setDragTarget({
													status,
													beforeId: before ? idea.id : dropNextId,
													hoverId: idea.id,
													half: before ? "before" : "after"
												});
											},
											onDragOver: (event) => {
												if (drag === void 0 || idea.id === drag.id) return;
												event.preventDefault();
												event.dataTransfer.dropEffect = "move";
												const before = beforeHalf(event, event.currentTarget);
												const beforeId = before ? idea.id : dropNextId;
												const half = before ? "before" : "after";
												setDragTarget((current) => current !== void 0 && current.status === status && current.beforeId === beforeId && current.hoverId === idea.id && current.half === half ? current : {
													status,
													beforeId,
													hoverId: idea.id,
													half
												});
											},
											onDrop: (event) => {
												event.preventDefault();
												event.stopPropagation();
												const before = beforeHalf(event, event.currentTarget);
												performDrop(event, status, before ? idea.id : dropNextId);
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: classes.card,
												"data-dsh-idea-id": idea.id,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: classes.cardHeader,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																className: classes.cardTitle,
																role: "button",
																tabIndex: 0,
																title: t("card.clickToEdit"),
																onClick: () => {
																	openEdit(idea);
																},
																onKeyDown: (event) => {
																	if (event.key === "Enter" || event.key === " ") {
																		event.preventDefault();
																		openEdit(idea);
																	}
																},
																children: [idea.ideaNumber !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																	className: classes.cardNumber,
																	children: ["#", idea.ideaNumber]
																}), idea.title]
															}),
															idea.followUpOfId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: classes.followUpBadge,
																title: t("card.followUpOfHint"),
																children: t("card.followUpOf", { number: ideaById.get(idea.followUpOfId)?.ideaNumber ?? "—" })
															}),
															idea.status === "underReview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: classes.reviewBadge,
																title: t("card.underReviewHint"),
																children: t("board.status.underReview")
															}),
															idea.deliveredAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: classes.deliveredBadge,
																title: t("card.deliveredHint"),
																children: t("card.delivered", { date: shortDate(idea.deliveredAt) })
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																className: classes.cardGrip,
																draggable: !client.pending,
																title: t("card.drag"),
																"aria-label": t("card.drag"),
																onDragStart: (event) => {
																	event.dataTransfer.setData("text/plain", idea.id);
																	event.dataTransfer.effectAllowed = "move";
																	const card = event.currentTarget.closest(".dsh-ideas-card");
																	if (card !== null) {
																		const rect = card.getBoundingClientRect();
																		event.dataTransfer.setDragImage(card, event.clientX - rect.left, event.clientY - rect.top);
																	}
																	startDrag(idea);
																},
																onDragEnd: () => {
																	setDrag(void 0);
																	setDragTarget(void 0);
																	dragAutoscrollEnd();
																},
																children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	"aria-hidden": "true",
																	children: "⠿"
																})
															})
														]
													}),
													(workspaceId !== void 0 || idea.tags !== void 0 && idea.tags.length > 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: classes.cardMeta,
														children: [workspaceId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: classes.workspaceChip,
															title: t("card.workspaceHint", { workspace: workspaceTitle(workspaceId) }),
															onClick: () => {
																setWorkspaceFilter(workspaceId);
															},
															children: workspaceTitle(workspaceId)
														}), idea.tags !== void 0 && idea.tags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: classes.tag,
															style: { "--dsh-ideas-tag-hue": tagHue(tag.name) },
															onClick: () => {
																toggleTag(tag.name);
															},
															children: tag.name
														}, tag.name))]
													}),
													idea.body.trim() !== "" && (mdMode ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: `${classes.markdownBody} ${classes.bodyClickable}`,
														tabIndex: 0,
														title: t("card.clickToEdit"),
														"data-dsh-ideas-md": "",
														dangerouslySetInnerHTML: { __html: renderMarkdown(idea.body) },
														onClick: (event) => {
															if (event.target.closest("a") !== null) return;
															openEdit(idea);
														},
														onKeyDown: (event) => {
															if (event.key === "Enter" || event.key === " ") {
																event.preventDefault();
																openEdit(idea);
															}
														}
													}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: `${classes.cardBody} ${classes.bodyClickable}`,
														role: "button",
														tabIndex: 0,
														title: t("card.clickToEdit"),
														onClick: () => {
															openEdit(idea);
														},
														onKeyDown: (event) => {
															if (event.key === "Enter" || event.key === " ") {
																event.preventDefault();
																openEdit(idea);
															}
														},
														children: idea.body
													})),
													(idea.value !== void 0 || idea.effort !== void 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: classes.cardMeta,
														children: [idea.value !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScoreBadge, {
															axis: "value",
															value: idea.value
														}), idea.effort !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScoreBadge, {
															axis: "effort",
															value: idea.effort
														})]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: classes.cardMeta,
														children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: classes.updated,
															children: t("card.updated", { date: shortDate(idea.updatedAt) })
														})
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: classes.cardActions,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: classes.actionButton,
																disabled: client.pending,
																onClick: () => {
																	openEdit(idea);
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEdit, {}), t("card.edit")]
															}),
															idea.status === "open" && canReanalyze(idea) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: classes.actionButton,
																disabled: client.pending,
																title: t("card.reanalyzeHint"),
																onClick: () => {
																	setReanalyzing(idea);
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconReanalyze, {}), t("card.reanalyze")]
															}),
															idea.status === "open" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LifecycleAction, {
																label: t("card.deliver"),
																icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCheck, {}),
																title: t("card.deliverHint"),
																pending: client.pending,
																confirming: armedFor(idea, "deliver"),
																onRun: () => {
																	runLifecycle(idea, "deliver", () => client.deliverIdea(idea.id));
																},
																onCancel: cancelLifecycle
															}),
															idea.status === "open" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: classes.actionButton,
																disabled: client.pending,
																onClick: () => {
																	client.moveIdea(idea.id, "archived");
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconArchive, {}), t("card.archive")]
															}),
															idea.status === "open" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LifecycleAction, {
																label: t("card.decline"),
																icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDecline, {}),
																pending: client.pending,
																confirming: armedFor(idea, "decline"),
																onRun: () => {
																	runLifecycle(idea, "decline", () => client.declineIdea(idea.id));
																},
																onCancel: cancelLifecycle
															}),
															idea.status === "underReview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LifecycleAction, {
																label: t("card.reviewOk"),
																title: t("card.reviewOkHint"),
																icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCheck, {}),
																pending: client.pending,
																confirming: armedFor(idea, "deliver"),
																onRun: () => {
																	runLifecycle(idea, "deliver", () => client.deliverIdea(idea.id));
																},
																onCancel: cancelLifecycle
															}),
															idea.status === "underReview" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: classes.actionButton,
																disabled: client.pending,
																title: t("card.followUpHint"),
																onClick: () => {
																	setConfirmId(void 0);
																	setConfirmVerb(void 0);
																	setFollowUp(idea);
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconFollowUp, {}), t("card.followUp")]
															}),
															idea.status === "underReview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LifecycleAction, {
																label: t("card.decline"),
																icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDecline, {}),
																pending: client.pending,
																confirming: armedFor(idea, "decline"),
																onRun: () => {
																	runLifecycle(idea, "decline", () => client.declineIdea(idea.id));
																},
																onCancel: cancelLifecycle
															}),
															(idea.status === "archived" || idea.status === "declined") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: classes.actionButton,
																disabled: client.pending,
																onClick: () => {
																	client.restoreIdea(idea.id);
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRestore, {}), t("card.restore")]
															}),
															!confirm ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: classes.dangerButton,
																disabled: client.pending,
																onClick: () => {
																	setConfirmId(idea.id);
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDelete, {}), t("card.delete")]
															}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: classes.confirmLabel,
																	children: t("card.confirmDelete")
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																	type: "button",
																	className: classes.dangerButton,
																	disabled: client.pending,
																	onClick: () => {
																		setConfirmId(void 0);
																		client.deleteIdea(idea.id);
																	},
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDelete, {}), t("card.deleteYes")]
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																	type: "button",
																	className: classes.ghostButton,
																	onClick: () => {
																		setConfirmId(void 0);
																	},
																	children: t("card.deleteNo")
																})
															] })
														]
													})
												]
											})
										}, idea.id);
									})]
								})]
							}, status);
						})
					})] }) : activeTab === "priorities" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PrioritiesView, {
						client,
						openIdeas: scopedOpen,
						allIdeas: ideas,
						workspaceTitle,
						onEdit: openEdit,
						onToggleTag: toggleTag,
						activeTags: tagFilter,
						mdMode,
						grouped: workspaceFilter === ""
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeliveredView, {
						client,
						archivedIdeas,
						workspaceTitle,
						onEdit: openEdit,
						onToggleTag: toggleTag,
						activeTags: tagFilter,
						mdMode
					}),
					showNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaModal, {
						client,
						initialWorkspace: workspaceFilter,
						onClose: () => {
							setShowNew(false);
						}
					}),
					editing !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaModal, {
						client,
						initial: editing,
						onClose: () => {
							setEditing(void 0);
						},
						onFollowUp: (idea) => {
							setFollowUp(idea);
						},
						onReanalyze: canReanalyze(editing) ? (idea) => {
							setReanalyzing(idea);
						} : void 0
					}),
					reanalyzing !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReanalyzeModal, {
						client,
						idea: reanalyzing,
						workspaceTitle: workspaceTitle(reanalyzing.workspaceId ?? ""),
						onLaunch: reanalyzeIdea,
						onClose: () => {
							setReanalyzing(void 0);
						}
					}),
					followUp !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FollowUpModal, {
						client,
						parent: followUp,
						onClose: () => {
							setFollowUp(void 0);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/board-mount.tsx
		/**
		* Mount the board React tree into the center column and bind its visibility
		* to the client's boardOpen state.
		* @param client - the ideas client driving the view.
		* @returns disposer unmounting the tree and restoring the column.
		*/
		function mountBoard(client) {
			return mountCenterPanel({
				render: (root) => root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeasBoard, { client })),
				viewDatasetKey: "dshIdeasView",
				pluginName: "ideas",
				viewClassName: classes.boardView,
				activeAttribute: "data-dsh-ideas-active",
				siblingActiveAttributes: ["data-dsh-taskboard-active", "data-dsh-ssh-active"],
				panelName: "ideas",
				siblingPanelNames: ["taskboard", "ssh"],
				evictDetails: ["ssh", "taskboard"],
				isOpen: () => client.boardOpen,
				close: () => client.closeBoard(),
				subscribe: (listener) => client.subscribe(listener)
			});
		}
		//#endregion
		//#region src/client/sidebar-entry-core.ts
		/**
		* Sidebar entry injection core (same discipline as the dsh-task-board /
		* dsh-ssh family: shared logic lives once here, packages supply their icon,
		* copy, CSS classes, ordering and toggle through options).
		*
		* dsh's sidebar shell exposes no slot an external plugin can register into,
		* so the entry row is injected between the shell's New Session button and the
		* workspace browser. The injection self-heals: a MutationObserver watches the
		* sidebar root and re-inserts the row whenever a React re-render displaces it
		* (re-insertion happens in the same frame, before paint, so no flicker).
		*
		* The row is plain DOM (no React tree) so it can never disturb the shell's
		* reconciliation; the view it toggles is a separate root owned by the caller.
		*/
		/** Find the sidebar shell root element, or undefined while not yet mounted. */
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
		function newSessionButton(root) {
			const nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (const child of root.children) if (child.tagName === "BUTTON") return child;
		}
		/** Build the entry row (a detached button; insert once the shell is up). */
		function createEntry(options) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.setAttribute(options.rowAttribute, "");
			if (options.plugin !== void 0) {
				entry.setAttribute("data-dsh-plugin", options.plugin);
				entry.setAttribute("data-dsh-part", "sidebar-entry");
			}
			entry.className = options.css["entry"] ?? "";
			const labelSpan = document.createElement("span");
			labelSpan.className = options.css["entryLabel"] ?? "";
			const iconSpan = document.createElement("span");
			iconSpan.className = options.css["entryIcon"] ?? "";
			iconSpan.innerHTML = options.icon;
			entry.append(iconSpan, labelSpan);
			const applyLabel = () => {
				entry.setAttribute("aria-label", options.label());
				if (options.tooltip !== void 0) entry.setAttribute("title", options.tooltip());
				labelSpan.textContent = options.label();
			};
			applyLabel();
			entry.addEventListener("click", options.onToggle);
			return { entry };
		}
		/** Re-insert the entry after the New Session row (before the browser region). */
		function placeEntry(root, entry, options) {
			const button = newSessionButton(root);
			if (button === void 0) return false;
			if (entry.parentElement !== root) {
				const row = button.closest("[class*=\"logoRow\"]");
				const base = row !== null && row.parentElement === root ? row : button;
				const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches(options.familySelectors.join(", ")));
				const anchor = options.position === "before" ? family.length > 0 ? family[0] : base.nextElementSibling : family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry$1(options) {
			if (typeof document !== "undefined" && document.querySelector(options.rowSelector) !== null) return () => {};
			const { entry } = createEntry(options);
			let root;
			let placed = false;
			const tryPlace = () => {
				if (root !== void 0 && !root.isConnected) {
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				placed = placeEntry(root, entry, options);
				if (placed) rootObserver.observe(root, {
					childList: true,
					subtree: true
				});
			};
			const unsubscribeBody = subscribeBodyInvalidations(() => {
				tryPlace();
			});
			const rootObserver = new MutationObserver(() => {
				if (root === void 0 || !root.isConnected) {
					placed = false;
					tryPlace();
					return;
				}
				if (!root.contains(entry)) placed = placeEntry(root, entry, options);
			});
			const unsubscribeActive = options.active === void 0 ? void 0 : (() => {
				const syncActive = () => {
					if (options.active.isOpen()) entry.dataset.active = "true";
					else delete entry.dataset.active;
				};
				const unsubscribe = options.active.subscribe(syncActive);
				syncActive();
				return unsubscribe;
			})();
			tryPlace();
			return () => {
				unsubscribeBody();
				rootObserver.disconnect();
				unsubscribeActive?.();
				entry.remove();
			};
		}
		//#endregion
		//#region src/client/sidebar-entry.ts
		/** Stable data attribute identifying the injected entry row. */
		const ENTRY_SELECTOR = "[data-dsh-ideas-entry]";
		/** Inline icon normalized to the shell's 18px navigation glyph size. */
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M8 1.5a4.3 4.3 0 0 0-2.1 8c.5.3.8.8.8 1.4v.6h2.6v-.6c0-.6.3-1.1.8-1.4A4.3 4.3 0 0 0 8 1.5Z\"/><path d=\"M6.6 13h2.8M6.9 14.5h2.2\"/></svg>";
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @param client - the ideas client the entry toggles.
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry(client) {
			return mountSidebarEntry$1({
				rowAttribute: "data-dsh-ideas-entry",
				rowSelector: ENTRY_SELECTOR,
				plugin: "ideas",
				icon: ICON,
				css: classes,
				label: () => t("entry.label"),
				tooltip: () => t("entry.tooltip"),
				onToggle: () => {
					client.toggleBoard();
				},
				position: "after",
				familySelectors: [
					"[data-dsh-ideas-entry]",
					"[data-dsh-taskboard-entry]",
					"[data-dsh-ssh-entry]"
				],
				active: {
					subscribe: (listener) => client.subscribe(listener),
					isOpen: () => client.boardOpen
				}
			});
		}
		//#endregion
		//#region src/client/settings-section.tsx
		/**
		* Settings surface for the plugin: a section in the DSH Settings modal,
		* registered through the shell's `settings.section` slot, reading and writing
		* the `ideas` settings namespace through the plugin's OWN fenced
		* /api/ideas/config route (the DSH settings RPC domain serves only
		* allowlisted namespaces to configuration clients - the Side card precedent).
		*
		* Two jobs, one install function:
		*  - applyTagChipRows runs on every IdeasClient config change and pushes the
		*    `tagRows` row budget onto the document (--dsh-ideas-tag-rows), which
		*    the tag-zone rule reads through calc();
		*  - registerIdeasSettingsSection contributes the nav row + page when the
		*    shell exposes the slots contract; a shell without it still gets the
		*    style wiring (never throws - the GUI must survive this plugin).
		*
		* Copy discipline: every option carries an explicit title AND a description
		* stating what it changes, its range/default and when it applies; failures
		* render inline instead of silently reverting. Controls commit immediately
		* (selects and toggle switches), except the number row which stages its draft
		* and commits on blur/Enter so typing never writes per keystroke.
		*/
		/**
		* Push the tag-filter row budget (settings option `tagRows`, 1..5) onto the
		* document as --dsh-ideas-tag-rows; the tag-zone rule reads it through
		* calc(). Idempotent and clamped, so a corrupt wire can never break layout.
		*/
		function applyTagChipRows(rows) {
			if (typeof document === "undefined") return;
			document.documentElement.style.setProperty("--dsh-ideas-tag-rows", String(clampTagRows(rows)));
		}
		/** One option row: title and description, with an optional control on the title line. */
		function SettingsRow({ title, desc, control, controlOnTitle = false }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.settingsRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `${classes.settingsRowText}${controlOnTitle ? ` ${classes.settingsRowTextWithTitleControl}` : ""}`,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.settingsRowHeading,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: classes.settingsRowTitle,
							children: title
						}), controlOnTitle && control]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.settingsRowDesc,
						children: desc
					})]
				}), !controlOnTitle && control]
			});
		}
		/** The section page: heading, intro, status lines, and the option rows. */
		function IdeasSettingsSection({ client }) {
			const [, bump] = (0, react.useState)(0);
			(0, react.useEffect)(() => client.subscribe(() => {
				bump((count) => count + 1);
			}), [client]);
			const [draft, setDraft] = (0, react.useState)(void 0);
			const raw = client.config;
			const view = {
				...raw,
				value: sanitizeSettings(raw.value)
			};
			const value = view.value;
			const disabled = !view.available || client.configPending;
			const commitRows = () => {
				if (draft === void 0) return;
				const text = draft.trim();
				setDraft(void 0);
				if (text === "") return;
				const parsed = Number(text);
				if (!Number.isFinite(parsed)) return;
				const clamped = clampTagRows(parsed);
				if (clamped === value.tagRows) return;
				client.saveConfig({ tagRows: clamped });
			};
			const onKeyDown = (event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				commitRows();
			};
			const save = (patch) => {
				client.saveConfig(patch);
			};
			const errorText = () => {
				const code = client.configError;
				if (code === void 0) return void 0;
				if (code === "settings-conflict") return t("settings.conflict");
				if (code === "settings-unavailable") return t("settings.unavailable");
				return `${t("settings.saveFailed")}${code}`;
			};
			const error = errorText();
			const tabLabels = {
				overview: t("tab.overview"),
				priorities: t("tab.priorities"),
				delivered: t("tab.delivered")
			};
			const densityLabels = {
				comfortable: t("settings.densityComfortable"),
				compact: t("settings.densityCompact")
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: classes.settingsSection,
				"data-dsh-ideas-settings": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: classes.settingsTitle,
						children: t("settings.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: classes.settingsIntro,
						children: t("settings.intro")
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.settingsError,
						children: error
					}),
					!view.available && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.settingsNote,
						children: t("settings.unavailable")
					}),
					view.available && draft === void 0 && client.configPending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.settingsNote,
						children: t("settings.loading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.settingsCard,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.settingsGroup,
								children: t("settings.group")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.tagRows"),
								desc: t("settings.tagRowsDesc"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classes.settingsNumber,
									type: "number",
									inputMode: "numeric",
									min: 1,
									max: 5,
									step: 1,
									value: draft ?? String(value.tagRows),
									disabled,
									"aria-label": t("settings.tagRows"),
									onChange: (event) => {
										setDraft(event.target.value);
									},
									onBlur: commitRows,
									onKeyDown
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.cardDensity"),
								desc: t("settings.cardDensityDesc"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									className: classes.settingsSelect,
									value: value.cardDensity,
									disabled,
									"aria-label": t("settings.cardDensity"),
									onChange: (event) => {
										save({ cardDensity: event.target.value });
									},
									children: IDEAS_DENSITIES.map((density) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: density,
										children: densityLabels[density]
									}, density))
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.renderMarkdown"),
								desc: t("settings.renderMarkdownDesc"),
								controlOnTitle: true,
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classes.settingsToggle,
									type: "checkbox",
									checked: value.renderMarkdown,
									disabled,
									"aria-label": t("settings.renderMarkdown"),
									onChange: (event) => {
										save({ renderMarkdown: event.target.checked });
									}
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.settingsCard,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.settingsGroup,
								children: t("settings.groupBehavior")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.defaultTab"),
								desc: t("settings.defaultTabDesc"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									className: classes.settingsSelect,
									value: value.defaultTab,
									disabled,
									"aria-label": t("settings.defaultTab"),
									onChange: (event) => {
										save({ defaultTab: event.target.value });
									},
									children: IDEAS_TABS.map((tab) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: tab,
										children: tabLabels[tab]
									}, tab))
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.rememberScope"),
								desc: t("settings.rememberScopeDesc"),
								controlOnTitle: true,
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classes.settingsToggle,
									type: "checkbox",
									checked: value.rememberWorkspaceScope,
									disabled,
									"aria-label": t("settings.rememberScope"),
									onChange: (event) => {
										save({ rememberWorkspaceScope: event.target.checked });
									}
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.confirmLifecycle"),
								desc: t("settings.confirmLifecycleDesc"),
								controlOnTitle: true,
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classes.settingsToggle,
									type: "checkbox",
									checked: value.confirmLifecycle,
									disabled,
									"aria-label": t("settings.confirmLifecycle"),
									onChange: (event) => {
										save({ confirmLifecycle: event.target.checked });
									}
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.hideDeclined"),
								desc: t("settings.hideDeclinedDesc"),
								controlOnTitle: true,
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classes.settingsToggle,
									type: "checkbox",
									checked: value.hideDeclinedColumn,
									disabled,
									"aria-label": t("settings.hideDeclined"),
									onChange: (event) => {
										save({ hideDeclinedColumn: event.target.checked });
									}
								})
							})
						]
					})
				]
			});
		}
		/**
		* Install the settings glue: wire `tagRows` from the client's config onto the
		* document (a settings write updates the open board live) and register the
		* Settings-modal section when the shell exposes the slots contract. A context
		* without slots still gets the style wiring. Returns the combined disposer.
		*/
		function registerIdeasSettingsSection(ctx, client) {
			const applyStyle = () => {
				applyTagChipRows(client.config.value.tagRows);
			};
			applyStyle();
			const offStyle = client.subscribe(applyStyle);
			let offSection;
			try {
				const slots = ctx?.slots;
				if (slots === void 0 || typeof slots.inject !== "function" || typeof slots.register !== "function") return offStyle;
				offSection = slots.inject("settings.section", () => slots.register({
					name: "settings.section",
					id: "ideas",
					order: 60,
					label: () => t("settings.nav"),
					inject: () => ({ client })
				}, IdeasSettingsSection));
			} catch (error) {
				console.error("[dsh-plugin-ideas-manager] settings section registration failed", error);
			}
			return () => {
				offStyle();
				offSection?.();
			};
		}
		//#endregion
		//#region src/client/session-context.ts
		/**
		* Session-aware capture context (T3): resolve which DSH workspace the current
		* session belongs to, so a new idea capture defaults to the project being
		* discussed instead of landing generic.
		*
		* The resolution mirrors the shell's own "active workspace" rule
		* (@linxin666/dsh-web-all git-graph auto-isolation and the task-board family):
		*
		*   sessions.list.getSnapshot().current            -> the current session id
		*   workspaces.list.getSnapshot().items[].sessionIds.includes(current)
		*                                                    -> that session's workspace
		*   workspaces.list.getSnapshot().recentWorkspaceId -> fallback when no session
		*                                                      is bound to a workspace yet
		*
		* Both services are consumed defensively (duck-typed and optional): when they
		* are absent the resolver returns undefined and the board keeps its current
		* capture default (board scope, else generic). The settings namespace is
		* untouched — this is a read-only context hint, never a workspace mutation.
		*/
		/** Cordis service name exposing the session list (same name as the task-board family). */
		const SESSIONS_SERVICE = "sessions";
		/**
		* Resolve the workspace of the current session from two shell snapshots.
		* Pure and unit-testable: returns undefined when nothing binds a session to a
		* workspace (or the registry does not know the ids yet).
		*/
		function resolveActiveWorkspace(currentSessionId, items, recentWorkspaceId) {
			if (currentSessionId !== void 0 && currentSessionId !== "") {
				for (const item of items ?? []) if (item.sessionIds?.includes(currentSessionId) === true) return {
					workspaceId: item.workspaceId,
					title: workspaceLabel(item)
				};
			}
			if (recentWorkspaceId !== void 0 && recentWorkspaceId !== "") {
				for (const item of items ?? []) if (item.workspaceId === recentWorkspaceId) return {
					workspaceId: item.workspaceId,
					title: workspaceLabel(item)
				};
			}
		}
		/**
		* Optional active-workspace adapter: watches the session + workspaces streams
		* and re-resolves the current workspace on every change. Degrades to
		* undefined on any failure (read-only; the board stays fully functional).
		*/
		var DshActiveWorkspaceSource = class {
			currentWorkspace;
			listeners = /* @__PURE__ */ new Set();
			unsubscribes = [];
			constructor(sessions, workspaces) {
				const replace = () => {
					try {
						const sessionsSnapshot = sessions.list.getSnapshot();
						const workspacesSnapshot = workspaces.list.getSnapshot();
						this.currentWorkspace = resolveActiveWorkspace(sessionsSnapshot.current, workspacesSnapshot.items, workspacesSnapshot.recentWorkspaceId);
					} catch {
						this.currentWorkspace = void 0;
					}
					this.notify();
				};
				for (const service of [sessions, workspaces]) try {
					this.unsubscribes.push(service.list.subscribe(replace));
				} catch {}
				replace();
			}
			current() {
				return this.currentWorkspace === void 0 ? void 0 : { ...this.currentWorkspace };
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			dispose() {
				for (const unsubscribe of this.unsubscribes.splice(0)) try {
					unsubscribe();
				} catch {}
				this.listeners.clear();
			}
			notify() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		/**
		* Defensively resolve the session + workspaces services from a client context.
		* Returns undefined when either service is absent or malformed, so callers
		* keep the pre-T3 capture default (board scope, else generic).
		*/
		function resolveActiveWorkspaceSource(ctx) {
			try {
				const sessions = ctx.get(SESSIONS_SERVICE);
				if (typeof sessions !== "object" || sessions === null) return void 0;
				const sessionsList = sessions.list;
				if (typeof sessionsList !== "object" || sessionsList === null) return void 0;
				const sessionsFace = sessionsList;
				if (typeof sessionsFace.getSnapshot !== "function" || typeof sessionsFace.subscribe !== "function") return void 0;
				const workspaces = ctx.get("workspaces");
				if (typeof workspaces !== "object" || workspaces === null) return void 0;
				const workspacesList = workspaces.list;
				if (typeof workspacesList !== "object" || workspacesList === null) return void 0;
				const workspacesFace = workspacesList;
				if (typeof workspacesFace.getSnapshot !== "function" || typeof workspacesFace.subscribe !== "function") return void 0;
				return new DshActiveWorkspaceSource(sessions, workspaces);
			} catch {
				return;
			}
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Cordis services this plugin consumes. Declared so apply runs once the DSH
		* shell Workspace registry (dsh-api-workspace-controller), the session
		* controller and the typed remote namespaces are up; the board still works
		* without them (ledger-derived workspace ids only, scope-or-generic capture
		* default). `remote` / `remote.session` are required so the model picker can
		* read the Host catalog and select a model; without them the AI capture stays
		* functional but the model selector is hidden. `slots` is the shell slot
		* registry (settings.section...): cordis REFUSES ctx.slots access without the
		* declaration ("cannot get property without inject") — same inject the Side
		* card plugin declares; the web shell bundle provides the service.
		*/
		const inject = [
			"slots",
			WORKSPACES_SERVICE,
			SESSIONS_SERVICE,
			"remote",
			"remote.session"
		];
		let claimed = false;
		const releaseClaim = () => {
			claimed = false;
		};
		function apply(ctx) {
			if (claimed) return;
			claimed = true;
			ctx.effect(() => releaseClaim, "ideas: apply claim");
			ctx.effect(() => {
				ensureIdeasStyle();
				const workspaces = resolveWorkspacesSource(ctx);
				const activeWorkspace = resolveActiveWorkspaceSource(ctx);
				const client = new IdeasClient(new HttpIdeasHostTransport(), workspaces, activeWorkspace);
				client.sessionLauncher = resolveSessionLauncher(ctx);
				client.start();
				const disposers = [];
				try {
					disposers.push(mountSidebarEntry(client));
					disposers.push(mountBoard(client));
				} catch (error) {
					console.error("[dsh-plugin-ideas-manager] mount failed:", error);
				}
				try {
					disposers.push(registerIdeasSettingsSection(ctx, client));
				} catch (error) {
					console.error("[dsh-plugin-ideas-manager] settings glue failed:", error);
				}
				return () => {
					for (const dispose of disposers.splice(0)) dispose();
					client.dispose();
				};
			}, "ideas: sidebar entry and board view");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map