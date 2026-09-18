/**
 * Ideas board copy: French-first dictionary with an English fallback, selected
 * by the document language. Kept dependency-free (no dsh locale service) so
 * the DOM-injected entry row and the standalone board tree share one lookup.
 */

export const fr = {
  'entry.label': 'Idées',
  'entry.tooltip': 'Tableau des idées',
  'board.title': 'Idées',
  'board.close': 'Retour au chat',
  'board.new': 'Nouvelle idée',
  'board.search': 'Filtrer les idées…',
  'board.revision': 'révision {revision}',
  'board.status.open': 'Ouvertes',
  'board.status.archived': 'Archivées',
  'board.status.declined': 'Refusées',
  'board.empty': 'Aucune idée ici',
  'board.emptyFiltered': 'Aucune idée ne correspond au filtre',
  'board.hostError': "Échec de l'opération Host : {error}",
  'board.retryHost': 'Réessayer la connexion Host',
  'board.tagFilter': 'Filtre :',
  'board.tagFilterClear': 'Effacer le filtre',
  'board.dragHint': 'Glissez les cartes entre Ouvertes et Archivées (poignée ⠿ en haut du titre)',
  'board.mdToggleLabel': 'Affichage des descriptions',
  'board.mdView': 'MD',
  'board.textView': 'Texte',
  'new.title': 'Titre',
  'new.titlePlaceholder': "Une phrase qui résume l'idée",
  'new.body': 'Description',
  'new.bodyPlaceholder': 'Contexte, valeur, effort, acceptation (optionnel)',
  'new.tags': 'Étiquettes (optionnelles)',
  'new.tagsPlaceholder': 'séparées par des virgules',
  'new.value': 'Valeur',
  'new.effort': 'Effort',
  'new.levelNone': '— non défini —',
  'new.submit': 'Créer',
  'new.cancel': 'Annuler',
  'new.required': 'Le titre est requis',
  'card.drag': 'Faire glisser',
  'card.clickToEdit': 'Cliquer pour modifier',
  'card.value': 'Valeur {level}',
  'card.effort': 'Effort {level}',
  'card.updated': 'màj {date}',
  'card.edit': 'Modifier',
  'card.archive': 'Archiver',
  'card.decline': 'Refuser',
  'card.restore': 'Restaurer',
  'card.delete': 'Supprimer',
  'card.confirmDelete': 'Confirmer la suppression ?',
  'card.deleteYes': 'Oui',
  'card.deleteNo': 'Non',
  'edit.title': "Modifier l'idée",
  'edit.save': 'Enregistrer',
  'edit.preview': 'Aperçu MD',
  'edit.previewOff': 'Texte brut',
  'level.low': 'Faible',
  'level.medium': 'Moyen',
  'level.high': 'Élevé',
}

export const en = {
  'entry.label': 'Ideas',
  'entry.tooltip': 'Ideas board',
  'board.title': 'Ideas',
  'board.close': 'Back to chat',
  'board.new': 'New idea',
  'board.search': 'Filter ideas…',
  'board.revision': 'revision {revision}',
  'board.status.open': 'Open',
  'board.status.archived': 'Archived',
  'board.status.declined': 'Declined',
  'board.empty': 'No ideas here yet',
  'board.emptyFiltered': 'No ideas match the filter',
  'board.hostError': 'Host operation failed: {error}',
  'board.retryHost': 'Retry Host connection',
  'board.tagFilter': 'Filter:',
  'board.tagFilterClear': 'Clear filter',
  'board.dragHint': 'Drag cards between Open and Archived (use the ⠿ grip on the title row)',
  'board.mdToggleLabel': 'Description rendering',
  'board.mdView': 'MD',
  'board.textView': 'Text',
  'new.title': 'Title',
  'new.titlePlaceholder': 'One sentence summarizing the idea',
  'new.body': 'Description',
  'new.bodyPlaceholder': 'Context, value, effort, acceptance (optional)',
  'new.tags': 'Tags (optional)',
  'new.tagsPlaceholder': 'comma separated',
  'new.value': 'Value',
  'new.effort': 'Effort',
  'new.levelNone': '— not set —',
  'new.submit': 'Create',
  'new.cancel': 'Cancel',
  'new.required': 'Title is required',
  'card.drag': 'Drag to move',
  'card.clickToEdit': 'Click to edit',
  'card.value': 'Value {level}',
  'card.effort': 'Effort {level}',
  'card.updated': 'updated {date}',
  'card.edit': 'Edit',
  'card.archive': 'Archive',
  'card.decline': 'Decline',
  'card.restore': 'Restore',
  'card.delete': 'Delete',
  'card.confirmDelete': 'Confirm deletion?',
  'card.deleteYes': 'Yes',
  'card.deleteNo': 'No',
  'edit.title': 'Edit idea',
  'edit.save': 'Save',
  'edit.preview': 'MD preview',
  'edit.previewOff': 'Raw text',
  'level.low': 'Low',
  'level.medium': 'Medium',
  'level.high': 'High',
}

export type IdeasKey = keyof typeof fr

const DICTIONARIES: Record<string, typeof fr> = { fr, en }

function currentDictionary(): typeof fr {
  if (typeof document === 'undefined') return fr
  const lang = document.documentElement.lang ?? ''
  const base = lang.split('-')[0]!.toLowerCase()
  return DICTIONARIES[base] ?? fr
}

/** Interpolate {placeholders} with the given params. */
export function translate(key: IdeasKey, params?: Record<string, string | number>): string {
  let text: string = currentDictionary()[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** Short alias used across the board/entry code. */
export const t = translate