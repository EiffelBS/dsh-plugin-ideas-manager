# Tableau des idées

Gardez un backlog d'idées dans l'interface DSH, triez-le sur un tableau kanban,
et transformez l'idée retenue en exécution réelle sans quitter la page.

## Ouvrir le tableau

Sélectionnez **Tableau des idées** dans la barre latérale, sous Nouvelle session.
Le tableau est un panneau global comme les autres : passer à un autre panneau le
ferme, et le badge de sa ligne indique combien d'idées attendent en **En revue**.

## Capturer et trier

- **Nouvelle idée** (ou la ligne de saisie rapide en haut de la colonne Ouvert)
  demande un titre, une description Markdown facultative, des étiquettes et un
  rang suggéré.
- **Capture IA** confie le brouillon à une nouvelle session d'analyse et vous y
  bascule. L'analyste écrit ensuite la carte sur le tableau avec son analyse, un
  titre amélioré, des étiquettes, une note valeur/effort et un rang suggéré.
- Chaque carte affiche son numéro stable, son espace de travail, ses étiquettes,
  ses badges valeur/effort et sa date de mise à jour. Faites glisser les cartes
  entre les quatre colonnes — **Ouvert**, **En revue**, **Archivé**, **Refusé** —
  ou réordonnez-les dans une colonne.
- **Recherche** et filtre par étiquette restreignent tout le tableau. L'onglet
  **Priorités** montre le classement, **Livré** les idées validées, et **Santé**
  une réponse d'une ligne par question du backlog.

## Lancer une idée

**Lancer** démarre l'idée comme exécution. Quand le plugin TaskBoard est installé,
une carte TaskBoard reflète l'idée et l'exécution s'y déroule ; sinon le plugin
ouvre une session directe dans l'espace de travail de l'idée. **Ouvrir la
session** sur une carte lancée ramène à la session qui a travaillé dessus, et la
porte de revue décide si le résultat est livré ou renvoyé.

## Réglages

L'engrenage dans l'en-tête du tableau ouvre la section de ce plugin dans la
fenêtre Réglages de DSH : options d'affichage (onglet par défaut, ordre,
densité des cartes, langue, rendu Markdown, seuil d'ancienneté),
**Sauvegarde** (instantanés horodatés, restauration, export et import
portables) et **À propos**.

## Prérequis

- Interface web DSH 0.1.5-rc.1 ou plus récente.
- Le plugin TaskBoard est facultatif ; le tableau des idées fonctionne sans lui.
- L'hôte détient le registre (`~/.dsh/ideas/ledger-v2.json`) ; les agents et
  l'interface le lisent et l'écrivent via les routes `/api/ideas` du plugin.
