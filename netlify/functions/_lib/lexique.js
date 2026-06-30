// netlify/functions/_lib/lexique.js
//
// DICTIONNAIRE PHONÉTIQUE — applique des corrections {mot -> réécriture} aux paroles envoyées à Suno,
// pour que les mots mal prononcés sonnent juste SANS changer les paroles AFFICHÉES au client.
// Module PUR (zéro I/O) : le stockage Airtable (table Lexique_Phonetique) et l'upsert sont câblés par les
// appelants. Portée = GLOBAL par langue + override par projet. Voir [[cm-lexique-phonetique-plan]].

// Échappe un mot pour l'insérer dans un RegExp littéral.
function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Clé de matching d'un mot : insensible à la casse + espaces (les accents restent significatifs).
function cleMot(mot) { return String(mot == null ? '' : mot).trim().toLowerCase(); }

// Remplace dans `lyrics` chaque `mot` par sa `reecriture` (limites de mot tolérant les accents À-ÿ,
// insensible à la casse — comme prononciation.js). `paires` = Map<mot, reecriture> OU tableau
// [{mot, phonetique}]. Ne touche jamais une réécriture vide ou identique au mot.
function appliquerLexique(lyrics, paires) {
  let texte = String(lyrics == null ? '' : lyrics);
  if (!texte) return texte;
  const liste = paires instanceof Map
    ? Array.from(paires, ([mot, phon]) => ({ mot, phonetique: phon }))
    : (Array.isArray(paires) ? paires : []);
  for (const { mot, phonetique } of liste) {
    const m = String(mot == null ? '' : mot).trim();
    const r = String(phonetique == null ? '' : phonetique).trim();
    if (!m || !r || r === m) continue;
    const rx = new RegExp('(?<![\\wÀ-ÿ])' + escapeRx(m) + '(?![\\wÀ-ÿ])', 'gi');
    texte = texte.replace(rx, r);
  }
  return texte;
}

// Dictionnaire EFFECTIF d'un projet : entrées GLOBALES de la langue, écrasées ou désactivées par les
// OVERRIDES du projet. Entrées = { mot, phonetique, desactive }. Renvoie une Map<cleMot, phonetique>.
function dictionnaireEffectif(globales = [], overrides = []) {
  const map = new Map();
  for (const e of (globales || [])) {
    if (e && e.mot && e.phonetique && !e.desactive) map.set(cleMot(e.mot), String(e.phonetique).trim());
  }
  for (const o of (overrides || [])) {
    if (!o || !o.mot) continue;
    const k = cleMot(o.mot);
    if (o.desactive) map.delete(k);                                  // l'override RETIRE ce mot pour le projet
    else if (o.phonetique) map.set(k, String(o.phonetique).trim());  // l'override REMPLACE la valeur globale
  }
  return map;
}

// UPSERT (décision pure) — trouver la bonne phonétique prend souvent PLUSIEURS essais. Donne les champs à
// écrire quand on (ré)apprend la réécriture d'un mot : la nouvelle valeur devient courante, l'ancienne va
// dans l'historique (pour ne pas re-tenter une graphie ratée), et on compte les tentatives. Renvoie null
// si rien de neuf (réécriture vide ou inchangée).
function majEntree(existante, reecriture) {
  const nouvelle = String(reecriture == null ? '' : reecriture).trim();
  const e = existante || {};
  const ancienne = String(e.phonetique == null ? '' : e.phonetique).trim();
  if (!nouvelle || nouvelle === ancienne) return null;
  const lignes = String(e.historique == null ? '' : e.historique).split('\n').filter(Boolean);
  if (ancienne && !lignes.includes(ancienne)) lignes.push(ancienne);
  return {
    phonetique: nouvelle,
    attempts:   (parseInt(e.attempts, 10) || (ancienne ? 1 : 0)) + 1,
    historique: lignes.join('\n')
  };
}

// ── Câblage Airtable (table Lexique_Phonetique) — I/O, best-effort (jamais d'exception qui casse l'appelant). ──
const TABLE = 'Lexique_Phonetique';
function formulaLiteral(v) {
  const s = String(v == null ? '' : v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Dictionnaire EFFECTIF d'un projet : entrées globales de la langue + overrides du projet. Renvoie une Map.
async function lireDictionnaire(api, headers, { langue, projetId } = {}) {
  const lit = formulaLiteral(langue);
  if (lit === null) return new Map();
  try {
    const f = encodeURIComponent(`{langue}=${lit}`);
    const r = await fetch(`${api}/${TABLE}?filterByFormula=${f}&maxRecords=1000`, { headers });
    if (!r.ok) return new Map();
    const recs = ((await r.json()).records) || [];
    const globales = [], overrides = [];
    for (const rec of recs) {
      const ff = rec.fields || {};
      const surProjet = Array.isArray(ff.projet) && ff.projet.length ? ff.projet : null;
      if (!surProjet) globales.push(ff);
      else if (projetId && surProjet.includes(projetId)) overrides.push(ff);
    }
    return dictionnaireEffectif(globales, overrides);
  } catch (_) { return new Map(); }
}

// UPSERT d'un mot (apprend/raffine une réécriture). Scope = global (projetId vide) ou override projet.
// Met à jour l'entrée existante (historique des essais + attempts) ou la crée. Best-effort.
async function upsertMot(api, headers, { langue, mot, phonetique, projetId = null, source = '' } = {}) {
  const litL = formulaLiteral(langue), litM = formulaLiteral(cleMot(mot));
  if (litL === null || litM === null || !cleMot(mot)) return;
  try {
    const f = encodeURIComponent(`AND({langue}=${litL}, LOWER(TRIM({mot}))=${litM})`);
    const r = await fetch(`${api}/${TABLE}?filterByFormula=${f}&maxRecords=50`, { headers });
    const recs = r.ok ? (((await r.json()).records) || []) : [];
    const want = projetId || null;
    const match = recs.find((rec) => {
      const pr = (rec.fields || {}).projet;
      return ((Array.isArray(pr) && pr.length ? pr[0] : null) || null) === want;
    });
    const maj = majEntree(match ? match.fields : null, phonetique);
    if (!maj) return;
    const fields = { ...maj };
    if (source) fields.source = source;
    if (match) {
      await fetch(`${api}/${TABLE}/${match.id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
    } else {
      fields.mot = String(mot).trim();
      fields.langue = String(langue);
      if (want) fields.projet = [want];
      await fetch(`${api}/${TABLE}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
    }
  } catch (_) { /* best-effort : l'apprentissage du lexique ne bloque jamais */ }
}

module.exports = { appliquerLexique, dictionnaireEffectif, cleMot, majEntree, lireDictionnaire, upsertMot, TABLE };
