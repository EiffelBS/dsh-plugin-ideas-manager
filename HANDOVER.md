# HANDOVER — plugin DSH `dsh-ideas` (gestionnaire d'idées générique)

> Lire ce fichier en premier avant toute implémentation. Il contient
> l'analyse complète et les décisions figées issues de la session de
> conception (workspace OpenTimbre). Repo : https://github.com/EiffelBS/dsh-plugin-ideas-manager.git

## 1. Contexte et objectif

OpenTimbre gère ses idées produit via `docs/IDEAS.md` (backlog ouvert) +
`docs/IDEAS-ARCHIVE.md` (livré/refusé), avec triage manuel et miroir vers le
plugin TaskBoard DSH (1 idée = 1 carte `read-only` en `backlog`).
L'objectif est d'en faire un **plugin DSH générique et réutilisable**
(`dsh-ideas`), utilisable par n'importe quel workspace, avec :
- une entrée sidebar injectée **sous le bouton "New Session"** (comme TaskBoard) ;
- un kanban simple + capture d'idées ;
- un ledger propre au plugin + export markdown ;
- un **pont optionnel** vers le TaskBoard (miroir si installé, autonome sinon).

## 2. Décisions figées (ne pas rouvrir sans l'auteur)

1. **Donnée = ledger plugin + export.** Ledger Host
   `~/.dsh/ideas/ledger-v2.json` (par workspace). Export markdown
   **unidirectionnel** ledger → md. Jamais de parse md → ledger.
2. **Plugin générique** multi-workspace, pas spécifique OpenTimbre.
3. **Lien TaskBoard optionnel par feature-detect runtime**
   (`GET /api/task-board/state`). Présent = miroir `create` + `move backlog` /
   `update` / `decline` → `archive`, livraison = closure-run vers `done`.
   Absent = tout fonctionne sauf "Promouvoir". **Aucun import dur.**
4. **MVP UI = kanban 3 colonnes** (Ouvertes / Archivées / Refusées) +
   recherche + modale création/édition (titre, body, valeur/effort, tags,
   rank manuel) + drag manuel open↔archived. Pas de triage auto au MVP.

## 3. Référence à lire (contrat réel, vérifié)

```
~/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/  (v0.3.22)
  package.json        # blocs dsh.bundle.patch + dsh.client.inject (à copier)
  cordis.patch.yml    # - insert: [{id: ui-ideas, name: 'dsh-ideas'}]
  src/index.ts        # apply + mountOnce + Config + guidance système
  src/protocol.ts     # préfixe, types, parseEnvelopeAction (exactKeys)
  src/host-routes.ts  # GET state / POST action / GET events + garde loopback
  lib/client.js       # recette injection sidebar (MutationObserver entre
                      # New Session et browser workspace + takeover central
                      # via data-attribute) + takeover panneau central
```

Le shell DSH n'expose **aucun slot** : l'entrée sidebar s'injecte en DOM
entre le bouton New Session et le browser workspace, avec `MutationObserver`
self-heal. Préfixe CSS propre, tokens `var(--dsw-*)`, support sidebar
collapsed. Deuxième ligne sous TaskBoard si les deux sont actifs
(ordre d'insertion à gérer).

## 4. Contrat Host API (copie la discipline TaskBoard)

- Préfixe : `/api/ideas`. Garde identique : socket loopback + marqueurs
  same-origin (`Origin` / `Referer` / `Sec-Fetch-Site` /
  `X-Requested-With`), `Content-Type: application/json` exigé,
  limites 64 Ko (action) / 2 Mo (import).
- Enveloppe **exactKeys strict** (`invalid-action` sinon) :
  `{ "requestId": "<non-vide ≤256>", "action": { "kind": "..." },
    "initiator": "<opt>" }`, `requestId` dédupé côté service.
- `GET /api/ideas/state` → `{ schemaVersion: 1, revision, ideas[] }`
- `POST /api/ideas/action`, verbes :

| kind | clés exactes | notes |
|---|---|---|
| `create` | kind, id, input | input exactKeys : `title*`, `body*`, `workspaceId`, `rank`, `value`, `effort`, `tags`. Démarre `open`. |
| `update` | kind, ideaId, patch | patch exactKeys : `title`, `body`, `rank`, `value`, `effort`, `tags`, `workspaceId`. `null` = clear tags. |
| `move` | kind, ideaId, status | `open` ↔ `archived` manuel ; `declined` via `decline`. |
| `decline` | kind, ideaId | → `declined` + `archivedAt`. Miroir TaskBoard `archive`. |
| `restore` | kind, ideaId | `archived`/`declined` → `open`. |
| `delete` | kind, ideaId | hard remove. |
| `reorder` | kind, orderedIds | réécrit les `rank` 1..n (triage). |
| `import` | kind, sourceId, ideas | bulk (migration OT) ; refuse champs exécutables comme TaskBoard (`command`/`shell`/…). |
| `export` | kind, workspaceId | retourne `{ ideasMd, archiveMd }` générés, **n'écrit pas** (l'agent écrit). |

- `IdeaRecord` : `{ id, title (≤200), body (≤32 Ko), status: open|archived|declined,
  rank?, value?, effort?, tags? [{ name ≤32, promptPrefix? }] (≤8),
  workspaceId?, taskBoardId?, createdAt, updatedAt, archivedAt? }`
- Erreurs : `forbidden` (403), `json-required` (415), `invalid-action` (400),
  `body-too-large` (413), `not-found` (400).
- `GET /api/ideas/events` → SSE `{ revision }` (pas de liste, comme TaskBoard).
- Settings namespace `ideas` : `enabled`, `announceToAgent` (défaut false,
  comme TaskBoard), `autoMirror` (défaut true). Sysprompt discret.

## 5. Arborescence cible

```
dsh-plugin-ideas-manager/
  package.json            # name: dsh-plugin-ideas-manager, main lib/index.js
  cordis.patch.yml        # insert id ui-ideas
  tsconfig.json / tsconfig.build.json
  src/
    index.ts              # apply + mountOnce + Config + guidance
    protocol.ts           # préfixe, types, parseEnvelopeAction
    host-service.ts       # ledger, revision, snapshot, apply()
    host-routes.ts        # routes + garde loopback
    host-ledger.ts        # load/save/migrate ledger
    taskboard-bridge.ts   # détection + miroir (aucun import dur)
    export-markdown.ts    # ledger -> IDEAS.md / IDEAS-ARCHIVE.md
    http.ts / loopback.ts # pattern TaskBoard, pas réinventé
    core/ideas.ts         # types IdeaRecord, statuts, validation tags
    client/
      sidebar-entry.ts    # injection sous New Session
      board-view.tsx      # kanban (React 18)
      api.ts              # fetch state/action + marqueurs same-origin
  tests/                  # vitest : protocol exactKeys, ledger migrate, export golden
  README.md + SKILL.md    # usage agent (contrat, verbes, gotchas PowerShell :
                          # Invoke-RestMethod -UseBasicParsing, jamais
                          # Invoke-WebRequest en non-interactif)
```

Build : `tsc + tsdown` (comme TaskBoard). Install dev :
`dsh plugin --profile web add link:<cwd>`.

## 6. Phases et acceptance

- **P0** squelette dual-face + sidebar + kanban sur mock → visible sous
  New Session, install `link:` OK.
- **P1** ledger + routes + persistance + export → CRUD + restart-safe.
- **P2** pont TaskBoard + settings + SKILL.md → miroir vérifié avec
  TaskBoard 0.3.22 (create→move backlog, update, decline→archive,
  closure-run→done documenté, pas auto).
- **P3** migration OT (import one-shot des sections `## Idea #N` de
  l'OT `IDEAS.md` #4–#23 + archive → `import`, vérif comptage, export-golden
  diff revu à la main) + README.

**Acceptance P0** : build OK, entrée visible sous New Session, kanban vide
sur ledger mock, zéro dépendance au TaskBoard. Commits petits, push `main`
en fin de phase.

## 7. Carte TaskBoard liée

Carte `ideas-plugin-p0-scaffold` (status `todo`, `workspace-write`, pinnée
à ce workspace) : c'est le suivi d'exécution. Son prompt est volontairement
court — **ce fichier fait foi** en cas de divergence.
