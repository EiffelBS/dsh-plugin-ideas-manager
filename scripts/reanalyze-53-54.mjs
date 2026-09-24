#!/usr/bin/env node
/**
 * Controlled re-analysis of the two cards corrupted by the mojibake bug
 * (idea #55 cleanup): #53 (kanban column resize) and #54 (About section).
 *
 * The stored values carry U+FFD replacement characters (information lost), so
 * they cannot be auto-repaired. This script re-writes each card through the
 * same source-of-truth write channel:
 *
 *   1. POST `reanalyze`  -> snapshots the prior (corrupted) content into the
 *      card's analysisAudit trail + stamps reanalyzeAt (history preserved).
 *   2. POST `update`     -> writes the corrected UTF-8 title / body / summary /
 *      tags / value / effort / rank / rationale over the card.
 *
 * #53's title / body / summary / tags come from create_idea2.json (the clean
 * create payload, verified to match the stored content modulo U+FFD); only its
 * rationale (set separately by triage, not in that fixture) is reconstructed.
 * #54 has no clean fixture, so every field is reconstructed from context
 * (each U+FFD is unambiguous in French). All accented characters are spelled
 * as \uXXXX escapes so this source stays ASCII and the bytes sent are exact.
 *
 * Usage: node scripts/reanalyze-53-54.mjs [--dry]
 *   --dry  prints the corrected content without posting (for review).
 */

import { readFileSync } from 'node:fs'

const BASE = process.env.IDEAS_BASE ?? 'http://127.0.0.1:3080'
const DRY = process.argv.includes('--dry')

// #53 clean source (verified to match the stored card modulo U+FFD).
const FIXTURE = JSON.parse(readFileSync('create_idea2.json', 'utf8'))
const CARD53_ID = 'd1e2f3a4-b5c6-7890-defa-bc1234567890'
// #53 priority opinion (kept from the stored card) + reconstructed rationale.
const CARD53 = {
  ideaId: CARD53_ID,
  title: FIXTURE.input.title,
  body: FIXTURE.input.body,
  summary: FIXTURE.input.summary,
  tags: FIXTURE.input.tags,
  value: 2,
  effort: 2,
  rank: 1,
  // Reconstructed from the stored (corrupted) rationale; each U+FFD is unambiguous.
  rationale: 'Fonctionnalit\u00e9 UI/UX utile (redimensionnement individuel des colonnes du kanban) avec un effort mod\u00e9r\u00e9, r\u00e9pondant directement au besoin exprim\u00e9 par l\u2019utilisateur. Valeur moyenne car elle am\u00e9liore l\u2019exp\u00e9rience sans changer la logique m\u00e9tier fondamentale. Rang 1 dans le backlog ouvert de cet espace de travail (premi\u00e8re id\u00e9e ouverte).',
}

// #54 fully reconstructed from context (no clean fixture exists).
const CARD54_ID = '6aedc6f8-a3cb-43c2-b8fc-f38c873f4870'
const CARD54 = {
  ideaId: CARD54_ID,
  title: 'Ajouter une section About standardis\u00e9e dans le panneau d\u2019options des plugins',
  summary: 'Standardiser une section About dans le panneau d\u2019options des plugins DSH pour afficher d\u00e9p\u00f4t, version, licence, compatibilit\u00e9 et v\u00e9rification des mises \u00e0 jour, afin d\u2019am\u00e9liorer la coh\u00e9rence et la d\u00e9couvrabilit\u00e9.',
  tags: [{ name: 'plugin-ui' }, { name: 'settings-panel' }, { name: 'dsh-platform' }],
  value: 2,
  effort: 2,
  rank: 3,
  rationale: 'Valeur 2 : standardisation utile mais pas un blocage. Effort 2 : composant partag\u00e9 + int\u00e9gration plugin + doc, sans moteur/API. Rang 2/2 dans le backlog ouvert de cet espace de travail (derri\u00e8re le redimensionnement kanban #53, avant tout autre projet).',
  body: [
    '## Context',
    'Les plugins DSH peuvent disposer d\u2019un onglet "About" dans leur panneau d\u2019options, comme c\u2019est le cas pour dsh-ears. Cette section affiche g\u00e9n\u00e9ralement : le lien vers le d\u00e9p\u00f4t GitHub, la version, la licence, la compatibilit\u00e9 avec les versions de DSH, et un bouton "V\u00e9rifier les mises \u00e0 jour". Actuellement, il n\u2019existe pas de consigne ni de composant partag\u00e9 pour standardiser cette section, ce qui conduit \u00e0 des impl\u00e9mentations \u00e9parses et parfois incompl\u00e8tes.',
    '',
    '## Value',
    'Standardiser une section About apporte une valeur mod\u00e9r\u00e9e (value 2) : elle am\u00e9liore la d\u00e9couvrabilit\u00e9 des m\u00e9tadonn\u00e9es du plugin (d\u00e9p\u00f4t, version, licence, compatibilit\u00e9) et offre une exp\u00e9rience utilisateur coh\u00e9rente entre les plugins. Cela ne cr\u00e9e pas de nouvelle fonctionnalit\u00e9 majeure, mais simplifie la maintenance et la perception de qualit\u00e9.',
    '',
    '## Effort',
    'L\u2019effort estim\u00e9 est moyen (effort 2) : il faut d\u00e9finir un composant UI r\u00e9utilisable (par exemple dans eiffelbs-ui) puis l\u2019int\u00e9grer dans au moins un plugin (dsh-ears) comme r\u00e9f\u00e9rence, en respectant le contrat du panneau d\u2019options. Aucun changement moteur ou API n\u2019est n\u00e9cessaire ; le travail se limite \u00e0 l\u2019interface et \u00e0 la documentation.',
    '',
    '## First steps',
    '1. Cr\u00e9er un composant AboutPanel dans la biblioth\u00e8que partag\u00e9e eiffelbs-ui, acceptant les propri\u00e9t\u00e9s : repositoryUrl, version, license, compatibleVersions, onCheckUpdate.',
    '2. Mettre \u00e0 jour le plugin dsh-ears pour utiliser ce composant dans son onglet About, en remplissant les propri\u00e9t\u00e9s depuis son manifeste ou ses m\u00e9tadonn\u00e9es.',
    '3. R\u00e9diger une guideline courte dans CONTRIBUTING.md ou docs/ indiquant que les nouveaux plugins doivent inclure une section About standardis\u00e9e lorsqu\u2019ils poss\u00e8dent un panneau d\u2019options.',
    '4. Ajouter des tests unitaires pour v\u00e9rifier le rendu et le comportement du bouton de mise \u00e0 jour.',
    '',
    '## Risks',
    '- **Fragmentation persistante** : si le composant n\u2019est pas adopt\u00e9, chaque plugin pourrait continuer avec sa propre impl\u00e9mentation.',
    '- **Surcharge de d\u00e9pendance** : introduire un nouveau composant partag\u00e9 augmente l\u00e9g\u00e8rement la taille de eiffelbs-ui ; il faut s\u2019assurer qu\u2019il reste l\u00e9ger et optionnel.',
    '- **Obsolescence des m\u00e9tadonn\u00e9es** : les informations comme la version ou la compatibilit\u00e9 doivent \u00eatre maintenues \u00e0 jour ; un m\u00e9canisme automatis\u00e9 (lecture du package.json) pourrait \u00eatre envisag\u00e9 mais d\u00e9passe le scope initial.',
  ].join('\n'),
}

function post(action, requestId) {
  const envelope = { requestId, initiator: 'plugin:ideas-manager:ai-reanalyze', action }
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8') // valid UTF-8 (the contract)
  return fetch(`${BASE}/api/ideas/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: bytes,
  }).then(response => response.json())
}

function freshId() {
  return `req-reanalyze-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const hasUfffd = (text) => typeof text === 'string' && text.includes('\u{fffd}')

async function main() {
  for (const card of [CARD53, CARD54]) {
    console.log(`\n=== ${card.ideaId} ===`)
    console.log('title:   ', card.title)
    console.log('summary: ', card.summary)
    console.log('rationale:', card.rationale)
    if (DRY) continue

    // 1. Snapshot the prior (corrupted) content into the audit trail.
    const reanalyzeResult = await post({ kind: 'reanalyze', ideaId: card.ideaId }, freshId())
    if (reanalyzeResult.ok === false || reanalyzeResult.error !== undefined) {
      throw new Error(`reanalyze failed for ${card.ideaId}: ${JSON.stringify(reanalyzeResult)}`)
    }

    // 2. Write the corrected UTF-8 content over the card.
    const updateResult = await post({ kind: 'update', ideaId: card.ideaId, patch: {
      title: card.title,
      body: card.body,
      summary: card.summary,
      tags: card.tags,
      value: card.value,
      effort: card.effort,
      rank: card.rank,
      rationale: card.rationale,
    } }, freshId())
    if (updateResult.ok === false || updateResult.error !== undefined) {
      throw new Error(`update failed for ${card.ideaId}: ${JSON.stringify(updateResult)}`)
    }
  }

  // Verify via GET that both cards are clean (no U+FFD in any text field).
  const state = await fetch(`${BASE}/api/ideas/state`, { headers: { 'sec-fetch-site': 'same-origin' } })
    .then(r => r.json())
  let allClean = true
  for (const card of [CARD53, CARD54]) {
    const live = state.ideas.find(i => i.id === card.ideaId)
    if (live === undefined) { console.log(`VERIFY: ${card.ideaId} NOT FOUND`); allClean = false; continue }
    const fields = ['title', 'body', 'summary', 'rationale']
    const bad = fields.filter(f => hasUfffd(live[f]))
    const tagBad = (live.tags ?? []).some(t => hasUfffd(t.name))
    if (bad.length > 0 || tagBad) { console.log(`VERIFY: ${card.ideaId} STILL CORRUPT in ${bad.join(',')}${tagBad ? ', tags' : ''}`); allClean = false }
    else console.log(`VERIFY: ${card.ideaId} clean (title/body/summary/rationale/tags, no U+FFD)`)
  }
  console.log(allClean ? '\nAll cards clean.' : '\nSome cards still corrupted.')
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1) })
