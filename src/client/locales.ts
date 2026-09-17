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
  'board.hostError': "Échec de l'opération Host : {error}",
  'board.retryHost': 'Réessayer la connexion Host',
  'board.tagFilter': 'Filtre :',
  'board.tagFilterClear': 'Effacer le filtre',
  'board.dragHint': 'Glissez les cartes entre Ouvertes et Archivées',
  'new.title': 'Titre',
  'new.titlePlaceholder': "Une phrase qui résume l'idée",
  'new.body': 'Description',
  'new.bodyPlaceholder': 'Contexte, valeur, effort, acceptation (optionnel)',
  'new.tags': 'Étiquettes (optionnelles)',
  'new.tagsPlaceholder': 'séparées par des virgules',
  'new.value': 'Valeur',
  'new.effort': 'Effort',
  'new.submit': 'Créer',
  'new.cancel': 'Annuler',
  'new.required': 'Le titre est requis',
  'card.value': 'Valeur {value}',
  'card.effort': 'Effort {effort}',
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
  'board.hostError': 'Host operation failed: {error}',
  'board.retryHost': 'Retry Host connection',
  'board.tagFilter': 'Filter:',
  'board.tagFilterClear': 'Clear filter',
  'board.dragHint': 'Drag cards between Open and Archived',
  'new.title': 'Title',
  'new.titlePlaceholder': 'One sentence summarizing the idea',
  'new.body': 'Description',
  'new.bodyPlaceholder': 'Context, value, effort, acceptance (optional)',
  'new.tags': 'Tags (optional)',
  'new.tagsPlaceholder': 'comma separated',
  'new.value': 'Value',
  'new.effort': 'Effort',
  'new.submit': 'Create',
  'new.cancel': 'Cancel',
  'new.required': 'Title is required',
  'card.value': 'Value {value}',
  'card.effort': 'Effort {effort}',
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