window.__ModuleLoader__.load({
	id: "dsh-plugin-ideas-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
		//#region src/core/ideas-stats.ts
		/** One day in milliseconds — the unit {@link durationParts} falls back on. */
		const IDEAS_STATS_DAY_MS = 864e5;
		/**
		* Split a duration into a value and a unit the panel can label. Pure and
		* locale-free on purpose: the definition of "how long" belongs here, the words
		* for it belong to the dictionary.
		*
		* Rounding never produces a zero: a lead time of zero is a real answer, and
		* printing "0 days" for half a day would be the rounding talking, not the data.
		*/
		function durationParts(ms) {
			const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
			const days = safe / IDEAS_STATS_DAY_MS;
			if (days >= 1) return {
				value: Math.round(days),
				unit: "days"
			};
			const hours = safe / 36e5;
			if (hours >= 1) return {
				value: Math.round(hours),
				unit: "hours"
			};
			return {
				value: Math.max(1, Math.round(safe / 6e4)),
				unit: "minutes"
			};
		}
		//#endregion
		//#region src/protocol.ts
		const IDEAS_API_PREFIX = "/api/ideas";
		[
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
		].filter((field) => field !== "body");
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
		/** Serialize the health query for the browser transport. */
		function ideasStatsSearchParams(query = {}) {
			const params = new URLSearchParams();
			params.set("view", "stats");
			if (query.workspaceId !== void 0) params.set("workspaceId", query.workspaceId);
			return params;
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
		* Orderings of the OPEN backlog offered by the settings row (idea #71):
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
		* Inclusive bounds of the `staleAfterDays` option (idea #91). 0 is a real
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
		* `workspaceId -> provider/model` (idea #107).
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
		//#endregion
		//#region src/client/locales.ts
		/**
		* Ideas board copy: per-document-language dictionary (`fr`, `en`, `zh`) with
		* an English default. Kept dependency-free (no dsh locale service) so the
		* DOM-injected entry row and the standalone board tree share one lookup.
		*
		* A plugin-owned language override (the `language` setting, applied by
		* IdeasClient) wins over the DSH shell language; see setLanguageOverride.
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
			"board.openColumnNotice": "Cette colonne contient {count} idées ouvertes. Faites défiler pour atteindre les autres — le glisser-déposer et la sélection multiple couvrent toujours toute la colonne.",
			"board.hostError": "Échec de l'opération Host : {error}",
			"board.retryHost": "Réessayer la connexion Host",
			"board.tagFilter": "Filtre :",
			"board.tagFilterSearch": "Rechercher une étiquette…",
			"board.tagFilterNoMatch": "Aucune étiquette correspondante",
			"board.tagFilterClear": "Effacer le filtre",
			"board.jump": "Aller à une idée par son numéro",
			"board.jumpPlaceholder": "#42",
			"board.jumpGo": "Aller",
			"board.jumpUnknown": "Aucune idée de ce tableau ne correspond à {ref}. Elle a peut-être été supprimée, ou le numéro appartient à un autre tableau.",
			"board.jumpHidden": "L'idée {ref} est refusée et la colonne Refusées est masquée : il n'y a aucune carte à mettre en avant.",
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
			"settings.defaultTabDesc": "Section du tableau ouverte au démarrage du panneau : Aperçu, Priorités, Livraisons ou Santé. Changer d’onglet en cours de session reste libre et sert de repli si les réglages sont indisponibles.",
			"settings.renderMarkdown": "Descriptions en Markdown par défaut",
			"settings.renderMarkdownDesc": "Affiche le corps des cartes en Markdown rendu dès l’ouverture ; le bouton MD/Texte de l’en-tête bascule librement en cours de session. Activé par défaut.",
			"settings.rememberScope": "Mémoriser le périmètre workspace",
			"settings.rememberScopeDesc": "Quand c’est activé, le panneau rouvre sur le dernier espace de travail sélectionné au lieu de revenir à Tous les espaces. Désactivé par défaut.",
			"settings.confirmLifecycle": "Confirmer Livrer et Refuser",
			"settings.confirmLifecycleDesc": "Demande une confirmation en place (Oui/Non) avant Livrer ou Refuser, comme pour Supprimer. Désactivé par défaut : ces actions s’appliquent en un clic.",
			"settings.hideDeclined": "Masquer la colonne Refusées",
			"settings.hideDeclinedDesc": "N’affiche pas la colonne Refusées du tableau (gain de place). Les idées refusées quittent la vue kanban : elles restent dans le ledger et l’export markdown. Désactivé par défaut.",
			"settings.cardDensity": "Densité des cartes",
			"settings.cardDensityDesc": "Normal : rendu complet. Compacte : les cartes de l’Aperçu ET les lignes de Priorités/Livraisons masquent les étiquettes, la description, la date et le workspace, avec des espacements réduits — titre et badges valeur/effort restent.",
			"settings.densityComfortable": "Normal",
			"settings.densityCompact": "Compacte",
			"settings.directRunPermission": "Permission des lancements directs",
			"settings.directRunPermissionDesc": "Niveau accordé à la session neuve quand vous lancez une idée sans carte TaskBoard. Par défaut workspace-write : le brief d’exécution demande d’implémenter, donc une session en lecture seule ne produirait qu’un plan. Sans effet sur les idées liées à une carte, qui suivent le réglage du TaskBoard.",
			"settings.openOrdering": "Ordre de la colonne Ouvertes",
			"settings.openOrderingDesc": "L’ordre par défaut de la colonne Ouvertes. Ce n’est qu’un défaut : dès que vous réordonnez cette colonne à la main, elle affiche votre ordre. Choisissez un autre ordre ici pour revenir à une vue par date.",
			"settings.openOrderingCreatedAt": "Date de création (plus anciennes d’abord)",
			"settings.openOrderingCreatedAtDesc": "Date de création (plus récentes d’abord)",
			"settings.openOrderingRank": "Rang",
			"settings.runningFirst": "Afficher les idées en cours d’exécution en haut",
			"settings.runningFirstDesc": "Fait remonter les idées dont une exécution est en cours au-dessus de l’ordre choisi ci-dessus, sans le modifier. Tant que cette option est cochée, l’ordre affiché diffère du rang enregistré ; le réordonnancement à la main reste possible, et la colonne affiche alors votre ordre.",
			"card.dragTakesOver": "Glissez pour déplacer la carte vers une autre colonne, ou réordonner celle-ci : un réordonnancement manuel fait afficher votre ordre, qui prend le pas sur le tri par défaut jusqu’à ce que vous en choisissiez un autre dans les options.",
			"card.confirmLifecycle": "Confirmer cette action ?",
			"board.dragHint": "Glissez les cartes entre les colonnes, et réordonnez-les dans la colonne Ouvertes (poignée ⠿ en haut du titre)",
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
			"tab.health": "Santé",
			"health.hint": "Vue d'ensemble du backlog {scope} — les chiffres sont calculés par l'hôte, jamais recomptés par le tableau",
			"health.scopeAll": "tous les espaces de travail",
			"health.scopeGeneric": "des idées sans espace de travail",
			"health.loading": "Calcul de la vue de santé…",
			"health.unavailable": "Cette installation ne sert pas cette vue de santé : le reste du tableau fonctionne normalement.",
			"health.error": "Échec de la lecture de la vue de santé : {error}",
			"health.retry": "Réessayer",
			"health.stale": "Chiffres calculés à la révision {revision} — le tableau a changé depuis.",
			"health.refreshing": "Chiffres calculés à la révision {revision} — mise à jour en cours…",
			"health.staleError": "Chiffres de la révision {revision}, et la mise à jour a échoué : {error}",
			"health.openTitle": "Backlog ouvert",
			"health.openValue": "{open} ouverte(s) sur {total} idée(s)",
			"health.openHint": "et leur répartition par espace de travail",
			"health.deliveredTitle": "Livré ce mois-ci",
			"health.deliveredValue": "{count} idée(s) livrée(s)",
			"health.deliveredWindow": "mois calendaire en cours ({month}), sur l'horloge de l'hôte",
			"health.medianTitle": "Temps médian de livraison",
			"health.medianValue": "{value} {unit}",
			"health.medianHint": "sur {count} livraison(s) horodatée(s) au total",
			"health.medianThin": "Pas encore assez de livraisons ({count} / {min})",
			"health.medianThinHint": "le temps médian n'est affiché qu'à partir de {min} livraisons réelles",
			"health.withoutStamp": "{count} idée(s) ont quitté le backlog sans horodatage de livraison : elles ne comptent pas dans le temps médian.",
			"health.inconsistent": "{count} horodatage(s) précèdent leur propre création : ils ne sont pas moyennés.",
			"health.noDeliveries": "Aucune livraison horodatée pour l'instant.",
			"health.workspacesTitle": "Ouvert par espace de travail",
			"health.workspacesEmpty": "Aucune idée dans ce périmètre",
			"health.workspaceRow": "{open} ouverte(s) · {total} au total",
			"health.moreWorkspaces": "+ {count} autre(s) espace(s) de travail",
			"health.tagsTitle": "Étiquettes les plus utilisées (backlog ouvert)",
			"health.tagsEmpty": "Aucune étiquette sur le backlog ouvert",
			"health.moreTags": "+ {count} autre(s) étiquette(s)",
			"health.triageTitle": "À trier",
			"health.triageValue": "{count} point(s) de tri à compléter",
			"health.triageHint": "travail à faire sur vos idées, pas une note de qualité",
			"health.triageDetailTitle": "Détails du tri",
			"health.missingRank": "idées ouvertes sans rang",
			"health.missingValue": "idées ouvertes sans valeur",
			"health.unitMinutes": "min",
			"health.unitHours": "h",
			"health.unitDays": "j",
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
			"edit.title": "Modifier l'idée {number}",
			"edit.save": "Enregistrer",
			"edit.preview": "Aperçu MD",
			"edit.previewOff": "Texte brut",
			"edit.workspaceUnknown": "(inconnu)",
			"level.low": "Faible",
			"level.medium": "Moyen",
			"level.high": "Élevé",
			"board.status.underReview": "En recette",
			"card.underReviewHint": "Travail terminé, en attente de recette humaine",
			"card.taskFailed": "Tâche en échec",
			"card.taskFailedHint": "La tâche TaskBoard liée est en échec (dernier état observé) : l'idée reste dans le backlog — relance la tâche ou ajuste l'idée",
			"card.taskRunning": "En cours",
			"card.taskRunningHint": "Une exécution de cette idée est en cours. L'idée reste dans le backlog jusqu'à la fin du run, puis passe automatiquement en recette.",
			"card.openSession": "Ouvrir la session",
			"card.openSessionHint": "Ouvrir dans DSH la conversation où cette idée a été traitée",
			"card.deliveryNote": "Note de livraison",
			"card.deliveryNoteHint": "Ce que la dernière exécution terminée a dit en dernier. « Ouvrir la session » reste le moyen de revoir le run entier.",
			"card.deliveryNoteEmpty": "Cette exécution n'a laissé aucune note : ouvrez la session pour savoir ce qu'il s'est passé.",
			"card.stale": "Périmée",
			"card.staleHint": "Aucune mise à jour depuis {days} jours.",
			"entry.reviewCountHint": "{count} idée(s) en attente de validation",
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
			"card.findSimilar": "Chercher des similaires",
			"card.findSimilarHint": "Demander à l'analyste si cette idée ouverte en double une autre du backlog de cet espace : le tableau propose ses candidats, l'analyste les juge et rapporte. Rien n'est fusionné sans vous.",
			"similar.title": "Chercher des idées similaires",
			"similar.hint": "Le tableau a comparé cette idée à {scanned} idée(s) ouverte(s) de l'espace {workspace} et gardé les plus proches. Une session d'analyste lira leur contenu réel et rapportera, pour chacune, s'il s'agit d'un doublon ou non — elle ne fusionne rien.",
			"similar.loading": "Recherche des idées similaires…",
			"similar.empty": "Aucune idée similaire dans le backlog ouvert de cet espace.",
			"similar.candidates": "Candidats signalés par le tableau",
			"similar.score": "score {score} · {signals}",
			"similar.signalTitle": "titre",
			"similar.signalTags": "étiquettes",
			"similar.signalLegend": "Un signal approximatif (recouvrement du titre et des étiquettes), pas un verdict : l'analyste lit chaque candidat avant de le juger.",
			"similar.askAnalyst": "Demander à l'analyste",
			"similar.cancel": "Annuler",
			"similar.loadFailed": "La recherche de similaires a échoué : {error}",
			"card.launch": "Lancer l'exécution",
			"card.launchHint": "Démarrer l'exécution de cette idée sur sa carte TaskBoard : une session reprend l'idée comme instruction ; au succès la carte passe done et l'idée arrive en recette",
			"relations.title": "Relations",
			"relations.hint": "Des liens que vous déclarez vous-même, jamais déduits par le tableau : lister une idée voisine, ou une idée qui doit atterrir avant celle-ci.",
			"relations.relatesTo": "Proche de",
			"relations.blocks": "Doit attendre",
			"relations.blockedBy": "Attend cette idée",
			"relations.none": "aucune",
			"relations.blockedByNone": "rien ne bloque cette idée",
			"relations.nothingToAdd": "Aucune autre idée à lier",
			"relations.more": "+{count}",
			"relations.addRelated": "Ajouter une idée voisine…",
			"relations.addBlocked": "Ajouter une idée à attendre…",
			"relations.removeRelated": "Retirer le lien avec {target}",
			"relations.removeBlocked": "Retirer {target} des idées à attendre",
			"relations.relatesToHint": "Idée voisine de {target} : lisez celle-ci aussi",
			"relations.blocksHint": "Ne peut pas atterrir avant {target}",
			"relations.blockedByHint": "{target} ne peut pas atterrir avant celle-ci : le lien est déclaré sur la carte de {target}",
			"relations.blockedByExplained": "Une relation « attend cette idée » se déclare sur l'autre carte : ouvrez {target} pour la retirer.",
			"launch.title": "Lancer l'exécution",
			"launch.hint": "Une nouvelle session va implémenter cette idée dans l'espace {workspace}. Le modèle choisi est épinglé sur la carte avant le lancement ; sans choix, la session utilise son modèle par défaut. Au succès, l'idée passe automatiquement en recette.",
			"launch.sessionHint": "Aucune carte tâche n'est liée à cette idée : le lancement ouvre une session de chat neuve dans son espace, avec la permission par défaut de DSH. Elle continue même si vous fermez cet onglet.",
			"launch.submit": "Lancer",
			"launch.cancel": "Annuler",
			"launch.permissionHint": "Le TaskBoard refuse de lancer cette carte tant qu'un humain n'a pas confirmé sa permission (au-dessus du défaut de session). Mettez la carte en vue ici, ou ouvrez le TaskBoard et retrouvez-la sous ce titre pour confirmer sa permission.",
			"launch.openTaskBoard": "Ouvrir le TaskBoard",
			"launch.showCard": "Afficher la carte",
			"launch.copyTitle": "Copier le titre",
			"launch.titleCopied": "Titre copié",
			"launch.defaultModel": "Modèle de lancement par défaut",
			"launch.defaultHint": "Les idées de cet espace de travail se lancent sur ce modèle, sauf si vous en choisissez un autre pour une seule exécution.",
			"launch.changeDefault": "Changer…",
			"launch.forgetDefault": "Oublier ce modèle",
			"launch.rememberDefault": "Retenir ce modèle pour {workspace}",
			"launch.saveDefault": "Enregistrer comme modèle par défaut",
			"followUp.title": "Suivi requis",
			"followUp.parent": "Pour : {title}",
			"followUp.childTitle": "Titre de la nouvelle idée",
			"followUp.childTitlePlaceholder": "Follow-up de #{number} — {title}",
			"followUp.justification": "Justification de la demande (reprise dans le corps de la nouvelle idée)",
			"followUp.summaryLabel": "Résumé de la carte d’origine",
			"followUp.submit": "Créer le suivi",
			"followUp.cancel": "Annuler",
			"followUp.required": "Le titre du suivi est requis",
			"settings.language": "Langue de l'interface",
			"settings.languageDesc": "Langue du panneau lui-même, indépendante du réglage DSH : par défaut « suivre le shell » (un shell en chinois affiche un panneau en chinois), ou fixez English, Français ou 中文.",
			"settings.languageAuto": "== Auto ==",
			"settings.languageEn": "English",
			"settings.languageFr": "Français",
			"settings.languageZh": "中文",
			"about.panelLabel": "À propos de ce plugin",
			"about.repository": "Dépôt",
			"about.version": "Version",
			"about.license": "Licence",
			"about.compatibleVersions": "Compatibilité DSH",
			"about.checkUpdate": "Vérifier les mises à jour",
			"about.tabDisplay": "Affichage",
			"about.tabAbout": "À propos",
			"about.tabBackup": "Sauvegarde",
			"about.tabs": "Onglets des réglages",
			"settings.columnMinWidth": "Largeur minimale de colonne",
			"settings.columnMinWidthDesc": "Plus petite largeur vers laquelle on peut glisser une colonne du kanban, en pixels : de 120 à 480, 200 par défaut. Glissez le bord droit d'une colonne pour la redimensionner ; double-cliquez sur ce bord pour réinitialiser sa largeur.",
			"settings.columnMaxWidth": "Largeur maximale de colonne",
			"settings.columnMaxWidthDesc": "Plus grande largeur vers laquelle on peut glisser une colonne du kanban, en pixels : de 240 à 1382, 922 par défaut. Une colonne ne dépasse jamais cette borne.",
			"settings.staleAfterDays": "Marquer une idée « périmée » après",
			"settings.staleAfterDaysDesc": "Nombre de jours sans mise à jour avant qu'une idée ouverte affiche un badge « Périmée » : de 0 à 3650, 30 par défaut. 0 désactive complètement le badge. Calculé à l'affichage, rien n'est enregistré sur l'idée.",
			"backup.intro": "Le tableau est un fichier sur cette machine. Ces actions en gardent des copies horodatées, en remettent une, et le transportent sur une autre machine.",
			"backup.groupSnapshots": "Copies de sécurité sur cette machine",
			"backup.listLabel": "Copies",
			"backup.empty": "Aucune copie pour l’instant",
			"backup.retention": "Les {retention} dernières copies sont conservées. Les fichiers que vous déposez vous-même dans le dossier ne sont jamais supprimés.",
			"backup.restore": "Restaurer…",
			"backup.restoreHint": "Remplacer le tableau actuel par cet instantané",
			"backup.restoreConfirm": "Remplacer le tableau actuel par cet instantané ?",
			"backup.restoreConfirmDesc": "Le tableau que vous avez maintenant est d'abord gardé comme son propre instantané, vous pourrez donc y revenir. Une exécution en cours fait refuser la restauration.",
			"backup.restoreYes": "Remplacer le tableau",
			"backup.restoreNo": "Annuler",
			"backup.restoreDone": "{source} restauré — {count} idées. Le tableau remplacé a été gardé sous {displaced}.",
			"backup.restoreBusy": "Une exécution est en cours : la restauration est refusée jusqu’à ce qu’elle se termine.",
			"backup.restoreUnknownFields": "Attention : ce fichier contenait des champs que cette version ne connaît pas, ils n’ont donc pas été restaurés : {fields}. S’il vient d’une version plus récente du plugin, mettez celle-ci à jour puis restaurez à nouveau.",
			"backup.item.manual": "Instantané",
			"backup.item.export": "Copie d'export",
			"backup.item.preRestore": "Tableau gardé avant une restauration",
			"backup.item.foreign": "Fichier ajouté par vous",
			"backup.itemMeta": "{date} · {size}",
			"backup.groupTransfer": "Emmener ce tableau sur une autre machine",
			"backup.export": "Exporter le tableau",
			"backup.exportDesc": "Écrit une copie horodatée du tableau entier — chaque idée, son historique et ses étiquettes — dans votre dossier de sauvegardes, puis vous la propose au téléchargement. Les {retention} dernières copies sont conservées, les plus anciennes sont supprimées. C’est aussi la sortie quand un second Hôte refuse de démarrer sur ce même dossier DSH, parce qu’il possède déjà le tableau.",
			"backup.exportAction": "Exporter le tableau",
			"backup.exported": "Votre copie est prête — téléchargez {name}.",
			"backup.import": "Importer un tableau depuis un fichier",
			"backup.importDesc": "Charge un fichier exporté ici (ou déposé dans votre dossier de sauvegardes). Il REMPLACE le tableau actuel, et le tableau qu’il remplace est gardé comme instantané vers lequel revenir. Un fichier illisible est refusé avec sa raison, sans rien changer.",
			"backup.importAction": "Choisir un fichier…",
			"backup.unavailable": "Les instantanés et la restauration ne sont pas disponibles sur l'instance en cours d'exécution — le tableau, lui, n'est pas affecté. Si vous venez de mettre le plugin à jour, redémarrez l'instance web : la moitié navigateur se recharge avec la page, les routes sont enregistrées au démarrage.",
			"backup.loading": "Lecture de vos instantanés…",
			"backup.pending": "En cours…",
			"backup.failed": "Échec : {error}",
			"backup.download": "Télécharger",
			"board.columnResize": "Redimensionner cette colonne — min {min} px, max {max} px ; double-clic pour réinitialiser",
			"activity.label": "Activité ({count})",
			"activity.hint": "Ce que cette idée a traversé : qui a fait quoi, et quand. Les {count} derniers mouvements sont conservés.",
			"activity.human": "vous",
			"activity.run": "exécution",
			"bulk.select": "Sélectionner pour une action groupée",
			"bulk.scope.everything": "toutes les idées, aucun filtre",
			"bulk.scope.label": "Portée : {scope}",
			"bulk.scope.allWorkspaces": "tous les espaces",
			"bulk.scope.tags": "étiquettes {tags}",
			"bulk.scope.search": "recherche « {query} »",
			"bulk.bar.selectAll": "Tout sélectionner",
			"bulk.bar.clearSelection": "Tout désélectionner",
			"bulk.bar.clear": "Effacer la sélection",
			"bulk.bar.count": "{selected} sélectionnée(s) sur {total} affichée(s)",
			"bulk.bar.tag": "Étiqueter…",
			"bulk.bar.workspace": "Déplacer vers un espace…",
			"bulk.bar.archive": "Archiver…",
			"bulk.bar.tagHint": "Ajouter des étiquettes aux idées sélectionnées, en gardant celles qu’elles portent déjà",
			"bulk.bar.workspaceHint": "Déplacer les idées sélectionnées vers un autre espace de travail",
			"bulk.bar.archiveHint": "Déplacer les idées sélectionnées dans la colonne Archivées",
			"bulk.tag.title": "Étiqueter {count} idée(s)",
			"bulk.batch.count": "{count} idée(s) dans ce lot",
			"bulk.tag.label": "Étiquettes à ajouter (séparées par des virgules)",
			"bulk.tag.placeholder": "examen, dette, 2026-q4",
			"bulk.tag.hint": "Les étiquettes existantes sont conservées ; chaque idée peut en porter 8 au maximum.",
			"bulk.tag.invalid": "Nom d’étiquette trop long (32 caractères maximum) : {tags}",
			"bulk.workspace.title": "Déplacer {count} idée(s)",
			"bulk.workspace.label": "Espace de travail de destination",
			"bulk.workspace.none": "— sans espace —",
			"bulk.archive.title": "Archiver {count} idée(s)",
			"bulk.archive.hint": "Les idées déjà archivées ne changent pas et les idées refusées sont laissées telles quelles : les archiver effacerait leur refus.",
			"bulk.roundTrip": "Une idée archivée liée à une carte tâche est restaurée, modifiée puis archivée à nouveau, pour que sa carte suive le changement.",
			"bulk.submit": "Appliquer",
			"bulk.cancel": "Annuler",
			"bulk.close": "Fermer",
			"bulk.running": "En cours… {done} sur {total}",
			"bulk.report.title": "Rapport de l’action groupée",
			"bulk.report.summary": "{applied} appliquée(s) · {skipped} ignorée(s) · {failed} en échec",
			"bulk.report.applied": "Appliquées ({count})",
			"bulk.report.skipped": "Ignorées ({count})",
			"bulk.report.failed": "En échec ({count})",
			"bulk.reason.declined": "refusée — restaurez-la avant de la changer",
			"bulk.reason.alreadyTagged": "porte déjà ces étiquettes",
			"bulk.reason.tagLimit": "porte déjà 8 étiquettes",
			"bulk.reason.alreadyThere": "déjà dans cet espace",
			"bulk.reason.alreadyArchived": "déjà archivée",
			"bulk.note.rearchived": "réarchivée après l’échec de la modification",
			"bulk.note.leftOpen": "laissée dans les Ouvertes — à archiver à la main",
			"bulk.undo": "Restaurer ces {count} idée(s)",
			"bulk.undoHint": "Une action groupée d’archivage est réversible : le bouton ci-dessous restaure exactement les idées qui viennent d’être archivées.",
			"bulk.undoDone": "{count} idée(s) restaurée(s) dans le backlog ouvert.",
			"bulk.undoReport": "Annulation de l’archivage groupé",
			"bulk.noUndo": "Cette action n’a pas d’annulation ici : seul un archivage groupé se restaure en un clic."
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
			"board.openColumnNotice": "This column holds {count} open ideas. Scroll to reach the rest — drag & drop and multi-select still cover the whole column.",
			"board.hostError": "Host operation failed: {error}",
			"board.retryHost": "Retry Host connection",
			"board.tagFilter": "Filter:",
			"board.tagFilterSearch": "Search tags…",
			"board.tagFilterNoMatch": "No matching tags",
			"board.tagFilterClear": "Clear filter",
			"board.jump": "Go to an idea by its number",
			"board.jumpPlaceholder": "#42",
			"board.jumpGo": "Go",
			"board.jumpUnknown": "No idea on this board matches {ref}. It may have been deleted, or the number belongs to another board.",
			"board.jumpHidden": "Idea {ref} is declined, and the Declined column is hidden — there is no card to bring into view.",
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
			"settings.defaultTabDesc": "The board section opened when the panel starts: Overview, Priorities, Delivered or Health. Switching tabs during a session stays free and is kept as the fallback when settings are unavailable.",
			"settings.renderMarkdown": "Render descriptions as Markdown by default",
			"settings.renderMarkdownDesc": "Show card bodies as rendered markdown when the panel opens; the MD/Text header toggle still switches freely per session. On by default.",
			"settings.rememberScope": "Remember the workspace scope",
			"settings.rememberScopeDesc": "When on, the panel reopens on the last selected workspace instead of All workspaces. Off by default.",
			"settings.confirmLifecycle": "Confirm Deliver and Decline",
			"settings.confirmLifecycleDesc": "Ask for an in-place confirmation (Yes/No) before Deliver or Decline, like Delete does. Off by default: those actions apply in one click.",
			"settings.hideDeclined": "Hide the Declined column",
			"settings.hideDeclinedDesc": "Do not show the board Declined column (saves space). Declined ideas leave the kanban view: they stay in the ledger and the markdown export. Off by default.",
			"settings.cardDensity": "Card density",
			"settings.cardDensityDesc": "Normal: full rendering. Compact: the Overview cards AND the Priorities/Delivered rows hide their tags, description, date and workspace, with tighter spacing too — title and value/effort badges stay.",
			"settings.densityComfortable": "Normal",
			"settings.densityCompact": "Compact",
			"settings.directRunPermission": "Direct-launch permission",
			"settings.directRunPermissionDesc": "Level granted to the fresh session when you launch an idea with no TaskBoard card. Defaults to workspace-write: the run brief asks for implementation, so a read-only session would only produce a plan. No effect on card-backed ideas, which follow the TaskBoard setting.",
			"settings.openOrdering": "Open column order",
			"settings.openOrderingDesc": "The default order of the Open column. It is only a default: as soon as you reorder that column by hand, it shows your order. Pick another order here to go back to a date view.",
			"settings.openOrderingCreatedAt": "Creation date (oldest first)",
			"settings.openOrderingCreatedAtDesc": "Creation date (newest first)",
			"settings.openOrderingRank": "Rank",
			"settings.runningFirst": "Show running ideas at the top",
			"settings.runningFirstDesc": "Floats the ideas whose run is in flight above the order picked above, without changing that order. While this is on, the displayed order differs from the stored rank; reordering by hand still works, and the column then shows your order.",
			"card.dragTakesOver": "Drag to move this card to another column, or to reorder this one: reordering by hand makes the column show YOUR order, which takes over from the default sort until you pick another order in the settings.",
			"card.confirmLifecycle": "Confirm this action?",
			"board.dragHint": "Drag cards between columns, and reorder them inside the Open column (use the ⠿ grip on the title row)",
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
			"tab.health": "Health",
			"health.hint": "Backlog overview for {scope} — the figures are computed by the host, never recounted by the board",
			"health.scopeAll": "all workspaces",
			"health.scopeGeneric": "the ideas with no workspace",
			"health.loading": "Working out the health view…",
			"health.unavailable": "This deployment does not serve the health view; the rest of the board works as usual.",
			"health.error": "Reading the health view failed: {error}",
			"health.retry": "Retry",
			"health.stale": "Figures computed at revision {revision} — the board has moved on since.",
			"health.refreshing": "Figures computed at revision {revision} — refreshing…",
			"health.staleError": "Figures are from revision {revision}, and the refresh failed: {error}",
			"health.openTitle": "Open backlog",
			"health.openValue": "{open} open of {total} idea(s)",
			"health.openHint": "and how that open work splits across workspaces",
			"health.deliveredTitle": "Delivered this month",
			"health.deliveredValue": "{count} delivered",
			"health.deliveredWindow": "current calendar month ({month}), on the host clock",
			"health.medianTitle": "Median time to deliver",
			"health.medianValue": "{value} {unit}",
			"health.medianHint": "across {count} timestamped delivery(ies) in total",
			"health.medianThin": "Not enough deliveries yet ({count} / {min})",
			"health.medianThinHint": "a median is only printed from {min} real deliveries",
			"health.withoutStamp": "{count} idea(s) left the backlog with no delivery stamp — they are not counted in the median.",
			"health.inconsistent": "{count} stamp(s) precede their own creation — they are never averaged in.",
			"health.noDeliveries": "No timestamped delivery yet.",
			"health.workspacesTitle": "Open per workspace",
			"health.workspacesEmpty": "No idea in this scope",
			"health.workspaceRow": "{open} open · {total} total",
			"health.moreWorkspaces": "+ {count} other workspace(s)",
			"health.tagsTitle": "Most used labels (open backlog)",
			"health.tagsEmpty": "No label on the open backlog",
			"health.moreTags": "+ {count} other label(s)",
			"health.triageTitle": "To triage",
			"health.triageValue": "{count} triage point(s) to fill in",
			"health.triageHint": "work to do on your ideas, never a quality score",
			"health.triageDetailTitle": "Triage detail",
			"health.missingRank": "open ideas with no rank",
			"health.missingValue": "open ideas with no value",
			"health.unitMinutes": "min",
			"health.unitHours": "h",
			"health.unitDays": "d",
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
			"edit.title": "Edit idea {number}",
			"edit.save": "Save",
			"edit.preview": "MD preview",
			"edit.previewOff": "Raw text",
			"edit.workspaceUnknown": "(unknown)",
			"level.low": "Low",
			"level.medium": "Medium",
			"level.high": "High",
			"about.panelLabel": "About this plugin",
			"about.repository": "Repository",
			"about.version": "Version",
			"about.license": "License",
			"about.compatibleVersions": "DSH compatibility",
			"about.checkUpdate": "Check for updates",
			"about.tabDisplay": "Display",
			"about.tabAbout": "About",
			"about.tabBackup": "Backup",
			"about.tabs": "Settings tabs",
			"board.status.underReview": "Under review",
			"card.underReviewHint": "Work done, human acceptance pending",
			"card.taskFailed": "Task failed",
			"card.taskFailedHint": "The linked TaskBoard task failed (last observed status): the idea stays in the backlog - retry the task or adjust the idea",
			"card.taskRunning": "Running",
			"card.taskRunningHint": "An execution of this idea is in flight. The idea stays in the backlog until the run settles, then moves to the review gate automatically.",
			"card.openSession": "Open session",
			"card.openSessionHint": "Open, in DSH, the conversation this idea was worked on",
			"card.deliveryNote": "Delivery note",
			"card.deliveryNoteHint": "What the last finished run said last. \"Open session\" is still the way to watch the whole run.",
			"card.deliveryNoteEmpty": "This run left no delivery note: open the session to see what happened.",
			"card.stale": "Stale",
			"card.staleHint": "No update for {days} days.",
			"entry.reviewCountHint": "{count} idea(s) waiting for review",
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
			"card.findSimilar": "Find similar",
			"card.findSimilarHint": "Ask the analyst whether this open idea duplicates something already in this workspace backlog: the board lists its own candidates, the analyst reads their real content and reports. Nothing is merged without you.",
			"similar.title": "Find similar ideas",
			"similar.hint": "The board compared this idea with {scanned} open idea(s) of workspace {workspace} and kept the closest ones. An analyst session will read their real content and report, for each, whether it is a duplicate — it merges nothing.",
			"similar.loading": "Looking for similar ideas…",
			"similar.empty": "Nothing similar in this workspace open backlog.",
			"similar.candidates": "Candidates the board flagged",
			"similar.score": "score {score} · {signals}",
			"similar.signalTitle": "title",
			"similar.signalTags": "tags",
			"similar.signalLegend": "A cheap signal (title and tag overlap), not a verdict: the analyst reads each candidate before judging it.",
			"similar.askAnalyst": "Ask the analyst",
			"similar.cancel": "Cancel",
			"similar.loadFailed": "The similar-idea search failed: {error}",
			"card.launch": "Launch execution",
			"card.launchHint": "Start this idea execution on its TaskBoard card: a new session receives the idea as its instruction. On success the card turns done and the idea moves to the review gate",
			"relations.title": "Relations",
			"relations.hint": "Links you state yourself, never ones the board infers: an idea worth reading next to this one, or one that has to land before it.",
			"relations.relatesTo": "Related to",
			"relations.blocks": "Waits for",
			"relations.blockedBy": "Waiting for this idea",
			"relations.none": "none",
			"relations.blockedByNone": "nothing waits on this idea",
			"relations.nothingToAdd": "No other idea to link",
			"relations.more": "+{count}",
			"relations.addRelated": "Add a related idea…",
			"relations.addBlocked": "Add an idea this one waits for…",
			"relations.removeRelated": "Remove the link with {target}",
			"relations.removeBlocked": "Stop waiting for {target}",
			"relations.relatesToHint": "Related to {target} — read that one too",
			"relations.blocksHint": "Cannot land before {target}",
			"relations.blockedByHint": "{target} cannot land before this one — that link is declared on {target}",
			"relations.blockedByExplained": "A \"waiting for this idea\" link is declared on the other card: open {target} to remove it.",
			"launch.title": "Launch execution",
			"launch.hint": "A new session will implement this idea in workspace {workspace}. The chosen model is pinned on the card before the run; without a pick the session keeps its default model. On success the idea moves to the review gate automatically.",
			"launch.sessionHint": "No task card is linked to this idea: the launch opens a brand-new chat session in its workspace, with the default DSH permission. It keeps running if you close this tab.",
			"launch.submit": "Launch",
			"launch.cancel": "Cancel",
			"launch.permissionHint": "The TaskBoard refuses to run this card until a human confirms its permission (it is above the session default). Bring the card into view here, or open the TaskBoard and find it under this title to confirm its permission.",
			"launch.openTaskBoard": "Open the TaskBoard",
			"launch.showCard": "Show the card",
			"launch.copyTitle": "Copy the title",
			"launch.titleCopied": "Title copied",
			"launch.defaultModel": "Default launch model",
			"launch.defaultHint": "Ideas in this workspace launch on this model, unless you pick another one for a single run.",
			"launch.changeDefault": "Change…",
			"launch.forgetDefault": "Forget this model",
			"launch.rememberDefault": "Remember this model for {workspace}",
			"launch.saveDefault": "Save as the workspace default",
			"followUp.title": "Follow-up needed",
			"followUp.parent": "For: {title}",
			"followUp.childTitle": "Title of the new idea",
			"followUp.childTitlePlaceholder": "Follow-up of #{number} — {title}",
			"followUp.justification": "Justification of the request (included in the new idea body)",
			"followUp.summaryLabel": "Summary of the original card",
			"followUp.submit": "Create follow-up",
			"followUp.cancel": "Cancel",
			"followUp.required": "Follow-up title is required",
			"settings.language": "Interface language",
			"settings.languageDesc": "The panel's own language, independent of the DSH shell setting: by default it follows the shell (a Chinese shell shows a Chinese panel), or pin English, Français or 中文.",
			"settings.languageAuto": "== Auto ==",
			"settings.languageEn": "English",
			"settings.languageFr": "Français",
			"settings.languageZh": "中文",
			"settings.columnMinWidth": "Minimum column width",
			"settings.columnMinWidthDesc": "Smallest a kanban column can be dragged to, in pixels: 120 to 480, default 200. Drag a column's right edge to resize it; double-click that edge to reset its width.",
			"settings.columnMaxWidth": "Maximum column width",
			"settings.columnMaxWidthDesc": "Largest a kanban column can be dragged to, in pixels: 240 to 1382, default 922. A column never grows past this bound.",
			"settings.staleAfterDays": "Mark an idea stale after",
			"settings.staleAfterDaysDesc": "Days without an update before an open idea wears a quiet \"Stale\" badge: 0 to 3650, default 30. 0 turns the badge off entirely. Computed while rendering, nothing is stored on the idea.",
			"backup.intro": "The board is a file on this machine. These actions keep timestamped copies of it, put one back, and carry it to another machine.",
			"backup.groupSnapshots": "Safety copies on this machine",
			"backup.listLabel": "Copies",
			"backup.empty": "No copy yet",
			"backup.retention": "The last {retention} copies are kept. Files you drop in the folder yourself are never removed.",
			"backup.restore": "Restore…",
			"backup.restoreHint": "Replace the current board with this snapshot",
			"backup.restoreConfirm": "Replace the current board with this snapshot?",
			"backup.restoreConfirmDesc": "The board you have now is kept as its own snapshot first, so you can go back to it. A run still in progress refuses the restore.",
			"backup.restoreYes": "Replace the board",
			"backup.restoreNo": "Cancel",
			"backup.restoreDone": "Restored {source} — {count} ideas. The board it replaced was kept as {displaced}.",
			"backup.restoreBusy": "A run is in flight — a restore is refused until it finishes.",
			"backup.restoreUnknownFields": "Heads up: this file carried fields this version does not know, so they were not restored: {fields}. If it came from a newer version of the plugin, update the plugin and restore again.",
			"backup.item.manual": "Snapshot",
			"backup.item.export": "Exported copy",
			"backup.item.preRestore": "Board kept before a restore",
			"backup.item.foreign": "File you added",
			"backup.itemMeta": "{date} · {size}",
			"backup.groupTransfer": "Move this board to another machine",
			"backup.export": "Export the board",
			"backup.exportDesc": "Writes a timestamped copy of the whole board — every idea, its history and its tags — into your backups folder, then offers it to you as a download. The last {retention} copies are kept; older ones are removed. It is also the way out when a second Host refuses to start on this same DSH home, because that one already owns the board.",
			"backup.exportAction": "Export the board",
			"backup.exported": "Your copy is ready — download {name}.",
			"backup.import": "Import a board from a file",
			"backup.importDesc": "Loads a file exported here (or dropped into your backups folder). It REPLACES the current board, and the board it replaces is kept as a snapshot you can go back to. A file that cannot be read is refused with its reason, and nothing is changed.",
			"backup.importAction": "Choose a file…",
			"backup.unavailable": "Snapshots and restore are not available on the running instance — the board itself is unaffected. If you just updated the plugin, restart the web instance: the browser half reloads with the page, the routes are registered at start-up.",
			"backup.loading": "Reading your snapshots…",
			"backup.pending": "Working…",
			"backup.failed": "Failed: {error}",
			"backup.download": "Download",
			"board.columnResize": "Resize this column — min {min}px, max {max}px; double-click to reset",
			"activity.label": "Activity ({count})",
			"activity.hint": "What this idea has been through: who did what, and when. The last {count} moves are kept.",
			"activity.human": "you",
			"activity.run": "run",
			"bulk.select": "Select for a bulk action",
			"bulk.scope.everything": "every idea, no filter",
			"bulk.scope.label": "Scope: {scope}",
			"bulk.scope.allWorkspaces": "all workspaces",
			"bulk.scope.tags": "tags {tags}",
			"bulk.scope.search": "search “{query}”",
			"bulk.bar.selectAll": "Select all",
			"bulk.bar.clearSelection": "Clear selection",
			"bulk.bar.clear": "Clear selection",
			"bulk.bar.count": "{selected} selected of {total} shown",
			"bulk.bar.tag": "Tag…",
			"bulk.bar.workspace": "Move to workspace…",
			"bulk.bar.archive": "Archive…",
			"bulk.bar.tagHint": "Add labels to the selected ideas, keeping the ones they already carry",
			"bulk.bar.workspaceHint": "Move the selected ideas to another workspace",
			"bulk.bar.archiveHint": "Move the selected ideas to the Archived column",
			"bulk.tag.title": "Tag {count} idea(s)",
			"bulk.batch.count": "{count} idea(s) in this batch",
			"bulk.tag.label": "Labels to add (comma separated)",
			"bulk.tag.placeholder": "review, debt, 2026-q4",
			"bulk.tag.hint": "Existing labels are kept; an idea can carry up to 8 of them.",
			"bulk.tag.invalid": "Label name too long (32 characters max): {tags}",
			"bulk.workspace.title": "Move {count} idea(s)",
			"bulk.workspace.label": "Target workspace",
			"bulk.workspace.none": "— no workspace —",
			"bulk.archive.title": "Archive {count} idea(s)",
			"bulk.archive.hint": "Already archived ideas stay as they are and declined ones are left untouched: archiving them would erase the decline.",
			"bulk.roundTrip": "An archived idea bound to a task card is restored, updated and archived again, so its card follows the change.",
			"bulk.submit": "Apply",
			"bulk.cancel": "Cancel",
			"bulk.close": "Close",
			"bulk.running": "Working… {done} of {total}",
			"bulk.report.title": "Bulk action report",
			"bulk.report.summary": "{applied} applied · {skipped} skipped · {failed} failed",
			"bulk.report.applied": "Applied ({count})",
			"bulk.report.skipped": "Skipped ({count})",
			"bulk.report.failed": "Failed ({count})",
			"bulk.reason.declined": "declined — restore it before changing it",
			"bulk.reason.alreadyTagged": "already carries these labels",
			"bulk.reason.tagLimit": "already carries 8 labels",
			"bulk.reason.alreadyThere": "already in that workspace",
			"bulk.reason.alreadyArchived": "already archived",
			"bulk.note.rearchived": "archived again after the failed update",
			"bulk.note.leftOpen": "left in Open — archive it by hand",
			"bulk.undo": "Restore these {count} idea(s)",
			"bulk.undoHint": "A bulk archive is reversible: the button below restores exactly the ideas that were just archived.",
			"bulk.undoDone": "{count} idea(s) restored into the open backlog.",
			"bulk.undoReport": "Undoing the bulk archive",
			"bulk.noUndo": "This action has no undo here: only a bulk archive can be restored in one click."
		};
		/**
		* Simplified Chinese copy (the language DSH serves besides English), so a
		* Chinese shell gets a Chinese panel under `language: auto` and any shell
		* can pin `zh` from the plugin settings. The key set is structurally typed
		* against `fr` (see IdeasKey), so a missing or extra key fails the build.
		*/
		const zh = {
			"entry.label": "想法",
			"entry.tooltip": "想法看板",
			"board.title": "想法",
			"board.close": "返回聊天",
			"board.new": "新建想法",
			"board.search": "筛选想法…",
			"board.revision": "修订号 {revision}",
			"board.status.open": "进行中",
			"board.status.archived": "已归档",
			"board.status.declined": "已否决",
			"board.empty": "这里没有想法",
			"board.emptyFiltered": "没有想法符合当前筛选条件",
			"board.openColumnNotice": "此列包含 {count} 条进行中的想法。滚动可查看其余部分 —— 拖放和多选仍然作用于整列。",
			"board.hostError": "Host 操作失败：{error}",
			"board.retryHost": "重新连接 Host",
			"board.tagFilter": "筛选：",
			"board.tagFilterSearch": "搜索标签…",
			"board.tagFilterNoMatch": "没有匹配的标签",
			"board.tagFilterClear": "清除筛选",
			"board.jump": "按编号跳转到想法",
			"board.jumpPlaceholder": "#42",
			"board.jumpGo": "跳转",
			"board.jumpUnknown": "看板上没有与 {ref} 匹配的想法。它可能已被删除，或该编号属于另一个看板。",
			"board.jumpHidden": "想法 {ref} 已被拒绝，且「已否决」列已隐藏，因此没有可定位的卡片。",
			"settings.nav": "想法看板",
			"settings.title": "想法看板选项",
			"settings.intro": "想法面板的显示偏好，保存在此 DSH 配置文件的设置中，并立即生效（无需重启）。",
			"settings.group": "面板显示",
			"settings.tagRows": "可见的标签筛选行数",
			"settings.tagRowsDesc": "标签区域开始滚动前的总行数：1 到 5，默认 3。第一行与搜索框和“清除筛选”按钮共用一行；其余标签可滚动查看。",
			"settings.loading": "正在加载设置…",
			"settings.unavailable": "此部署未提供设置：将使用默认值。",
			"settings.saveFailed": "保存失败：",
			"settings.conflict": "设置已在别处变更，请重试。",
			"settings.groupBehavior": "面板行为",
			"settings.defaultTab": "打开时显示的标签页",
			"settings.defaultTabDesc": "面板启动时打开的看板区域：概览、优先级、交付记录或健康度。会话中切换标签页仍然自由，设置不可用时以此为默认。",
			"settings.renderMarkdown": "默认以 Markdown 显示描述",
			"settings.renderMarkdownDesc": "打开时即以渲染后的 Markdown 显示卡片正文；顶部的 MD/文本按钮可在会话中自由切换。默认开启。",
			"settings.rememberScope": "记住工作区范围",
			"settings.rememberScopeDesc": "开启后面板会以上次选择的工作区打开，而不是回到“所有工作区”。默认关闭。",
			"settings.confirmLifecycle": "确认交付与否决",
			"settings.confirmLifecycleDesc": "与删除一样，在交付或否决前就地询问（是/否）。默认关闭：这些操作单击即生效。",
			"settings.hideDeclined": "隐藏“已否决”列",
			"settings.hideDeclinedDesc": "不显示看板的“已否决”列（节省空间）。被否决的想法会离开看板视图：它们仍保留在 ledger 与 Markdown 导出中。默认关闭。",
			"settings.cardDensity": "卡片密度",
			"settings.cardDensityDesc": "标准：完整渲染。紧凑：概览卡片以及优先级/交付记录的行都隐藏标签、描述、日期和工作区，间距也更紧凑 — 标题与价值/成本徽章保留。",
			"settings.densityComfortable": "标准",
			"settings.densityCompact": "紧凑",
			"settings.directRunPermission": "直接启动的权限",
			"settings.directRunPermissionDesc": "当您启动一个没有 TaskBoard 卡片的想法时，授予新会话的权限级别。默认为 workspace-write：执行说明要求真正落实代码，只读会话只能给出计划。对有卡片的想法无效，那些跟随 TaskBoard 的设置。",
			"settings.openOrdering": "“进行中”列的顺序",
			"settings.openOrderingDesc": "“进行中”列的默认顺序。这只是默认值：一旦您手动重排该列，它就会显示您的顺序。在此另选一种顺序即可回到按日期的视图。",
			"settings.openOrderingCreatedAt": "创建日期（最早优先）",
			"settings.openOrderingCreatedAtDesc": "创建日期（最新优先）",
			"settings.openOrderingRank": "排名",
			"settings.runningFirst": "将正在执行的想法置顶",
			"settings.runningFirstDesc": "把执行正在进行的想法放到上面所选顺序之前，而不改变该顺序。启用时，显示顺序与已保存的排名不同；手动重排仍然可用，该列随后会显示您的顺序。",
			"card.dragTakesOver": "拖动可把卡片移到其他列，也可在该列内重新排序：手动重排后该列会显示您的顺序，并取代默认排序，直到您在设置中另选一种顺序。",
			"card.confirmLifecycle": "确认此操作？",
			"board.dragHint": "在列之间拖动卡片，也可在“进行中”列内重新排序（标题上方的 ⠿ 手柄）",
			"board.mdToggleLabel": "描述显示方式",
			"board.mdView": "MD",
			"board.textView": "文本",
			"board.workspace": "工作区",
			"board.allWorkspaces": "所有工作区",
			"board.noWorkspace": "— 无工作区 —",
			"board.workspaceHint": "将看板限定到某个工作区",
			"board.settings": "打开想法看板选项",
			"tab.label": "想法看板区域",
			"tab.overview": "概览",
			"tab.priorities": "优先级",
			"tab.delivered": "交付记录",
			"tab.health": "健康度",
			"health.hint": "当前范围的待办概览（{scope}）— 数字由 Host 计算，看板不会重新统计",
			"health.scopeAll": "全部工作区",
			"health.scopeGeneric": "未归属工作区的想法",
			"health.loading": "正在计算健康度视图…",
			"health.unavailable": "此部署不提供健康度视图；看板的其余部分照常工作。",
			"health.error": "读取健康度视图失败：{error}",
			"health.retry": "重试",
			"health.stale": "这些数字计算自修订号 {revision} — 此后看板已发生变化。",
			"health.refreshing": "这些数字计算自修订号 {revision} — 正在刷新…",
			"health.staleError": "这些数字来自修订号 {revision}，且刷新失败：{error}",
			"health.openTitle": "进行中的待办",
			"health.openValue": "{total} 个想法中 {open} 个进行中",
			"health.openHint": "以及按工作区的分布",
			"health.deliveredTitle": "本月已交付",
			"health.deliveredValue": "已交付 {count} 个",
			"health.deliveredWindow": "按 Host 本地时钟的自然月（{month}）",
			"health.medianTitle": "交付耗时中位数",
			"health.medianValue": "{value} {unit}",
			"health.medianHint": "基于全部 {count} 条带时间戳的交付记录",
			"health.medianThin": "交付样本还不足（{count} / {min}）",
			"health.medianThinHint": "至少需要 {min} 条真实交付记录才会给出中位数",
			"health.withoutStamp": "有 {count} 个想法离开待办时没有交付时间戳 — 它们不计入中位数。",
			"health.inconsistent": "有 {count} 个时间戳早于其创建时间 — 不会被平均进去。",
			"health.noDeliveries": "目前还没有带时间戳的交付记录。",
			"health.workspacesTitle": "按工作区统计进行中",
			"health.workspacesEmpty": "该范围内没有想法",
			"health.workspaceRow": "进行中 {open} · 共 {total}",
			"health.moreWorkspaces": "另有 {count} 个工作区",
			"health.tagsTitle": "最常用标签（进行中的待办）",
			"health.tagsEmpty": "进行中的待办没有标签",
			"health.moreTags": "另有 {count} 个标签",
			"health.triageTitle": "待分诊",
			"health.triageValue": "{count} 项分诊信息待补全",
			"health.triageHint": "这是要完成的工作，不是质量评分",
			"health.triageDetailTitle": "分诊明细",
			"health.missingRank": "进行中且没有排序的想法",
			"health.missingValue": "进行中且没有价值分的想法",
			"health.unitMinutes": "分钟",
			"health.unitHours": "小时",
			"health.unitDays": "天",
			"delivered.hint": "已离开待办的想法日志（已归档）— 交付显示绿色时间戳，手动归档显示中性时间戳",
			"delivered.empty": "目前没有已归档的想法",
			"delivered.deliverAt": "交付于 {date}",
			"delivered.archivedAt": "归档于 {date}",
			"delivered.archivedHint": "已归档（放弃）的想法 — 恢复即可重新打开",
			"priorities.hint": "进行中待办的建议排序，在每个工作区分组内相对排序（无工作区的想法排在一起）— 使用箭头或拖放来调整",
			"priorities.empty": "没有需要排序的进行中想法",
			"priorities.moveUp": "上移一位",
			"priorities.moveDown": "下移一位",
			"priorities.rationale": "理由：",
			"new.title": "标题",
			"new.titlePlaceholder": "一句话概括这个想法",
			"new.body": "描述",
			"new.bodyPlaceholder": "背景、价值、成本、验收标准（可选）",
			"new.tags": "标签（可选）",
			"new.tagsPlaceholder": "用逗号分隔",
			"new.rationale": "优先级理由（可选）",
			"new.rationalePlaceholder": "为什么是这个位置？（价值、成本、依赖、项目状态）",
			"new.rank": "建议排名（可选）",
			"new.rankValueEffortHint": "相对该想法所在工作区的进行中待办排序：排名 = 位置（分诊会插入并重排现有排名），价值/成本 = 1 低、2 中、3 高",
			"new.rankInvalid": "排名必须是正整数（1 = 该想法所在工作区进行中待办的第一位）",
			"new.value": "价值",
			"new.effort": "成本",
			"new.levelNone": "— 未设定 —",
			"new.submit": "创建",
			"new.submitAi": "启动 AI 分析并创建想法",
			"new.aiCaptureHint": "新会话将分析该想法、在此工作区的待办中创建它（或合并重复项），并向你报告所采用的排名。",
			"new.cancel": "取消",
			"new.required": "标题为必填项",
			"new.workspace": "工作区",
			"new.workspaceNone": "— 无工作区 —",
			"new.model": "分析所用模型",
			"new.modelProvider": "提供方",
			"new.modelFilterPlaceholder": "搜索模型…",
			"new.modelSessionDefault": "沿用会话（默认）",
			"new.modelHint": "已按当前会话的模型预选；可先选提供方再选模型以强制使用其他模型，或保留“沿用会话”让分析会话使用其默认模型",
			"new.sessionWorkspaceHint": "当前会话的工作区 — 可修改",
			"card.drag": "拖动",
			"card.clickToEdit": "点击以修改",
			"card.value": "价值 {level}",
			"card.effort": "成本 {level}",
			"card.updated": "更新于 {date}",
			"card.edit": "修改",
			"card.archive": "归档",
			"card.decline": "否决",
			"card.deliver": "交付",
			"card.deliverHint": "标记为已交付（归档并加盖今日时间戳）",
			"card.delivered": "已交付 {date}",
			"card.deliveredHint": "已交付的想法 — 点击可修改或恢复",
			"card.restore": "恢复",
			"card.delete": "删除",
			"card.confirmDelete": "确认删除？",
			"card.deleteYes": "是",
			"card.deleteNo": "否",
			"card.workspaceHint": "工作区 {workspace} — 点击可筛选",
			"edit.title": "修改想法 {number}",
			"edit.save": "保存",
			"edit.preview": "MD 预览",
			"edit.previewOff": "纯文本",
			"edit.workspaceUnknown": "（未知）",
			"level.low": "低",
			"level.medium": "中",
			"level.high": "高",
			"board.status.underReview": "验收中",
			"card.underReviewHint": "工作已完成，等待人工验收",
			"card.taskFailed": "任务失败",
			"card.taskFailedHint": "关联的 TaskBoard 任务处于失败状态（最近一次观察到的状态）：该想法仍留在待办中 — 请重试任务或调整想法",
			"card.taskRunning": "进行中",
			"card.taskRunningHint": "该想法的一个执行正在进行。运行结束前该想法仍留在待办中，随后自动进入验收。",
			"card.openSession": "打开会话",
			"card.openSessionHint": "在 DSH 中打开处理该想法的那段对话",
			"card.deliveryNote": "交付说明",
			"card.deliveryNoteHint": "上一次完成的执行最后说了什么。查看整段运行仍请用「打开会话」。",
			"card.deliveryNoteEmpty": "该执行没有留下交付说明：请打开会话查看发生了什么。",
			"card.stale": "陈旧",
			"card.staleHint": "已 {days} 天没有更新。",
			"entry.reviewCountHint": "{count} 个想法待验收",
			"card.reviewOk": "验收通过",
			"card.reviewOkHint": "确认验收：交付该想法（归档并加盖时间戳）",
			"card.followUp": "需要后续跟进…",
			"card.followUpHint": "验收不通过：创建一个后续想法并归档当前想法",
			"card.followUpOf": "跟进 #{number}",
			"card.followUpOfHint": "验收不通过后创建的想法",
			"card.reanalyze": "重新分析（AI）",
			"card.reanalyzeHint": "对该进行中想法重新运行 AI 分析：新会话会重写分析与优先级意见；此前的分析仍保留在卡片上",
			"reanalyze.title": "使用 AI 重新分析",
			"reanalyze.hint": "新的分析会话将重写该进行中想法（工作区 {workspace}）的标题、分析、标签和优先级意见；此前的分析仍保留在卡片上。",
			"reanalyze.submit": "启动分析",
			"reanalyze.cancel": "取消",
			"card.findSimilar": "查找相似",
			"card.findSimilarHint": "让分析会话判断该进行中想法是否与本工作区的现有想法重复：看板先列出候选，分析会话再逐一研判并汇报。除非你确认，否则不会合并任何想法。",
			"similar.title": "查找相似想法",
			"similar.hint": "看板已将此想法与工作区 {workspace} 的 {scanned} 个进行中想法比较，并保留最接近的若干项。分析会话会读取它们的真实内容，并逐项汇报是否为重复——它不会执行任何合并。",
			"similar.loading": "正在查找相似想法…",
			"similar.empty": "本工作区的进行中待办中没有相似想法。",
			"similar.candidates": "看板标记的候选项",
			"similar.score": "分数 {score} · {signals}",
			"similar.signalTitle": "标题",
			"similar.signalTags": "标签",
			"similar.signalLegend": "这是一个粗略信号（标题与标签的重合度），不是结论：分析会话会先阅读每个候选项再判断。",
			"similar.askAnalyst": "交给分析会话",
			"similar.cancel": "取消",
			"similar.loadFailed": "查找相似想法失败：{error}",
			"card.launch": "启动执行",
			"card.launchHint": "在该想法的 TaskBoard 卡片上启动执行：新会话会把该想法作为指令。成功后卡片变为 done，想法自动进入验收",
			"relations.title": "关联",
			"relations.hint": "由您亲自声明的链接，看板不会推断：值得一併阅读的想法，或必须先于本想法落地的想法。",
			"relations.relatesTo": "相关于",
			"relations.blocks": "等待",
			"relations.blockedBy": "被此想法阻塞",
			"relations.none": "无",
			"relations.blockedByNone": "没有想法等待本想法",
			"relations.nothingToAdd": "没有其他可关联的想法",
			"relations.more": "+{count}",
			"relations.addRelated": "添加相关想法…",
			"relations.addBlocked": "添加本想法等待的想法…",
			"relations.removeRelated": "移除与 {target} 的关联",
			"relations.removeBlocked": "不再等待 {target}",
			"relations.relatesToHint": "与 {target} 相关 — 也读一读那条",
			"relations.blocksHint": "不能先于 {target} 落地",
			"relations.blockedByHint": "{target} 不能先于本想法落地 — 该链接声明在 {target} 的卡片上",
			"relations.blockedByExplained": "「被此想法阻塞」声明在另一张卡片上：打开 {target} 即可移除。",
			"launch.title": "启动执行",
			"launch.hint": "新会话将在工作区 {workspace} 中实现该想法。所选模型会在运行前固定到卡片上；不选择则沿用会话默认模型。成功后该想法自动进入验收。",
			"launch.sessionHint": "该想法没有关联任务卡片：启动会在其工作区中新建一个聊天会话，并采用 DSH 的默认权限。即使关闭此标签页，它也会继续运行。",
			"launch.submit": "启动",
			"launch.cancel": "取消",
			"launch.permissionHint": "在人工确认该卡片权限（高于会话默认权限）前，TaskBoard 会拒绝运行该卡片。可在此显示该卡片，或打开 TaskBoard 并按此标题找到它来确认权限。",
			"launch.openTaskBoard": "打开 TaskBoard",
			"launch.showCard": "显示该卡片",
			"launch.copyTitle": "复制标题",
			"launch.titleCopied": "已复制标题",
			"launch.defaultModel": "默认启动模型",
			"launch.defaultHint": "该工作区的想法默认在此模型上启动，除非你为单次运行另选一个模型。",
			"launch.changeDefault": "更改…",
			"launch.forgetDefault": "清除此默认模型",
			"launch.rememberDefault": "为 {workspace} 记住该模型",
			"launch.saveDefault": "保存为该工作区的默认模型",
			"followUp.title": "需要后续跟进",
			"followUp.parent": "针对：{title}",
			"followUp.childTitle": "新想法的标题",
			"followUp.childTitlePlaceholder": "#{number} 的跟进 — {title}",
			"followUp.justification": "请求理由（会写入新想法的正文）",
			"followUp.summaryLabel": "原卡片的摘要",
			"followUp.submit": "创建跟进",
			"followUp.cancel": "取消",
			"followUp.required": "跟进标题为必填项",
			"settings.language": "界面语言",
			"settings.languageDesc": "面板自身的语言，独立于 DSH 外壳语言：默认“跟随外壳”（中文外壳即显示中文），也可固定为 English、Français 或中文。",
			"settings.languageAuto": "== Auto ==",
			"settings.languageEn": "English",
			"settings.languageFr": "Français",
			"settings.languageZh": "中文",
			"about.panelLabel": "关于此插件",
			"about.repository": "仓库",
			"about.version": "版本",
			"about.license": "许可证",
			"about.compatibleVersions": "DSH 兼容性",
			"about.checkUpdate": "检查更新",
			"about.tabDisplay": "显示",
			"about.tabAbout": "关于",
			"about.tabBackup": "备份",
			"about.tabs": "设置选项卡",
			"settings.columnMinWidth": "列最小宽度",
			"settings.columnMinWidthDesc": "看板列可拖动到的最小宽度（像素）：120 到 480，默认 200。拖动列的右边缘以调整其宽度；双击该边缘可将其重置。",
			"settings.columnMaxWidth": "列最大宽度",
			"settings.columnMaxWidthDesc": "看板列可拖动到的最大宽度（像素）：240 到 1382，默认 922。列不会超过此上限。",
			"settings.staleAfterDays": "标记想法为陈旧的天数",
			"settings.staleAfterDaysDesc": "开放中的想法在多少天没有更新后显示安静的「陈旧」徽标：0 到 3650，默认 30。填 0 可完全关闭该徽标。仅在渲染时计算，不会在想法上写入任何内容。",
			"backup.intro": "看板就是这台机器上的一个文件。这些操作为它保留带时间戳的副本、把副本放回去，以及把它带到另一台机器上。",
			"backup.groupSnapshots": "本机的安全副本",
			"backup.listLabel": "副本",
			"backup.empty": "还没有副本",
			"backup.retention": "保留最近 {retention} 份副本。你自己放进该文件夹的文件永远不会被删除。",
			"backup.restore": "恢复…",
			"backup.restoreHint": "用此快照替换当前看板",
			"backup.restoreConfirm": "用此快照替换当前看板？",
			"backup.restoreConfirmDesc": "你现在的看板会先被保存为它自己的快照，因此可以随时退回去。有执行正在进行时，恢复会被拒绝。",
			"backup.restoreYes": "替换看板",
			"backup.restoreNo": "取消",
			"backup.restoreDone": "已恢复 {source}——共 {count} 个想法。被替换的看板已保存为 {displaced}。",
			"backup.restoreBusy": "有执行正在进行——恢复会被拒绝，直到它结束。",
			"backup.restoreUnknownFields": "注意：该文件包含此版本不认识的字段，因此未被恢复：{fields}。如果它来自更新版本的插件，请先更新插件再恢复。",
			"backup.item.manual": "快照",
			"backup.item.export": "导出的副本",
			"backup.item.preRestore": "恢复前保留的看板",
			"backup.item.foreign": "你添加的文件",
			"backup.itemMeta": "{date} · {size}",
			"backup.groupTransfer": "把这个看板带到另一台机器",
			"backup.export": "导出看板",
			"backup.exportDesc": "把整个看板的带时间戳副本——每个想法、它的历史和标签——写入你的备份文件夹，然后提供下载。最近 {retention} 份副本会保留，更早的会被删除。当第二个 Host 因为已经拥有这个看板而拒绝在同一个 DSH 主目录上启动时，这也是出口。",
			"backup.exportAction": "导出看板",
			"backup.exported": "副本已就绪——请下载 {name}。",
			"backup.import": "从文件导入看板",
			"backup.importDesc": "读取一份在这里导出的文件（或放进备份文件夹的文件）。它会替换当前看板，而被替换的看板会保留为快照，可以随时退回。无法读取的文件会被拒绝并说明原因，不会改动任何内容。",
			"backup.importAction": "选择文件…",
			"backup.unavailable": "当前运行的实例上无法使用快照和恢复——看板本身不受影响。如果您刚刚更新了插件，请重启 web 实例：浏览器部分随页面重新加载，路由在启动时注册。",
			"backup.loading": "正在读取快照…",
			"backup.pending": "处理中…",
			"backup.failed": "失败：{error}",
			"backup.download": "下载",
			"board.columnResize": "调整此列宽度 — 最小 {min} 像素，最大 {max} 像素；双击重置",
			"activity.label": "动态（{count}）",
			"activity.hint": "这个想法经历过什么：谁做了什么，以及何时。仅保留最近 {count} 条记录。",
			"activity.human": "你",
			"activity.run": "执行",
			"bulk.select": "选择以进行批量操作",
			"bulk.scope.everything": "全部想法，未筛选",
			"bulk.scope.label": "范围：{scope}",
			"bulk.scope.allWorkspaces": "所有工作区",
			"bulk.scope.tags": "标签 {tags}",
			"bulk.scope.search": "搜索「{query}」",
			"bulk.bar.selectAll": "全选",
			"bulk.bar.clearSelection": "取消全选",
			"bulk.bar.clear": "清除选择",
			"bulk.bar.count": "已选 {selected} 项，共显示 {total} 项",
			"bulk.bar.tag": "加标签…",
			"bulk.bar.workspace": "移动到工作区…",
			"bulk.bar.archive": "归档…",
			"bulk.bar.tagHint": "为选中的想法添加标签，保留它们已有的标签",
			"bulk.bar.workspaceHint": "把选中的想法移动到另一个工作区",
			"bulk.bar.archiveHint": "把选中的想法移动到「已归档」列",
			"bulk.tag.title": "为 {count} 个想法加标签",
			"bulk.batch.count": "本批次包含 {count} 个想法",
			"bulk.tag.label": "要添加的标签（用逗号分隔）",
			"bulk.tag.placeholder": "评审、债务、2026-q4",
			"bulk.tag.hint": "已有标签会保留；每个想法最多 8 个标签。",
			"bulk.tag.invalid": "标签名过长（最多 32 个字符）：{tags}",
			"bulk.workspace.title": "移动 {count} 个想法",
			"bulk.workspace.label": "目标工作区",
			"bulk.workspace.none": "— 无工作区 —",
			"bulk.archive.title": "归档 {count} 个想法",
			"bulk.archive.hint": "已归档的想法保持不变，已否决的想法原样保留：归档它们会抹掉否决记录。",
			"bulk.roundTrip": "已归档且关联任务卡片的想法会先恢复、修改后再归档，以便其卡片同步变更。",
			"bulk.submit": "应用",
			"bulk.cancel": "取消",
			"bulk.close": "关闭",
			"bulk.running": "处理中… 第 {done} 项，共 {total} 项",
			"bulk.report.title": "批量操作报告",
			"bulk.report.summary": "已应用 {applied} · 已跳过 {skipped} · 失败 {failed}",
			"bulk.report.applied": "已应用（{count}）",
			"bulk.report.skipped": "已跳过（{count}）",
			"bulk.report.failed": "失败（{count}）",
			"bulk.reason.declined": "已否决 — 请先恢复再修改",
			"bulk.reason.alreadyTagged": "已带有这些标签",
			"bulk.reason.tagLimit": "已带有 8 个标签",
			"bulk.reason.alreadyThere": "已在该工作区",
			"bulk.reason.alreadyArchived": "已归档",
			"bulk.note.rearchived": "修改失败后已重新归档",
			"bulk.note.leftOpen": "仍留在「进行中」— 请手动归档",
			"bulk.undo": "恢复这 {count} 个想法",
			"bulk.undoHint": "批量归档是可撤销的：下面的按钮会恢复刚刚归档的那批想法。",
			"bulk.undoDone": "已将 {count} 个想法恢复到进行中待办。",
			"bulk.undoReport": "撤销批量归档",
			"bulk.noUndo": "此操作在此没有撤销：只有批量归档可以一键恢复。"
		};
		const DICTIONARIES = {
			fr,
			en,
			zh
		};
		/** Plugin-owned language override (the `language` setting, 'auto' = none). */
		let languageOverride = "auto";
		/**
		* Apply (or clear, with 'auto') the plugin-owned interface language. The
		* resolution order is override -> DSH shell document language -> English, so
		* `auto` is byte-identical to the pre-0.4.0 behavior.
		*/
		function setLanguageOverride(language) {
			languageOverride = language;
		}
		/** The dictionary the panel currently renders with (after the override). */
		function interfaceDictionary() {
			if (languageOverride !== "auto") return DICTIONARIES[languageOverride] ?? en;
			if (typeof document === "undefined") return en;
			const base = (document.documentElement.lang ?? "").split("-")[0].toLowerCase();
			return DICTIONARIES[base] ?? en;
		}
		/** BCP-47 tag of the interface language, for the board root's lang attribute. */
		function interfaceLanguage() {
			if (languageOverride !== "auto") return languageOverride;
			if (typeof document === "undefined") return "en";
			return document.documentElement.lang || "en";
		}
		/**
		* Every label the DSH settings modal can carry for OUR nav row. The host
		* resolves our `label()` thunk when it builds the dialog, so a panel whose
		* interface language was pinned after boot can see the row rendered in the
		* boot language: the board gear must match any of them, not just the current
		* one (0.4.0 fix - it only worked while the interface was English).
		*/
		const SETTINGS_NAV_LABELS = [.../* @__PURE__ */ new Set([
			en["settings.nav"],
			fr["settings.nav"],
			zh["settings.nav"]
		])];
		/** Interpolate {placeholders} with the given params. */
		function translate(key, params) {
			let text = interfaceDictionary()[key];
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
			return text;
		}
		/** Short alias used across the board/entry code. */
		const t = translate;
		//#endregion
		//#region src/client/panel-navigation.ts
		/**
		* Shell panel navigation — the one cross-plugin call the layout exposes.
		*
		* `ctx.get("layout").selectPanel(panelId)` is the sanctioned way for a plugin
		* to bring a global center panel to the front: the shell's own sidebar rows use
		* it, and so do the TaskBoard, Skill Explorer and SSH shortcuts. It THROWS when
		* the main key is not registered, so every call here is wrapped — a deployment
		* that serves no such panel must degrade to "the button did nothing", never to
		* a dead click or a plugin-wide exception.
		*
		* Two things this file exists to get right, both learned the hard way:
		*
		* 1. The layout is a cordis SERVICE, reached through `ctx.get("layout")`, not
		*    through a `ctx.layout` property: cordis refuses an undeclared property
		*    read, and a service we never declared in `inject` is not a property at
		*    all. Reading the property therefore throws, and a resolver that trusted it
		*    produced a navigator that silently did nothing.
		* 2. The face is resolved DEFENSIVELY rather than declared in `inject`:
		*    declaring a service the deployment may not have would keep the WHOLE
		*    plugin from booting (board, settings section and exports) over a panel
		*    that is only ever a convenience.
		*/
		/** The panel id shared by the Ideas sidebar row and its main-slot occupant. */
		const IDEAS_PANEL_ID = "ideas";
		/** The panel id the TaskBoard plugin registers (0.4.x, `TASK_BOARD_PANEL_ID`). */
		const TASK_BOARD_PANEL_ID = "task-board";
		/**
		* Build a navigator over the layout service, or undefined when this
		* deployment has none.
		* @param ctx - the client root context.
		* @returns the navigator, or undefined when no layout service is reachable.
		*/
		function resolvePanelNavigator(ctx) {
			const layout = readLayoutFace(ctx);
			if (layout === void 0) return void 0;
			return { select(panelId) {
				try {
					layout.selectPanel?.(panelId);
				} catch (error) {
					console.warn("[dsh-plugin-ideas-manager] panel selection refused:", error);
				}
			} };
		}
		/** The layout face behind a context, or undefined. Never throws. */
		function readLayoutFace(ctx) {
			if (ctx === null || typeof ctx !== "object" && typeof ctx !== "function") return void 0;
			const host = ctx;
			let candidate;
			try {
				candidate = typeof host.get === "function" ? host.get.call(ctx, "layout") : host.layout;
			} catch {
				return;
			}
			if (typeof candidate !== "object" || candidate === null) return void 0;
			return candidate;
		}
		//#endregion
		//#region src/client/deeplink.ts
		/** The mirrored-card prefix the mirror mints deterministically. */
		const MIRRORED_CARD_PREFIX = /^idea-/i;
		/**
		* Parse a reference into a number or an id.
		*
		* Accepted, in the order they are tried: `#42`, `42`, `idea-<uuid>`, `<uuid>`.
		* A leading `#` is decoration; the rest decides the kind. Digits are ALWAYS a
		* number and never an id — an id is a uuid, and reading a digit string as one
		* would silently miss every idea on the board.
		*
		* @param raw - whatever the caller typed or passed (`'  #7 '`, `'idea-abc'`).
		* @returns the parsed reference, or undefined when there is nothing to look up.
		*/
		function parseIdeaRef(raw) {
			let token = raw.trim();
			if (token.startsWith("#")) token = token.slice(1).trim();
			if (token === "") return void 0;
			const mirrored = MIRRORED_CARD_PREFIX.exec(token);
			if (mirrored !== null) {
				const id = token.slice(mirrored[0].length).trim();
				return id === "" ? void 0 : {
					kind: "id",
					id
				};
			}
			if (/^\d+$/.test(token)) {
				const number = Number(token);
				return Number.isSafeInteger(number) && number > 0 ? {
					kind: "number",
					number
				} : void 0;
			}
			return {
				kind: "id",
				id: token
			};
		}
		/**
		* Find the idea a reference names.
		*
		* The caller passes the WHOLE board on purpose: the number is the stable human
		* reference, so it has to resolve whatever the current workspace scope happens
		* to be. Scoping is the board's job at render time, never the resolver's.
		*
		* @param ref - a parsed reference.
		* @param ideas - every idea the client currently holds, all workspaces.
		* @returns the matching idea, or undefined.
		*/
		function resolveIdeaRef(ref, ideas) {
			return ref.kind === "number" ? ideas.find((idea) => idea.ideaNumber === ref.number) : ideas.find((idea) => idea.id === ref.id);
		}
		/**
		* The bounded read that answers the same question against the Host.
		*
		* This is the EXISTING `?view=summary` projection with its `numbers` / `ids`
		* selector and a one-row limit — no route, no query parameter and no response
		* shape was added for the deep-link. It is the cold path: the 2.5 s poll only
		* runs while the board is open, so a board that has been closed since a capture
		* has no row to resolve and must ask once.
		*
		* @param ref - a parsed reference.
		* @returns a one-row bounded read query for it.
		*/
		function focusReadQuery(ref) {
			return {
				view: "summary",
				limit: 1,
				...ref.kind === "number" ? { numbers: [ref.number] } : { ids: [ref.id] }
			};
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
		function uuid$1() {
			return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		}
		/**
		* The Host answered 404 WITHOUT a JSON body — i.e. no route of ours is
		* registered on the running instance.
		*
		* This is not a rare shape: the browser half is re-resolved per request while
		* the host half registers its routes at boot, so a plugin updated under a LIVE
		* instance serves the new panel against the old route table. The caller turns
		* this into a capability downgrade (see `IdeasClient.backupUnavailable`)
		* instead of showing a dead button, and the reader never sees a parser error.
		*/
		var IdeasRouteMissingError = class extends Error {
			/** The status that proved it (always 404). */
			status = 404;
			constructor() {
				super("the running Host does not serve this route");
				this.name = "IdeasRouteMissingError";
			}
		};
		/**
		* The error an answer that is not JSON at all deserves. A typed
		* {@link IdeasRouteMissingError} for a 404 (so the caller can downgrade
		* instead of reporting a failure), a plain status sentence otherwise.
		*/
		function unreadableAnswer(status) {
			return status === 404 ? new IdeasRouteMissingError() : /* @__PURE__ */ new Error(`the Host answered ${status} without a readable body`);
		}
		/**
		* Decode one JSON answer, and never let the parser speak.
		*
		* `response.json()` throws a raw `SyntaxError` on a non-JSON body, which is how
		* a user ended up reading `Unexpected token 'o', "not found" is not valid JSON`
		* from the settings panel. The body is read as text and parsed defensively: a
		* JSON refusal keeps its own sentence, a missing route becomes a typed
		* {@link IdeasRouteMissingError}, and anything else is reported by status.
		*/
		async function readJson(response) {
			const text = await response.text();
			let body;
			try {
				body = text.trim() === "" ? void 0 : JSON.parse(text);
			} catch {
				body = void 0;
			}
			if (!response.ok) {
				if (body === void 0) throw unreadableAnswer(response.status);
				if (body.error === void 0) throw new Error(`ideas request failed: ${response.status}`);
				throw new Error(typeof body.message === "string" && body.message !== "" ? body.message : body.error);
			}
			if (body === void 0) throw unreadableAnswer(response.status);
			return body;
		}
		var HttpIdeasHostTransport = class {
			async state() {
				return await this.request(`${IDEAS_API_PREFIX}/state?view=list`, { cache: "no-store" });
			}
			async stateFull() {
				return await this.request(`${IDEAS_API_PREFIX}/state`, { cache: "no-store" });
			}
			async read(query = {}) {
				const view = query.view ?? "summary";
				const params = ideasReadSearchParams({
					...query,
					view
				});
				return await this.request(`${IDEAS_API_PREFIX}/state?${params.toString()}`, { cache: "no-store" });
			}
			async idea(id) {
				return await this.request(`${IDEAS_API_PREFIX}/idea?id=${encodeURIComponent(id)}`, { cache: "no-store" });
			}
			/**
			* The action wire is untouched (full snapshot, frozen contract); the
			* projection to list rows happens HERE so every client consumer - board,
			* priorities, delivered - works from the same deferred-body shape as the
			* lean `state()` poll.
			*/
			async action(action, initiator) {
				return toListSnapshot(await this.post(uuid$1(), action, initiator));
			}
			async config() {
				return await this.request(`${IDEAS_API_PREFIX}/config`, { cache: "no-store" });
			}
			async backups() {
				return await this.request(`${IDEAS_API_PREFIX}/backup`, { cache: "no-store" });
			}
			async takeSnapshot(reason = "manual") {
				return await this.request(`${IDEAS_API_PREFIX}/backup`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ reason })
				});
			}
			async restoreSnapshot(request) {
				return await this.request(`${IDEAS_API_PREFIX}/backup/restore`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(request)
				});
			}
			snapshotContentUrl(name) {
				return `${IDEAS_API_PREFIX}/backup/content?name=${encodeURIComponent(name)}`;
			}
			/**
			* The health aggregate (idea #110): its own small GET, never folded into the
			* board poll. The scope mirrors the board's workspace selector — omitted for
			* every workspace, a blank value for the workspace-less group.
			*/
			async stats(query = {}) {
				return await this.request(`${IDEAS_API_PREFIX}/state?${ideasStatsSearchParams(query).toString()}`, { cache: "no-store" });
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
			/**
			* The launch route (idea #66) is a dedicated POST, not an action verb: the
			* answer is a small `{ok, runId, runStatus}`, never a board snapshot, and it
			* must not consume the persisted action dedupe cache. `readJson` already
			* turns the host's `error` field into the rejection message.
			*/
			async launch(ideaId, model) {
				return await this.request(`${IDEAS_API_PREFIX}/launch`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						requestId: uuid$1(),
						initiator: "plugin:ideas-manager:launch",
						ideaId,
						...model === void 0 || model === "" ? {} : { model }
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
		//#region src/client/ideas-client.ts
		function uuid() {
			return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		}
		var IdeasClient = class {
			transport;
			boardOpen = false;
			/** Board state as LIST rows (bodies deferred, idea #34). */
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
			/**
			* Optional jump into a run the board started (idea #66). A run can execute
			* in a session the human never saw open — the direct-session backend always
			* does — so a card carrying a `runSessionId` offers this link. Undefined
			* (no sessions service) simply renders no link.
			*/
			sessionOpener;
			/**
			* Shell panel navigation, resolved from `ctx.layout` by the panel
			* registration. Undefined on a shell with no layout service: the board then
			* keeps the local open/close behavior and simply has no entry row to drive
			* it. This is also the face a launch refusal redirects through.
			*/
			panelNavigator;
			/**
			* Snapshot folder (idea #95), undefined until the backup panel asks for it.
			* A transport without the capability leaves it undefined forever, which the
			* panel reads as "this deployment has no backup surface" — a downgrade, never
			* an error: the board itself does not depend on it.
			*/
			backups;
			/** Last backup failure, verbatim (the Host's own refusal sentence). */
			backupError;
			/** Whether a snapshot/restore request is in flight (the panel disables itself). */
			backupPending = false;
			/**
			* The running Host serves no backup route (idea #95 follow-up): an instance
			* that has not been restarted since the plugin was updated answers 404 on
			* `/api/ideas/backup` while serving the NEW panel. Set by `loadBackups`, it
			* turns the capability check into a runtime fact and the panel into one
			* explanatory note instead of three dead buttons.
			*/
			backupUnavailable = false;
			/** The snapshot a fresh export produced, so the panel can offer its download. */
			exported;
			/**
			* The outcome of the last successful restore, so the panel can name the
			* snapshot the displaced board was kept as: a restore must be loud about what
			* it replaced, and that fact is only true for a moment after the click.
			*
			* `unknownFields` is the other half of that promise: record keys the file
			* carried that this build does not know, and therefore did not restore. It is
			* empty in the normal case and shown as a warning when it is not.
			*/
			lastRestore;
			/**
			* Deep-link request awaiting the panel (idea #105). It lives HERE rather than
			* in React state on purpose: a request can arrive while the board is CLOSED
			* (the permission-gate refusal is raised from the board itself, but the
			* published service is reachable from anywhere in the page), and the panel has
			* to find it waiting when it mounts — the cold-load case.
			*/
			focusRequest;
			/** What the last request achieved; the board renders the unhappy answers. */
			focusResult;
			/** The card a deep-link landed on, or undefined once the human took over. */
			focusedIdeaId;
			/**
			* Backlog-health aggregate (idea #110), undefined until the Health tab asks
			* for it. It lives here rather than in React state for the same reason the
			* deep-link request does: the tab is opened by the panel, and the fetch it
			* owns must survive the panel being closed and reopened without re-deciding
			* anything.
			*/
			stats;
			/**
			* The scope {@link stats} was computed for, so the panel can refuse to paint
			* numbers that answer a question the reader is no longer asking. `undefined`
			* = every workspace; `''` = the workspace-less group.
			*/
			statsScope;
			/** Whether a stats request is in flight (the view shows it is refreshing). */
			statsPending = false;
			/** Last stats failure, verbatim; cleared on success. */
			statsError;
			/** Sequence of the newest stats request; older answers are dropped on arrival. */
			statsRequestSeq = 0;
			focusSeq = 0;
			listeners = /* @__PURE__ */ new Set();
			unsubscribeEvents;
			workspaces = [];
			workspacesSource;
			activeWorkspaceSource;
			unsubscribeWorkspaces;
			unsubscribeActive;
			/** Full records fetched on demand (body + audit), keyed by idea id (idea #34). */
			fullRecords = /* @__PURE__ */ new Map();
			/** Highest revision whose full snapshot already filled {@link fullRecords}. */
			searchIndexedAtRevision = -1;
			/** In-flight deep-search index load (at most one at a time). */
			searchIndexLoad;
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
			/**
			* Ask the shell to show the board panel. The row click is owned by the shell
			* (it selects the panel itself), so this is only the programmatic path;
			* without a navigator the flag flips locally, which keeps the board usable
			* on a shell that has no layout service.
			*/
			toggleBoard() {
				const navigator = this.panelNavigator;
				if (navigator === void 0) {
					this.setBoardOpen(!this.boardOpen);
					return;
				}
				navigator.select(this.boardOpen ? null : IDEAS_PANEL_ID);
			}
			/** Return to the conversation ("Back to chat" on the board header). */
			closeBoard() {
				const navigator = this.panelNavigator;
				if (navigator === void 0) {
					this.setBoardOpen(false);
					return;
				}
				navigator.select(null);
			}
			/**
			* Bring the board panel to the front WITHOUT toggling it.
			*
			* `toggleBoard` is the wrong verb for a deep-link: the destination is the
			* board, so selecting it again must never close it. Without a layout service
			* the local flag is all there is, and a deep-link to a closed board is exactly
			* when the refresh matters most.
			*/
			openBoard() {
				const navigator = this.panelNavigator;
				if (navigator === void 0) {
					this.setBoardOpen(true);
					return;
				}
				navigator.select(IDEAS_PANEL_ID);
			}
			/**
			* Open the TaskBoard panel through the shell's own layout face.
			*
			* Deliberately just that. This used to be `client/taskboard-focus.ts`, which
			* additionally typed the idea title into the TaskBoard's filter field through
			* the native value setter and a bubbling `input` event — DOM surgery on a
			* third-party React tree, because that board published no service and no
			* deeplink to use instead (verified on the installed 0.4.4; see
			* docs/architecture.md). The mirrored card is filed under the idea title, which
			* the caller shows next to the button, so the human can find it by eye.
			*/
			openTaskBoard() {
				this.panelNavigator?.select(TASK_BOARD_PANEL_ID);
			}
			/**
			* Ask the board to focus one idea, by `#N`, by number or by id.
			*
			* The request is stored, the board is brought to the front, and the PANEL
			* applies it (it owns the scope, the tab and the filters). A request that
			* arrives before the panel is mounted simply waits — that is what makes a
			* link work from a cold panel load.
			*
			* Fire and forget by design: the outcome is observable on {@link focusResult},
			* and a caller has no useful way to act on a promise here that the board's own
			* message does not already say better.
			*
			* @param ref - `'#42'`, `'42'`, `'idea-<uuid>'` or an idea id.
			*/
			requestFocus(ref) {
				this.focusSeq += 1;
				this.focusRequest = {
					ref: ref.trim(),
					seq: this.focusSeq
				};
				this.focusResult = void 0;
				this.focusedIdeaId = void 0;
				this.emit();
				this.openBoard();
			}
			/**
			* The panel reports what it did with a request.
			*
			* Answering CLEARS the request: it is one-shot, so a re-render can never
			* re-apply it (a second apply would fight the scope the first one set). A
			* report for a stale sequence is dropped — two links in a row must not let the
			* older answer overwrite the newer one.
			*
			* @param seq - the request's sequence number.
			* @param outcome - what the panel could do with it.
			* @param ideaId - the focused card; omitted when nothing could be focused.
			*/
			reportFocus(seq, outcome, ideaId) {
				const request = this.focusRequest;
				if (request === void 0 || request.seq !== seq) return;
				this.focusRequest = void 0;
				this.focusResult = {
					ref: request.ref,
					seq,
					outcome
				};
				this.focusedIdeaId = ideaId;
				this.emit();
			}
			/**
			* Drop the focus affordance: the human narrowed the scope, searched, toggled a
			* tag or changed tab, so the link's destination is no longer what they are
			* reading. Same discipline as the multi-select (idea #94) — a view marker the
			* reader owns, never something the 2.5 s poll restores.
			*/
			clearFocus() {
				if (this.focusedIdeaId === void 0) return;
				this.focusedIdeaId = void 0;
				this.emit();
			}
			/**
			* Resolve a reference to the idea it names, across every workspace.
			*
			* The snapshot is asked first because it is free and holds the whole board.
			* On a MISS the board asks the Host once through the existing bounded read and
			* adopts a fresh list before answering: the poll only runs while the panel is
			* open, so a board closed since a capture genuinely does not know the idea,
			* and a card has to exist in the snapshot before anything can focus it.
			*
			* Never throws: a failed read is logged and answered as "not found", because a
			* deep-link that cannot resolve must degrade to a message, not to a broken
			* panel.
			*
			* @param ref - the caller's reference, unparsed.
			* @returns the idea, or undefined when this board holds no such reference.
			*/
			async resolveFocus(ref) {
				const parsed = parseIdeaRef(ref);
				if (parsed === void 0) return void 0;
				const local = resolveIdeaRef(parsed, this.snapshot?.ideas ?? []);
				if (local !== void 0) return local;
				if (this.transport.read === void 0) return void 0;
				try {
					const page = await this.transport.read(focusReadQuery(parsed));
					if (page.ideas.length === 0) return void 0;
					await this.refresh();
					return resolveIdeaRef(parsed, this.snapshot?.ideas ?? []) ?? page.ideas[0];
				} catch (error) {
					console.warn("[dsh-plugin-ideas-manager] deep-link lookup failed:", error);
					return;
				}
			}
			/**
			* The shell mounted our panel: the board is now visible, so the background
			* poll may run and the state is refreshed immediately (the poll alone would
			* leave an empty board for up to one tick).
			*/
			panelShown() {
				this.setBoardOpen(true);
			}
			/** The shell unmounted our panel: a closed board holds no traffic. */
			panelHidden() {
				this.setBoardOpen(false);
			}
			/** Single writer of the open flag, so every path refreshes identically. */
			setBoardOpen(open) {
				if (this.boardOpen === open) return;
				this.boardOpen = open;
				if (open) this.refresh();
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
				const errorBefore = this.error;
				let adopted = false;
				try {
					adopted = this.adopt(await this.transport.state());
					this.error = void 0;
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
				}
				if (adopted || this.error !== errorBefore) this.emit();
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
					this.applyInterfaceLanguage();
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
				this.applyInterfaceLanguage();
				this.configLoaded = true;
				this.emit();
			}
			/**
			* Push the `language` setting to the i18n lookup (0.4.0): the panel language
			* is plugin-owned and independent of the DSH shell language. Called on every
			* config load and save, so switching the row re-renders the whole panel in
			* the chosen language (and a failed load falls back to `auto` = the shell).
			*/
			applyInterfaceLanguage() {
				setLanguageOverride(this.config.value.language);
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
					this.applyInterfaceLanguage();
					this.emit();
				}
			}
			/**
			* Run one bounded filtered read without changing board state. This is the
			* common agent/client path: summary-first metadata, explicit fields, and a
			* capped body slice all arrive with revision and truncation metadata. The
			* raw full snapshot and single-idea detail methods remain available for
			* backward compatibility and deep workflows.
			*/
			async readIdeas(query = {}) {
				if (this.transport.read === void 0) throw new Error("read-view-unavailable");
				return await this.transport.read(query);
			}
			async createIdea(input) {
				const tags = tagNames(input.tags).map((name) => ({ name }));
				await this.run({
					kind: "create",
					id: uuid(),
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
				const tags = patch.tags === void 0 ? void 0 : normalizeClientTags(patch.tags);
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
						...tags === void 0 ? {} : { tags: tags.length === 0 ? null : tags },
						...patch.relatesTo === void 0 ? {} : { relatesTo: patch.relatesTo.length === 0 ? null : patch.relatesTo },
						...patch.blocks === void 0 ? {} : { blocks: patch.blocks.length === 0 ? null : patch.blocks }
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
			* Review rejected: create a child follow-up idea (linked to `ideaId` and
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
			/**
			* Read the near-duplicate report for one idea (Find similar). Opt-in by
			* construction: it rides the bounded read query's `similar` key, so the
			* board's 2.5 s poll never runs the scan and the default snapshot never
			* grows a byte because of it. `limit` bounds both the returned rows and the
			* candidate set, so a caller cannot accidentally ask for the whole board.
			*
			* Not a write: it returns a FLAG (which open same-workspace ideas look
			* similar, and on which cheap signals), never an action.
			*
			* @throws when the transport predates the bounded read (`read-view-unavailable`)
			*   or answers without the report the query asked for.
			*/
			async findSimilarIdea(ideaId, limit = 8) {
				const report = (await this.readIdeas({
					view: "summary",
					similar: ideaId,
					limit
				})).similar;
				if (report === void 0) throw new Error("similar-report-unavailable");
				return report;
			}
			async deleteIdea(ideaId) {
				await this.run({
					kind: "delete",
					ideaId
				});
			}
			/**
			* Start the idea's execution (idea #66) through the Host, which owns the
			* mirrored card. NOT a ledger mutation: no `pending` banner for the whole
			* board, no revision write here (the host stamps `runStatus` itself) — but a
			* refresh follows so the card status the poll will publish is not the only
			* visible change. A refusal is surfaced on the board's error bar verbatim
			* (`task is already running or missing`, `taskboard-unavailable`, ...) and
			* rethrown for the modal to keep the human in place.
			*
			* `model` is the `provider/model` target id, or undefined to let the run
			* keep the session default.
			*
			* @throws when the transport predates the launch route (`launch-unavailable`).
			*/
			async launchIdea(ideaId, model) {
				if (this.transport.launch === void 0) throw new Error("launch-unavailable");
				try {
					await this.transport.launch(ideaId, model);
					this.error = void 0;
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
					this.emit();
					throw error;
				}
				await this.refresh();
			}
			async reorderIdea(orderedIds) {
				await this.run({
					kind: "reorder",
					orderedIds
				});
			}
			/**
			* Load the snapshot folder. Reads only: opening the backup panel never
			* writes, so browsing the list cannot be the thing that fills the folder.
			*
			* A 404 without a body is NOT a failure to show — it means the running Host
			* has no backup route (an instance that has not been restarted since the
			* plugin was updated). That is a capability downgrade, so it clears the
			* error, records {@link backupUnavailable} and lets the panel render its one
			* explanatory note instead of three buttons that cannot work.
			*/
			async loadBackups() {
				if (this.transport.backups === void 0) {
					this.backups = void 0;
					this.backupUnavailable = true;
					this.emit();
					return;
				}
				try {
					this.backups = await this.transport.backups();
					this.backupError = void 0;
					this.backupUnavailable = false;
				} catch (error) {
					if (error instanceof IdeasRouteMissingError) {
						this.backups = void 0;
						this.backupError = void 0;
						this.backupUnavailable = true;
					} else this.backupError = error instanceof Error ? error.message : String(error);
				}
				this.emit();
			}
			/**
			* Take a snapshot now. `reason: 'export'` is the portable copy: the same
			* write, stamped as the one meant to travel, and remembered in `exported` so
			* the panel can hand the human the download instead of guessing a file name.
			*
			* @returns whether the snapshot was written.
			*/
			async takeSnapshot(reason = "manual") {
				if (this.transport.takeSnapshot === void 0) return false;
				this.backupPending = true;
				this.backupError = void 0;
				this.emit();
				try {
					const taken = await this.transport.takeSnapshot(reason);
					if (reason === "export") this.exported = taken.snapshot;
					await this.loadBackups();
					return true;
				} catch (error) {
					this.backupError = error instanceof Error ? error.message : String(error);
					return false;
				} finally {
					this.backupPending = false;
					this.emit();
				}
			}
			/**
			* Restore the board from a snapshot or from an imported document.
			*
			* A refusal is reported through `backupError` (the Host's own sentence) and
			* answers false — never thrown — because the panel's job is to explain it, not
			* to break. A success re-reads the board: the whole document was replaced, so
			* the open panel must not keep painting the ideas that just went away.
			*/
			async restoreSnapshot(request) {
				if (this.transport.restoreSnapshot === void 0) {
					this.backupError = "backup-unavailable";
					this.emit();
					return false;
				}
				this.backupPending = true;
				this.backupError = void 0;
				this.emit();
				try {
					const outcome = await this.transport.restoreSnapshot(request);
					if (!outcome.ok) {
						this.backupError = outcome.message;
						return false;
					}
					await this.loadBackups();
					await this.refresh();
					this.lastRestore = {
						...outcome,
						unknownFields: outcome.unknownFields ?? []
					};
					return true;
				} catch (error) {
					this.backupError = error instanceof Error ? error.message : String(error);
					return false;
				} finally {
					this.backupPending = false;
					this.emit();
				}
			}
			/** Download URL of one snapshot (the portable export / a hand-off copy). */
			snapshotContentUrl(name) {
				return this.transport.snapshotContentUrl?.(name);
			}
			/**
			* Whether this deployment serves the backup surface at all.
			*
			* Both halves matter and only the second one is a runtime fact: a transport
			* can lack the method (a test fake, an older shell build), AND the running
			* Host can lack the route (an instance not restarted since the plugin was
			* updated). A capability check that only looks at the method shows a working
			* panel over a route table that answers 404.
			*/
			get backupAvailable() {
				return this.transport.backups !== void 0 && !this.backupUnavailable;
			}
			/**
			* Report a backup failure that happened in the BROWSER (a file the page could
			* not open, for instance): same channel as a Host refusal, so the panel has
			* one place where "what went wrong" is rendered.
			*/
			reportBackupError(message) {
				this.backupError = message;
				this.emit();
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
					this.adopt(await this.transport.action(action));
					this.error = void 0;
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
					throw error;
				} finally {
					this.pending = false;
					this.emit();
				}
			}
			/**
			* Adopt a fresh snapshot (idea #34): an IDLE refresh - same revision, the
			* Host bumps it on every commit - keeps the SAME reference, so the board's
			* setSnapshot bails out by Object.is and React rebuilds nothing on the
			* 2.5 s short-poll tick that found no change. The revision is the Host's
			* single source of truth: equal revision means identical content (replayed
			* requests and no-op applies return the current state verbatim).
			* @returns whether the snapshot reference actually moved.
			*/
			adopt(fresh) {
				if (this.snapshot !== void 0 && fresh.revision === this.snapshot.revision) return false;
				this.snapshot = fresh;
				return true;
			}
			emit() {
				for (const listener of [...this.listeners]) listener();
			}
			/**
			* Full record behind one list row (idea #34 deferred body): the edit
			* modal, the follow-up composer and the re-analyze input read the WHOLE
			* body here, fetched once per change. Cached until the row's updatedAt
			* moves - every commit stamps updatedAt on changed ideas - so the entry
			* self-invalidates after each action.
			*/
			async fetchIdea(row) {
				const hit = this.fullRecords.get(row.id);
				if (hit !== void 0 && hit.updatedAt === row.updatedAt) return hit;
				if (this.transport.idea === void 0) throw new Error("body-unavailable");
				const full = await this.transport.idea(row.id);
				this.fullRecords.set(full.id, full);
				return full;
			}
			/** The whole body when its full record is loaded (deep search), else undefined. */
			cachedBodyOf(id) {
				return this.fullRecords.get(id)?.body;
			}
			/**
			* Deep-search index (idea #34): the list snapshot carries only excerpts,
			* so the FIRST active search loads the full snapshot ONCE per revision and
			* fills the record cache; matchesFilter then scans whole bodies exactly
			* like before the projection. Idle boards and clean filters never pay it.
			* Never rejects (a failed load logs and lets the next keystroke retry), so
			* callers can fire-and-forget; the record cache - not the snapshot - is
			* the deliverable (adopt() stays the only snapshot mutator).
			*/
			async ensureSearchIndex() {
				if (this.snapshot === void 0 || this.transport.stateFull === void 0) return;
				if (this.searchIndexedAtRevision >= this.snapshot.revision) return;
				if (this.searchIndexLoad !== void 0) {
					await this.searchIndexLoad;
					return;
				}
				this.searchIndexLoad = (async () => {
					try {
						const full = await this.transport.stateFull();
						for (const idea of full.ideas) this.fullRecords.set(idea.id, idea);
						this.searchIndexedAtRevision = Math.max(this.searchIndexedAtRevision, full.revision);
					} catch (error) {
						console.error("[dsh-plugin-ideas-manager] search index load failed:", error);
					}
				})();
				try {
					await this.searchIndexLoad;
				} finally {
					this.searchIndexLoad = void 0;
				}
			}
			/** Surface a transport/UI failure through the board's existing error bar. */
			reportError(message) {
				this.error = message;
				this.emit();
			}
			/** Whether this deployment serves the health aggregate at all. */
			get statsAvailable() {
				return this.transport.stats !== void 0;
			}
			/**
			* Load the bounded health aggregate for one workspace scope.
			*
			* Called by the Health tab when it opens and whenever the ledger revision
			* actually moves while it is open — never on the 2.5 s poll, which keeps its
			* exact pre-existing request and payload. A transport without the capability
			* leaves {@link stats} undefined forever, which the view reads as "this
			* deployment has no health surface" (a downgrade, like the backup one).
			*
			* The result is stored WITH the scope it was asked for, so switching the
			* workspace selector can never paint the previous scope's numbers under the
			* new label: a stale scope reads as "no data yet" until its own fetch lands.
			*
			* @param workspaceId - the scope; undefined = every workspace.
			*/
			async loadStats(workspaceId) {
				if (this.transport.stats === void 0) {
					this.stats = void 0;
					this.statsError = void 0;
					this.emit();
					return;
				}
				this.statsPending = true;
				this.statsError = void 0;
				this.emit();
				const seq = ++this.statsRequestSeq;
				try {
					const query = workspaceId === void 0 ? {} : { workspaceId };
					const fresh = await this.transport.stats(query);
					if (seq !== this.statsRequestSeq) return;
					this.stats = fresh;
					this.statsScope = workspaceId;
				} catch (error) {
					if (seq === this.statsRequestSeq) this.statsError = error instanceof Error ? error.message : String(error);
				} finally {
					if (seq === this.statsRequestSeq) this.statsPending = false;
					this.emit();
				}
			}
			/** Forget the aggregate (the Health tab was left): the next open refetches. */
			dropStats() {
				if (this.stats === void 0 && this.statsScope === void 0) return;
				this.stats = void 0;
				this.statsScope = void 0;
				this.statsRequestSeq += 1;
				this.emit();
			}
		};
		/** Trim a comma-separated input into clean tag names. */
		function tagNames(raw) {
			return (raw ?? []).flatMap((line) => line.split(",")).map((tag) => tag.trim()).filter((tag) => tag !== "");
		}
		/**
		* Client-side tag patch normalization (idea #94): plain strings are the
		* comma-separated modal input and become name-only rows, while {@link IdeaTag}
		* rows travel through untouched so a bulk tag keeps every existing label's
		* `promptPrefix` (the wire patch replaces the whole set, so dropping it would
		* be a silent loss).
		*/
		function normalizeClientTags(raw) {
			const tags = [];
			for (const entry of raw) {
				if (typeof entry === "string") {
					for (const name of entry.split(",")) {
						const trimmed = name.trim();
						if (trimmed !== "") tags.push({ name: trimmed });
					}
					continue;
				}
				if (entry !== null && typeof entry === "object" && typeof entry.name === "string") tags.push({ ...entry });
			}
			return tags;
		}
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
		const CSS_TEXT = `/* --- theme fallback palette --- */
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
  /* Launch affordance (idea #66): the one GREEN action — it starts the work,
     while every other card action only moves the card. A lighter green on the
     dark theme so the triangle keeps its contrast on dark cards. */
  --dsh-ideas-run: #16a34a;
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
  --dsh-ideas-run: #34d399;
}

/* --- board panel container (the shell mounts it in the keyed main slot) --- */

/* The layout hands a main-slot occupant the whole center column, so the panel
   only fills it and carries the surface. */
[data-dsh-ideas-view] {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
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

/* Deep-link jump (idea #105): "Go to idea" sits in the header's right cluster
   next to the scope selector. A compact text field — NOT a second search box:
   it takes a reference (#42) and jumps, it does not narrow. */
.dsh-ideas-jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.dsh-ideas-jump-input {
  box-sizing: border-box;
  width: 92px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  font-family: inherit;
}

.dsh-ideas-jump-go {
  flex: none;
  white-space: nowrap;
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

/* Launch refused by the TaskBoard permission gate: a warning box, not an
   error box, because the launch is still valid the moment a human confirms
   the card. The raw Host sentence rides at the bottom, muted and truncated
   by its container, for diagnosis only. */
.dsh-ideas-launch-gate {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-warn-bg, color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsh-ideas-fb-accent)) 12%, transparent));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 12px;
}

.dsh-ideas-launch-gate code {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-ideas-launch-gate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* The workspace default launch model's own row of controls (idea #107). Same
   shape as the gate actions, its own name: the launch modal is the one surface
   that both SHOWS a stored preference and edits it. */
.dsh-ideas-default-model-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
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
  position: relative;
  /* Scope each column's reflow (idea #53): resizing one column must not
     invalidate the others' card layout — they only shift position — so a dense
     drag stays fast. "layout" only (not "paint") so the resizer, which sits in
     the inter-column gap, is not clipped. */
  contain: layout;
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 240px;
  /* Default cap of the equal-share layout (a resized column overrides this via
     its explicit width, so it can honour the wider columnMaxWidth setting). */
  max-width: 600px;
  min-height: 0;
  border-radius: 10px;
  background: var(--dsw-alias-bg-subtle, var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1)));
  padding: 10px;
  gap: 8px;
}

/* Per-column width resizer (idea #53): a thin grip centred on the column's
   right edge (inside the 12px inter-column gap) that drags to resize THAT
   column. Absolutely positioned so it never takes layout space; the hairline
   affordance appears on hover, focus and while dragging ([data-resizing]). */
.dsh-ideas-column-resizer {
  position: absolute;
  top: 0;
  right: -6px;
  width: 12px;
  height: 100%;
  z-index: 5;
  cursor: col-resize;
  touch-action: none;
}

.dsh-ideas-column-resizer::after {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 1px;
  background: transparent;
}

.dsh-ideas-column-resizer:hover::after,
.dsh-ideas-column-resizer:focus-visible::after,
.dsh-ideas-column-resizer[data-resizing]::after {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-column-resizer:focus-visible {
  outline: none;
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

/* Windowed column (idea #108): a sizer as tall as the WHOLE column, with only
   the cards near the viewport as absolutely-positioned children. The inter-card
 * gap lives inside each card's slot (see IDEA_CARD_GAP_PX), so the geometry and
   the painted spacing are the same number rather than two that can drift. */
.dsh-ideas-virtual-list {
  position: relative;
  flex: none;
}

/* The standing notice on a column past the notice threshold: a quiet line that
   stays put above the scrolling body, so the reader meets it before scrolling
   rather than after losing the thread. */
.dsh-ideas-open-column-notice {
  flex: none;
  margin: 0;
  padding: 0 4px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
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

/* --- relations (idea #106) ---
   The chip is deliberately NEUTRAL: a relation is a statement the human made,
   so it must not borrow the tag hues, which are a filter the reader clicks. It
   reads as a quiet reference (#N plus a direction arrow) rather than as a
   badge claiming importance. */
.dsh-ideas-relations {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 0 10px;
}

.dsh-ideas-relation-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dsh-ideas-relation-row > .dsh-ideas-select {
  max-width: 260px;
  font-size: 12px;
}

.dsh-ideas-relation-chips {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.dsh-ideas-relation-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  font-size: 11px;
}

/* The derived "blocked by" line is not editable here, so it must LOOK
   uneditable: same chip, no remove button, no pointer. */
.dsh-ideas-relation-chip-locked {
  border-style: dashed;
  cursor: default;
}

.dsh-ideas-relation-glyph {
  flex: none;
  opacity: 0.75;
}

.dsh-ideas-relation-remove {
  flex: none;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  padding: 0 0 0 2px;
  cursor: pointer;
}

.dsh-ideas-relation-remove:disabled {
  opacity: 0.5;
  cursor: default;
}

.dsh-ideas-relation-empty,
.dsh-ideas-relation-more {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
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
   review approved / follow-up / restore, by status): a quiet row above the form
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

/* --- Backup panel (snapshots, restore, portable export/import) --- */

.dsh-ideas-backup-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.dsh-ideas-backup-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  max-height: 260px;
  overflow-y: auto;
}

.dsh-ideas-backup-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-backup-item-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dsh-ideas-backup-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.dsh-ideas-backup-status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-backup-status-warn {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-warn-bg, color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsh-ideas-fb-accent)) 12%, transparent));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 12px;
  overflow-wrap: anywhere;
}

.dsh-ideas-backup-download {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-backup-file {
  font-family: var(--dsh-font-family, monospace);
  font-size: 11px;
  overflow-wrap: anywhere;
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

/* Health view (idea #110): the bounded aggregate. Same flex/scroll contract as
   the Priorities wrapper — the panel owns the height, the view owns its scroll.
   The five figures sit on one wrapping grid so the row never forces a
   horizontal scrollbar on a narrow panel. */
.dsh-ideas-health {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  margin-top: 4px;
}

.dsh-ideas-health-hint {
  flex: none;
  margin: 4px 0 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-health-figures {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.dsh-ideas-health-figure {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 180px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l, var(--dsh-ideas-fb-border));
  border-radius: 6px;
  background: var(--dsw-alias-card-bg, var(--dsh-ideas-fb-bg));
}

/* The "not enough deliveries yet" figure: a missing median is a fact to read,
   not an error to hide, so it is tinted rather than greyed out. */
.dsh-ideas-health-figure-warn {
  border-color: var(--dsw-alias-state-warn-primary, var(--dsh-ideas-fb-accent));
  background: var(--dsw-alias-warn-bg, color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsh-ideas-fb-accent)) 12%, transparent));
}

.dsh-ideas-health-figure-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-health-figure-value {
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.dsh-ideas-health-figure-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-health-note {
  flex: none;
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-health-note p {
  margin: 2px 0;
}

.dsh-ideas-health-section {
  flex: none;
  margin-bottom: 10px;
}

.dsh-ideas-health-section-title {
  margin: 8px 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-health-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.dsh-ideas-health-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l, var(--dsh-ideas-fb-border));
}

.dsh-ideas-health-row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-ideas-health-row-value {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-health-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.dsh-ideas-health-tag-count {
  margin-left: 5px;
  opacity: 0.75;
}

.dsh-ideas-health-more {
  margin-top: 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
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

/* Run-state tags on the list rows (idea #71): their own slot in the row's
   top-right corner, mirroring the Overview card header, and deliberately NOT
   part of the meta line. In the meta line they sat between the topic tags and
   the value/effort badges, where a quiet blue pill reads as one more topic
   label and the eye scans straight past it — a live acceptance run reported
   the "Running" tag as missing from a row that was showing it. The row is
   align-items: flex-start, so this item lands on the title line; the
   auto margin pushes it flush against the row actions. */
.dsh-ideas-row-state {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: none;
  margin-left: auto;
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

/* Under-review badge on a kanban card: amber pill marking the review gate
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

/* Failed-task badge on an OPEN kanban card: red pill marking that the last
   observed status of the linked TaskBoard card is failed. The idea
   deliberately stays in the backlog (a failed run delivered nothing) - the
   badge only makes the situation visible. Card header. */
.dsh-ideas-task-failed-badge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, hsl(0 72% 45%) 40%, transparent);
  background: color-mix(in srgb, hsl(0 72% 45%) 14%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(0 70% 40%) 88%, var(--dsh-ideas-fb-fg));
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Running badge on a kanban card: blue pill marking a launch in flight (idea
   #66). The mirror image of the failed badge - it is what keeps a card from
   looking ordinary the second after the Launch button was clicked, and what the
   session link below hangs from. Card header. */
.dsh-ideas-task-running-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, hsl(210 80% 50%) 40%, transparent);
  background: color-mix(in srgb, hsl(210 80% 50%) 14%, var(--dsh-ideas-fb-layer2));
  color: color-mix(in srgb, hsl(210 78% 38%) 88%, var(--dsh-ideas-fb-fg));
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* The pulsing dot inside the running badge. Motion is decorative and the only
   one on the board, so it is disabled wholesale under reduced-motion. */
.dsh-ideas-task-running-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: dsh-ideas-running-pulse 1.4s ease-in-out infinite;
}

@keyframes dsh-ideas-running-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

@media (prefers-reduced-motion: reduce) {
  .dsh-ideas-task-running-dot { animation: none; opacity: 0.7; }
}

/* Stale badge on an OPEN idea (idea #91): a deliberately quiet marker, not an
   alarm. Neutral ink, no fill, dashed edge - it says "this one has been quiet"
   without competing with the review gate's amber pill for attention. Rendered
   next to the run-state tags of the Overview card header and the Priorities
   rows, which is exactly the set of open-idea surfaces. */
.dsh-ideas-stale-badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px dashed color-mix(in srgb, var(--dsh-ideas-fb-fg) 28%, transparent);
  color: color-mix(in srgb, var(--dsh-ideas-fb-fg) 62%, transparent);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Delivery note (idea #91): the one block that gives the review gate something
   to decide on. Sits below the description on the Overview card, above the
   verdict buttons in the editor, and under the exit stamp on a Delivered row.
   Left-ruled and recessed so it reads as quoted output from the run rather
   than as more of the idea's own prose. */
.dsh-ideas-delivery-note {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 6px 0 2px;
  padding: 6px 8px;
  border-left: 2px solid color-mix(in srgb, var(--dsh-ideas-fb-fg) 20%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsh-ideas-fb-fg) 4%, transparent);
}

.dsh-ideas-delivery-note-label {
  color: color-mix(in srgb, var(--dsh-ideas-fb-fg) 55%, transparent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* The harvested text. Clamped rather than truncated in JS: the note is bounded
   host-side, and a runaway model answer must still not push the verdict
   buttons off the card. */
.dsh-ideas-delivery-note-text {
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: color-mix(in srgb, var(--dsh-ideas-fb-fg) 88%, transparent);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* The "no note" line: italic and dimmer than the text, so an absent delivery
   is legible as an absence rather than read as an empty run. */
.dsh-ideas-delivery-note-empty {
  color: color-mix(in srgb, var(--dsh-ideas-fb-fg) 50%, transparent);
  font-size: 12px;
  font-style: italic;
}

/* Activity timeline (idea #92): the editor's read-only record of what this
   idea has been through. Quieter than the delivery note — it is bookkeeping,
   not evidence — so it sits below the fields and above the verdict buttons and
   stays recessed. The list is capped in CSS only: the host already bounds the
   log to its last 50 entries. */
.dsh-ideas-activity {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 8px 0 2px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--dsh-ideas-fb-fg) 12%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsh-ideas-fb-fg) 3%, transparent);
}

.dsh-ideas-activity-label {
  color: color-mix(in srgb, var(--dsh-ideas-fb-fg) 55%, transparent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.dsh-ideas-activity-list {
  margin: 2px 0 0;
  padding: 0 0 0 2px;
  list-style: none;
  overflow-y: auto;
}

.dsh-ideas-activity-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0;
}

.dsh-ideas-activity-row + .dsh-ideas-activity-row {
  border-top: 1px solid color-mix(in srgb, var(--dsh-ideas-fb-fg) 7%, transparent);
}

.dsh-ideas-activity-when {
  color: color-mix(in srgb, var(--dsh-ideas-fb-fg) 48%, transparent);
  font-size: 10px;
  white-space: nowrap;
}

.dsh-ideas-activity-actor {
  font-weight: 600;
}

.dsh-ideas-activity-summary {
  color: color-mix(in srgb, var(--dsh-ideas-fb-fg) 82%, transparent);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* The "N to review" badge on the sidebar panel row (idea #91) has NO rule here
   on purpose: it is painted inside the plugin's own glyph SVG (see
   panel-registration.tsx), which is the only DOM this plugin owns inside that
   shell-owned row. The panel-row contract has no badge seat and no badge prop,
   so taking the row box back is the only other way to draw one — and that would
   undo the panel registration this plugin exists to use. The pill hangs off the
   glyph's top-right corner through overflow:visible; a shell whose glyph span
   clipped its own overflow would silently drop it, which is a cosmetic
   degradation and never a broken row. */

/* "Open the session" affordance on a card whose run is in flight (idea #66):
   the only way back into an execution the board started, whether it ran on a
   mirrored card or in a direct chat session. Renders beside the running
   badge, and degrades to nothing when the shell serves no sessions service. */
.dsh-ideas-open-session {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: none;
  color: color-mix(in srgb, hsl(210 78% 45%) 82%, var(--dsh-ideas-fb-fg));
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.dsh-ideas-open-session:hover {
  border-color: color-mix(in srgb, hsl(210 80% 50%) 40%, transparent);
  background: color-mix(in srgb, hsl(210 80% 50%) 12%, var(--dsh-ideas-fb-layer2));
}

.dsh-ideas-open-session:focus-visible {
  outline: 2px solid color-mix(in srgb, hsl(210 80% 50%) 70%, transparent);
  outline-offset: 1px;
}

/* Follow-up lineage chip on a child card: neutral pill referencing the parent
   idea the review rejected created it from ("suivi de #N"). */
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

/* --- multi-select and bulk actions (idea #94) --- */

/* Per-row select box (idea #94): a real checkbox-looking control that stays
   readable on a card surface and in both themes. The native appearance is
   dropped so the mark and the checked fill follow the skin tokens like every
   other control. The tick is a PSEUDO-ELEMENT, not a child span: this box
   renders on every card, and a second node per card is ~140 extra DOM nodes on
   each re-render of a full board. */
.dsh-ideas-select-box,
.dsh-ideas-select-box-checked {
  appearance: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  padding: 0;
  flex: none;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.dsh-ideas-select-box:hover {
  border-color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
}

.dsh-ideas-select-box-checked {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, var(--dsh-ideas-fb-accent-fg));
  font-weight: 700;
}

.dsh-ideas-select-box-checked::after {
  /* CSS escape for U+2713 (the sheet stays pure ASCII); the TS template
     literal needs the doubled backslash to emit one. */
  content: '\\2713';
}

.dsh-ideas-select-box:focus-visible,
.dsh-ideas-select-box-checked:focus-visible {
  outline: 2px solid var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  outline-offset: 1px;
}

/* Selected card: an accent edge, never a repaint of the whole card — the
   badges, tags and body of a selected row must stay exactly as readable as an
   unselected one. */
.dsh-ideas-card-selected {
  border-color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  box-shadow:
    inset 3px 0 0 0 var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent))),
    0 1px 2px var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
}

/* Deep-link focus (idea #105): the accent ring the board already paints for a
   focused field, drawn AROUND the card instead of on one control — so "this is
   where the link landed" reads exactly like keyboard focus and never like a
   selection the reader made (that keeps its own inset edge above). The ring is
   drawn on the wrapper because the inner card is clipped by the column's own
   rounded corners; an outline is not clipped by the scroll container, so the
   card stays visible at the top and bottom of a full column. */
.dsh-ideas-card-wrapper[data-dsh-ideas-focused] {
  outline: 2px solid var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  outline-offset: -1px;
  border-radius: 10px;
}

.dsh-ideas-card-wrapper[data-dsh-ideas-focused] .dsh-ideas-card {
  border-color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsh-ideas-fb-accent)));
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-button-primary-fill, var(--dsh-alias-fb-accent)) 18%, transparent);
}

/* A deep-link that could not land: a quiet line, not the error box. It is an
   answer to a request the human made, not a failure of the Host. */
.dsh-ideas-focus-note {
  flex: none;
  padding: 6px 9px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  font-size: 12px;
}

/* Selection bar: one quiet row above the tab content, like the tag filter row
   above it. It is the place that states "N selected of M shown, in this scope",
   which is what makes a bulk action auditable before it is posted. */
.dsh-ideas-selection-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: none;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-selection-count {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  white-space: nowrap;
}

/* The scope sentence ("workspace X · tags a, b · search …"): it may wrap, the
   count beside it never does. */
.dsh-ideas-selection-scope {
  min-width: 0;
  flex: 1 1 160px;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-selection-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-left: auto;
}

/* Bulk report: the per-idea answer to a batch. Applied rows are a plain list;
   skipped and failed rows carry the accent/danger ink so a partial failure can
   never read as a blanket success. */
.dsh-ideas-bulk-summary {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
}

.dsh-ideas-bulk-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
}

.dsh-ideas-bulk-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-bulk-item-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dsh-ideas-bulk-item-reason,
.dsh-ideas-bulk-item-note {
  flex: none;
  max-width: 45%;
  overflow-wrap: anywhere;
  text-align: right;
}

.dsh-ideas-bulk-item-skipped .dsh-ideas-bulk-item-reason {
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-ideas-bulk-item-failed .dsh-ideas-bulk-item-reason {
  color: var(--dsw-alias-state-error-primary, var(--dsh-ideas-fb-danger));
}

.dsh-ideas-bulk-item-failed .dsh-ideas-bulk-item-note {
  font-style: italic;
  color: var(--dsw-alias-label-tertiary, var(--dsh-ideas-fb-fg-soft));
}

/* Progress of a running batch: the run is serial on purpose, so the author
   watches it settle idea by idea rather than waiting on one opaque request. */
.dsh-ideas-bulk-progress {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, var(--dsh-ideas-fb-layer1));
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
  font-size: 12px;
}

.dsh-ideas-bulk-warning {
  margin-top: 4px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-warn-bg, color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsh-ideas-fb-accent)) 12%, transparent));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 12px;
}

/* --- About panel (standardized plugin settings section) --- */

.dsh-plugin-about-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 12px;
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-family: var(--dsw-font-family);
}

.dsh-plugin-about-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.dsh-plugin-about-repo-link {
  color: var(--dsw-alias-color-accent, var(--dsh-ideas-fb-accent));
  text-decoration: none;
  font-weight: 500;
  word-break: break-all;
}

.dsh-plugin-about-repo-link:hover {
  text-decoration: underline;
}

.dsh-plugin-about-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
  border-top: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  border-bottom: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  font-size: 13px;
}

.dsh-plugin-about-row {
  display: flex;
  gap: 8px;
}

.dsh-plugin-about-label {
  flex: none;
  min-width: 110px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, var(--dsh-ideas-fb-fg-soft));
}

.dsh-plugin-about-value {
  flex: 1;
  word-break: break-word;
}

.dsh-plugin-about-check-update {
  align-self: flex-start;
  padding: 6px 14px;
  border: 1px solid var(--dsw-alias-border-l3, var(--dsh-ideas-fb-border));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, var(--dsh-ideas-fb-layer2));
  color: var(--dsw-alias-label-primary, var(--dsh-ideas-fb-fg));
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.dsh-plugin-about-check-update:hover {
  background: var(--dsw-alias-bg-layer-3, var(--dsh-ideas-fb-layer3));
}

.dsh-plugin-about-check-update:active {
  border-color: var(--dsw-alias-color-accent, var(--dsh-ideas-fb-accent));
}
`;
		/** Class map consumed by the panel registration and the board JSX. */
		const classes = {
			boardView: "dsh-ideas-board-view",
			board: "dsh-ideas-board",
			boardHeader: "dsh-ideas-board-header",
			boardTitle: "dsh-ideas-board-title",
			backButton: "dsh-ideas-back-button",
			detailMeta: "dsh-ideas-detail-meta",
			search: "dsh-ideas-search",
			jump: "dsh-ideas-jump",
			jumpInput: "dsh-ideas-jump-input",
			jumpGo: "dsh-ideas-jump-go",
			workspaceSelect: "dsh-ideas-workspace-select",
			mdToggle: "dsh-ideas-md-toggle",
			mdToggleButton: "dsh-ideas-md-toggle-button",
			mdToggleActive: "dsh-ideas-md-toggle-active",
			primaryButton: "dsh-ideas-primary-button",
			ghostButton: "dsh-ideas-ghost-button",
			settingsGear: "dsh-ideas-settings-gear",
			error: "dsh-ideas-error",
			focusNote: "dsh-ideas-focus-note",
			launchGate: "dsh-ideas-launch-gate",
			launchGateActions: "dsh-ideas-launch-gate-actions",
			defaultModelActions: "dsh-ideas-default-model-actions",
			columns: "dsh-ideas-columns",
			column: "dsh-ideas-column",
			columnHeader: "dsh-ideas-column-header",
			columnTitle: "dsh-ideas-column-title",
			columnCount: "dsh-ideas-column-count",
			quickAdd: "dsh-ideas-quick-add",
			columnBody: "dsh-ideas-column-body",
			columnResizer: "dsh-ideas-column-resizer",
			virtualList: "dsh-ideas-virtual-list",
			openColumnNotice: "dsh-ideas-open-column-notice",
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
			backupActions: "dsh-ideas-backup-actions",
			backupList: "dsh-ideas-backup-list",
			backupItem: "dsh-ideas-backup-item",
			backupItemMeta: "dsh-ideas-backup-item-meta",
			backupItemActions: "dsh-ideas-backup-item-actions",
			backupStatus: "dsh-ideas-backup-status",
			backupStatusWarn: "dsh-ideas-backup-status-warn",
			backupDownload: "dsh-ideas-backup-download",
			backupFile: "dsh-ideas-backup-file",
			filterChip: "dsh-ideas-filter-chip",
			filterChipActive: "dsh-ideas-filter-chip-active",
			dragHint: "dsh-ideas-drag-hint",
			cardWrapper: "dsh-ideas-card-wrapper",
			cardSelected: "dsh-ideas-card-selected",
			selectBox: "dsh-ideas-select-box",
			selectBoxChecked: "dsh-ideas-select-box-checked",
			selectionBar: "dsh-ideas-selection-bar",
			selectionCount: "dsh-ideas-selection-count",
			selectionScope: "dsh-ideas-selection-scope",
			selectionActions: "dsh-ideas-selection-actions",
			bulkSummary: "dsh-ideas-bulk-summary",
			bulkItems: "dsh-ideas-bulk-items",
			bulkItem: "dsh-ideas-bulk-item",
			bulkItemApplied: "dsh-ideas-bulk-item-applied",
			bulkItemSkipped: "dsh-ideas-bulk-item-skipped",
			bulkItemFailed: "dsh-ideas-bulk-item-failed",
			bulkItemTitle: "dsh-ideas-bulk-item-title",
			bulkItemReason: "dsh-ideas-bulk-item-reason",
			bulkItemNote: "dsh-ideas-bulk-item-note",
			bulkProgress: "dsh-ideas-bulk-progress",
			bulkWarning: "dsh-ideas-bulk-warning",
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
			rowState: "dsh-ideas-row-state",
			prioritiesMove: "dsh-ideas-priorities-move",
			deliveredStamp: "dsh-ideas-delivered-stamp",
			deliveredBadge: "dsh-ideas-delivered-badge",
			archivedStamp: "dsh-ideas-archived-stamp",
			reviewBadge: "dsh-ideas-review-badge",
			taskFailedBadge: "dsh-ideas-task-failed-badge",
			taskRunningBadge: "dsh-ideas-task-running-badge",
			taskRunningDot: "dsh-ideas-task-running-dot",
			openSession: "dsh-ideas-open-session",
			followUpBadge: "dsh-ideas-followup-badge",
			staleBadge: "dsh-ideas-stale-badge",
			deliveryNote: "dsh-ideas-delivery-note",
			deliveryNoteLabel: "dsh-ideas-delivery-note-label",
			deliveryNoteText: "dsh-ideas-delivery-note-text",
			deliveryNoteEmpty: "dsh-ideas-delivery-note-empty",
			activity: "dsh-ideas-activity",
			activityLabel: "dsh-ideas-activity-label",
			activityList: "dsh-ideas-activity-list",
			activityRow: "dsh-ideas-activity-row",
			activityWhen: "dsh-ideas-activity-when",
			activityActor: "dsh-ideas-activity-actor",
			activitySummary: "dsh-ideas-activity-summary",
			tabCount: "dsh-ideas-tab-count",
			health: "dsh-ideas-health",
			healthHint: "dsh-ideas-health-hint",
			healthFigures: "dsh-ideas-health-figures",
			healthFigure: "dsh-ideas-health-figure",
			healthFigureWarn: "dsh-ideas-health-figure-warn",
			healthFigureLabel: "dsh-ideas-health-figure-label",
			healthFigureValue: "dsh-ideas-health-figure-value",
			healthFigureHint: "dsh-ideas-health-figure-hint",
			healthNote: "dsh-ideas-health-note",
			healthSection: "dsh-ideas-health-section",
			healthSectionTitle: "dsh-ideas-health-section-title",
			healthList: "dsh-ideas-health-list",
			healthRow: "dsh-ideas-health-row",
			healthRowName: "dsh-ideas-health-row-name",
			healthRowValue: "dsh-ideas-health-row-value",
			healthTags: "dsh-ideas-health-tags",
			healthTagCount: "dsh-ideas-health-tag-count",
			healthMore: "dsh-ideas-health-more",
			scoreIcon: "dsh-ideas-score-icon",
			fieldHint: "dsh-ideas-field-hint",
			relations: "dsh-ideas-relations",
			relationRow: "dsh-ideas-relation-row",
			relationChips: "dsh-ideas-relation-chips",
			relationChip: "dsh-ideas-relation-chip",
			relationChipLocked: "dsh-ideas-relation-chip-locked",
			relationGlyph: "dsh-ideas-relation-glyph",
			relationRemove: "dsh-ideas-relation-remove",
			relationEmpty: "dsh-ideas-relation-empty",
			relationMore: "dsh-ideas-relation-more",
			aboutPanel: "dsh-plugin-about-panel",
			aboutRepoLink: "dsh-plugin-about-repo-link",
			aboutDetails: "dsh-plugin-about-details",
			aboutRow: "dsh-plugin-about-row",
			aboutLabel: "dsh-plugin-about-label",
			aboutValue: "dsh-plugin-about-value",
			aboutCheckUpdate: "dsh-plugin-about-check-update"
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
		//#region src/client/idea-preview.tsx
		/**
		* Card/row description preview (idea #34): every list surface - kanban card,
		* Priorities row, Delivered row - renders the SAME deferred-body teaser (the
		* list snapshot's body excerpt) through the shared markdown/raw toggle. The
		* full analysis is not part of the board snapshot anymore; it loads on
		* demand in the edit modal, the follow-up composer and the re-analyze flow.
		*/
		/** One description preview block (null when there is nothing to show). */
		function IdeaPreview({ excerpt, mdMode, onEdit }) {
			if (excerpt.trim() === "") return null;
			if (mdMode) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: `${classes.markdownBody} ${classes.bodyClickable}`,
				tabIndex: 0,
				title: t("card.clickToEdit"),
				"data-dsh-ideas-md": "",
				dangerouslySetInnerHTML: { __html: renderMarkdown(excerpt) },
				onClick: (event) => {
					if (event.target.closest("a") !== null) return;
					onEdit();
				},
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onEdit();
					}
				}
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: `${classes.cardBody} ${classes.bodyClickable}`,
				role: "button",
				tabIndex: 0,
				title: t("card.clickToEdit"),
				onClick: onEdit,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onEdit();
					}
				},
				children: excerpt
			});
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
		*
		* The one departure from the human ranking is the open column's optional
		* display order (idea #71): orderOpenColumn can lay the column out by creation
		* date instead of rank, and can float the in-flight work above whichever order
		* is selected. Both are views, never a persisted order — every 2.5 s client poll
		* re-derives them from the same snapshot, so they cannot rewrite the human
		* ranking behind the reader's back.
		*
		* A view order is a DEFAULT, not a lock (see the `targetOrder` argument of
		* rebuildOrder): a drop in a column that paints something else than the rank
		* writes the ranking the author actually built on screen, and the board then
		* paints that ranking. Pure and unit-testable in isolation.
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
		/** Stable rank-sorted copy (ties keep their input order). Generic over the
		*  row type so list rows and full records both pass through unchanged. */
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
		*
		* `targetOrder` is the DISPLAY order of the target group when that column does
		* not paint the stored rank (a date order, or the running block floated to the
		* top). The drop anchor is read from the rows the author actually sees, so the
		* rank that gets written has to be built from that same list: resolving the
		* anchor in rank space instead is what used to make a drop in a reordered
		* column land on the rank the card already held. Omitted, the behaviour is the
		* historical rank-space rebuild, which every rank-ordered column still uses.
		*/
		function rebuildOrder(all, movedId, targetStatus, beforeId, targetOrder) {
			const moved = all.find((idea) => idea.id === movedId);
			if (moved === void 0) return groupedIdOrder(all);
			const targetKey = rankGroupKey(targetStatus, moved.workspaceId);
			const groupRows = all.filter((idea) => idea.id !== movedId && groupKeyOf(idea) === targetKey);
			const groupIds = new Set(groupRows.map((idea) => idea.id));
			const targetIds = targetOrder === void 0 ? orderIdeas(groupRows).map((idea) => idea.id) : targetOrder.filter((id) => id !== movedId && groupIds.has(id));
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
		* Running block of one idea: 0 = a run in flight, 1 = everything else (idle,
		* done, or failed).
		*
		* Only the RUNNING state is floated, deliberately: a failed run keeps its tag
		* but its row stays where the selected order puts it, because a date-ordered
		* backlog that jumped every failure to the top would stop reading as a diary.
		* The rule mirrors the running badge exactly, so the sort and the tag can never
		* point at different rows: the block is `runStatus` OR the raw card observation
		* (a card started from the task board itself is only folded into runStatus by
		* the next poll).
		*/
		function runningBlockOf(idea) {
			return idea.runStatus === "running" || idea.taskBoardStatus === "running" ? 0 : 1;
		}
		/** Creation instant of a row, used by the date orderings. */
		function createdAtKey(idea) {
			return idea.createdAt;
		}
		/**
		* Creation-date ordering of one block (idea #71). `desc` flips it to newest
		* first. Ties — an import can stamp a whole batch with the same instant — fall
		* back to the human rank and then to the input order, so the column is
		* deterministic from one poll to the next instead of reshuffling on every 2.5 s
		* refresh.
		*/
		function orderByCreatedAt(rows, desc) {
			const direction = desc ? -1 : 1;
			return [...rows].sort((a, b) => (createdAtKey(a) - createdAtKey(b)) * direction || orderKey(a) - orderKey(b));
		}
		/** The comparator behind each `openOrdering` member, as a pure function. */
		function sortByOrdering(rows, ordering) {
			if (ordering === "rank") return orderIdeas(rows);
			return orderByCreatedAt(rows, ordering === "createdAtDesc");
		}
		/**
		* The presentation order of the Overview **Open column**, combining the three
		* orthogonal decisions (idea #71):
		*
		*  - grouping: `grouped` lays the column out per workspace group (the board on
		*    "all workspaces"); ungrouped is one flat list;
		*  - ordering: `createdAt` (the default, oldest first), `createdAtDesc`, or
		*    `rank` — the human ranking the reorder verb wrote;
		*  - `runningFirst`: with it on, the ideas whose run is in flight are laid out
		*    first and every other idea keeps the selected order below them, so the
		*    float composes with a date order exactly as it does with the rank.
		*
		* The selected order is applied INSIDE each group, never across groups: a
		* running idea of workspace B must not land under workspace A's header, and
		* the drag & drop of a grouped column stays group-local by construction.
		*
		* The Priorities ranking deliberately does NOT go through here. It is a pure
		* rank list whose rows print their position and whose arrows/drag write one
		* rank step, so an attention order would make the printed number contradict
		* the stored rank the reader is editing. Priorities carries the run-state
		* badges instead, which answer the same question without moving anything.
		*
		* Pure, so the whole decision is unit-testable without a component.
		*/
		function orderOpenColumn(rows, grouped, workspaceTitle, ordering, runningFirst) {
			const within = (group) => {
				const sorted = sortByOrdering(group, ordering);
				if (!runningFirst) return sorted;
				const running = [];
				const rest = [];
				for (const idea of sorted) if (runningBlockOf(idea) === 0) running.push(idea);
				else rest.push(idea);
				return [...running, ...rest];
			};
			if (!grouped) return within(rows);
			return groupOpenByWorkspace(rows).sort((a, b) => compareWorkspaceGroups(a, b, workspaceTitle)).flatMap((group) => within(group.ideas));
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
		*     board — it varies per instance, so only the prompt can supply it),
		*   - the bounded summary selector, which overrides an older first-wins
		*     installed skill during rollout.
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

Bounded-read override (also applies when an older first-wins skill file is installed): start with GET ${origin}/api/ideas/state?view=summary&workspaceId=${encodeURIComponent(input.workspaceId)}&status=open&status=archived. Follow meta.nextOffset until that filtered page is complete, inspect meta.omittedFields, and fetch the resolved target's complete body only through /api/ideas/idea?id=<target-id>. Never replace this with the full /state snapshot.

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
			const summary = input.summary ?? "—";
			const taskBoardLink = input.taskBoardId ?? "—";
			const opinion = [
				`value: ${input.value === void 0 ? "not set" : String(input.value)} (scale 1..3)`,
				`effort: ${input.effort === void 0 ? "not set" : String(input.effort)} (scale 1..3)`,
				`rationale: ${input.rationale ?? "not set"}`
			].join("\n");
			return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}). This is a RE-ANALYZE run: a human asked you to re-process an idea that ALREADY exists on the board. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog and follow it. It is the single source of the analysis methodology, bounded context-loading workflow, handoff format, escalation contract, final report, and write-channel contract.

=== Re-analysis overrides (precedence over the skill for this run) ===
- Envelope initiator: "plugin:ideas-manager:ai-reanalyze" (NOT ai-capture).
- NEVER use the create verb. The idea already exists.
- You MUST issue an update verb with ideaId ${input.ideaId} (your new title, full body, your summary, and tags), then triage the SAME ideaId.
- Keep the existing rank unless the fresh analysis justifies a change.
- Do NOT re-analyze again or launch anything recursive.

=== Exact target selector ===
- ideaId: ${input.ideaId}
- ideaNumber: ${input.ideaNumber === void 0 ? "not assigned" : `#${input.ideaNumber}`}
- workspaceId: ${input.workspaceId}
- title hint: ${input.title}
- status hint: ${input.status}
- summary hint: ${summary}
- tags hint: ${tagsHuman}
- TaskBoard link: ${taskBoardLink}

Load summary metadata first with GET ${origin}/api/ideas/state?view=summary&id=${encodeURIComponent(input.ideaId)}. Inspect the response revision and meta before trusting the projection. Resolve this target by the exact ideaId, then verify the supplied ideaNumber (when present), workspaceId, and status before loading anything full. If any identity check fails, follow the skill escalation contract and do not write.

Then fetch ONLY the target with GET ${origin}/api/ideas/idea?id=${encodeURIComponent(input.ideaId)}. Analyze its complete current body. Load full bodies only for directly related follow-ups identified by followUpOfId; never load the full /state snapshot and never load an unrelated body.

=== What this idea has already been through (the board's activity log) ===
${renderActivity(input.activity)}
This is the REAL history, recorded by the board: read it before you write, and never contradict it. An idea that was already declined, delivered or archived-and-restored has a story — a re-analysis that ignores it will re-propose what was already refused. When the log contradicts the current body, believe the log and say so in your analysis.

=== Stored priority opinion (re-decide it and justify the final choice) ===
${opinion}`;
		}
		/**
		* Render the activity log for the re-analysis prompt. Chronological, one line
		* per entry, oldest first — the order in which a reader of the board reads it.
		* An empty log reads as "nothing recorded yet", never as an omission.
		*/
		function renderActivity(activity) {
			if (activity === void 0 || activity.length === 0) return "— nothing recorded yet (the idea predates the activity log, or nothing has happened to it since).";
			return activity.map((entry) => `- ${new Date(entry.at).toISOString()} · ${entry.actor} · ${entry.verb}: ${entry.summary}`).join("\n");
		}
		/**
		* The FIND SIMILAR launch prompt. Same split as the other two analyst
		* prompts: the skill carries the methodology, this prompt carries the anchor,
		* the bounded candidate set, the server origin — and the rules that make this
		* run a REPORT rather than an action.
		*
		* Two things the prompt is careful about:
		*  - the candidate scores are labelled a cheap signal the analyst must
		*    distrust, because a bounded set without that caveat reads as a verdict;
		*  - the merge verb is forbidden outright, and the report asks for a merge
		*    RECOMMENDATION instead. The human stays the one who merges.
		*/
		function buildFindSimilarPrompt(input, origin) {
			const candidateLines = input.candidates.map((candidate, index) => `${index + 1}. ${candidate.ideaNumber === void 0 ? "(no number)" : `#${candidate.ideaNumber}`} — ${candidate.title}\n   ideaId: ${candidate.id} · score ${candidate.score.toFixed(2)} (signals: ${candidate.signals.join(", ") || "none"})`);
			const candidateBlock = input.candidates.length === 0 ? "— none. No open idea of this workspace scored above the floor for this idea." : candidateLines.join("\n");
			return `You are the ideas analyst of the DSH Ideas board, for the workspace "${input.workspaceTitle}" (workspaceId ${input.workspaceId}). This is a FIND SIMILAR run: a human asked you to judge whether this idea duplicates something already in this workspace's open backlog. Do the work now — no clarifying questions.

Load the skill named "ideas-analyst" from the available_skills catalog. You are NOT producing an analysis for this run: your deliverable is a comparison and a verdict, never a card.

=== Find-similar overrides (precedence over the skill for this run) ===
- Write NOTHING. Never create, never update, never triage — and above all NEVER use the merge verb. A merge is the human's decision, not yours; this run reports, it does not act.
- Compare ONLY the candidates listed below. Do not go hunting for more: this bounded list is the whole scope of the question.
- If the human replies in a later turn, that reply — not this prompt — decides what happens next.

=== The idea under review ===
- ideaId: ${input.ideaId}
- ideaNumber: ${input.ideaNumber === void 0 ? "not assigned" : `#${input.ideaNumber}`}
- workspaceId: ${input.workspaceId}
- status: ${input.status}
- title hint: ${input.title}
- summary hint: ${input.summary ?? "—"}
- tags hint: ${input.tags.length === 0 ? "—" : input.tags.join(", ")}

Load its complete current body with GET ${origin}/api/ideas/idea?id=${encodeURIComponent(input.ideaId)}. Do not load the full /state snapshot.

=== The candidate set the board computed ===
The board compared this idea against ${input.scanned} open idea(s) of THIS workspace and kept those that scored above a low floor. These are the ${input.candidates.length} it kept:
${candidateBlock}

The score is a CHEAP SIGNAL, not a judgement: it is normalized-title overlap plus tag overlap. Distrust it in both directions — a high score is often two genuinely different ideas sharing vocabulary, and a low one is often the same idea worded differently. Read each candidate's REAL body with GET ${origin}/api/ideas/idea?id=<candidate-id> before you judge it. Load full bodies only for the candidates listed here.

=== Your report (the whole deliverable) ===
For EVERY candidate you weighed, write one line: its "#N" (or ideaId), its title, then DUPLICATE, RELATED BUT DISTINCT, or UNRELATED, with the reason in a few words. Then close with exactly one line: either "No duplicate found." or the single best merge pair you would recommend, written as "recommend merging <source> into <survivor>" — a recommendation the human acts on, never a merge you perform.

Report and stop.`;
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
		* Match a stored `provider/model` launch target against the catalog choices,
		* so a picker can preselect the option a run would use anyway.
		*
		* The inverse of {@link modelTargetIdOf}, and therefore as strict: the target
		* must be a qualified `provider/model` and must exist in the catalog. A target
		* the catalog does not know returns undefined rather than guessing — a model
		* the deployment has dropped is exactly the case where the panel must show the
		* stored id as it is (and where the launch will refuse loudly) instead of
		* silently showing some other row.
		*/
		function pickModelTarget(choices, target) {
			if (target === void 0) return void 0;
			const trimmed = target.trim();
			const slash = trimmed.indexOf("/");
			if (slash <= 0) return void 0;
			const provider = trimmed.slice(0, slash);
			const model = trimmed.slice(slash + 1);
			return choices.find((choice) => choice.provider === provider && choice.model === model);
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
					launchFindSimilar: async (input) => launchAnalystSession(controller, modelSource, input, buildFindSimilarPrompt(input, pageOrigin())),
					listModels: () => modelSource === void 0 ? Promise.resolve([]) : modelChoicesOf(modelSource),
					currentModel: () => Promise.resolve(currentSessionSelectionOf(controller))
				};
			} catch {
				return;
			}
		}
		//#endregion
		//#region src/client/launch.ts
		/**
		* Card statuses a launch may start from. `failed` is INCLUDED (decision D4):
		* the task-board accepts a run on a failed task, and without it a card whose
		* run failed could never be retried from our board — the human would have to
		* go to the TaskBoard itself, which is exactly what #66 removes.
		* `running` is excluded (the task-board would refuse anyway, with a less
		* helpful message), `done` and `archived` too. A not-yet-observed card
		* (undefined) stays launchable so a freshly captured idea is not gated behind
		* the first poll tick.
		*/
		const LAUNCHABLE_TASK_STATUSES = [
			"backlog",
			"todo",
			"failed"
		];
		/**
		* Whether the Launch affordance belongs on this card. Pure, synchronous, and
		* the single source of truth for the button (and its absence).
		*
		* A card is NOT required: on a Host that serves no task-board plugin no card is
		* ever mirrored, and the direct-session backend runs the idea without one. The
		* card status therefore only constrains a card that EXISTS — a card that is
		* `running` or `done` is the run of record, and starting a second, invisible
		* session next to it would be a lie, so the button stays hidden either way.
		*/
		function canLaunch(idea) {
			if (idea.status !== "open") return false;
			if (idea.workspaceId === void 0 || idea.workspaceId === "") return false;
			if (idea.runStatus === "running") return false;
			if (idea.taskBoardId === void 0 || idea.taskBoardId === "") return true;
			const status = idea.taskBoardStatus;
			return status === void 0 || LAUNCHABLE_TASK_STATUSES.includes(status);
		}
		/**
		* The `provider/model` target id the task-board stores on the task and the
		* runner pins on the fresh session. Built from a catalog choice, so the ids are
		* already qualified (a bare id would keep the session provider).
		*/
		function modelTargetIdOf(model) {
			if (model === void 0) return void 0;
			const target = `${model.provider}/${model.model}`.trim();
			return target === "" ? void 0 : target;
		}
		/**
		* The default launch model this workspace carries (idea #107), or undefined
		* when it carries none.
		*
		* The client twin of the Host's own rule (`IdeasHostService.workspaceLaunchModel`)
		* and deliberately the same shape, so the modal can say what the run will use
		* without a second source of truth. It is a DISPLAY of the setting, not the
		* decision: the fallback is resolved Host-side at launch time, so a browser
		* that never rendered the modal gets exactly the same run.
		*/
		function launchModelForWorkspace(models, workspaceId) {
			const key = workspaceId?.trim();
			if (key === void 0 || key === "") return void 0;
			const target = models?.[key];
			return typeof target === "string" && target.trim() !== "" ? target.trim() : void 0;
		}
		/**
		* The next map with `workspaceId`'s default SET to `target` — the "remember
		* this model for this workspace" gesture. A pure read-modify-write over the map
		* the client already holds, because the settings write replaces the map whole
		* (see parseSettingsBody): the client must send every other workspace's
		* default back, not just its own.
		*
		* Keys and targets are TRIMMED, exactly as `sanitizeLaunchModelByWorkspace`
		* trims them on the way in: the map this plugin writes and the map the Host
		* reads must agree on the spelling of a workspace id, or a stored default would
		* silently miss.
		*/
		function withWorkspaceLaunchModel(models, workspaceId, target) {
			const key = workspaceId.trim();
			const model = target.trim();
			if (key === "" || model === "") return { ...models };
			return {
				...models,
				[key]: model
			};
		}
		/**
		* The next map with `workspaceId`'s default REMOVED — what "forget this
		* workspace default" writes. Removing the last entry leaves an empty map
		* rather than an absent one: the setting is always spelled, and a board with
		* no default anywhere is exactly the board that predates #107.
		*/
		function withoutWorkspaceLaunchModel(models, workspaceId) {
			const next = { ...models };
			delete next[workspaceId.trim()];
			return next;
		}
		/**
		* The TaskBoard's permission-gate marker. A card whose effective permission is
		* above the session default is refused until a HUMAN confirms the binding in
		* the board UI, and the Host relays that sentence verbatim — an English,
		* agent-shaped message with no next step for the reader.
		*/
		const CONFIRMATION_REQUIRED = "confirmation-required";
		/**
		* Classify a launch refusal message.
		*
		* Substring matching on the marker, not equality: the Host prefixes the
		* exception with the action and the status (`task-board run -> 400:
		* confirmation-required: ...`), and a future board version may reword the tail
		* without changing the marker.
		* @param message - the message the failed launch threw with.
		* @returns the refusal kind, keeping the original message in both arms.
		*/
		function classifyLaunchRefusal(message) {
			if (message.includes(CONFIRMATION_REQUIRED)) return {
				kind: "permission",
				message
			};
			return {
				kind: "plain",
				message
			};
		}
		//#endregion
		//#region src/client/find-similar.ts
		/**
		* Whether the Find-similar affordance belongs on this card.
		*
		* Same gate as Re-analyze, and deliberately so: both are "hand a bounded
		* question to an analyst session in this idea's workspace", so they must
		* appear and disappear together. An OPEN idea only — the scan compares the
		* idea against an OPEN backlog, and a closed idea has a state that already
		* answers the question a human would ask it.
		*/
		function canFindSimilar(idea, gate) {
			if (idea.status !== "open") return false;
			if (!gate.hasLauncher) return false;
			if (idea.workspaceId === void 0 || idea.workspaceId === "") return false;
			return gate.knownWorkspaceIds.has(idea.workspaceId);
		}
		/**
		* Build the analyst launch input from the idea and the report the Host just
		* served. Pure mapping, no fetch and no merge: the `model` the modal picked
		* rides along exactly like it does for the capture and the re-analysis.
		*/
		function buildFindSimilarInput(idea, report, context) {
			if (idea.workspaceId === void 0 || idea.workspaceId === "") return void 0;
			const candidates = report.candidates.map((candidate) => ({
				id: candidate.id,
				...candidate.ideaNumber === void 0 ? {} : { ideaNumber: candidate.ideaNumber },
				title: candidate.title,
				score: candidate.score,
				signals: candidate.signals
			}));
			return {
				workspaceId: idea.workspaceId,
				workspaceTitle: context.workspaceTitle,
				ideaId: idea.id,
				...idea.ideaNumber === void 0 ? {} : { ideaNumber: idea.ideaNumber },
				title: idea.title,
				...idea.summary === void 0 ? {} : { summary: idea.summary },
				status: idea.status,
				tags: (idea.tags ?? []).map((tag) => tag.name),
				candidates,
				scanned: report.scanned,
				...context.model === void 0 ? {} : { model: context.model }
			};
		}
		function similarCandidateViews(report, labels) {
			return report.candidates.map((candidate) => ({
				id: candidate.id,
				...candidate.ideaNumber === void 0 ? {} : { ideaNumber: candidate.ideaNumber },
				title: candidate.title,
				score: candidate.score,
				signals: candidate.signals.map((signal) => signal === "title" ? labels.title : labels.tags)
			}));
		}
		//#endregion
		//#region src/client/settings-navigation.ts
		/**
		* Open the DSH Settings modal on this plugin's section.
		*
		* The shell keeps its active section as private React state and exposes no
		* open-section API, so the header gear drives the DOM the shell actually
		* paints. Two shells are in the field, and a deployment has exactly one of
		* them:
		*
		* 1. Dialog trigger (the web shell, and any build that still paints the
		*    fallback sidebar button): the only shell button carrying both
		*    `aria-haspopup="dialog"` and an aria-label from the host locale dict
		*    ("Settings" / "设置"). Clicking it opens the modal on the first section.
		* 2. Account launcher (the Desktop shell since 0.2.0-rc.2): `settings.launcher`
		*    replaces that button with an account menu (`aria-haspopup="menu"`,
		*    labelled "Account menu" / "账号菜单"). Settings is a menuitem inside it;
		*    choosing the item calls the same `open()` the dialog trigger used to.
		*
		* Either way the follow-up click is our nav row, matched by every dictionary's
		* label: the host resolves `label()` when it builds the dialog, so the row can
		* carry the boot language while the panel renders in the pinned one. Matching
		* only the current label opened the modal without selecting Ideas.
		*
		* When neither hook matches, log and leave the GUI untouched — never throw.
		*/
		/** Host locale labels of the fallback settings button (`t("trigger")`). */
		const DIALOG_TRIGGER_LABELS = ["Settings", "设置"];
		/**
		* Host locale labels of the account menu button (`t("menu")`). The visible
		* caption can be the signed-in name or "More"; the accessible name stays this.
		*/
		const ACCOUNT_MENU_LABELS = ["Account menu", "账号菜单"];
		/** Host locale labels of the Settings menuitem (`t("settings")`). */
		const SETTINGS_ITEM_LABELS = ["Settings", "设置"];
		/** How long we keep looking after a click before giving up. */
		const OPEN_DEADLINE_MS = 800;
		/**
		* Find our settings nav row inside an open dialog, or undefined.
		* @returns the row button, when the dialog is open and the label matches.
		*/
		function findIdeasSettingsNavRow() {
			const labels = [t("settings.nav"), ...SETTINGS_NAV_LABELS];
			for (const dialog of Array.from(document.querySelectorAll("[role=\"dialog\"]"))) {
				if (!dialog.isConnected) continue;
				for (const button of Array.from(dialog.querySelectorAll("nav button"))) {
					const text = (button.textContent ?? "").trim();
					if (labels.includes(text)) return button;
				}
			}
		}
		/** The fallback settings button, or undefined when this shell does not paint it. */
		function findHostSettingsTrigger() {
			return findButton("button[aria-haspopup=\"dialog\"]", DIALOG_TRIGGER_LABELS);
		}
		/**
		* The account menu button that owns the Settings item on the Desktop shell.
		* @returns the button, or undefined when this shell still uses the dialog trigger.
		*/
		function findAccountMenuTrigger() {
			return findButton("button[aria-haspopup=\"menu\"]", ACCOUNT_MENU_LABELS);
		}
		/**
		* The Settings row of an open account menu.
		* @returns the menuitem, or undefined while the menu is closed or unlabelled.
		*/
		function findSettingsMenuItem() {
			for (const item of Array.from(document.querySelectorAll("[role=\"menu\"] button[role=\"menuitem\"]"))) {
				const text = (item.textContent ?? "").trim();
				if (SETTINGS_ITEM_LABELS.some((label) => text === label || text.startsWith(label))) return item;
			}
		}
		/**
		* Open Settings on this plugin's section.
		*
		* An already-open dialog is selected directly. Otherwise the dialog trigger is
		* preferred (one click, then the row), and the account menu is the Desktop
		* path (open the menu, choose Settings, then the row).
		*/
		function openIdeasSettingsSection() {
			if (clickIdeasNavRow()) return;
			const dialogTrigger = findHostSettingsTrigger();
			if (dialogTrigger !== void 0) {
				dialogTrigger.click();
				watchFor(clickIdeasNavRow, () => {
					console.warn("[dsh-plugin-ideas-manager] settings dialog did not render in time: section select skipped");
				});
				return;
			}
			const account = findAccountMenuTrigger();
			if (account === void 0) {
				console.warn("[dsh-plugin-ideas-manager] settings trigger not found: looked for the dialog button (\"Settings\"/\"设置\") and the account menu (\"Account menu\"/\"账号菜单\")");
				return;
			}
			if (account.getAttribute("aria-expanded") !== "true") account.click();
			let itemClicked = false;
			watchFor(() => {
				if (clickIdeasNavRow()) return true;
				if (itemClicked) return false;
				const item = findSettingsMenuItem();
				if (item === void 0) return false;
				itemClicked = true;
				item.click();
				return clickIdeasNavRow();
			}, () => {
				console.warn("[dsh-plugin-ideas-manager] settings dialog did not render in time: section select skipped");
			});
		}
		/** Click our nav row when the dialog is already open. */
		function clickIdeasNavRow() {
			const row = findIdeasSettingsNavRow();
			if (row === void 0) return false;
			row.click();
			return true;
		}
		/**
		* The first button matching `selector` whose accessible name is one of `labels`.
		* @param selector - button query, including the popup kind.
		* @param labels - host locale labels to accept.
		*/
		function findButton(selector, labels) {
			for (const button of Array.from(document.querySelectorAll(selector))) {
				const label = button.getAttribute("aria-label") ?? "";
				if (labels.includes(label)) return button;
			}
		}
		/**
		* Run `step` on the next frames until it reports done or the deadline passes.
		* The shell commits the menu and the dialog on a later React frame, so the
		* first look is the frame after the click, not the click itself.
		* @param step - returns true when the section has been selected.
		* @param onTimeout - called once when the deadline passes with the step still false.
		*/
		function watchFor(step, onTimeout) {
			const deadline = performance.now() + OPEN_DEADLINE_MS;
			const tick = () => {
				if (step()) return;
				if (performance.now() < deadline) requestAnimationFrame(tick);
				else onTimeout();
			};
			requestAnimationFrame(tick);
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
		//#region src/client/staleness.ts
		/** Milliseconds in one day, the unit `staleAfterDays` is expressed in. */
		const DAY_MS = 864e5;
		/**
		* Whether an open idea has gone quiet long enough to wear the badge.
		*
		* Three deliberate rules:
		*  - OPEN ideas only: an idea in the review gate or the archive is not "stale",
		*    it is finished, and the columns that say so already say it louder;
		*  - `staleAfterDays <= 0` is OFF (the settings option's escape hatch), not
		*    "everything is stale";
		*  - the comparison is strict, so an idea updated exactly N days ago is not
		*    yet stale — the day count reported in the tooltip is the configured
		*    threshold, which is the number the reader set.
		*
		* @param idea - the row to judge (a list row is enough).
		* @param staleAfterDays - the settings threshold; 0 disables the badge.
		* @param now - render instant, passed in so the value is stable for one render.
		*/
		function isStaleIdea(idea, staleAfterDays, now) {
			if (idea.status !== "open") return false;
			if (!Number.isFinite(staleAfterDays) || staleAfterDays <= 0) return false;
			return now - idea.updatedAt > staleAfterDays * DAY_MS;
		}
		//#endregion
		//#region src/client/run-state-badges.tsx
		/** Compact day/month stamp, the canonical one (the Overview card's updated
		*  date and the Delivered stamp both read it). Exported rather than repeated:
		*  board-view imports it back from here. */
		function shortDate$1(epoch) {
			return new Date(epoch).toLocaleDateString(void 0, {
				day: "numeric",
				month: "short"
			});
		}
		/**
		* The shared state pills of one idea, in header order. Renders nothing (an
		* empty fragment) for an idea that is simply idle: the callers drop it in
		* unconditionally, each in the top-right corner of its card or row.
		*/
		function RunStateBadges({ idea, client, parentNumber, showDelivered = true, staleAfterDays = 0, now = Date.now() }) {
			const sessionId = idea.runSessionId;
			const opener = client.sessionOpener;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				idea.followUpOfId !== void 0 && parentNumber !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.followUpBadge,
					title: t("card.followUpOfHint"),
					children: t("card.followUpOf", { number: parentNumber(idea.followUpOfId) ?? "—" })
				}),
				idea.status === "underReview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.reviewBadge,
					title: t("card.underReviewHint"),
					children: t("board.status.underReview")
				}),
				idea.status === "open" && idea.taskBoardStatus === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.taskFailedBadge,
					title: t("card.taskFailedHint"),
					"data-dsh-ideas-task-failed": "",
					children: t("card.taskFailed")
				}),
				(idea.runStatus === "running" || idea.taskBoardStatus === "running") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: classes.taskRunningBadge,
					title: t("card.taskRunningHint"),
					"data-dsh-ideas-task-running": "",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.taskRunningDot,
						"aria-hidden": "true"
					}), t("card.taskRunning")]
				}),
				sessionId !== void 0 && sessionId !== "" && opener !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: classes.openSession,
					title: t("card.openSessionHint"),
					"data-dsh-ideas-open-session": "",
					onClick: (event) => {
						event.stopPropagation();
						opener.open(sessionId);
					},
					children: t("card.openSession")
				}),
				showDelivered && idea.deliveredAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.deliveredBadge,
					title: t("card.deliveredHint"),
					children: t("card.delivered", { date: shortDate$1(idea.deliveredAt) })
				}),
				isStaleIdea(idea, staleAfterDays, now) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.staleBadge,
					title: t("card.staleHint", { days: staleAfterDays }),
					children: t("card.stale")
				})
			] });
		}
		//#endregion
		//#region src/client/idea-title.tsx
		/** Shared card-title rendering for the persistent idea number. */
		/** Return true only for a finite persistent ledger number. */
		function hasIdeaNumber(ideaNumber) {
			return typeof ideaNumber === "number" && Number.isFinite(ideaNumber);
		}
		/** Avoid adding the same persistent prefix twice to legacy/imported titles. */
		function alreadyPrefixed(title, ideaNumber) {
			return new RegExp(`^#${ideaNumber}(?:\\s|$)`).test(title);
		}
		/** Shared title fragment used by Overview, Priorities and Delivered cards. */
		function IdeaTitle({ ideaNumber, title }) {
			if (!hasIdeaNumber(ideaNumber) || alreadyPrefixed(title, ideaNumber)) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: title });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: classes.cardNumber,
				children: ["#", ideaNumber]
			}), title] });
		}
		//#endregion
		//#region src/client/relations.ts
		/**
		* Relations on the board (idea #106): the pure half.
		*
		* Everything the UI needs to decide — which ideas a relation row may name, what
		* a chip prints, and whether a list actually changed — is here, DOM-free and
		* framework-free, so the rules are unit-testable and the React half only
		* paints and posts. The ledger owns the truth; this module never decides
		* whether an edge is legal, it only prepares what a human can pick and what to
		* send.
		*
		* The stored model is one-direction per kind (see docs/architecture.md): the
		* board's own rows carry `relatesTo` / `blocks`, and the `blockedBy` side is
		* derived with {@link ideaBlockedBy} rather than stored. Nothing here invents
		* an edge: a relation is a statement the human makes, exactly like the
		* near-duplicate flag is NOT (that one is a scan, this one is a sentence).
		*/
		function labelOf(row, id) {
			if (row === void 0) return id;
			return row.ideaNumber === void 0 ? row.title : `#${row.ideaNumber} ${row.title}`;
		}
		function shortOf(row, id) {
			if (row === void 0) return id;
			return row.ideaNumber === void 0 ? row.title : `#${row.ideaNumber}`;
		}
		/**
		* The three relation lines of one idea, in the order a reader wants them:
		* what it is adjacent to, what it waits for, what waits for it.
		*
		* Every reference is resolved through the row map, so a chip NEVER prints a
		* bare id while the board still has the idea — and a relation pointing at
		* something the board cannot resolve is dropped from the VIEW rather than
		* rendered as an unopenable `#3` with no title. (The ledger keeps such an edge
		* only until its next reconciliation, and `delete` removes it outright.)
		*/
		function relationViews(ideas, ideaId) {
			return relationIndexOf(ideas).get(ideaId) ?? [];
		}
		/**
		* The relation lines of EVERY row, built in one pass.
		*
		* A card asks for its own line, and a naive `relationViews` per card would
		* rebuild the row map and rescan the board once per card — O(rows²) on every
		* paint. The board therefore derives the whole index ONCE per paint (the same
		* discipline the multi-select follows when it derives the scope where the
		* columns are drawn) and hands each card its slice.
		*/
		function relationIndexOf(ideas) {
			const byId = new Map(ideas.map((item) => [item.id, item]));
			const index = /* @__PURE__ */ new Map();
			for (const idea of ideas) {
				const views = [];
				for (const id of idea.relatesTo ?? []) {
					const target = byId.get(id);
					if (target === void 0 || id === idea.id) continue;
					views.push({
						id,
						kind: "relatesTo",
						label: labelOf(target, id),
						short: shortOf(target, id)
					});
				}
				for (const id of idea.blocks ?? []) {
					const target = byId.get(id);
					if (target === void 0 || id === idea.id) continue;
					views.push({
						id,
						kind: "blocks",
						label: labelOf(target, id),
						short: shortOf(target, id)
					});
				}
				for (const id of ideaBlockedBy(ideas, idea.id)) {
					const target = byId.get(id);
					if (target === void 0) continue;
					views.push({
						id,
						kind: "blockedBy",
						label: labelOf(target, id),
						short: shortOf(target, id)
					});
				}
				if (views.length > 0) index.set(idea.id, views);
			}
			return index;
		}
		/**
		* The ideas a relation picker may still offer: every other idea the board
		* knows, minus the ones already named by `exclude`, ordered by the stable `#N`
		* so the list reads like the board does. Ids with no number sort last, by
		* title, so an imported row is still findable and the order never flickers.
		*/
		function relationCandidates(ideas, selfId, exclude = []) {
			const taken = /* @__PURE__ */ new Set([selfId, ...exclude]);
			return ideas.filter((idea) => !taken.has(idea.id)).map((idea) => ({
				id: idea.id,
				label: labelOf(idea, idea.id)
			})).sort((a, b) => a.label.localeCompare(b.label, void 0, { numeric: true }));
		}
		/**
		* Whether an edited list actually differs from the stored one. The editor sends
		* only what changed: an untouched relation must not spend a revision, a mirror
		* round trip and an activity-log line saying "Edited related ideas".
		*
		* Order is NOT a change. The ledger appends and re-points edges, so the same
		* set in a different order is the same statement — treating it as a change
		* would make every open-and-save rewrite a list nobody touched.
		*/
		function relationListChanged(next, previous) {
			const before = [...previous ?? []].sort();
			const after = [...next].sort();
			if (before.length !== after.length) return true;
			return after.some((id, index) => id !== before[index]);
		}
		/**
		* Add one target to a relation list, keeping the ledger's cap and refusing a
		* repeat. Returns the SAME array when nothing changed, so a React state that
		* holds the list does not re-render for a no-op.
		*/
		function withRelation(list, id, limit = 20) {
			if (id === "" || list.includes(id) || list.length >= limit) return [...list];
			return [...list, id];
		}
		/** Remove one target from a relation list (same identity rule as above). */
		function withoutRelation(list, id) {
			if (!list.includes(id)) return [...list];
			return list.filter((entry) => entry !== id);
		}
		//#endregion
		//#region src/client/relations-view.tsx
		/**
		* Relations on the board (idea #106): the React half.
		*
		* The pure rules live in `./relations.ts`; this file only paints. Two surfaces,
		* one module:
		*  - {@link RelationChips} is the compact, READ-ONLY line a card prints, under
		*    its description. It renders nothing at all for an idea that carries no
		*    relation — an absence is not a box — and it caps itself so a heavily
		*    linked card cannot push the board's DOM budget around.
		*  - {@link RelationsEditor} is the editor's Relations section: the two kinds a
		*    human states (`relates to`, `blocks`) are editable, and the third line
		*    (`blocked by`) is READ-ONLY on purpose.
		*
		* Why `blocked by` is not editable here: it is the derived inverse of an edge
		* stored on the OTHER idea, so "removing" it would mean editing a different
		* card. The editor says so instead of silently writing to a row the human never
		* opened — the same honesty the launch gate and the permission refusal use.
		*/
		/**
		* The arrow each kind prints. `blocks` points AT the idea it waits for and
		* `blockedBy` points back at the idea doing the waiting, so the two chips for
		* one edge are mirror images and the board's direction rule is legible on the
		* card itself rather than only in a tooltip.
		*/
		function relationGlyph(kind) {
			if (kind === "blocks") return "→";
			if (kind === "blockedBy") return "←";
			return "↔";
		}
		/** Tooltip naming what the chip means, so a glyph never reads as a verdict. */
		function relationHint(kind, label) {
			if (kind === "blocks") return t("relations.blocksHint", { target: label });
			if (kind === "blockedBy") return t("relations.blockedByHint", { target: label });
			return t("relations.relatesToHint", { target: label });
		}
		/**
		* The read-only relation line of a card: up to {@link CARD_RELATION_CHIP_LIMIT}
		* chips, then a counter. Returns null when there is nothing to say, so a card
		* without relations pays zero DOM nodes.
		*
		* The views are DERIVED ONCE per paint by the board (`relationIndexOf`) and
		* handed down: computing them per card would rebuild the row map and rescan the
		* whole board for every one of them.
		*/
		function RelationChips({ views }) {
			if (views === void 0 || views.length === 0) return null;
			const shown = views.slice(0, 3);
			const rest = views.length - shown.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: classes.cardMeta,
				"data-dsh-ideas-relations": "",
				children: [shown.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: classes.relationChip,
					"data-dsh-ideas-relation": view.kind,
					title: relationHint(view.kind, view.label),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.relationGlyph,
						"aria-hidden": "true",
						children: relationGlyph(view.kind)
					}), view.short]
				}, `${view.kind}:${view.id}`)), rest > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.relationMore,
					children: t("relations.more", { count: rest })
				})]
			});
		}
		/** One editable line: its label, its chips, and the picker that adds one. */
		function RelationLine({ label, list, ideas, ideaId, exclude, placeholder, disabled, onChange, removeTitle }) {
			const byId = new Map(ideas.map((item) => [item.id, item]));
			const candidates = relationCandidates(ideas, ideaId, [...list, ...exclude]);
			const labelFor = (id) => {
				const row = byId.get(id);
				return row === void 0 ? id : row.ideaNumber === void 0 ? row.title : `#${row.ideaNumber} ${row.title}`;
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.relationRow,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.fieldLabel,
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: classes.relationChips,
						children: [list.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: classes.relationChip,
							"data-dsh-ideas-relation-edit": id,
							children: [labelFor(id), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.relationRemove,
								disabled,
								title: removeTitle(labelFor(id)),
								onClick: () => {
									onChange(withoutRelation(list, id));
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: "×"
								})
							})]
						}, id)), list.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: classes.relationEmpty,
							children: t("relations.none")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						className: classes.select,
						value: "",
						disabled: disabled || candidates.length === 0 || list.length >= 20,
						"aria-label": placeholder,
						"data-dsh-ideas-relation-add": "",
						onChange: (event) => {
							const id = event.target.value;
							if (id === "") return;
							onChange(withRelation(list, id));
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "",
							children: candidates.length === 0 ? t("relations.nothingToAdd") : placeholder
						}), candidates.map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: candidate.id,
							children: candidate.label
						}, candidate.id))]
					})
				]
			});
		}
		/**
		* The editor's Relations section. State is owned by the caller (the idea modal)
		* and only the CHANGED lists are posted, so opening an editor and saving an
		* unrelated field never rewrites an edge.
		*/
		function RelationsEditor({ ideas, ideaId, relatesTo, blocks, disabled, onRelatesTo, onBlocks }) {
			const blockers = relationViews(ideas, ideaId).filter((view) => view.kind === "blockedBy");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.relations,
				"data-dsh-ideas-relations-editor": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.fieldLabel,
						children: t("relations.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.fieldHint,
						children: t("relations.hint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RelationLine, {
						label: t("relations.relatesTo"),
						list: relatesTo,
						ideas,
						ideaId,
						exclude: blocks,
						placeholder: t("relations.addRelated"),
						disabled,
						onChange: onRelatesTo,
						removeTitle: (target) => t("relations.removeRelated", { target })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RelationLine, {
						label: t("relations.blocks"),
						list: blocks,
						ideas,
						ideaId,
						exclude: relatesTo,
						placeholder: t("relations.addBlocked"),
						disabled,
						onChange: onBlocks,
						removeTitle: (target) => t("relations.removeBlocked", { target })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.relationRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: classes.fieldLabel,
							children: t("relations.blockedBy")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: classes.relationChips,
							"data-dsh-ideas-blocked-by": "",
							children: blockers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: classes.relationEmpty,
								children: t("relations.blockedByNone")
							}) : blockers.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: `${classes.relationChip} ${classes.relationChipLocked}`,
								"data-dsh-ideas-relation-locked": view.id,
								title: relationHint("blockedBy", view.label),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.relationGlyph,
									"aria-hidden": "true",
									children: relationGlyph("blockedBy")
								}), view.label]
							}, view.id))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.fieldHint,
						children: t("relations.blockedByExplained")
					})
				]
			});
		}
		//#endregion
		//#region src/client/bulk.ts
		/** Labels a card-bound, ARCHIVED idea needs the mirror round trip. */
		function needsMirrorRoundTrip(row) {
			return row.status === "archived" && row.taskBoardId !== void 0 && row.taskBoardId !== "";
		}
		/**
		* Wrap an update in the mirror round trip when the idea's card is archived.
		* The order matters: the card is read-only until the idea leaves the archive,
		* and the idea must go back to the archive right after the patch lands.
		*/
		function updateSteps(row, patch) {
			const update = {
				verb: "update",
				patch
			};
			if (!needsMirrorRoundTrip(row)) return {
				steps: [update],
				roundTrip: false
			};
			return {
				steps: [
					{ verb: "restore" },
					update,
					{
						verb: "move",
						status: "archived"
					}
				],
				roundTrip: true
			};
		}
		function planItem(row, steps, skipReason, roundTrip = false) {
			return {
				id: row.id,
				...row.ideaNumber === void 0 ? {} : { ideaNumber: row.ideaNumber },
				title: row.title,
				steps,
				...skipReason === void 0 ? {} : { skipReason },
				roundTrip
			};
		}
		/** The reason every label/workspace action reports for a declined idea: restoring
		*  it to patch its card would rewrite a decline into a plain archive. */
		const DECLINED_SKIP = "declined";
		/**
		* Bulk tag: add the given labels to every selected idea, keeping the labels it
		* already has (and each one's prompt line). An idea is SKIPPED rather than
		* silently truncated when the union would exceed the ledger's per-idea label
		* cap, because the Host would drop the overflow instead of refusing it.
		*/
		function planBulkTag(rows, names) {
			return rows.map((row) => {
				if (row.status === "declined") return planItem(row, [], DECLINED_SKIP);
				const existing = row.tags ?? [];
				const known = new Set(existing.map((tag) => tag.name));
				const additions = names.filter((tag) => !known.has(tag.name));
				if (additions.length === 0) return planItem(row, [], "already-tagged");
				if (existing.length + additions.length > 8) return planItem(row, [], "tag-limit");
				const { steps, roundTrip } = updateSteps(row, { tags: [...existing, ...additions] });
				return planItem(row, steps, void 0, roundTrip);
			});
		}
		/**
		* Bulk re-home: move every selected idea to `workspaceId` — the stable
		* workspace UUID, or '' for the generic (workspace-less) group. An idea already
		* there is reported as skipped: posting an identical patch would only spend a
		* revision and a mirror round trip on a no-op.
		*/
		function planBulkWorkspace(rows, workspaceId) {
			return rows.map((row) => {
				if (row.status === "declined") return planItem(row, [], DECLINED_SKIP);
				if ((row.workspaceId ?? "") === workspaceId) return planItem(row, [], "already-there");
				const { steps, roundTrip } = updateSteps(row, { workspaceId });
				return planItem(row, steps, void 0, roundTrip);
			});
		}
		/**
		* Bulk archive: the ordinary `move` to the Archived column for everything that
		* can legally go there. Declined ideas are skipped (archiving one would erase
		* the decline itself), already archived ones are skipped as no-ops.
		*/
		function planBulkArchive(rows) {
			return rows.map((row) => {
				if (row.status === "archived") return planItem(row, [], "already-archived");
				if (row.status === "declined") return planItem(row, [], DECLINED_SKIP);
				return planItem(row, [{
					verb: "move",
					status: "archived"
				}]);
			});
		}
		/** Undo a bulk archive: the reverse verb for exactly the ideas that went through. */
		function planBulkRestore(rows) {
			return rows.map((row) => planItem(row, [{ verb: "restore" }]));
		}
		/**
		* Validate the tag input of the bulk dialog. Over-long and blank names are
		* rejected BEFORE the run instead of being dropped by the ledger's own
		* normalization, which would leave a "tagged" batch that never got the label.
		*/
		function parseBulkTagNames(raw) {
			const names = [];
			const invalid = [];
			const seen = /* @__PURE__ */ new Set();
			for (const piece of raw.split(",")) {
				const name = piece.trim();
				if (name === "") continue;
				if (name.length > 32) {
					invalid.push(name);
					continue;
				}
				if (seen.has(name)) continue;
				seen.add(name);
				names.push({ name });
			}
			return {
				names,
				invalid
			};
		}
		/**
		* Execute a plan, one idea at a time, and never abort the batch: a refusal is
		* recorded against the idea that hit it and the run continues, because the whole
		* point of the report is to say which ones went through.
		*
		* A round-trip idea whose patch fails leaves the idea in the OPEN backlog (the
		* `restore` already landed). The runner therefore compensates with the same
		* archive verb and says so in the reason — a bulk tag must not be able to leave
		* an archived backlog open by accident.
		*/
		async function runBulkPlan(plan, run, onProgress) {
			const results = [];
			for (let index = 0; index < plan.length; index++) {
				const item = plan[index];
				if (item.steps.length === 0) {
					results.push({
						id: item.id,
						...item.ideaNumber === void 0 ? {} : { ideaNumber: item.ideaNumber },
						title: item.title,
						state: "skipped",
						reason: item.skipReason
					});
					onProgress?.(index + 1, plan.length);
					continue;
				}
				results.push(await runPlanItem(item, run));
				onProgress?.(index + 1, plan.length);
			}
			return results;
		}
		/** Run one item's verbs, settling the item the moment one of them refuses. */
		async function runPlanItem(item, run) {
			const identity = {
				id: item.id,
				...item.ideaNumber === void 0 ? {} : { ideaNumber: item.ideaNumber },
				title: item.title
			};
			for (let step = 0; step < item.steps.length; step++) try {
				await run(item.id, item.steps[step]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!item.roundTrip || step === 0) return {
					...identity,
					state: "failed",
					reason: message
				};
				const note = await rearchive(item.id, run);
				return {
					...identity,
					state: "failed",
					reason: message,
					note
				};
			}
			return {
				...identity,
				state: "applied"
			};
		}
		/**
		* Put a round-tripped idea back in the archive after a failed patch, so a bulk
		* tag can never leave an archived backlog open by accident. Returns which of the
		* two happened, so the report can say it in the reader's language.
		*/
		async function rearchive(ideaId, run) {
			try {
				await run(ideaId, {
					verb: "move",
					status: "archived"
				});
				return "rearchived";
			} catch {
				return "left-open";
			}
		}
		/** Split a finished run into the three per-idea buckets the report renders. */
		function summarizeBulk(operation, results) {
			return {
				operation,
				total: results.length,
				results: [...results],
				applied: results.filter((result) => result.state === "applied"),
				skipped: results.filter((result) => result.state === "skipped"),
				failed: results.filter((result) => result.state === "failed"),
				reversible: operation === "archive",
				undone: false
			};
		}
		/** Mark a report as undone (the bulk archive restored) without touching counts. */
		function markBulkUndone(report) {
			return {
				...report,
				undone: true
			};
		}
		/**
		* The ids a bulk archive's undo restores: exactly the ideas the run really
		* archived. Skipped and failed ones are deliberately excluded — restoring an
		* idea that never moved would silently resurrect an unrelated row.
		*/
		function undoableIds(report) {
			return report.reversible && !report.undone ? report.applied.map((result) => result.id) : [];
		}
		//#endregion
		//#region src/client/bulk-bar.tsx
		/**
		* Multi-select and bulk actions on the board (idea #94): the per-row select
		* box, the selection bar, and the bulk dialog that runs a batch and reports it
		* idea by idea.
		*
		* The three components here are deliberately thin. Every rule — what may be
		* selected, which verbs a batch posts, what a skip or a failure means — lives in
		* the pure modules `selection.ts` and `bulk.ts`, so this file only renders them
		* and posts the ordinary per-idea verbs through `IdeasClient`. There is no
		* bulk-only verb and no ledger write anywhere on this path.
		*
		* The bar always states what "all" means: how many are selected, how many the
		* current filter shows, and which workspace / tags / search produced that set.
		* That sentence is the difference between "everything" (what the user sees) and
		* "everything" (what the batch would touch).
		*/
		/**
		* Per-row select box. A real button with `role="checkbox"` (keyboard reachable
		* and announced), stopping propagation so picking a row never opens the editor
		* underneath it, and honouring shift-click for a range.
		*
		* The tick is drawn by a CSS pseudo-element, NOT by a child span: this control
		* renders on EVERY card of every view, and at 140 cards a second node per card
		* is ~140 extra DOM nodes on every re-render of the board (the search
		* keystroke and the workspace scoping both re-render all of them). One node per
		* row is the whole budget this affordance spends.
		*/
		function SelectBox({ checked, onToggle, label }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				role: "checkbox",
				"aria-checked": checked,
				"aria-label": label,
				title: label,
				className: checked ? classes.selectBoxChecked : classes.selectBox,
				"data-dsh-ideas-select": "",
				onClick: (event) => {
					event.preventDefault();
					event.stopPropagation();
					onToggle(event.shiftKey);
				}
			});
		}
		/** The selection bar: the count, the scope sentence and the three bulk actions. */
		function SelectionBar({ selectedCount, scopeTotal, scopeLabel, wholeScope, busy, onSelectAll, onClear, onTag, onWorkspace, onArchive }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.selectionBar,
				"data-dsh-ideas-selection-bar": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: wholeScope ? classes.ghostButton : classes.actionButton,
						"aria-pressed": wholeScope,
						"data-dsh-ideas-select-all": "",
						disabled: scopeTotal === 0 || busy,
						onClick: onSelectAll,
						children: wholeScope ? t("bulk.bar.clearSelection") : t("bulk.bar.selectAll")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.selectionCount,
						"data-dsh-ideas-selection-count": "",
						children: t("bulk.bar.count", {
							selected: selectedCount,
							total: scopeTotal
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.selectionScope,
						children: scopeLabel
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.selectionActions,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.actionButton,
								disabled: selectedCount === 0 || busy,
								title: t("bulk.bar.tagHint"),
								"data-dsh-ideas-bulk-tag": "",
								onClick: onTag,
								children: t("bulk.bar.tag")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.actionButton,
								disabled: selectedCount === 0 || busy,
								title: t("bulk.bar.workspaceHint"),
								"data-dsh-ideas-bulk-workspace": "",
								onClick: onWorkspace,
								children: t("bulk.bar.workspace")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.actionButton,
								disabled: selectedCount === 0 || busy,
								title: t("bulk.bar.archiveHint"),
								"data-dsh-ideas-bulk-archive": "",
								onClick: onArchive,
								children: t("bulk.bar.archive")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.ghostButton,
								disabled: selectedCount === 0 || busy,
								"data-dsh-ideas-selection-clear": "",
								onClick: onClear,
								children: t("bulk.bar.clear")
							})
						]
					})
				]
			});
		}
		/** Localized sentence for a skip code; a Host refusal prints its own message. */
		const REASON_KEYS = {
			declined: "bulk.reason.declined",
			"already-tagged": "bulk.reason.alreadyTagged",
			"tag-limit": "bulk.reason.tagLimit",
			"already-there": "bulk.reason.alreadyThere",
			"already-archived": "bulk.reason.alreadyArchived"
		};
		/** Per-state class of a report line (applied / skipped / failed). */
		function stateClass(state) {
			if (state === "applied") return classes.bulkItemApplied;
			if (state === "skipped") return classes.bulkItemSkipped;
			return classes.bulkItemFailed;
		}
		/** The report line of one idea: its ledger number, its title and why. */
		function ResultLine({ result }) {
			const known = typeof result.reason === "string" && result.reason in REASON_KEYS ? REASON_KEYS[result.reason] : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `${classes.bulkItem} ${stateClass(result.state)}`,
				"data-dsh-ideas-bulk-item": result.state,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: classes.bulkItemTitle,
						children: [result.ideaNumber !== void 0 ? `#${result.ideaNumber} — ` : "", result.title]
					}),
					result.reason !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.bulkItemReason,
						children: known === void 0 ? result.reason : t(known)
					}),
					result.note !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.bulkItemNote,
						children: result.note === "rearchived" ? t("bulk.note.rearchived") : t("bulk.note.leftOpen")
					})
				]
			});
		}
		/** One bucket of the report ("Failed (3)"), with its per-idea lines. */
		function ResultGroup({ title, bucket, results }) {
			if (results.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.field,
				"data-dsh-ideas-bulk-group": bucket,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.fieldLabel,
					children: t(title, { count: results.length })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: classes.bulkItems,
					children: results.map((result) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultLine, { result }, result.id))
				})]
			});
		}
		/** Post one planned verb through the ordinary per-idea client methods. */
		function stepRunner(client) {
			return async (ideaId, step) => {
				if (step.verb === "restore") await client.restoreIdea(ideaId);
				else if (step.verb === "move") await client.moveIdea(ideaId, step.status);
				else await client.updateIdea(ideaId, step.patch);
			};
		}
		/**
		* The bulk dialog: confirm -> run -> report, in one modal so the batch keeps the
		* author's attention until it is settled. Every verb goes through `IdeasClient`;
		* a refusal is recorded against the idea that hit it and the batch continues,
		* because the report owes a per-idea answer rather than a single error line.
		*/
		function BulkDialog({ client, operation, rows, catalog, scopeLabel, onClose }) {
			const [tagInput, setTagInput] = (0, react.useState)("");
			const [targetWorkspace, setTargetWorkspace] = (0, react.useState)(NO_WORKSPACE_FILTER);
			const [running, setRunning] = (0, react.useState)(false);
			const [done, setDone] = (0, react.useState)(0);
			const [report, setReport] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape" && !running) {
						event.stopPropagation();
						onClose();
					}
				};
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
				};
			}, [onClose, running]);
			const parsed = parseBulkTagNames(tagInput);
			const valid = operation !== "tag" || parsed.names.length > 0 && parsed.invalid.length === 0;
			const apply = (0, react.useCallback)(async () => {
				const plan = operation === "tag" ? planBulkTag(rows, parsed.names) : operation === "workspace" ? planBulkWorkspace(rows, targetWorkspace === "__no-workspace__" ? "" : targetWorkspace) : planBulkArchive(rows);
				setRunning(true);
				setDone(0);
				try {
					const results = await runBulkPlan(plan, stepRunner(client), (settled) => {
						setDone(settled);
					});
					setReport(summarizeBulk(operation, results));
				} finally {
					setRunning(false);
				}
			}, [
				client,
				operation,
				parsed.names,
				rows,
				targetWorkspace
			]);
			/** Undo the bulk archive: restore exactly the ideas the run archived. */
			const undo = (0, react.useCallback)(async (current) => {
				const ids = new Set(undoableIds(current));
				const plan = planBulkRestore(rows.filter((row) => ids.has(row.id)));
				setRunning(true);
				setDone(0);
				try {
					const results = await runBulkPlan(plan, stepRunner(client), (settled) => {
						setDone(settled);
					});
					setReport(markBulkUndone(summarizeBulk("archive", results)));
				} finally {
					setRunning(false);
				}
			}, [client, rows]);
			const submit = (event) => {
				event.preventDefault();
				if (!valid || running) return;
				apply();
			};
			const title = report === void 0 ? `bulk.${operation}.title` : report.undone ? "bulk.undoReport" : "bulk.report.title";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.overlay,
				onClick: () => {
					if (!running) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: classes.modal,
					onClick: (event) => {
						event.stopPropagation();
					},
					"data-dsh-ideas-bulk-dialog": operation,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: classes.modalTitle,
							children: t(title, { count: report?.total ?? rows.length })
						}),
						report === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classes.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.detailMeta,
									"data-dsh-ideas-bulk-batch": "",
									children: t("bulk.batch.count", { count: rows.length })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.fieldHint,
									"data-dsh-ideas-bulk-scope": "",
									children: scopeLabel
								})]
							}),
							operation === "tag" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classes.field,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: classes.fieldLabel,
										htmlFor: "dsh-ideas-bulk-tags",
										children: t("bulk.tag.label")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "dsh-ideas-bulk-tags",
										className: classes.input,
										type: "text",
										value: tagInput,
										placeholder: t("bulk.tag.placeholder"),
										disabled: running,
										onChange: (event) => {
											setTagInput(event.target.value);
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: classes.fieldHint,
										children: t("bulk.tag.hint")
									}),
									parsed.invalid.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: classes.bulkWarning,
										"data-dsh-ideas-bulk-invalid": "",
										children: t("bulk.tag.invalid", { tags: parsed.invalid.join(", ") })
									})
								]
							}),
							operation === "workspace" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classes.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: classes.fieldLabel,
									htmlFor: "dsh-ideas-bulk-workspace",
									children: t("bulk.workspace.label")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									id: "dsh-ideas-bulk-workspace",
									className: classes.select,
									value: targetWorkspace,
									disabled: running,
									onChange: (event) => {
										setTargetWorkspace(event.target.value);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "__no-workspace__",
										children: t("bulk.workspace.none")
									}), catalog.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: entry.workspaceId,
										children: [entry.title, entry.knownToApp ? "" : ` (${entry.workspaceId})`]
									}, entry.workspaceId))]
								})]
							}),
							operation === "archive" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.field,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									children: t("bulk.archive.hint")
								})
							}),
							(operation === "tag" || operation === "workspace") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.field,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									children: t("bulk.roundTrip")
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classes.modalActions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.ghostButton,
									disabled: running,
									onClick: onClose,
									children: t("bulk.cancel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.primaryButton,
									disabled: running || !valid,
									"data-dsh-ideas-bulk-submit": "",
									onClick: submit,
									children: t("bulk.submit")
								})]
							})
						] }),
						report !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.field,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.bulkSummary,
									"data-dsh-ideas-bulk-summary": "",
									children: t("bulk.report.summary", {
										applied: report.applied.length,
										skipped: report.skipped.length,
										failed: report.failed.length
									})
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultGroup, {
								title: "bulk.report.applied",
								bucket: "applied",
								results: report.applied
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultGroup, {
								title: "bulk.report.skipped",
								bucket: "skipped",
								results: report.skipped
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultGroup, {
								title: "bulk.report.failed",
								bucket: "failed",
								results: report.failed
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.field,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									"data-dsh-ideas-bulk-undo-note": "",
									children: report.reversible && !report.undone ? t("bulk.undoHint") : report.undone ? t("bulk.undoDone", { count: report.applied.length }) : t("bulk.noUndo")
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classes.modalActions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.ghostButton,
									disabled: running,
									onClick: onClose,
									children: t("bulk.close")
								}), report.reversible && !report.undone && report.applied.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.primaryButton,
									disabled: running,
									"data-dsh-ideas-bulk-undo": "",
									onClick: () => {
										undo(report);
									},
									children: t("bulk.undo", { count: report.applied.length })
								})]
							})
						] }),
						running && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.bulkProgress,
							"data-dsh-ideas-bulk-progress": "",
							children: t("bulk.running", {
								done,
								total: report?.total ?? rows.length
							})
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/priorities-view.tsx
		/**
		* Priorities view: the suggested ranking of the open backlog — the current
		* best ordering of the open ideas. Each open idea is one ranked row (rank,
		* title, workspace chip, run-state tags, value/effort, description preview,
		* rationale) with move-up/move-down actions and drag & drop reordering of the
		* open column. During a drag an accent line shows the insertion point: before
		* the hovered row (upper half) or after it (lower half); dropping on the list
		* surface below the rows appends at the end of the dragged idea's workspace
		* group.
		*
		* The run-state tags (idea #71) are the shared RunStateBadges of the Overview
		* card header: an idea in flight or in failure says so on its row, which is
		* where the "what do I pick next" decision is actually made. They are
		* last-observation facts written by the host poll, never by an idea verb, and
		* they never move a row — the ranking below stays the human order.
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
		function PrioritiesView({ client, openIdeas, allIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, grouped, parentNumber, staleAfterDays = 0, now = Date.now(), selectedIds, onSelect, relations }) {
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
										onSelect !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectBox, {
											checked: selectedIds?.has(idea.id) === true,
											label: t("bulk.select"),
											onToggle: (shiftKey) => {
												onSelect(idea.id, shiftKey);
											}
										}),
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
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaTitle, {
														ideaNumber: idea.ideaNumber,
														title: idea.title
													})
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
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaPreview, {
													excerpt: idea.bodyExcerpt,
													mdMode,
													onEdit: () => {
														onEdit(idea);
													}
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RelationChips, { views: relations?.get(idea.id) }),
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
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: classes.rowState,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RunStateBadges, {
												idea,
												client,
												parentNumber,
												showDelivered: false,
												staleAfterDays,
												now
											})
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
		//#region src/client/delivery-note.tsx
		/**
		* The delivery note of a finished run, or nothing at all.
		*
		* Renders only for a run that actually finished (`runStatus === 'done'`): a
		* running idea has no conclusion yet, and a failed one has no delivery to
		* describe — the *Task failed* badge already owns that story.
		*/
		function DeliveryNote({ idea }) {
			if (idea.runStatus !== "done") return null;
			const note = idea.deliveryNote?.trim();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.deliveryNote,
				"data-dsh-ideas-delivery-note": "",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.deliveryNoteLabel,
					children: t("card.deliveryNote")
				}), note !== void 0 && note !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.deliveryNoteText,
					children: note
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.deliveryNoteEmpty,
					children: t("card.deliveryNoteEmpty")
				})]
			});
		}
		//#endregion
		//#region src/client/delivered-view.tsx
		/** Most recent exit first (deliveredAt for delivered, archivedAt otherwise). */
		function mostRecentFirst(ideas) {
			return [...ideas].sort((a, b) => exitAt(b) - exitAt(a));
		}
		/**
		* The Delivered log's display order, exported so the board's multi-select
		* (idea #94) ranges over exactly the rows this view paints: a shift-click
		* block must be the block the author sees, in the order they see it.
		*/
		function deliveredRows(ideas) {
			return mostRecentFirst(ideas);
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
		function DeliveredView({ client, archivedIdeas, workspaceTitle, onEdit, onToggleTag, activeTags, mdMode, parentNumber, selectedIds, onSelect, relations }) {
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
								onSelect !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectBox, {
									checked: selectedIds?.has(idea.id) === true,
									label: t("bulk.select"),
									onToggle: (shiftKey) => {
										onSelect(idea.id, shiftKey);
									}
								}),
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
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaTitle, {
												ideaNumber: idea.ideaNumber,
												title: idea.title
											})
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
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaPreview, {
											excerpt: idea.bodyExcerpt,
											mdMode,
											onEdit: () => {
												onEdit(idea);
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RelationChips, { views: relations?.get(idea.id) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeliveryNote, { idea })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.rowState,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RunStateBadges, {
										idea,
										client,
										parentNumber,
										showDelivered: false
									})
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
		//#region src/client/health-view.tsx
		/** The scope key the panel uses: `''` = all, `''` = generic, or a real id. */
		function wireScopeOf(scopeWorkspaceId) {
			return scopeWorkspaceId === "" ? void 0 : scopeWorkspaceId === "__no-workspace__" ? "" : scopeWorkspaceId;
		}
		/** "October 2026" for the month the window actually measured, in the UI locale. */
		function monthLabelOf(at) {
			const formatted = new Date(at).toLocaleDateString(void 0, {
				year: "numeric",
				month: "long"
			});
			return formatted === "" ? String(new Date(at).getMonth() + 1) : formatted;
		}
		function durationUnitLabel(unit) {
			return unit === "days" ? t("health.unitDays") : unit === "hours" ? t("health.unitHours") : t("health.unitMinutes");
		}
		/** The five questions, one figure each. */
		function Figure({ label, value, hint, tone }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `${classes.healthFigure}${tone === "warn" ? ` ${classes.healthFigureWarn}` : ""}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.healthFigureLabel,
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.healthFigureValue,
						children: value
					}),
					hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.healthFigureHint,
						children: hint
					})
				]
			});
		}
		function HealthView({ client, scopeWorkspaceId, workspaceTitle, boardRevision }) {
			const stats = client.stats;
			const scope = wireScopeOf(scopeWorkspaceId);
			const current = stats !== void 0 && client.statsScope === scope ? stats : void 0;
			if (!client.statsAvailable) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.health,
				"data-dsh-ideas-health": "",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: classes.healthNote,
					role: "status",
					children: t("health.unavailable")
				})
			});
			if (current === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.health,
				"data-dsh-ideas-health": "",
				children: client.statsError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: classes.healthNote,
					role: "status",
					children: [
						t("health.error", { error: client.statsError }),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: classes.ghostButton,
							onClick: () => {
								client.loadStats(scope);
							},
							children: t("health.retry")
						})
					]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: classes.healthNote,
					role: "status",
					children: t("health.loading")
				})
			});
			const delivery = current.delivery;
			const median = delivery.medianMs === null ? null : durationParts(delivery.medianMs);
			const month = monthLabelOf(current.window.start);
			const stale = boardRevision !== void 0 && current.revision !== boardRevision;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.health,
				"data-dsh-ideas-health": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.healthHint,
						children: t("health.hint", { scope: current.scope.kind === "workspace" ? workspaceTitle(current.scope.workspaceId ?? "") : t(current.scope.kind === "generic" ? "health.scopeGeneric" : "health.scopeAll") })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.healthFigures,
						"data-dsh-ideas-health-figures": "",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Figure, {
								label: t("health.openTitle"),
								value: t("health.openValue", {
									open: current.openTotal,
									total: current.scope.ideas
								}),
								hint: t("health.openHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Figure, {
								label: t("health.deliveredTitle"),
								value: t("health.deliveredValue", { count: current.deliveredInWindow }),
								hint: t("health.deliveredWindow", { month })
							}),
							median === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Figure, {
								label: t("health.medianTitle"),
								value: t("health.medianThin", {
									count: delivery.sample,
									min: delivery.minSamples
								}),
								hint: t("health.medianThinHint"),
								tone: "warn"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Figure, {
								label: t("health.medianTitle"),
								value: t("health.medianValue", {
									value: median.value,
									unit: durationUnitLabel(median.unit)
								}),
								hint: t("health.medianHint", { count: delivery.sample })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Figure, {
								label: t("health.triageTitle"),
								value: t("health.triageValue", { count: current.triage.missingRank + current.triage.missingValue }),
								hint: t("health.triageHint")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.healthNote,
						"data-dsh-ideas-health-delivery": "",
						children: [
							delivery.withoutStamp > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("health.withoutStamp", { count: delivery.withoutStamp }) }),
							delivery.inconsistent > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("health.inconsistent", { count: delivery.inconsistent }) }),
							delivery.withoutStamp === 0 && delivery.inconsistent === 0 && delivery.sample === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("health.noDeliveries") })
						]
					}),
					stale && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.healthNote,
						role: "status",
						"data-dsh-ideas-health-stale": client.statsError !== void 0 ? "failed" : "",
						children: client.statsError !== void 0 ? t("health.staleError", {
							revision: current.revision,
							error: client.statsError
						}) : t(client.statsPending ? "health.refreshing" : "health.stale", { revision: current.revision })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: classes.healthSection,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: classes.healthSectionTitle,
								children: t("health.workspacesTitle")
							}),
							current.openByWorkspace.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.empty,
								children: t("health.workspacesEmpty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: classes.healthList,
								children: current.openByWorkspace.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: classes.healthRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: classes.healthRowName,
										children: row.workspaceId === void 0 ? t("board.noWorkspace") : workspaceTitle(row.workspaceId)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: classes.healthRowValue,
										children: t("health.workspaceRow", {
											open: row.open,
											total: row.total
										})
									})]
								}, row.workspaceId ?? ""))
							}),
							current.workspacesTotal > current.openByWorkspace.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.healthMore,
								children: t("health.moreWorkspaces", { count: current.workspacesTotal - current.openByWorkspace.length })
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: classes.healthSection,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: classes.healthSectionTitle,
								children: t("health.tagsTitle")
							}),
							current.topTags.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.empty,
								children: t("health.tagsEmpty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: classes.healthTags,
								children: current.topTags.map((tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: classes.tag,
									style: { "--dsh-ideas-tag-hue": tagHue(tag.name) },
									children: [tag.name, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: classes.healthTagCount,
										children: tag.count
									})]
								}, tag.name))
							}),
							current.tagsTotal > current.topTags.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.healthMore,
								children: t("health.moreTags", { count: current.tagsTotal - current.topTags.length })
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: classes.healthSection,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: classes.healthSectionTitle,
							children: t("health.triageDetailTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
							className: classes.healthList,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: classes.healthRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.healthRowName,
									children: t("health.missingRank")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.healthRowValue,
									children: current.triage.missingRank
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: classes.healthRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.healthRowName,
									children: t("health.missingValue")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.healthRowValue,
									children: current.triage.missingValue
								})]
							})]
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/activity-timeline.tsx
		/** How one actor label reads in the UI. */
		function actorLabel(actor) {
			if (actor === "human") return t("activity.human");
			if (actor === "run") return t("activity.run");
			return actor.startsWith("agent:") ? actor.slice(6) : actor;
		}
		/** One entry: when, who, what. Rendered chronologically, oldest first. */
		function ActivityRow({ entry }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: classes.activityRow,
				"data-dsh-ideas-activity-row": "",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: classes.activityWhen,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("time", {
							dateTime: new Date(entry.at).toISOString(),
							children: shortDate(entry.at)
						}),
						" · ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: classes.activityActor,
							children: actorLabel(entry.actor)
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.activitySummary,
					children: entry.summary
				})]
			});
		}
		/**
		* The recorded life of an idea, or nothing at all.
		*
		* Renders only when the ledger actually holds entries: an idea that has never
		* been touched since the log landed simply has none, and silence is the honest
		* reading.
		*/
		function ActivityTimeline({ idea }) {
			const events = idea.events;
			if (events === void 0 || events.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: classes.activity,
				"data-dsh-ideas-activity": "",
				title: t("activity.hint"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.activityLabel,
					children: t("activity.label", { count: events.length })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
					className: classes.activityList,
					style: { maxHeight: "9.5em" },
					children: events.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActivityRow, { entry }, `${entry.at}-${index}`))
				})]
			});
		}
		/** Compact day/month stamp, the same one every other date on the board uses. */
		function shortDate(epoch) {
			return new Date(epoch).toLocaleDateString(void 0, {
				day: "numeric",
				month: "short"
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
			"delivered",
			"health"
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
		//#region src/client/column-widths.ts
		/**
		* Per-column kanban width persistence (idea #53): the user's individual column
		* widths survive reloads through a storage pair (localStorage on the page, an
		* injectable seam in tests). The map is keyed by idea status and holds pixel
		* widths; anything wrong on the way back — unknown key, non-numeric value,
		* out-of-range number — is dropped so a corrupt entry can never break layout.
		* The board clamps each width against the current [min, max] bounds at render
		* time, so this module only needs to keep the stored values sane.
		*/
		/** Storage key of the persisted per-column widths. */
		const COLUMN_WIDTHS_STORAGE_KEY = "dsh.ideas.columnWidths";
		function isFiniteNumber(value) {
			return typeof value === "number" && Number.isFinite(value);
		}
		/** Read + validate the persisted widths; any hiccup falls back to an empty map. */
		function readColumnWidths(storage) {
			if (storage === void 0) return {};
			let raw = null;
			try {
				raw = storage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
			} catch {
				return {};
			}
			if (raw === null || raw === "") return {};
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return {};
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const widths = {};
			for (const status of IDEA_COLUMNS) {
				const value = parsed[status];
				if (isFiniteNumber(value) && value >= 80 && value <= 2e3) widths[status] = Math.round(value);
			}
			return widths;
		}
		/** Persist the widths; storage failures are ignored (never throw). */
		function writeColumnWidths(storage, widths) {
			if (storage === void 0) return;
			const clean = {};
			for (const status of IDEA_COLUMNS) {
				const value = widths[status];
				if (isFiniteNumber(value)) clean[status] = Math.round(value);
			}
			try {
				storage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(clean));
			} catch {}
		}
		/** Clamp a pixel width into [lo, hi]; unordered bounds are normalized here. */
		function clampColumnWidth(width, lo, hi) {
			const floor = Math.min(lo, hi);
			const ceil = Math.max(lo, hi);
			if (!Number.isFinite(width)) return floor;
			return Math.round(Math.min(ceil, Math.max(floor, width)));
		}
		//#endregion
		//#region src/client/selection.ts
		/** The neutral selection: nothing selected, no anchor. */
		const EMPTY_SELECTION = {
			ids: [],
			anchor: void 0
		};
		/** True when this idea is part of the selection. */
		function isSelected(selection, ideaId) {
			return selection.ids.includes(ideaId);
		}
		/** True when the whole scope is selected (the "select everything" affordance). */
		function isWholeScopeSelected(selection, scopeIds) {
			return scopeIds.length > 0 && scopeIds.every((id) => selection.ids.includes(id));
		}
		/**
		* Click: add the row when it is not selected, remove it when it is. An id
		* outside the scope is refused rather than silently selected (the board only
		* ever passes scoped ids, so this is the guard that keeps the rule true even if
		* a stale click arrives after the filter moved). The clicked row always becomes
		* the anchor.
		*/
		function toggleSelection(selection, ideaId, scopeIds) {
			if (!scopeIds.includes(ideaId)) return selection;
			return {
				ids: selection.ids.includes(ideaId) ? selection.ids.filter((id) => id !== ideaId) : [...selection.ids, ideaId],
				anchor: ideaId
			};
		}
		/**
		* Shift-click: select the block of scope rows between the anchor and the
		* clicked row, inclusive, in display order. The range is **added** to whatever
		* was already selected (the usual multi-select behaviour: two shift-clicks
		* paint two blocks), and the clicked row becomes the new anchor so a further
		* shift-click re-grows from it. Without an anchor, or when the anchor left the
		* scope, the click degrades to a plain toggle.
		*/
		function extendSelection(selection, ideaId, scopeIds) {
			const anchor = selection.anchor;
			if (anchor === void 0 || !scopeIds.includes(anchor) || !scopeIds.includes(ideaId)) return toggleSelection(selection, ideaId, scopeIds);
			const from = scopeIds.indexOf(anchor);
			const to = scopeIds.indexOf(ideaId);
			const [start, end] = from <= to ? [from, to] : [to, from];
			const range = scopeIds.slice(start, end + 1);
			return {
				ids: [...selection.ids, ...range.filter((id) => !selection.ids.includes(id))],
				anchor: ideaId
			};
		}
		/** "Select everything in the current filter": exactly the scope, in scope order. */
		function selectAll(scopeIds) {
			return {
				ids: [...scopeIds],
				anchor: scopeIds[scopeIds.length - 1]
			};
		}
		/**
		* Re-bind the selection to a scope that moved (a typed search, a toggled tag, a
		* changed workspace selector, a tab switch, a poll that brought in a new idea).
		* Ids that left the scope are dropped, order is preserved and the anchor
		* survives only while it is still selected-visible — so a bulk action can never
		* fire on an idea the current filter hides.
		*/
		function pruneSelection(selection, scopeIds) {
			if (selection.ids.length === 0) return selection;
			const inside = new Set(scopeIds);
			const ids = selection.ids.filter((id) => inside.has(id));
			if (ids.length === selection.ids.length) return selection;
			return {
				ids,
				anchor: selection.anchor !== void 0 && inside.has(selection.anchor) ? selection.anchor : void 0
			};
		}
		/** The selected rows of a scope, in scope order (what a bulk action operates on). */
		function selectedRows(scopeRows, selection) {
			const chosen = new Set(selection.ids);
			return scopeRows.filter((row) => chosen.has(row.id));
		}
		/** One line of card text, in px (12-13px font at the board's line height). */
		const LINE_PX = 17;
		/**
		* Fixed vertical parts of a card: padding, the header row, the updated stamp
		* and the action buttons. Only the WRAPPING rows vary with content, so the
		* estimate is `chrome + wrapping lines`.
		*/
		const CHROME_PX = 116;
		/** Characters per rendered line at the default column width (~300 px). */
		const DEFAULT_CHARS_PER_LINE = 34;
		/** Average px per character at the board's font, used to fit the line budget. */
		const PX_PER_CHAR = 7.2;
		/** Clamp bounds for a width-derived line budget (a 240 px column is ~33 chars). */
		const MIN_CHARS_PER_LINE = 18;
		const MAX_CHARS_PER_LINE = 90;
		/** Number of lines `text` needs at `charsPerLine` characters per line. */
		function linesOf(text, charsPerLine) {
			if (text <= 0) return 0;
			return Math.max(1, Math.ceil(text / Math.max(1, charsPerLine)));
		}
		/**
		* First-paint card height, a pure function of the row.
		*
		* It is an ESTIMATE and it is allowed to be wrong by a few pixels per row —
		* `IdeaWindow.measure` corrects it against the real DOM. What it must never do
		* is be non-deterministic or unbounded, because the scrollbar height and every
		* row offset below depend on it before anything has been measured.
		*
		* The counted parts are exactly the rows that wrap: the title (with its `#N`
		* prefix), the workspace/tag line, the clamped description, the relation chips,
		* the delivery note of a finished run and the value/effort badges.
		*/
		function estimateIdeaCardHeight(row, charsPerLine = DEFAULT_CHARS_PER_LINE) {
			const perLine = clampNumber(Math.round(charsPerLine), MIN_CHARS_PER_LINE, MAX_CHARS_PER_LINE);
			const numberPrefix = row.ideaNumber === void 0 ? 0 : String(row.ideaNumber).length + 3;
			let lines = linesOf((row.title ?? "").length + numberPrefix, perLine);
			const metaChars = (row.workspaceId === void 0 ? 0 : row.workspaceId.length + 2) + (row.tags ?? []).reduce((sum, tag) => sum + tag.name.length + 3, 0);
			if (metaChars > 0) lines += linesOf(metaChars, perLine);
			if ((row.bodyExcerpt ?? "").trim() !== "") lines += Math.min(3, linesOf((row.bodyExcerpt ?? "").length, perLine * 2));
			if ((row.relatesTo ?? []).length > 0 || (row.blocks ?? []).length > 0) lines += 1;
			if (row.status === "underReview" && (row.deliveryNote ?? "") !== "") lines += 2;
			if (row.value !== void 0 || row.effort !== void 0) lines += 1;
			return CHROME_PX + lines * LINE_PX;
		}
		/**
		* Characters that fit one line at `width` px. Returns the default rather than a
		* degenerate budget for a width a DOM never laid out (0 in jsdom, and the same
		* on a hidden column), so an unmeasurable column estimates like a real one
		* instead of like a 18-character sliver.
		*/
		function charsPerLineFor(width) {
			if (!(width > 0)) return DEFAULT_CHARS_PER_LINE;
			return Math.max(MIN_CHARS_PER_LINE, Math.min(MAX_CHARS_PER_LINE, Math.round(width / PX_PER_CHAR)));
		}
		/**
		* The scroll geometry of one column: a size cache, prefix-sum offsets and the
		* window to paint.
		*
		* One instance per column, fed the column's FULL display order. That last part
		* is the contract the drag anchor and the multi-select both rely on: the window
		* decides what is painted, never what the column contains.
		*/
		var IdeaWindow = class {
			/** Rows painted above and below the viewport. */
			overscan;
			/** Characters per line the estimates are built on. */
			charsPerLine;
			rows = [];
			indexById = /* @__PURE__ */ new Map();
			measuredById = /* @__PURE__ */ new Map();
			/** Slot size per row (row + inter-card gap). */
			slots = [];
			/** Offset of each row inside the list; `offsets[n]` is the total height. */
			offsets = [0];
			geometryDirty = true;
			constructor(rows = [], options = {}) {
				this.overscan = Math.max(0, options.overscan ?? 6);
				this.charsPerLine = clampNumber(Math.round(options.charsPerLine ?? DEFAULT_CHARS_PER_LINE), MIN_CHARS_PER_LINE, MAX_CHARS_PER_LINE);
				this.setRows(rows);
			}
			/** The full column, in display order — what a drop anchor may name. */
			get length() {
				return this.rows.length;
			}
			/** Scrollable height of the whole column, in px. */
			get totalHeight() {
				this.ensureGeometry();
				return this.offsets[this.rows.length];
			}
			/** Replace the column content, keeping the cache honest. */
			setRows(rows) {
				this.rows = rows;
				this.indexById = new Map(rows.map((row, index) => [row.id, index]));
				for (const id of [...this.measuredById.keys()]) if (!this.indexById.has(id)) this.measuredById.delete(id);
				this.geometryDirty = true;
			}
			/** Position of a row in the column, or -1 when it is not in it. */
			indexOf(id) {
				return this.indexById.get(id) ?? -1;
			}
			/** The row at `index`, or undefined past the end. */
			rowAt(index) {
				return this.rows[index];
			}
			/** Top of a row's slot in px (clamped to the list). */
			offsetOf(index) {
				this.ensureGeometry();
				if (index <= 0) return 0;
				return this.offsets[Math.min(index, this.rows.length)];
			}
			/** Effective height of a row: the measured one, else the estimate. */
			heightOf(id) {
				const index = this.indexById.get(id);
				if (index === void 0) return 0;
				return this.slotSize(index) - 8;
			}
			/**
			* Record a real measured height.
			*
			* `anchorIndex` is the row the reader is looking at (the first painted one):
			* every size change ABOVE it moved the list under the pointer, so the return
			* value is that movement in px and the caller adds it to `scrollTop`. Changes
			* at or below the anchor move nothing that is visible, which is why the
			* delta is 0 for them.
			*
			* @returns px to add to `scrollTop`, or 0 when nothing moved.
			*/
			measure(id, height, anchorIndex) {
				const index = this.indexById.get(id);
				if (index === void 0 || !(height > 0)) return 0;
				this.ensureGeometry();
				const anchor = Math.max(0, Math.min(anchorIndex, this.rows.length));
				const before = this.offsets[anchor];
				const current = this.slotSize(index);
				const next = Math.round(height) + 8;
				if (Math.abs(next - current) < 1) return 0;
				this.measuredById.set(id, Math.round(height));
				this.geometryDirty = true;
				this.ensureGeometry();
				return this.offsets[anchor] - before;
			}
			/**
			* The rows to paint for a viewport starting at `scrollTop`.
			*
			* `viewport <= 0` answers with the WHOLE column: an unmeasurable viewport
			* cannot be windowed honestly, and painting everything is the one answer that
			* is never wrong.
			*/
			window(scrollTop, viewport) {
				const n = this.rows.length;
				if (n === 0) return {
					start: 0,
					end: 0
				};
				if (!(viewport > 0)) return {
					start: 0,
					end: n
				};
				this.ensureGeometry();
				const top = Math.max(0, scrollTop);
				const bottom = top + viewport;
				let start = this.firstIndexAfter(top);
				let end = start;
				while (end < n && this.offsets[end] < bottom) end += 1;
				if (end < n) end += 1;
				start = Math.max(0, start - this.overscan);
				end = Math.min(n, end + this.overscan);
				return {
					start,
					end: Math.max(start, end)
				};
			}
			/** The rows of `range`, each with the top its slot sits at. */
			entries(range) {
				this.ensureGeometry();
				const out = [];
				for (let index = range.start; index < range.end; index++) {
					const row = this.rows[index];
					if (row !== void 0) out.push({
						row,
						index,
						top: this.offsets[index]
					});
				}
				return out;
			}
			/** True when a row is inside the painted range (its DOM node exists). */
			isPainted(id, range) {
				const index = this.indexById.get(id);
				return index !== void 0 && index >= range.start && index < range.end;
			}
			/**
			* The `scrollTop` that puts `id` in the middle of a `viewport`-tall window,
			* or undefined when the column does not hold it.
			*
			* A non-positive viewport asks only for "make the row visible": the row is
			* scrolled to the top edge, which is enough for the window to mount it and
			* for the caller's own `scrollIntoView` to finish the job.
			*/
			scrollTopFor(id, viewport) {
				const index = this.indexById.get(id);
				if (index === void 0) return void 0;
				this.ensureGeometry();
				const maxScroll = Math.max(0, this.offsets[this.rows.length] - Math.max(0, viewport));
				const rowHeight = this.slotSize(index);
				const lead = viewport > 0 ? Math.max(0, (viewport - rowHeight) / 2) : 0;
				return clampNumber(this.offsets[index] - lead, 0, maxScroll);
			}
			/**
			* Index of the row sitting at the top edge of a scrolled viewport.
			*
			* This is the anchor a measurement must preserve: it is the row the reader is
			* reading, and it is the one that must not move when the rows above it are
			* found to be taller (or shorter) than estimated.
			*/
			anchorIndexFor(scrollTop) {
				this.ensureGeometry();
				if (this.rows.length === 0) return 0;
				const top = Math.max(0, scrollTop);
				let low = 0;
				let high = this.rows.length - 1;
				while (low < high) {
					const mid = low + high + 1 >> 1;
					if (this.offsets[mid] <= top) low = mid;
					else high = mid - 1;
				}
				return low;
			}
			/** Effective slot size (row + gap) at `index`. */
			slotSize(index) {
				const row = this.rows[index];
				if (row === void 0) return 0;
				return (this.measuredById.get(row.id) ?? estimateIdeaCardHeight(row, this.charsPerLine)) + 8;
			}
			/** Rebuild the prefix sums after a row set or a size changed. */
			ensureGeometry() {
				if (!this.geometryDirty) return;
				const n = this.rows.length;
				const offsets = new Array(n + 1);
				offsets[0] = 0;
				for (let index = 0; index < n; index++) offsets[index + 1] = offsets[index] + this.slotSize(index);
				this.offsets = offsets;
				this.geometryDirty = false;
			}
			/** First index whose slot ENDS after `top` (binary search on the prefix sums). */
			firstIndexAfter(top) {
				let low = 0;
				let high = this.rows.length;
				while (low < high) {
					const mid = low + high >> 1;
					if (this.offsets[mid + 1] <= top) low = mid + 1;
					else high = mid;
				}
				return Math.min(low, Math.max(0, this.rows.length - 1));
			}
		};
		function clampNumber(value, lo, hi) {
			if (hi < lo) return lo;
			return Math.min(Math.max(value, lo), hi);
		}
		//#endregion
		//#region src/client/virtual-column.ts
		/**
		* React binding for the column windowing of idea #108.
		*
		* `windowing.ts` owns the geometry; this file owns the three things only a DOM
		* can supply: the scroll offset, the measured heights, and the scroller's own
		* size. Everything else - which rows exist, what order they are in, what a drop
		* anchor means, what a selection range covers - is decided above this layer and
		* is deliberately NOT touched here.
		*
		* Two rules shape the code:
		*
		*  - **No layout read during render.** `clientHeight` forces layout, so the
		*    window is recomputed only where layout can legitimately change: when the
		*    scroller attaches, when it scrolls, when the row count moves and when the
		*    viewport resizes. A render reads the cached range.
		*  - **Stable ref callbacks.** A card ref is memoized per column and id, or
		*    React would detach and re-attach every mounted card on every poll, which
		*    would re-measure the whole column several times a second.
		*
		* One hook owns the WHOLE board rather than one hook per column: the set of
		* painted columns follows the `hideDeclinedColumn` setting, so a per-column
		* hook would be a different number of hooks from one render to the next.
		*/
		function sameRange(a, b) {
			return a.start === b.start && a.end === b.end;
		}
		function fullRange(length) {
			return {
				start: 0,
				end: length
			};
		}
		/**
		* The last viewport height each column actually had, kept at MODULE scope so it
		* survives the panel being closed and re-opened.
		*
		* This is what keeps the first render of a re-opened board cheap. A board that
		* has been opened once already knows how tall its columns are; one that has not
		* falls back to `provisionalViewport()`, and the ref callback corrects it in the
		* same commit. Without this the feature would still build 500 cards on every
		* re-open, which is exactly what it exists to avoid.
		*/
		const lastViewport = /* @__PURE__ */ new Map();
		/**
		* A safe budget for a column nobody has measured yet.
		*
		* `window.innerHeight` is readable synchronously, with no layout, and a column
		* can never be taller than the window it is drawn in - so it is an upper bound
		* that bounds how many cards the FIRST render builds. The scroller ref replaces
		* it with the real measurement before the browser paints.
		*/
		function provisionalViewport() {
			if (typeof window === "undefined") return 0;
			return window.innerHeight > 0 ? window.innerHeight : 0;
		}
		/**
		* Upper bound on a REMEMBERED column height, as a multiple of the window.
		*
		* A column cannot be usefully taller than the window it is drawn in, so a
		* measurement beyond this is not a viewport: it is a panel rendered somewhere
		* it has no height (a detached container, a hidden tab, a display:none
		* ancestor). Remembering that number would pin a useless budget for the rest of
		* the session and every later open would build the whole column again.
		*/
		const MAX_REMEMBERED_VIEWPORT_FACTOR = 4;
		function rememberViewport(status, viewport) {
			const ceiling = Math.max(provisionalViewport(), 1) * MAX_REMEMBERED_VIEWPORT_FACTOR;
			const remembered = viewport > 0 ? Math.min(viewport, ceiling) : viewport;
			lastViewport.set(status, remembered);
			return remembered;
		}
		/**
		* Window the kanban columns.
		*
		* @param rowsByStatus - the FULL display order of every column, computed once
		*   per paint by the board. This is also what the multi-select scope and the
		*   drop anchor are built from, so "what the column contains" keeps exactly one
		*   definition and windowing can never become a second, disagreeing one.
		* @param statuses - the columns actually painted, in board order. Pass a
		*   memoized array: the hook keys its effects on the content, not the identity.
		*/
		function useVirtualColumns(rowsByStatus, statuses) {
			const statusKey = statuses.join(",");
			const windowsRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const scrollersRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const cardElsRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const observerRef = (0, react.useRef)(null);
			const cardRefsRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const scrollerRefsRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const viewRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const [tick, bump] = (0, react.useState)(0);
			const statusesRef = (0, react.useRef)(statuses);
			statusesRef.current = statuses;
			const windowFor = (0, react.useCallback)((status) => {
				const known = windowsRef.current.get(status);
				if (known !== void 0) return known;
				const created = new IdeaWindow();
				windowsRef.current.set(status, created);
				return created;
			}, []);
			/** The window for a column, from its cached scroll geometry. */
			const rangeFor = (0, react.useCallback)((window, scrollTop, viewport) => {
				if (window.length <= 40) return fullRange(window.length);
				return window.window(scrollTop, viewport);
			}, []);
			const measureAll = (0, react.useCallback)(() => {
				let moved = 0;
				let changed = false;
				for (const status of statusesRef.current) {
					const window = windowsRef.current.get(status);
					const scroller = scrollersRef.current.get(status);
					if (window === void 0 || scroller === void 0) continue;
					const anchor = window.anchorIndexFor(scroller.scrollTop);
					let delta = 0;
					for (const [id, element] of cardElsRef.current) {
						if (window.indexOf(id) < 0) continue;
						delta += window.measure(id, element.offsetHeight, anchor);
					}
					moved += delta;
					if (delta !== 0) changed = true;
				}
				if (moved !== 0) {
					for (const [status, element] of scrollersRef.current) {
						element.scrollTop += moved;
						viewRef.current.set(status, {
							scrollTop: element.scrollTop,
							viewport: element.clientHeight
						});
					}
					changed = true;
				}
				if (changed) bump((value) => value + 1);
			}, []);
			const columns = /* @__PURE__ */ new Map();
			let rowCountKey = "";
			for (const status of statuses) {
				const window = windowFor(status);
				const rows = rowsByStatus[status] ?? [];
				const scroller = scrollersRef.current.get(status);
				if (scroller !== void 0 && scroller.clientWidth > 0) {
					const perLine = charsPerLineFor(scroller.clientWidth);
					if (perLine !== window.charsPerLine) {
						window.charsPerLine = perLine;
						window.setRows(rows);
					}
				}
				window.setRows(rows);
				rowCountKey += `${window.length},`;
				const view = viewRef.current.get(status) ?? {
					scrollTop: 0,
					viewport: lastViewport.get(status) ?? provisionalViewport()
				};
				const range = rangeFor(window, view.scrollTop, view.viewport);
				const scrollerRef = scrollerRefsRef.current.get(status) ?? ((element) => {
					if (element === null) {
						scrollersRef.current.delete(status);
						viewRef.current.delete(status);
						bump((value) => value + 1);
						return;
					}
					scrollersRef.current.set(status, element);
					observerRef.current?.observe(element);
					rememberViewport(status, element.clientHeight);
					const next = {
						scrollTop: element.scrollTop,
						viewport: element.clientHeight
					};
					const previous = viewRef.current.get(status);
					viewRef.current.set(status, next);
					if (previous !== void 0 && previous.scrollTop === next.scrollTop && previous.viewport === next.viewport) return;
					bump((value) => value + 1);
				});
				scrollerRefsRef.current.set(status, scrollerRef);
				const cardRef = (id) => {
					const key = `${status}|${id}`;
					const known = cardRefsRef.current.get(key);
					if (known !== void 0) return known;
					const created = (element) => {
						const previous = cardElsRef.current.get(id);
						if (previous !== void 0 && previous !== element) {
							observerRef.current?.unobserve(previous);
							cardElsRef.current.delete(id);
						}
						if (element === null) {
							cardRefsRef.current.delete(key);
							return;
						}
						cardElsRef.current.set(id, element);
						observerRef.current?.observe(element);
						const scroller = scrollersRef.current.get(status);
						window.measure(id, element.offsetHeight, window.anchorIndexFor(scroller?.scrollTop ?? 0));
					};
					cardRefsRef.current.set(key, created);
					return created;
				};
				const reveal = (id) => {
					const element = scrollersRef.current.get(status);
					if (element === void 0) return false;
					const target = window.scrollTopFor(id, element.clientHeight);
					if (target === void 0) return false;
					const maxScroll = Math.max(0, window.totalHeight - element.clientHeight);
					const clamped = Math.min(Math.max(target, 0), maxScroll);
					if (Math.abs(element.scrollTop - clamped) < 1) return false;
					element.scrollTop = clamped;
					viewRef.current.set(status, {
						scrollTop: clamped,
						viewport: element.clientHeight
					});
					bump((value) => value + 1);
					return true;
				};
				columns.set(status, {
					rowCount: window.length,
					windowed: range.end - range.start < window.length,
					entries: window.entries(range),
					totalHeight: window.totalHeight,
					scrollerRef,
					cardRef,
					reveal
				});
			}
			const onScroll = (0, react.useCallback)((event) => {
				const element = event.currentTarget;
				if (element === null) return;
				for (const [status, window] of windowsRef.current) {
					if (scrollersRef.current.get(status) !== element) continue;
					const nextView = {
						scrollTop: element.scrollTop,
						viewport: element.clientHeight
					};
					rememberViewport(status, element.clientHeight);
					const previous = viewRef.current.get(status);
					viewRef.current.set(status, nextView);
					if (previous !== void 0 && sameRange(rangeFor(window, previous.scrollTop, previous.viewport), rangeFor(window, nextView.scrollTop, nextView.viewport))) break;
					bump((value) => value + 1);
				}
			}, [rangeFor]);
			(0, react.useEffect)(() => {
				measureAll();
			}, [
				measureAll,
				statusKey,
				rowCountKey,
				tick
			]);
			(0, react.useEffect)(() => {
				if (typeof ResizeObserver !== "function") return;
				const observer = new ResizeObserver(() => {
					for (const [status, element] of scrollersRef.current) {
						rememberViewport(status, element.clientHeight);
						viewRef.current.set(status, {
							scrollTop: element.scrollTop,
							viewport: element.clientHeight
						});
					}
					measureAll();
					bump((value) => value + 1);
				});
				observerRef.current = observer;
				for (const element of scrollersRef.current.values()) observer.observe(element);
				for (const element of cardElsRef.current.values()) observer.observe(element);
				return () => {
					observer.disconnect();
					observerRef.current = null;
				};
			}, [measureAll, statusKey]);
			return {
				columns,
				onScroll
			};
		}
		//#endregion
		//#region src/client/board-view.tsx
		/**
		* Board view: the 4-column kanban (open / under review / archived / declined)
		* that replaces the center column while active. P1 scope: full CRUD — capture
		* and edit modals, per-card archive/restore/decline/delete, manual drag
		* between the move-verb columns (+ intra-column reorder), search and a
		* conjunctive tag filter. The under-review column is the review gate: Approve
		* delivers, Follow-up raises a linked child idea and archives the parent,
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
		/**
		* Minimum gap between two committed column widths while dragging (idea #53).
		* A dense column reflows its cards' text on every width change, so committing
		* per pointermove (per frame) is what makes the drag laggy; ~60 ms keeps the
		* feedback feeling live while cutting the reflow rate to a third. The release
		* always lands the exact final width regardless of this throttle.
		*/
		const RESIZE_THROTTLE_MS = 60;
		function matchesFilter(idea, filter, deepBody) {
			if (filter.trim() === "") return true;
			const needle = filter.trim().toLowerCase();
			return [
				idea.title,
				idea.summary ?? "",
				deepBody ?? idea.bodyExcerpt,
				...(idea.tags ?? []).map((tag) => tag.name)
			].some((text) => text.toLowerCase().includes(needle));
		}
		/**
		* The card element behind an idea id, for the deep-link scroll (idea #105).
		*
		* The attribute is read off every candidate instead of being interpolated into
		* a selector: idea ids are uuids today, but a selector built from a value that
		* came from a query string is a CSS-injection surface waiting for the first
		* importer that hands us something else.
		*
		* @param root - the board root, or null before it mounts.
		* @param ideaId - the idea to find.
		* @returns the outer card wrapper, or undefined when that card is not painted.
		*/
		function ideaCardOf(root, ideaId) {
			if (root === null) return void 0;
			for (const node of root.querySelectorAll("[data-dsh-idea-id]")) if (node.getAttribute("data-dsh-idea-id") === ideaId) return node;
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
		/** Rotate-cw: the re-analyze affordance (a fresh analyst run over the card). */ function IconReanalyze() {
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
		/**
		* Copy: the find-similar affordance (a bounded near-duplicate question handed
		* to the analyst). Deliberately NOT a funnel: a funnel reads as "merge
		* duplicates", and this action never merges anything.
		*/
		function IconFindSimilar() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...actionIcon,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "9",
					y: "9",
					width: "13",
					height: "13",
					rx: "2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })]
			});
		}
		/**
		* Play: the launch affordance of idea #66 (start the idea's execution on its
		* TaskBoard card). The only icon painted GREEN in the whole action row — it is
		* the one card action that makes the agent work happen, not just the card
		* move. `currentColor` everywhere else so a skin/dark-mode change still wins;
		* the fill is explicit here, with a matching drop shadow for contrast on light
		* cards.
		*/
		function IconPlay() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...actionIcon,
				style: { color: "var(--dsh-ideas-run, #16a34a)" },
				fill: "currentColor",
				stroke: "none",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 3.6a1 1 0 0 1 1.52-.85l11.2 7.4a1 1 0 0 1 0 1.7l-11.2 7.4A1 1 0 0 1 6 18.4z" })
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
		*  capture modal and the re-analyze confirm modal.
		*
		*  `initialTarget` (a stored `provider/model`, idea #107) OUTRANKS the session
		*  model when the launch modal reveals the picker over a workspace default: the
		*  run would use that model anyway, so showing it selected is honest, and the
		*  picker then reads as "the current default, which you may change". Held in a
		*  ref so a later settings write cannot restart the catalog load. */
		function useAnalystModelPicker(launcher, initialTarget) {
			const [modelChoices, setModelChoices] = (0, react.useState)([]);
			const [selProvider, setSelProvider] = (0, react.useState)("");
			const [modelQuery, setModelQuery] = (0, react.useState)("");
			const [selModelKey, setSelModelKey] = (0, react.useState)("");
			const initialTargetRef = (0, react.useRef)(initialTarget);
			(0, react.useEffect)(() => {
				let cancelled = false;
				if (launcher === void 0) return;
				launcher.listModels().then((choices) => {
					if (cancelled) return;
					setModelChoices(choices);
					const preset = pickModelTarget(choices, initialTargetRef.current);
					if (preset !== void 0) {
						setSelProvider(preset.provider);
						setSelModelKey(preset.label);
						return;
					}
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
		*  here per status (deliver / archive / decline / review approved / follow-up /
		*  restore), so the author can move an idea without leaving the editor. */
		function IdeaModal({ client, initial, initialWorkspace, onClose, onFollowUp, onReanalyze, onFindSimilar, onLaunch }) {
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
			const [relatesTo, setRelatesTo] = (0, react.useState)(() => [...initial?.relatesTo ?? []]);
			const [blocks, setBlocks] = (0, react.useState)(() => [...initial?.blocks ?? []]);
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
					const relationPatch = initial === void 0 ? {} : {
						...relationListChanged(relatesTo, initial.relatesTo) ? { relatesTo } : {},
						...relationListChanged(blocks, initial.blocks) ? { blocks } : {}
					};
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
							workspaceId: workspace,
							...relationPatch
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
							workspaceId: workspace,
							...relationPatch
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
							children: initial === void 0 || initial.ideaNumber === void 0 ? t("board.new") : t("edit.title", { number: `#${initial.ideaNumber}` })
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
						initial !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RelationsEditor, {
							ideas: client.snapshot?.ideas ?? [],
							ideaId: initial.id,
							relatesTo,
							blocks,
							disabled: client.pending,
							onRelatesTo: setRelatesTo,
							onBlocks: setBlocks
						}),
						initial !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActivityTimeline, { idea: initial }),
						initial !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeliveryNote, { idea: initial }),
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
									onFindSimilar !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										title: t("card.findSimilarHint"),
										onClick: () => {
											onFindSimilar(initial);
											onClose();
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconFindSimilar, {}), t("card.findSimilar")]
									}),
									onLaunch !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: classes.actionButton,
										disabled: client.pending,
										title: t("card.launchHint"),
										"data-dsh-ideas-launch-edit": "",
										onClick: () => {
											onLaunch(initial);
											onClose();
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlay, {}), t("card.launch")]
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
		* Follow-up modal: raise a child follow-up idea that carries the parent
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
		* Find similar modal: the board's cheap near-duplicate FLAG, and the
		* explicit hand-off of the real judgement to an analyst session.
		*
		* Three decisions live here.
		*
		* 1. The candidate list is FETCHED when the modal opens, through the opt-in
		*    `similar` read query — never from the snapshot the poll already carries.
		*    That is what keeps the flag free on the 2.5 s poll.
		* 2. The scores are shown, and shown as what they are. The modal prints the
		*    signal legend next to them: a score is title+tag overlap, and the analyst
		*    reads each candidate's real body before saying anything about it. A
		*    hidden or unexplained number would read as a verdict.
		* 3. The modal can only ASK. There is no merge control anywhere in this tree,
		*    and the prompt forbids the merge verb in the session it starts: the human
		*    stays the one who merges.
		*
		* The model picker is the same cascade as the capture and the re-analyze, so
		* the three AI affordances of the board behave identically.
		*/
		function SimilarModal({ client, idea, workspaceTitle, onLaunch, onClose }) {
			const picker = useAnalystModelPicker(client.sessionLauncher);
			const [pending, setPending] = (0, react.useState)(false);
			const [report, setReport] = (0, react.useState)(void 0);
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
			(0, react.useEffect)(() => {
				let live = true;
				client.findSimilarIdea(idea.id, 8).then((found) => {
					if (live) setReport(found);
				}, (loadError) => {
					console.error("[dsh-plugin-ideas-manager] similar-idea scan failed:", loadError);
					if (live) setError(loadError instanceof Error ? loadError.message : String(loadError));
				});
				return () => {
					live = false;
				};
			}, [client, idea.id]);
			const views = report === void 0 ? [] : similarCandidateViews(report, {
				title: t("similar.signalTitle"),
				tags: t("similar.signalTags")
			});
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
							children: t("similar.title")
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
								children: error !== void 0 ? t("similar.loadFailed", { error }) : report === void 0 ? t("similar.hint", {
									workspace: workspaceTitle,
									scanned: "…"
								}) : t("similar.hint", {
									workspace: workspaceTitle,
									scanned: String(report.scanned)
								})
							})
						}),
						report !== void 0 && views.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.fieldLabel,
									children: t("similar.candidates")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.preview,
									"data-dsh-ideas-similar-candidates": "",
									children: views.map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: classes.detailMeta,
										children: [
											candidate.ideaNumber !== void 0 ? `#${candidate.ideaNumber} — ` : "",
											candidate.title,
											" · ",
											t("similar.score", {
												score: candidate.score.toFixed(2),
												signals: candidate.signals.join(" + ")
											})
										]
									}, candidate.id))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									children: t("similar.signalLegend")
								})
							]
						}),
						report !== void 0 && views.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.field,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.fieldHint,
								children: t("similar.empty")
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
								children: t("similar.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.primaryButton,
								disabled: pending || client.pending || report === void 0,
								"data-dsh-ideas-find-similar-submit": "",
								onClick: start,
								children: t("similar.askAnalyst")
							})]
						})
					]
				})
			});
		}
		/**
		* Launch confirm modal (idea #66): the human starts the idea's execution, WITH
		* the model choice. The run is TaskBoard-owned (the Host patches the card's
		* `model` then posts `run`; the runner pins the model on a fresh session and
		* queues the shared run prompt), so the modal's only real choice is WHICH model
		* — '' keeps the session default, the exact cascade used by the capture and
		* re-analyze modals.
		*
		* A refusal (already running, archived card, task-board absent) is shown HERE
		* and keeps the modal open: the reason is the whole value of an explicit
		* launch, so it is never reduced to a silent log line.
		*
		* ONE refusal is special. A card whose effective permission sits above the
		* session default is refused until a human confirms that binding in the
		* TaskBoard, and no agent can confirm it (the board deliberately ships no such
		* affordance for one). So the modal does not relay the Host's English sentence
		* bare: it names the card, offers the redirect to the board panel with the
		* filter already set on the idea title, and keeps the raw text for diagnosis.
		*
		* The workspace's DEFAULT LAUNCH MODEL (idea #107) is what makes this modal
		* stop asking: a workspace that carries one shows WHICH model the run will use
		* instead of the picker, with the two gestures that can change or forget it.
		* Two decisions are worth stating:
		*
		*  - **The default lives in the settings document, not on the idea.** The board
		*    adopts whatever the Host serves on its 2.5 s poll, so a per-idea copy
		*    would be written straight back over the choice just made.
		*  - **The picker is not deleted, it is deferred.** `Change…` reveals it
		*    preselected with the current default, so a single run can still override
		*    the workspace (step 1 of the fallback order) without touching what every
		*    later run will use. Nothing here decides anything: the Host resolves the
		*    same order at launch time, so a browser that never opened this modal gets
		*    the identical run.
		*/
		function LaunchModal({ client, idea, workspaceTitle, onLaunch, onClose }) {
			const workspaceId = idea.workspaceId ?? "";
			const storedModels = client.config.value.launchModelByWorkspace;
			const workspaceDefault = launchModelForWorkspace(storedModels, workspaceId);
			const [changingDefault, setChangingDefault] = (0, react.useState)(false);
			const picker = useAnalystModelPicker(client.sessionLauncher, workspaceDefault);
			const [pending, setPending] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const [copied, setCopied] = (0, react.useState)(false);
			const defaultLabel = workspaceDefault === void 0 ? void 0 : pickModelTarget(picker.modelChoices, workspaceDefault)?.label ?? workspaceDefault;
			const pickedTarget = modelTargetIdOf(picker.selectedModel);
			const rememberDefault = () => {
				const target = modelTargetIdOf(picker.selectedModel);
				if (target === void 0) return Promise.resolve();
				return client.saveConfig({ launchModelByWorkspace: withWorkspaceLaunchModel(storedModels, workspaceId, target) });
			};
			const forgetDefault = () => {
				setChangingDefault(false);
				client.saveConfig({ launchModelByWorkspace: withoutWorkspaceLaunchModel(storedModels, workspaceId) });
			};
			(0, react.useEffect)(() => {
				if (!changingDefault || workspaceDefault === void 0) return;
				const preset = pickModelTarget(picker.modelChoices, workspaceDefault);
				if (preset === void 0) return;
				picker.setSelProvider(preset.provider);
				picker.setSelModelKey(preset.label);
			}, [
				changingDefault,
				workspaceDefault,
				picker.modelChoices
			]);
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
				setError(void 0);
				onLaunch(idea, workspaceDefault !== void 0 && !changingDefault ? void 0 : picker.selectedModel).catch((launchError) => {
					setPending(false);
					setError(launchError instanceof Error ? launchError.message : String(launchError));
				});
			};
			const refusal = error === void 0 ? void 0 : classifyLaunchRefusal(error);
			const copyTitle = () => {
				copyIdeaTitle(idea.title).then((ok) => {
					setCopied(ok);
				});
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
							children: t("launch.title")
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
								children: t("launch.hint", { workspace: workspaceTitle })
							})
						}),
						(idea.taskBoardId === void 0 || idea.taskBoardId === "") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.field,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.fieldHint,
								children: t("launch.sessionHint")
							})
						}),
						picker.modelChoices.length > 0 && (workspaceDefault === void 0 || changingDefault) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPickerField, {
							picker,
							disabled: pending
						}) : null,
						workspaceDefault !== void 0 && !changingDefault && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.fieldLabel,
									children: t("launch.defaultModel")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									"data-dsh-ideas-launch-default": "",
									children: defaultLabel
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									children: t("launch.defaultHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.defaultModelActions,
									children: [picker.modelChoices.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: classes.ghostButton,
										disabled: pending || client.configPending,
										"data-dsh-ideas-change-default": "",
										onClick: () => {
											setChangingDefault(true);
										},
										children: t("launch.changeDefault")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: classes.ghostButton,
										disabled: pending || client.configPending || !client.config.available,
										"data-dsh-ideas-forget-default": "",
										onClick: forgetDefault,
										children: t("launch.forgetDefault")
									})]
								}),
								client.configError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.error,
									children: `${t("settings.saveFailed")}${client.configError}`
								})
							]
						}),
						workspaceDefault === void 0 && pickedTarget !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.field,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.defaultModelActions,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.ghostButton,
									disabled: pending || client.configPending || !client.config.available,
									"data-dsh-ideas-remember-default": "",
									onClick: () => {
										rememberDefault();
									},
									children: t("launch.rememberDefault", { workspace: workspaceTitle })
								})
							})
						}),
						changingDefault && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.defaultModelActions,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.ghostButton,
									disabled: pending || client.configPending || !client.config.available || pickedTarget === void 0 || pickedTarget === workspaceDefault,
									"data-dsh-ideas-save-default": "",
									onClick: () => {
										rememberDefault().then(() => {
											if (client.configError === void 0) setChangingDefault(false);
										});
									},
									children: t("launch.saveDefault")
								})
							}), client.configError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.error,
								children: `${t("settings.saveFailed")}${client.configError}`
							})]
						}),
						refusal?.kind === "plain" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: classes.error,
							children: refusal.message
						}),
						refusal?.kind === "permission" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.launchGate,
							"data-dsh-ideas-launch-gate": "",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.fieldHint,
									children: t("launch.permissionHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.detailMeta,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: idea.title })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.launchGateActions,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: classes.primaryButton,
											"data-dsh-ideas-show-card": "",
											onClick: () => {
												client.requestFocus(idea.ideaNumber !== void 0 ? `#${idea.ideaNumber}` : idea.id);
												onClose();
											},
											children: t("launch.showCard")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: classes.ghostButton,
											"data-dsh-ideas-open-taskboard": "",
											onClick: () => {
												client.openTaskBoard();
											},
											children: t("launch.openTaskBoard")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: classes.ghostButton,
											"data-dsh-ideas-copy-title": "",
											onClick: copyTitle,
											children: copied ? t("launch.titleCopied") : t("launch.copyTitle")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: classes.detailMeta,
									title: refusal.message,
									children: refusal.message
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: classes.modalActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.ghostButton,
								disabled: pending,
								onClick: onClose,
								children: t("launch.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classes.primaryButton,
								disabled: pending,
								onClick: start,
								"data-dsh-ideas-launch-submit": "",
								children: t("launch.submit")
							})]
						})
					]
				})
			});
		}
		/**
		* Put the idea title on the clipboard, so the card stays findable in the board
		* filter even when the automatic write is refused. A clipboard the browser
		* refuses (insecure context, denied permission) is reported, never thrown: the
		* title is already on screen for a manual copy.
		*/
		async function copyIdeaTitle(title) {
			try {
				await navigator.clipboard.writeText(title);
				return true;
			} catch {
				return false;
			}
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
		/** Board component; subscribes to the client snapshot. */
		function IdeasBoard({ client }) {
			const [snapshot, setSnapshot] = (0, react.useState)(client.snapshot);
			const [settings, setSettings] = (0, react.useState)(client.config);
			const [, setClientTick] = (0, react.useState)(0);
			const [filter, setFilter] = (0, react.useState)("");
			const [tagFilter, setTagFilter] = (0, react.useState)([]);
			const [workspaceFilter, setWorkspaceFilter] = (0, react.useState)("");
			const [showNew, setShowNew] = (0, react.useState)(false);
			const [editing, setEditing] = (0, react.useState)(void 0);
			const [followUp, setFollowUp] = (0, react.useState)(void 0);
			const [reanalyzing, setReanalyzing] = (0, react.useState)(void 0);
			const [findingSimilar, setFindingSimilar] = (0, react.useState)(void 0);
			const [launching, setLaunching] = (0, react.useState)(void 0);
			const [confirmId, setConfirmId] = (0, react.useState)(void 0);
			const [confirmVerb, setConfirmVerb] = (0, react.useState)(void 0);
			const [selection, setSelection] = (0, react.useState)(EMPTY_SELECTION);
			const [bulk, setBulk] = (0, react.useState)(void 0);
			const [openColumnReordered, setOpenColumnReordered] = (0, react.useState)(false);
			const [drag, setDrag] = (0, react.useState)(void 0);
			const [dragTarget, setDragTarget] = (0, react.useState)(void 0);
			const [jumpRef, setJumpRef] = (0, react.useState)("");
			const [mdMode, setMdMode] = (0, react.useState)(true);
			const [activeTab, setActiveTab] = (0, react.useState)(() => readActiveTab(activeTabStorage()));
			const switchTab = (tab) => {
				setActiveTab(tab);
				writeActiveTab(activeTabStorage(), tab);
			};
			(0, react.useEffect)(() => client.subscribe(() => {
				setSnapshot(client.snapshot);
				setSettings(client.config);
				setClientTick((tick) => tick + 1);
			}), [client]);
			const cfg = settings.value;
			const renderedAt = Date.now();
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
			const boardRef = (0, react.useRef)(null);
			const focusSeq = client.focusRequest?.seq;
			const focusRef = client.focusRequest?.ref;
			(0, react.useEffect)(() => {
				if (focusSeq === void 0 || focusRef === void 0) return;
				if (snapshot === void 0) return;
				let cancelled = false;
				client.resolveFocus(focusRef).then((found) => {
					if (cancelled) return;
					if (found === void 0) {
						client.reportFocus(focusSeq, "unknown");
						return;
					}
					setFilter("");
					setTagFilter([]);
					setWorkspaceFilter(found.workspaceId ?? "__no-workspace__");
					switchTab("overview");
					if (found.status === "declined" && cfg.hideDeclinedColumn) {
						client.reportFocus(focusSeq, "hidden");
						return;
					}
					client.reportFocus(focusSeq, "focused", found.id);
				});
				return () => {
					cancelled = true;
				};
			}, [
				client,
				focusSeq,
				snapshot?.revision,
				cfg.hideDeclinedColumn
			]);
			const [revealTick, setRevealTick] = (0, react.useState)(0);
			const [columnWidths, setColumnWidths] = (0, react.useState)(() => readColumnWidths(activeTabStorage()));
			const [resizingStatus, setResizingStatus] = (0, react.useState)(void 0);
			const colLo = Math.min(cfg.columnMinWidth, cfg.columnMaxWidth);
			const colHi = Math.max(cfg.columnMinWidth, cfg.columnMaxWidth);
			const resizingRef = (0, react.useRef)(null);
			const lastCommitRef = (0, react.useRef)(0);
			const colBoundsRef = (0, react.useRef)({
				lo: colLo,
				hi: colHi
			});
			colBoundsRef.current = {
				lo: colLo,
				hi: colHi
			};
			const frozenBodyRef = (0, react.useRef)(null);
			/** Commit one column's width (clamped to the current bounds) into state. */
			const applyColumnWidth = (0, react.useCallback)((status, raw) => {
				const bounds = colBoundsRef.current;
				setColumnWidths((prev) => ({
					...prev,
					[status]: clampColumnWidth(raw, bounds.lo, bounds.hi)
				}));
			}, []);
			const onResizeMove = (0, react.useCallback)((event) => {
				const live = resizingRef.current;
				if (live === null) return;
				event.preventDefault();
				const now = performance.now();
				if (now - lastCommitRef.current < RESIZE_THROTTLE_MS) return;
				lastCommitRef.current = now;
				applyColumnWidth(live.status, live.startWidth + (event.clientX - live.startX));
			}, [applyColumnWidth]);
			const onResizeUp = (0, react.useCallback)((event) => {
				const live = resizingRef.current;
				if (live !== null) applyColumnWidth(live.status, live.startWidth + (event.clientX - live.startX));
				const body = frozenBodyRef.current;
				if (body !== null) {
					body.style.width = "";
					frozenBodyRef.current = null;
				}
				resizingRef.current = null;
				setResizingStatus(void 0);
				window.removeEventListener("pointermove", onResizeMove);
				window.removeEventListener("pointerup", onResizeUp);
			}, [onResizeMove, applyColumnWidth]);
			(0, react.useEffect)(() => () => {
				const body = frozenBodyRef.current;
				if (body !== null) {
					body.style.width = "";
					frozenBodyRef.current = null;
				}
				window.removeEventListener("pointermove", onResizeMove);
				window.removeEventListener("pointerup", onResizeUp);
			}, [onResizeMove, onResizeUp]);
			(0, react.useEffect)(() => {
				writeColumnWidths(activeTabStorage(), columnWidths);
			}, [columnWidths]);
			/** Start a per-column resize: anchor the pointer, then track it on window. */
			const beginResize = (status, event) => {
				if (drag !== void 0) return;
				const column = event.currentTarget.closest(`.${classes.column}`);
				if (column === null) return;
				resizingRef.current = {
					status,
					startX: event.clientX,
					startWidth: column.getBoundingClientRect().width
				};
				lastCommitRef.current = 0;
				const body = column.querySelector("[data-dsh-column-scroll]");
				if (body !== null) {
					frozenBodyRef.current = body;
					body.style.width = `${Math.round(body.getBoundingClientRect().width)}px`;
				}
				setResizingStatus(status);
				window.addEventListener("pointermove", onResizeMove);
				window.addEventListener("pointerup", onResizeUp);
			};
			/** Drop one column's stored width (double-click a resizer): back to the default share. */
			const resetColumnWidth = (status) => {
				setColumnWidths((prev) => {
					if (prev[status] === void 0) return prev;
					const next = { ...prev };
					delete next[status];
					return next;
				});
			};
			const ideas = snapshot?.ideas ?? [];
			const revision = snapshot?.revision;
			const relationIndex = (0, react.useMemo)(() => relationIndexOf(ideas), [ideas]);
			const [, setSearchIndexGen] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (filter.trim() === "") return;
				let cancelled = false;
				client.ensureSearchIndex().then(() => {
					if (!cancelled) setSearchIndexGen((gen) => gen + 1);
				});
				return () => {
					cancelled = true;
				};
			}, [
				filter,
				client,
				revision
			]);
			const ideaById = new Map(ideas.map((idea) => [idea.id, idea]));
			const parentNumberOf = (ideaId) => ideaById.get(ideaId)?.ideaNumber;
			const knownTags = collectKnownTags(ideas.filter((idea) => matchesWorkspaceScope(idea, workspaceFilter)));
			const catalog = buildWorkspaceCatalog(ideas, client.workspaceOptions);
			const workspaceTitle = (workspaceId) => catalog.find((entry) => entry.workspaceId === workspaceId)?.title ?? workspaceId;
			const filtering = filter.trim() !== "" || tagFilter.length > 0;
			const visible = ideas.filter((idea) => matchesWorkspaceScope(idea, workspaceFilter) && matchesFilter(idea, filter, client.cachedBodyOf(idea.id)) && matchesTags(idea, tagFilter));
			const scopedOpen = ideas.filter((idea) => idea.status === "open" && matchesWorkspaceScope(idea, workspaceFilter) && matchesFilter(idea, filter, client.cachedBodyOf(idea.id)) && matchesTags(idea, tagFilter));
			const archivedIdeas = archivedIdeasOf(ideas, workspaceFilter).filter((idea) => matchesFilter(idea, filter, client.cachedBodyOf(idea.id)) && matchesTags(idea, tagFilter));
			const openOrdering = openColumnReordered ? "rank" : cfg.openOrdering;
			const openColumnRanked = openOrdering === "rank";
			const byStatus = (status) => {
				const rows = visible.filter((idea) => idea.status === status);
				const grouped = workspaceFilter === "";
				return status === "open" ? orderOpenColumn(rows, grouped, workspaceTitle, openOrdering, cfg.runningFirst) : grouped ? orderByWorkspaceGroups(rows, workspaceTitle) : orderIdeas(rows);
			};
			const columnRows = {};
			for (const status of IDEA_COLUMNS) columnRows[status] = byStatus(status);
			const visibleStatuses = (0, react.useMemo)(() => IDEA_COLUMNS.filter((status) => !(status === "declined" && cfg.hideDeclinedColumn)), [cfg.hideDeclinedColumn]);
			const { columns: virtualColumns, onScroll: onColumnScroll } = useVirtualColumns(columnRows, visibleStatuses);
			(0, react.useEffect)(() => {
				const id = client.focusedIdeaId;
				if (id === void 0 || activeTab !== "overview") return;
				let moved = false;
				for (const column of virtualColumns.values()) if (column.reveal(id)) moved = true;
				if (moved) setRevealTick((tick) => tick + 1);
			}, [
				client.focusedIdeaId,
				activeTab,
				virtualColumns
			]);
			(0, react.useEffect)(() => {
				const id = client.focusedIdeaId;
				if (id === void 0) return;
				const card = ideaCardOf(boardRef.current, id);
				if (card !== void 0 && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center" });
			}, [
				client.focusedIdeaId,
				activeTab,
				revealTick
			]);
			/**
			* The rows the multi-select may hold, in DISPLAY order (idea #94): the
			* current tab's filtered rows, laid out exactly as they are painted. The
			* Overview concatenates its columns in board order (so a shift-click range
			* reads as the block of cards the author sees), Priorities reuses the same
			* group-then-rank layout the view paints, Delivered the same exit-order sort.
			* A shift-click range over this list is therefore never an arbitrary order.
			*/
			const scopeRows = activeTab === "overview" ? visibleStatuses.flatMap((status) => columnRows[status]) : activeTab === "priorities" ? groupOpenByWorkspace(scopedOpen).sort((a, b) => compareWorkspaceGroups(a, b, workspaceTitle)).flatMap((group) => group.ideas) : activeTab === "delivered" ? deliveredRows(archivedIdeas) : [];
			const scopeIds = scopeRows.map((row) => row.id);
			(0, react.useEffect)(() => {
				setSelection((current) => pruneSelection(current, scopeIds));
			}, [scopeIds.join("\0")]);
			const wholeScope = isWholeScopeSelected(selection, scopeIds);
			const scopeParts = [workspaceFilter === "" ? t("bulk.scope.allWorkspaces") : workspaceFilter === "__no-workspace__" ? t("board.noWorkspace") : workspaceTitle(workspaceFilter)];
			if (tagFilter.length > 0) scopeParts.push(t("bulk.scope.tags", { tags: tagFilter.join(", ") }));
			if (filter.trim() !== "") scopeParts.push(t("bulk.scope.search", { query: filter.trim() }));
			const scopeLabel = scopeParts.length === 1 && workspaceFilter === "" && tagFilter.length === 0 && filter.trim() === "" ? t("bulk.scope.everything") : t("bulk.scope.label", { scope: scopeParts.join(" · ") });
			const bulkSelected = selectedRows(scopeRows, selection);
			const selectedSet = new Set(selection.ids);
			const listTab = activeTab !== "health";
			(0, react.useEffect)(() => {
				if (activeTab !== "health") {
					client.dropStats();
					return;
				}
				client.loadStats(workspaceFilter === "" ? void 0 : workspaceFilter === "__no-workspace__" ? "" : workspaceFilter);
			}, [
				client,
				activeTab,
				workspaceFilter,
				snapshot?.revision
			]);
			/**
			* Select box click: a plain click toggles one row, a shift-click paints the
			* range between the anchor and this row. Drag & drop is deliberately NOT a
			* selection gesture — the grip is an explicit move handle, and a drag that
			* silently selected the rows it passed over would make a 10-card selection
			* impossible to reason about.
			*/
			const toggleRow = (ideaId, shiftKey) => {
				setSelection((current) => shiftKey ? extendSelection(current, ideaId, scopeIds) : toggleSelection(current, ideaId, scopeIds));
			};
			const toggleTag = (name) => {
				client.clearFocus();
				setTagFilter((current) => current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]);
			};
			/**
			* Lifecycle runner (settings option confirmLifecycle): with the option ON,
			* the first click ARMS the in-place Yes/No confirmation for (idea, verb)
			* and only the second click runs the verb; with it OFF every click runs
			* directly (today's behaviour). One armed state covers the four lifecycle
			* buttons (Deliver, Review approved, Decline on open + under-review cards).
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
				const displayOrder = columnRows[status].map((row) => row.id);
				try {
					if (source !== status) if (status === "declined") await client.declineIdea(draggedId);
					else await client.moveIdea(draggedId, status);
					const ordered = rebuildOrder(client.snapshot?.ideas ?? [], draggedId, status, beforeId, displayOrder);
					await client.reorderIdea(ordered);
					if (source === "open" && status === "open" && !openColumnRanked) setOpenColumnReordered(true);
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
				client.fetchIdea(idea).then((full) => {
					setEditing(full);
				}, (error) => {
					console.error("[dsh-plugin-ideas-manager] deferred body load failed:", error);
					client.reportError(error instanceof Error ? error.message : String(error));
				});
			};
			/** Follow-up (review rejected) from the card: same deferred-body fetch (the
			*  composer quotes the parent's whole summary). The edit modal passes its
			*  already-full record straight through. */
			const openFollowUp = (idea) => {
				setConfirmId(void 0);
				setConfirmVerb(void 0);
				client.fetchIdea(idea).then((parent) => {
					setFollowUp(parent);
				}, (error) => {
					console.error("[dsh-plugin-ideas-manager] deferred body load failed:", error);
					client.reportError(error instanceof Error ? error.message : String(error));
				});
			};
			/** Idea #30 flow: a Re-analyze affordance is offered on an open idea only
			*  when the analyst can actually run there — a session launcher resolved
			*  AND the idea's workspace known to the DSH app (a ledger-only workspace
			*  cannot host a session, exactly like the capture AI mode). */
			const canReanalyze = (idea) => idea.status === "open" && client.sessionLauncher !== void 0 && idea.workspaceId !== void 0 && catalog.some((entry) => entry.workspaceId === idea.workspaceId && entry.knownToApp);
			/**
			* The Find similar affordance, gated EXACTLY like Re-analyze: same status,
			* same launcher requirement, same "workspace known to the app" test. Both are
			* the same gesture — hand a bounded question to an analyst session in this
			* idea's workspace — so they must appear and disappear together. The matrix
			* itself lives in `canFindSimilar` (pure, unit-tested); this is only the
			* board's wiring of the two inputs it has.
			*/
			const canFindSimilarHere = (idea) => canFindSimilar(idea, {
				hasLauncher: client.sessionLauncher !== void 0,
				knownWorkspaceIds: new Set(catalog.filter((entry) => entry.knownToApp).map((entry) => entry.workspaceId))
			});
			/**
			* Find similar: re-read the bounded report the modal is already showing and
			* hand it to a fresh analyst session. The re-read costs one opt-in read and
			* removes the only real race — a candidate set fetched when the modal opened
			* may be a revision old by the time the human clicks.
			*
			* No write happens here, and the prompt forbids the merge verb, so the run
			* can only report. A failure is logged, exactly like the AI capture: the
			* modal closes either way because there is no card state to reconcile.
			*/
			const findSimilarIdea = (idea, model) => {
				const launcher = client.sessionLauncher;
				if (launcher === void 0) return;
				const run = async () => {
					const input = buildFindSimilarInput(idea, await client.findSimilarIdea(idea.id, 8), {
						workspaceTitle: workspaceTitle(idea.workspaceId ?? ""),
						...model === void 0 ? {} : { model }
					});
					if (input === void 0) return;
					launcher.launchFindSimilar(input).catch((launchError) => {
						console.error("[dsh-plugin-ideas-manager] find similar failed:", launchError);
					});
				};
				run().catch((readError) => {
					console.error("[dsh-plugin-ideas-manager] similar-idea scan failed:", readError);
				});
				setFindingSimilar(void 0);
			};
			/** Stamp the audit cycle first so the Host preserves the current body as
			*  the prior-analysis audit, then launch with summary metadata only. */
			const reanalyzeIdea = (idea, model) => {
				const launcher = client.sessionLauncher;
				if (launcher === void 0 || idea.workspaceId === void 0) return;
				const run = async () => {
					await client.reanalyzeIdea(idea.id);
					const activity = await client.fetchIdea(idea).then((full) => full.events).catch((error) => {
						console.error("[dsh-plugin-ideas-manager] activity log load failed:", error);
					});
					const input = {
						workspaceId: idea.workspaceId,
						workspaceTitle: workspaceTitle(idea.workspaceId),
						ideaId: idea.id,
						...idea.ideaNumber !== void 0 ? { ideaNumber: idea.ideaNumber } : {},
						title: idea.title,
						...idea.summary !== void 0 ? { summary: idea.summary } : {},
						status: idea.status,
						...idea.taskBoardId !== void 0 ? { taskBoardId: idea.taskBoardId } : {},
						tags: (idea.tags ?? []).map((tag) => tag.name),
						...idea.value === void 0 ? {} : { value: idea.value },
						...idea.effort === void 0 ? {} : { effort: idea.effort },
						...idea.rationale === void 0 ? {} : { rationale: idea.rationale },
						...activity === void 0 ? {} : { activity },
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
			/**
			* Idea #66: hand the launch to the Host, which owns the mirrored card
			* (ensure card -> model-only patch -> run). The picked model becomes the
			* task-board's `provider/model` target; no pick keeps the session default.
			* The modal closes on success; a refusal keeps it open with the message.
			*/
			const launchIdea = (idea, model) => client.launchIdea(idea.id, modelTargetIdOf(model)).then(() => {
				setLaunching(void 0);
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: boardRef,
				className: classes.board,
				"data-dsh-ideas-board": "",
				"data-dsh-plugin": "ideas",
				"data-dsh-ideas-density": cfg.cardDensity === "compact" ? "compact" : void 0,
				lang: interfaceLanguage(),
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
									client.clearFocus();
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								className: classes.jump,
								onSubmit: (event) => {
									event.preventDefault();
									if (jumpRef.trim() === "") return;
									client.requestFocus(jumpRef);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classes.jumpInput,
									type: "text",
									inputMode: "numeric",
									value: jumpRef,
									placeholder: t("board.jumpPlaceholder"),
									"aria-label": t("board.jump"),
									"data-dsh-ideas-jump-input": "",
									onChange: (event) => {
										setJumpRef(event.target.value);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "submit",
									className: `${classes.ghostButton} ${classes.jumpGo}`,
									disabled: jumpRef.trim() === "",
									title: t("board.jump"),
									"data-dsh-ideas-jump": "",
									children: t("board.jumpGo")
								})]
							}),
							listTab && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: classes.search,
								type: "search",
								placeholder: t("board.search"),
								value: filter,
								"aria-label": t("board.search"),
								onChange: (event) => {
									client.clearFocus();
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
									client.clearFocus();
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
									client.clearFocus();
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
									client.clearFocus();
									switchTab("delivered");
								},
								children: [t("tab.delivered"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.tabCount,
									children: archivedIdeas.length
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								role: "tab",
								className: activeTab === "health" ? classes.tabActive : classes.tab,
								"data-active": activeTab === "health" ? "" : void 0,
								"aria-selected": activeTab === "health",
								onClick: () => {
									client.clearFocus();
									switchTab("health");
								},
								children: t("tab.health")
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
					client.focusResult !== void 0 && client.focusResult.outcome === "unknown" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.focusNote,
						role: "status",
						"data-dsh-ideas-focus-note": "unknown",
						children: t("board.jumpUnknown", { ref: client.focusResult.ref })
					}),
					client.focusResult !== void 0 && client.focusResult.outcome === "hidden" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.focusNote,
						role: "status",
						"data-dsh-ideas-focus-note": "hidden",
						children: t("board.jumpHidden", { ref: client.focusResult.ref })
					}),
					knownTags.length > 0 && listTab && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TagFilterRow, {
						knownTags,
						selected: tagFilter,
						onToggle: toggleTag,
						onClear: () => {
							setTagFilter([]);
						}
					}),
					ideas.length > 0 && listTab && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectionBar, {
						selectedCount: selection.ids.length,
						scopeTotal: scopeRows.length,
						scopeLabel,
						wholeScope,
						busy: bulk !== void 0,
						onSelectAll: () => {
							setSelection((current) => wholeScope ? EMPTY_SELECTION : selectAll(scopeIds));
						},
						onClear: () => {
							setSelection(EMPTY_SELECTION);
						},
						onTag: () => {
							setBulk("tag");
						},
						onWorkspace: () => {
							setBulk("workspace");
						},
						onArchive: () => {
							setBulk("archive");
						}
					}),
					activeTab === "overview" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.dragHint,
						children: t("board.dragHint")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.columns,
						"data-dsh-columns-scroll": "",
						children: visibleStatuses.map((status) => {
							const columnIdeas = columnRows[status];
							const vcol = virtualColumns.get(status);
							const storedWidth = columnWidths[status];
							const columnWidth = storedWidth === void 0 ? void 0 : clampColumnWidth(storedWidth, colLo, colHi);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: classes.column,
								style: columnWidth !== void 0 ? {
									flex: `0 0 ${columnWidth}px`,
									width: `${columnWidth}px`,
									maxWidth: "none"
								} : void 0,
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
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: classes.columnHeader,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: classes.columnTitle,
											children: t(STATUS_LABEL[status])
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: classes.columnCount,
											children: columnIdeas.length
										})]
									}),
									status === "open" && columnIdeas.length >= 300 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: classes.openColumnNotice,
										"data-dsh-ideas-open-notice": "",
										children: t("board.openColumnNotice", { count: columnIdeas.length })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: classes.columnBody,
										"data-dsh-column-scroll": "",
										ref: vcol.scrollerRef,
										onScroll: onColumnScroll,
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
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: classes.virtualList,
											style: { height: `${vcol.totalHeight}px` },
											children: vcol.entries.map(({ row: idea, index, top }) => {
												const confirm = confirmId === idea.id;
												const selected = isSelected(selection, idea.id);
												const focused = client.focusedIdeaId === idea.id;
												const workspaceId = idea.workspaceId;
												const dragLabel = status === "open" && !openColumnRanked ? t("card.dragTakesOver") : t("card.drag");
												const dropBefore = dragTarget?.status === status && dragTarget?.hoverId === idea.id && dragTarget?.half === "before";
												const dropAfter = dragTarget?.status === status && dragTarget?.hoverId === idea.id && dragTarget?.half === "after";
												const dropNextId = columnIdeas[index + 1]?.id;
												return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: classes.cardWrapper,
													style: {
														position: "absolute",
														top: `${top}px`,
														left: 0,
														right: 0
													},
													ref: vcol.cardRef(idea.id),
													"data-dsh-idea-id": idea.id,
													"data-dsh-ideas-focused": focused ? "" : void 0,
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
														className: selected ? `${classes.card} ${classes.cardSelected}` : classes.card,
														"data-dsh-idea-id": idea.id,
														"data-selected": selected ? "" : void 0,
														"data-dsh-ideas-card-focused": focused ? "" : void 0,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																className: classes.cardHeader,
																children: [
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectBox, {
																		checked: selected,
																		label: t("bulk.select"),
																		onToggle: (shiftKey) => {
																			toggleRow(idea.id, shiftKey);
																		}
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
																		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaTitle, {
																			ideaNumber: idea.ideaNumber,
																			title: idea.title
																		})
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RunStateBadges, {
																		idea,
																		client,
																		parentNumber: parentNumberOf,
																		staleAfterDays: cfg.staleAfterDays,
																		now: renderedAt
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																		className: classes.cardGrip,
																		draggable: !client.pending,
																		title: dragLabel,
																		"aria-label": dragLabel,
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
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeaPreview, {
																excerpt: idea.bodyExcerpt,
																mdMode,
																onEdit: () => {
																	openEdit(idea);
																}
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RelationChips, { views: relationIndex.get(idea.id) }),
															status === "underReview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeliveryNote, { idea }),
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
																	children: t("card.updated", { date: shortDate$1(idea.updatedAt) })
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
																	idea.status === "open" && canFindSimilarHere(idea) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																		type: "button",
																		className: classes.actionButton,
																		disabled: client.pending,
																		title: t("card.findSimilarHint"),
																		"data-dsh-ideas-find-similar": "",
																		onClick: () => {
																			setFindingSimilar(idea);
																		},
																		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconFindSimilar, {}), t("card.findSimilar")]
																	}),
																	idea.status === "open" && canLaunch(idea) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																		type: "button",
																		className: classes.actionButton,
																		disabled: client.pending,
																		title: t("card.launchHint"),
																		"data-dsh-ideas-launch": "",
																		onClick: () => {
																			setLaunching(idea);
																		},
																		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlay, {}), t("card.launch")]
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
																			openFollowUp(idea);
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
											})
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: classes.columnResizer,
										role: "separator",
										"aria-orientation": "vertical",
										"data-resizing": resizingStatus === status ? "" : void 0,
										title: t("board.columnResize", {
											min: colLo,
											max: colHi
										}),
										"aria-label": t("board.columnResize", {
											min: colLo,
											max: colHi
										}),
										onPointerDown: (event) => {
											event.preventDefault();
											beginResize(status, event);
										},
										onDoubleClick: () => {
											resetColumnWidth(status);
										}
									})
								]
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
						grouped: workspaceFilter === "",
						parentNumber: parentNumberOf,
						staleAfterDays: cfg.staleAfterDays,
						now: renderedAt,
						selectedIds: selectedSet,
						onSelect: toggleRow,
						relations: relationIndex
					}) : activeTab === "delivered" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeliveredView, {
						client,
						archivedIdeas,
						workspaceTitle,
						onEdit: openEdit,
						onToggleTag: toggleTag,
						activeTags: tagFilter,
						mdMode,
						parentNumber: parentNumberOf,
						selectedIds: selectedSet,
						onSelect: toggleRow,
						relations: relationIndex
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HealthView, {
						client,
						scopeWorkspaceId: workspaceFilter,
						workspaceTitle,
						boardRevision: revision
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
						} : void 0,
						onFindSimilar: canFindSimilarHere(editing) ? (idea) => {
							setFindingSimilar(idea);
						} : void 0,
						onLaunch: editing.status === "open" && canLaunch(editing) ? (idea) => {
							setLaunching(idea);
						} : void 0
					}),
					findingSimilar !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SimilarModal, {
						client,
						idea: findingSimilar,
						workspaceTitle: workspaceTitle(findingSimilar.workspaceId ?? ""),
						onLaunch: findSimilarIdea,
						onClose: () => {
							setFindingSimilar(void 0);
						}
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
					}),
					launching !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LaunchModal, {
						client,
						idea: launching,
						workspaceTitle: workspaceTitle(launching.workspaceId ?? ""),
						onLaunch: launchIdea,
						onClose: () => {
							setLaunching(void 0);
						}
					}),
					bulk !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BulkDialog, {
						client,
						operation: bulk,
						rows: bulkSelected,
						catalog,
						scopeLabel,
						onClose: () => {
							setBulk(void 0);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/review-count.ts
		/**
		* The workspace scope the badge counts in.
		*
		* The sidebar row exists whether or not the board is mounted, so it cannot
		* read the board's own transient workspace selector — that state only exists
		* while the panel is open. What DOES exist outside the board is the persisted
		* scope (`rememberWorkspaceScope` + `workspaceScope`), which is by construction
		* "the workspace this reader works in", so:
		*  - remembered scope on -> count that workspace only;
		*  - remembered scope off -> count every workspace.
		*
		* `workspaceScope` is only meaningful with the remember option on: a stale id
		* left over from a previous session would otherwise silently hide every badge.
		*/
		function panelReviewScope(config) {
			if (!config.rememberWorkspaceScope) return "";
			const scope = config.workspaceScope.trim();
			if (scope === "" || scope === "__no-workspace__") return "";
			return scope;
		}
		/**
		* How many ideas sit in the review gate for one workspace scope. Only
		* `underReview` counts: that is the column whose every row is waiting on a
		* human verdict, and it is the only status a finished run can open.
		*
		* The tag filter and the text search are deliberately NOT applied — this is a
		* "how much is on my plate" signal, and a reviewer who filtered the board to
		* one tag must still learn that two runs finished elsewhere.
		*
		* @param ideas - the list rows already in memory (no request is made).
		* @param scope - '' for every workspace, or one workspace scope id.
		*/
		function underReviewCountOf(ideas, scope) {
			if (ideas === void 0) return 0;
			let count = 0;
			for (const idea of ideas) if (idea.status === "underReview" && matchesWorkspaceScope(idea, scope)) count += 1;
			return count;
		}
		//#endregion
		//#region src/client/panel-registration.tsx
		/**
		* Native panel registration for the Ideas board.
		*
		* The board is an official-style center-column panel, not a DOM takeover: it
		* contributes a row into the sidebar shell's own global panel list
		* (`sidebar.panellist`) and its page into the layout's keyed `main` slot. The
		* shell then owns the row box, the label, the font, the active highlight, the
		* collapsed rail and the panel switch, exactly as it does for Plugins, Task
		* Board and Skill Center.
		*
		* This replaces a raw injected `<button>` plus a self-owned visibility flag.
		* That arrangement is why Ideas behaved like a toggle — selecting another panel
		* never closed it, because the shell did not know the row existed — and why its
		* label and glyph did not match the shipped rows. With the seats, the shell is
		* the single source of panel truth, so the eviction broadcasts the old path
		* needed (ideas <-> taskboard <-> ssh) are gone with it.
		*
		* Both registrations go through `ctx.slots.inject`, which fires only once the
		* owning shell entry has declared the seat: load order between this plugin and
		* ui-layout / ui-sidebar does not matter, and a shell that cannot serve the
		* seats simply leaves Ideas absent instead of failing the boot.
		*/
		/** Row order among the shell's global panel rows (Plugins 0, Schedule 10, Task Board 20). */
		const PANEL_ORDER = 30;
		/**
		* How long to wait before calling a shell that never declared the seats
		* abnormal. Seat declaration is immediate in a healthy shell, so a longer
		* silence means the board will simply not appear.
		*/
		const SEAT_WAIT_MS = 1e4;
		/**
		* The client the panel row reads its badge from.
		*
		* Module-scoped because the shell hands the glyph component only its own
		* `{size, active}` props — there is no injection path into a `panellist` icon,
		* and `slots.register` takes the component by value rather than as a factory.
		* One module owns one panel row, so a module-level handle is the same scoping
		* the rest of this file already uses (`IdeasPanel` gets its client the same
		* way, from the registration closure); it is set and cleared with the
		* registration itself, never longer.
		*/
		let panelClient;
		/**
		* The number of ideas waiting in the review gate, read through the client's own
		* subscription (idea #91, part B).
		*
		* `useSyncExternalStore` over the client rather than a prop: the sidebar row
		* lives outside the board's React tree, and the shell re-renders this glyph
		* only when the panel list or the selection changes — a number that moved only
		* when a run settled would otherwise stay frozen at whatever it was when the
		* row last drew. The store read is a primitive number derived from the list
		* snapshot the poll already refreshes, so there is no new timer and no extra
		* request. With the board CLOSED that snapshot is as stale as every other part
		* of the panel (the poll is gated on the board being open), which is the
		* accepted trade: a badge that costs one request per open board is not a badge.
		*
		* Returns 0 when nothing is waiting — the badge is drawn by that absence, not
		* by an explicit zero, so an idle board wears no mark at all.
		*/
		function useReviewCount() {
			const client = panelClient;
			return (0, react.useSyncExternalStore)((onChange) => client === void 0 ? () => {} : client.subscribe(onChange), () => client === void 0 ? 0 : underReviewCountOf(client.snapshot?.ideas, panelReviewScope(client.config.value)), () => 0);
		}
		/**
		* The sidebar row glyph the shell asks for, at its own size and active state.
		* The shell owns the button, the label, the tooltip and the rail geometry;
		* this component draws only the glyph, like every other panel row.
		*
		* The glyph carries `data-dsh-panel-entry` because it is the only DOM this
		* plugin owns inside that shell-owned row: the L2 contract (skins) resolves
		* which row belongs to which plugin through it, the shell stamping no
		* per-entry hook of its own.
		*
		* A non-zero review count adds a small pill to the glyph's top-right corner
		* (`overflow: visible` lets it paint outside the 16px box, which is how a
		* badged nav icon is expected to look). The shell's panel-row contract has no
		* badge seat and takes no badge prop, so the glyph is the honest place to put
		* it rather than taking the row's DOM back.
		* @param props - the shell's icon share: square edge and selection state.
		* @returns the decorative ideas glyph.
		*/
		function IdeasPanelIcon({ size, active }) {
			const toReview = useReviewCount();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				"data-dsh-panel-entry": IDEAS_PANEL_ID,
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.3",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				style: toReview > 0 ? { overflow: "visible" } : void 0,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1.5a4.3 4.3 0 0 0-2.1 8c.5.3.8.8.8 1.4v.6h2.6v-.6c0-.6.3-1.1.8-1.4A4.3 4.3 0 0 0 8 1.5Z" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.6 13h2.8M6.9 14.5h2.2" }),
					toReview > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
						"data-dsh-ideas-review-count": toReview,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
							transform: "translate(9.4 -1.2) scale(0.72)",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
								x: "0",
								y: "0",
								width: badgeWidth(toReview),
								height: "11",
								rx: "5.5",
								fill: "hsl(38 92% 45%)",
								stroke: "none"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: badgeWidth(toReview) / 2,
								y: "8.4",
								textAnchor: "middle",
								fill: "#fff",
								stroke: "none",
								fontSize: "9",
								fontWeight: "700",
								children: toReview > 99 ? "99+" : toReview
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("title", { children: t("entry.reviewCountHint", { count: toReview }) })]
					})
				]
			});
		}
		/**
		* Pill width for a count, in the badge's own units: two round end-caps plus
		* roughly half a glyph per digit, so 1 and 12 both fit their pill instead of
		* overflowing it.
		*/
		function badgeWidth(count) {
			return 11 + (count > 99 ? 3 : String(count).length) * 5.4;
		}
		/**
		* The main-slot page. The layout mounts it only while the board is the
		* selected panel, so the conversation keeps the center column untouched the
		* rest of the time, and the wrapper carries the pinned `data-dsh-ideas-view`
		* semantic anchor the stylesheet and the L2 skin contract key on.
		*
		* Mount/unmount is also how the client learns the panel is shown or hidden:
		* `panelShown` / `panelHidden` mirror it onto `boardOpen`, which gates the
		* background poll (a closed board holds no connections and no traffic).
		* @param props - this entry's injected face: the ideas client.
		* @returns the board page.
		*/
		function IdeasPanel({ client }) {
			(0, react.useEffect)(() => {
				client.panelShown();
				return () => {
					client.panelHidden();
				};
			}, [client]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: classes.boardView,
				"data-dsh-ideas-view": "",
				"data-dsh-plugin": "ideas",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IdeasBoard, { client })
			});
		}
		/**
		* Register the board's sidebar row and center-column page.
		*
		* A shell that declares neither seat leaves Ideas simply absent, which is the
		* documented degradation — but silence is a bad diagnostic, so an unclaimed
		* seat is logged once rather than leaving the board to "just not be there".
		* @param ctx - client root context (services: slots).
		* @param client - the ideas client the panel renders.
		* @returns a disposer releasing both registrations and the watchdog.
		*/
		function registerIdeasPanel(ctx, client) {
			const slots = ctx.slots;
			panelClient = client;
			let declared = 0;
			/** Claim one seat, counting the ones the shell actually declares. */
			const seat = (key, contribute) => slots.inject(key, () => {
				declared += 1;
				return contribute();
			});
			const disposers = [seat("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: IDEAS_PANEL_ID,
				order: PANEL_ORDER,
				label: () => t("entry.label")
			}, IdeasPanelIcon)), seat("main", () => slots.register({
				name: "main",
				key: IDEAS_PANEL_ID,
				inject: () => ({ client })
			}, IdeasPanel))];
			const watchdog = setTimeout(() => {
				if (declared === 0) console.warn("[dsh-plugin-ideas-manager] no shell panel seat was declared (sidebar.panellist / main): the Ideas board will not appear.");
			}, SEAT_WAIT_MS);
			return () => {
				clearTimeout(watchdog);
				for (const dispose of disposers) dispose();
				if (panelClient === client) panelClient = void 0;
			};
		}
		//#endregion
		//#region src/client/about-panel.tsx
		/**
		* Reusable About panel component for plugin settings.
		* Accepts metadata and an optional update-check callback.
		*
		* Intended to be promoted to the shared eiffelbs-ui library and used
		* by all DSH plugins that expose an options panel, providing a
		* standardized "About" tab.
		*
		* Props:
		* - repositoryUrl: link to the plugin's GitHub repository
		* - version: plugin version string
		* - license: license identifier (e.g. "AGPL-3.0")
		* - compatibleVersions: compatible DSH version range / list
		* - onCheckUpdate: optional callback invoked when the user clicks
		*   "Check for updates"
		*/
		function AboutPanel({ repositoryUrl, version, license, compatibleVersions, onCheckUpdate }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-plugin-about-panel",
				role: "region",
				"aria-label": t("about.panelLabel"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-plugin-about-header",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
							className: "dsh-plugin-about-repo-link",
							href: repositoryUrl,
							target: "_blank",
							rel: "noopener noreferrer",
							children: [
								t("about.repository"),
								" ",
								repositoryUrl
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-plugin-about-details",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-plugin-about-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsh-plugin-about-label",
									children: [t("about.version"), ":"]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-plugin-about-value",
									children: version
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-plugin-about-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsh-plugin-about-label",
									children: [t("about.license"), ":"]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-plugin-about-value",
									children: license
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-plugin-about-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsh-plugin-about-label",
									children: [t("about.compatibleVersions"), ":"]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-plugin-about-value",
									children: compatibleVersions
								})]
							})
						]
					}),
					onCheckUpdate && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsh-plugin-about-check-update",
						onClick: onCheckUpdate,
						children: t("about.checkUpdate")
					})
				]
			});
		}
		//#endregion
		//#region src/client/settings-row.tsx
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
		//#endregion
		//#region src/client/backup-panel.tsx
		/**
		* Backup surface of the settings section (idea #95): timestamped snapshots of
		* the whole board, a restore that keeps what it replaces, and the portable
		* export/import that moves a ledger between machines.
		*
		* Three rules shape the panel, and all three are about being honest rather than
		* convenient:
		*
		*  - **A restore is loud before and after.** It asks first, spelling out that
		*    the current board is displaced but kept, and after the click it NAMES the
		*    snapshot holding the board that was replaced — "it was overwritten" and
		*    "you can go back to it" are different sentences.
		*  - **A refusal is a sentence, not a spinner.** The Host answers a refusal with
		*    its own reason (a run in flight, an unreadable file, a ledger written by
		*    another version) and the panel prints it verbatim. A restore that failed
		*    quietly is indistinguishable from one that worked.
		*  - **Nothing here depends on the settings service.** The panel drives its own
		*    routes, so a deployment whose settings surface is unavailable still gets
		*    snapshots and restore; only the display options above are degraded.
		*
		* The download is a plain link to the Host's content route, not a blob: the
		* bytes are the ledger's own, so the file the browser stores is exactly the
		* document a restore adopts on the other machine.
		*/
		/** Compact human size, so the list reads without counting digits. */
		function sizeLabel(bytes) {
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}
		/** Timestamp of a snapshot, in the reader's own locale. */
		function dateLabel(at) {
			try {
				return new Date(at).toLocaleString();
			} catch {
				return String(at);
			}
		}
		/** What one snapshot IS, from its stamp (or from the fact it is a foreign file). */
		function reasonLabel(snapshot) {
			if (snapshot.foreign) return t("backup.item.foreign");
			if (snapshot.reason === "export") return t("backup.item.export");
			if (snapshot.reason === "pre-restore") return t("backup.item.preRestore");
			return t("backup.item.manual");
		}
		/**
		* Read a picked file as text.
		*
		* `FileReader` rather than `File.text()`: the promise form is the one every
		* browser implements (and the one a DOM double implements too), and a reader
		* also reports a file it cannot open as an error instead of resolving to an
		* empty string — which would look exactly like an empty ledger.
		*/
		function readFileText(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					resolve(typeof reader.result === "string" ? reader.result : "");
				};
				reader.onerror = () => {
					reject(reader.error ?? /* @__PURE__ */ new Error("the file could not be read"));
				};
				reader.readAsText(file);
			});
		}
		/** Compact date + size line of one snapshot. */
		function backupItemMeta(snapshot) {
			return t("backup.itemMeta", {
				date: dateLabel(snapshot.createdAt),
				size: sizeLabel(snapshot.bytes)
			});
		}
		function BackupPanel({ client }) {
			const [, bump] = (0, react.useState)(0);
			(0, react.useEffect)(() => client.subscribe(() => {
				bump((count) => count + 1);
			}), [client]);
			const [loading, setLoading] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(void 0);
			const fileInput = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (loading) return;
				setLoading(true);
				client.loadBackups().finally(() => {
					setLoading(false);
				});
			}, [client]);
			const view = client.backups;
			const pending = client.backupPending;
			const disabled = pending || loading;
			const exported = client.exported;
			const restore = client.lastRestore;
			const onImportFile = async (event) => {
				const file = event.target.files?.[0];
				event.target.value = "";
				if (file === void 0) return;
				try {
					await client.restoreSnapshot({ document: await readFileText(file) });
				} catch (error) {
					client.reportBackupError(error instanceof Error ? error.message : String(error));
				}
			};
			if (!client.backupAvailable) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				className: classes.settingsSection,
				"data-dsh-ideas-backup": "",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: classes.settingsNote,
					children: t("backup.unavailable")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: classes.settingsSection,
				"data-dsh-ideas-backup": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: classes.settingsIntro,
						children: t("backup.intro")
					}),
					client.backupError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.settingsError,
						children: t("backup.failed", { error: client.backupError })
					}),
					view?.running !== void 0 && view.running > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.backupStatusWarn,
						children: t("backup.restoreBusy")
					}),
					restore !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.backupStatus,
						children: t("backup.restoreDone", {
							source: restore.source,
							count: restore.ideas,
							displaced: restore.displaced.name
						})
					}),
					restore !== void 0 && restore.unknownFields.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: classes.backupStatusWarn,
						"data-dsh-ideas-backup-unknown": "",
						children: t("backup.restoreUnknownFields", { fields: restore.unknownFields.join(", ") })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.settingsCard,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.settingsGroup,
								children: t("backup.groupSnapshots")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("backup.export"),
								desc: t("backup.exportDesc", { retention: view?.retention ?? 0 }),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.primaryButton,
									disabled,
									"aria-label": t("backup.exportAction"),
									onClick: () => {
										client.takeSnapshot("export");
									},
									children: pending ? t("backup.pending") : t("backup.exportAction")
								})
							}),
							exported !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								className: classes.backupDownload,
								href: client.snapshotContentUrl(exported.name) ?? "#",
								download: exported.name,
								children: t("backup.exported", { name: exported.name })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("backup.import"),
								desc: t("backup.importDesc"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									ref: fileInput,
									className: classes.backupFile,
									type: "file",
									accept: "application/json,.json",
									disabled,
									"aria-label": t("backup.importAction"),
									onChange: (event) => {
										onImportFile(event);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: classes.ghostButton,
									disabled,
									onClick: () => {
										fileInput.current?.click();
									},
									children: t("backup.importAction")
								})] })
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classes.settingsCard,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: classes.settingsGroup,
								children: t("backup.listLabel")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: classes.settingsRowDesc,
								children: t("backup.retention", { retention: view?.retention ?? 0 })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classes.backupList,
								children: [(view?.snapshots ?? []).map((snapshot) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: classes.backupItem,
									"data-dsh-snapshot": snapshot.name,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: classes.backupItemMeta,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: reasonLabel(snapshot) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: backupItemMeta(snapshot) })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: classes.backupItemActions,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
												className: classes.ghostButton,
												href: client.snapshotContentUrl(snapshot.name) ?? "#",
												download: snapshot.name,
												children: t("backup.download")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: classes.ghostButton,
												disabled,
												title: t("backup.restoreHint"),
												"aria-label": t("backup.restore"),
												onClick: () => {
													setConfirming(confirming === snapshot.name ? void 0 : snapshot.name);
												},
												children: t("backup.restore")
											})]
										}),
										confirming === snapshot.name && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: classes.backupItemActions,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: classes.settingsRowDesc,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("backup.restoreConfirm") }),
														" ",
														t("backup.restoreConfirmDesc")
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: classes.dangerButton,
													"aria-label": t("backup.restoreYes"),
													onClick: async () => {
														setConfirming(void 0);
														await client.restoreSnapshot({ name: snapshot.name });
													},
													children: t("backup.restoreYes")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: classes.ghostButton,
													"aria-label": t("backup.restoreNo"),
													onClick: () => {
														setConfirming(void 0);
													},
													children: t("backup.restoreNo")
												})
											]
										})
									]
								}, snapshot.name)), (view?.snapshots ?? []).length === 0 && !loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classes.settingsNote,
									children: t("backup.empty")
								})]
							})
						]
					})
				]
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
		* Three jobs, one install function:
		*  - applyTagChipRows runs on every IdeasClient config change and pushes the
		*    `tagRows` row budget onto the document (--dsh-ideas-tag-rows), which
		*    the tag-zone rule reads through calc();
		*  - the Display and About tabs render the plugin's own copy of its options
		*    and its metadata;
		*  - registerIdeasSettingsSection contributes the nav row + page when the
		*    shell exposes the slots contract; a shell without it still gets the
		*    style wiring (never throws - the GUI must survive this plugin).
		*
		* The Backup tab (idea #95, `client/backup-panel.tsx`) drives its OWN Host
		* routes rather than the settings port, so a deployment whose settings service
		* is unavailable still gets snapshots, restore and the portable export: only
		* the display options above degrade to the spelled defaults.
		*
		* Copy discipline: every option carries an explicit title AND a description
		* stating what it changes, its range/default and when it applies; failures
		* render inline instead of silently reverting. Controls commit immediately
		* (selects and toggle switches), except the number row which stages its draft
		* and commits on blur/Enter so typing never writes per keystroke.
		*/
		/**
		* Plugin metadata for the About section. `version` is injected from
		* package.json at build time — never spelled out here. The typeof guard keeps
		* the module importable where no bundler ran (a bare vitest pass, a plain
		* typecheck); only a real bundle ever prints the fallback.
		*/
		const PLUGIN_METADATA = {
			repositoryUrl: "https://github.com/EiffelBS/dsh-plugin-ideas-manager",
			version: "0.8.0",
			license: "MIT",
			compatibleVersions: ">=0.1.5-rc.1"
		};
		/**
		* Push the tag-filter row budget (settings option `tagRows`, 1..5) onto the
		* document as --dsh-ideas-tag-rows; the tag-zone rule reads it through
		* calc(). Idempotent and clamped, so a corrupt wire can never break layout.
		*/
		function applyTagChipRows(rows) {
			if (typeof document === "undefined") return;
			document.documentElement.style.setProperty("--dsh-ideas-tag-rows", String(clampTagRows(rows)));
		}
		/**
		* One numeric option row (idea #53 column-width bounds): title + description on
		* the left, a clamped number input on the right that stages its draft and
		* commits on blur/Enter — the same discipline as the tagRows row, so typing
		* never writes per keystroke and a failed save reverts to the stored value.
		*/
		function NumberRow({ field, title, desc, value, min, max, clamp, disabled, onSave }) {
			const [draft, setDraft] = (0, react.useState)(void 0);
			const commit = () => {
				if (draft === void 0) return;
				const text = draft.trim();
				setDraft(void 0);
				if (text === "") return;
				const parsed = Number(text);
				if (!Number.isFinite(parsed)) return;
				const clamped = clamp(parsed);
				if (clamped === value) return;
				onSave({ [field]: clamped });
			};
			const onKeyDown = (event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				commit();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
				title,
				desc,
				control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: classes.settingsNumber,
					type: "number",
					inputMode: "numeric",
					min,
					max,
					step: 1,
					value: draft ?? String(value),
					disabled,
					"aria-label": title,
					onChange: (event) => {
						setDraft(event.target.value);
					},
					onBlur: commit,
					onKeyDown
				})
			});
		}
		/** The section page: heading, tabs, status lines, and the option rows. */
		function IdeasSettingsSection({ client }) {
			const [, bump] = (0, react.useState)(0);
			(0, react.useEffect)(() => client.subscribe(() => {
				bump((count) => count + 1);
			}), [client]);
			const [activeTab, setActiveTab] = (0, react.useState)("display");
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
				delivered: t("tab.delivered"),
				health: t("tab.health")
			};
			const densityLabels = {
				comfortable: t("settings.densityComfortable"),
				compact: t("settings.densityCompact")
			};
			const languageLabels = {
				auto: t("settings.languageAuto"),
				en: t("settings.languageEn"),
				fr: t("settings.languageFr"),
				zh: t("settings.languageZh")
			};
			const openOrderingLabels = {
				createdAt: t("settings.openOrderingCreatedAt"),
				createdAtDesc: t("settings.openOrderingCreatedAtDesc"),
				rank: t("settings.openOrderingRank")
			};
			const runPermissionLabels = {
				"read-only": "read-only",
				"workspace-write": "workspace-write",
				"danger-full-access": "danger-full-access"
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
						className: classes.tabs,
						role: "tablist",
						"aria-label": t("about.tabs"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								role: "tab",
								"aria-selected": activeTab === "display",
								className: activeTab === "display" ? classes.tabActive : classes.tab,
								onClick: () => setActiveTab("display"),
								children: t("about.tabDisplay")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								role: "tab",
								"aria-selected": activeTab === "backup",
								className: activeTab === "backup" ? classes.tabActive : classes.tab,
								onClick: () => setActiveTab("backup"),
								children: t("about.tabBackup")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								role: "tab",
								"aria-selected": activeTab === "about",
								className: activeTab === "about" ? classes.tabActive : classes.tab,
								onClick: () => setActiveTab("about"),
								children: t("about.tabAbout")
							})
						]
					}),
					activeTab === "display" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
								title: t("settings.language"),
								desc: t("settings.languageDesc"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									className: classes.settingsSelect,
									value: value.language,
									disabled,
									"aria-label": t("settings.language"),
									onChange: (event) => {
										save({ language: event.target.value });
									},
									children: IDEAS_LANGUAGES.map((language) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: language,
										children: languageLabels[language]
									}, language))
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.directRunPermission"),
								desc: t("settings.directRunPermissionDesc"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									className: classes.settingsSelect,
									value: value.directRunPermission,
									disabled,
									"aria-label": t("settings.directRunPermission"),
									onChange: (event) => {
										save({ directRunPermission: event.target.value });
									},
									children: IDEAS_RUN_PERMISSIONS.map((permission) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: permission,
										children: runPermissionLabels[permission]
									}, permission))
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
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
								field: "columnMinWidth",
								title: t("settings.columnMinWidth"),
								desc: t("settings.columnMinWidthDesc"),
								value: value.columnMinWidth,
								min: COLUMN_MIN_WIDTH_RANGE.min,
								max: COLUMN_MIN_WIDTH_RANGE.max,
								clamp: clampColumnMinWidth,
								disabled,
								onSave: save
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
								field: "columnMaxWidth",
								title: t("settings.columnMaxWidth"),
								desc: t("settings.columnMaxWidthDesc"),
								value: value.columnMaxWidth,
								min: COLUMN_MAX_WIDTH_RANGE.min,
								max: COLUMN_MAX_WIDTH_RANGE.max,
								clamp: clampColumnMaxWidth,
								disabled,
								onSave: save
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
								field: "staleAfterDays",
								title: t("settings.staleAfterDays"),
								desc: t("settings.staleAfterDaysDesc"),
								value: value.staleAfterDays,
								min: STALE_AFTER_DAYS_RANGE.min,
								max: STALE_AFTER_DAYS_RANGE.max,
								clamp: clampStaleAfterDays,
								disabled,
								onSave: save
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
								title: t("settings.openOrdering"),
								desc: t("settings.openOrderingDesc"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									className: classes.settingsSelect,
									value: value.openOrdering,
									disabled,
									"aria-label": t("settings.openOrdering"),
									onChange: (event) => {
										save({ openOrdering: event.target.value });
									},
									children: IDEAS_OPEN_ORDERINGS.map((ordering) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: ordering,
										children: openOrderingLabels[ordering]
									}, ordering))
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRow, {
								title: t("settings.runningFirst"),
								desc: t("settings.runningFirstDesc"),
								controlOnTitle: true,
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classes.settingsToggle,
									type: "checkbox",
									checked: value.runningFirst,
									disabled,
									"aria-label": t("settings.runningFirst"),
									onChange: (event) => {
										save({ runningFirst: event.target.checked });
									}
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
					})] }),
					activeTab === "backup" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BackupPanel, { client }),
					activeTab === "about" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classes.aboutPanel,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AboutPanel, {
							repositoryUrl: PLUGIN_METADATA.repositoryUrl,
							version: PLUGIN_METADATA.version,
							license: PLUGIN_METADATA.license,
							compatibleVersions: PLUGIN_METADATA.compatibleVersions,
							onCheckUpdate: () => {
								window.open(`${PLUGIN_METADATA.repositoryUrl}/releases`, "_blank", "noopener,noreferrer");
							}
						})
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
		//#region src/client/session-opener.ts
		/**
		* Session opener (idea #66): the one way back into the conversation a card was
		* worked on.
		*
		* The Host settles a run on its own (the launch records the session it ran in,
		* whether that was a mirrored card or a fresh direct session), but the human
		* still has to be able to LOOK at it. A row of ideas saying "running" does not
		* show a token stream — it only says a run exists. This resolves the shell's
		* navigation face so a card carrying a `runSessionId` can jump straight to the
		* conversation, with no new surface to learn and no tab to open.
		*
		* TWO NAMES, because the plugin declares compatibility from DSH 0.1.5-rc.1 and
		* the way to show a session has moved: `uiWorkspace.openSession(id)` is the
		* documented navigation face (`@deepseek-ai/dsh-client-ui-workspace`), and
		* `sessions.open(id)` is probed second for an older host that served it. Both
		* are feature-detected, so a deployment with neither renders no link rather than
		* a broken button — and the caller WARNS in that case, because a link missing
		* because the name is wrong looks exactly like a link missing because the
		* deployment does not support it, and only one of those is a bug.
		*
		* Services are read through `ctx.get(name)`, never as a property: cordis refuses
		* an undeclared property read, and a resolver that trusted one produced a
		* navigator that silently did nothing (see `panel-navigation.ts` for the same
		* lesson). The property read survives only as a second chance for a context
		* whose service really is a property — a test double, an older shell.
		*/
		/**
		* The faces that have carried "show this session", most current first. Ordered
		* so a host serving both uses the one its own UI navigates with.
		*/
		const OPENER_FACES = [{
			service: "uiWorkspace",
			method: "openSession"
		}, {
			service: SESSIONS_SERVICE$1,
			method: "open"
		}];
		/**
		* Resolve the opener from a client context, or undefined when the page serves no
		* usable navigation face. Never throws: an undeclared property read is caught
		* exactly like an absent service.
		*
		* @param ctx - the client root context.
		* @returns the opener, or undefined when no navigation face is reachable.
		*/
		function resolveSessionOpener(ctx) {
			for (const { service, method } of OPENER_FACES) {
				const face = readServiceFace(ctx, service);
				if (face === void 0) continue;
				const open = face[method];
				if (typeof open !== "function") continue;
				const target = face;
				return { open(sessionId) {
					if (sessionId === "") return;
					open.call(target, sessionId);
				} };
			}
		}
		/**
		* One value out of a context by name, or undefined. Never throws.
		*
		* BOTH readings are tried, and that is not belt-and-braces: on a real cordis
		* context `ctx.get(name)` looks up a SERVICE, while `ctx[name]` goes through the
		* context proxy — which serves declared context PROPERTIES too (`events`,
		* `logger`, `reflect`, `registry` are properties, not services). A reader that
		* picks one therefore misses half the surface: the first version of this file
		* probed `ctx.get('reflect')` only, `get` existed, so the property fallback never
		* ran and the diagnostic reported an empty page.
		*/
		function readService(ctx, name) {
			if (ctx === null || typeof ctx !== "object" && typeof ctx !== "function") return void 0;
			const host = ctx;
			const viaAccessor = () => typeof host.get === "function" ? host.get.call(ctx, name) : void 0;
			try {
				const found = viaAccessor();
				if (found !== void 0 && found !== null) return found;
			} catch {}
			try {
				return host[name];
			} catch {
				return;
			}
		}
		/** One service out of a context by NAME, or undefined. Never throws. */
		function readServiceFace(ctx, name) {
			const candidate = readService(ctx, name);
			if (typeof candidate !== "object" || candidate === null) return void 0;
			return candidate;
		}
		/**
		* Every service name this page declares — the complete picture, for when the
		* filtered list above is not enough.
		*
		* The verb-filtered list answers "what could open something"; this answers "what
		* is here at all", which is what identifies a face whose method is named
		* something the filter never imagined (`navigate`, `show`, `goto`) or a page
		* that navigates by URL rather than by service. Sorted and bounded so it stays
		* one console line.
		*/
		function serviceNames(ctx) {
			const props = readService(ctx, "reflect")?.props;
			if (typeof props !== "object" || props === null) return [];
			return Object.keys(props).sort().slice(0, SERVICES_REPORTED);
		}
		/** How many service names the diagnostic is allowed to print. */
		const SERVICES_REPORTED = 60;
		/**
		* What this page CAN do to show a session — the honest companion to a missing
		* link.
		*
		* A dead feature that says only "no navigation face" is unactionable: the
		* reader has no way to tell a wrong name from an unsupported deployment, and the
		* answer is sitting in the context, enumerable. The reflection layer holds every
		* declared context property BY NAME (`ctx.reflect.props`), so the diagnostic
		* reads that, resolves each value, and names the methods that could open or focus
		* something. It is bounded and sorted: a console line a developer can act on, not
		* a page dump. Empty means the context could not be enumerated — which is itself
		* a fact worth keeping: the plugin's client half may be running on a context
		* scoped to its own declared dependencies rather than the application root.
		*
		* @returns `name.method` pairs, empty when the context cannot be enumerated.
		*/
		function navigationFaces(ctx) {
			const props = readService(ctx, "reflect")?.props;
			if (typeof props !== "object" || props === null) return [];
			const found = [];
			for (const name of Object.keys(props)) {
				const value = readService(ctx, name);
				if (typeof value !== "object" || value === null) continue;
				const members = value;
				for (const key of Object.keys(members)) {
					if (typeof members[key] !== "function") continue;
					if (!/open|focus|reveal|select|activate/i.test(key)) continue;
					found.push(`${name}.${key}`);
				}
			}
			return found.sort().slice(0, FACES_REPORTED);
		}
		/** How many candidate faces the diagnostic is allowed to name. */
		const FACES_REPORTED = 12;
		//#endregion
		//#region src/client/deeplink-service.ts
		/** The cordis service name other plugins reach the ideas board through. */
		const IDEAS_BOARD_SERVICE = "ideas-manager.board";
		/**
		* Build the published face over an ideas client.
		*
		* @param client - the client the board panel renders from.
		* @returns the service value to hand to `ctx.provide`.
		*/
		function createIdeasBoardService(client) {
			return {
				focusIdea: (ref) => {
					client.requestFocus(ref);
				},
				get focusedIdeaId() {
					return client.focusedIdeaId;
				},
				get lastFocusOutcome() {
					return client.focusResult?.outcome;
				}
			};
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
		/** The missing-navigation warning is emitted once per page, not per state update. */
		let warnedAboutNavigation = false;
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
				client.sessionOpener = resolveSessionOpener(ctx);
				if (client.sessionOpener === void 0 && !warnedAboutNavigation) {
					warnedAboutNavigation = true;
					const faces = navigationFaces(ctx);
					const names = serviceNames(ctx);
					console.warn(`[dsh-plugin-ideas-manager] no session navigation face on this page (tried uiWorkspace.openSession, sessions.open): the "Open session" link will not be shown${faces.length === 0 ? "; no navigation face could be enumerated on this context" : `; pages offering one: ${faces.join(", ")}`}${names.length === 0 ? "" : `; page services: ${names.join(", ")}`}`);
				}
				client.panelNavigator = resolvePanelNavigator(ctx);
				client.start();
				const disposers = [];
				try {
					disposers.push(registerIdeasPanel(ctx, client));
				} catch (error) {
					console.error("[dsh-plugin-ideas-manager] panel registration failed:", error);
				}
				try {
					disposers.push(ctx.provide(IDEAS_BOARD_SERVICE, createIdeasBoardService(client)));
				} catch (error) {
					console.error("[dsh-plugin-ideas-manager] deep-link service registration failed:", error);
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
			}, "ideas: panel registration and settings section");
		}
		//#endregion
		exports.HttpIdeasHostTransport = HttpIdeasHostTransport;
		exports.IDEAS_BOARD_SERVICE = IDEAS_BOARD_SERVICE;
		exports.IdeasClient = IdeasClient;
		exports.apply = apply;
		exports.createIdeasBoardService = createIdeasBoardService;
		exports.focusReadQuery = focusReadQuery;
		exports.inject = inject;
		exports.parseIdeaRef = parseIdeaRef;
		exports.resolveIdeaRef = resolveIdeaRef;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map