// netlify/functions/_lib/style.js
//
// Style Suno curé, lu depuis Airtable (table « Songs_Styles », migrée depuis l'ancienne Data Store
// Make). On cherche la ligne (Style Musical × Ambiance × Cadeau/Mémoire) et on renvoie son
// « Prompt Complet », avec l'accent adapté à la langue de la chanson.
//
// REPLI SÛR : si la table n'existe pas encore, ne renvoie rien, ou erreur réseau -> on retombe sur
// le style construit `music_style, mood, accent` (= comportement actuel de lancer-cover/sentinelle).
// Donc aucune régression : ça marche AVANT comme APRÈS l'import de la table.
//
// Env : AIRTABLE_BASE_ID, AIRTABLE_TOKEN ; AIRTABLE_STYLES_TABLE (optionnel, défaut « Songs_Styles »).

const { accentFor } = require('./lyrics');

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const TABLE   = process.env.AIRTABLE_STYLES_TABLE || 'Songs_Styles';

// Les prompts curés sont écrits en accent québécois ; on le remplace selon la langue choisie.
const QC_ACCENT  = 'Quebec French accent, Canadian French';
const ACCENT_SWAP = { 'fr-FR': 'French (France) accent', 'en': 'English', 'es': 'Spanish' };

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Renvoie le prompt de style Suno. Toujours une chaîne non vide (repli garanti).
async function styleFor({ music_style, mood, cadeau, language }) {
  const fallback = [music_style, mood, accentFor(language)].filter(Boolean).join(', ');
  try {
    if (!music_style || !mood || !BASE_ID || !AT_TOKEN) return fallback;
    const ms = formulaLiteral(music_style);
    const mo = formulaLiteral(mood);
    const cm = formulaLiteral(cadeau ? 'Cadeau' : 'Mémoire');
    if (ms === null || mo === null || cm === null) return fallback;

    const formula = `AND({Style Musical}=${ms},{Ambiance}=${mo},{Cadeau/Mémoire}=${cm})`;
    const url = `${API}/${encodeURIComponent(TABLE)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    if (!r.ok) return fallback;
    const d = await r.json();
    let prompt = d && d.records && d.records[0] && d.records[0].fields && d.records[0].fields['Prompt Complet'];
    if (!prompt || !String(prompt).trim()) return fallback;

    const swap = ACCENT_SWAP[language];
    if (swap) prompt = String(prompt).split(QC_ACCENT).join(swap);   // adapte l'accent selon la langue
    return String(prompt).trim();
  } catch (_) {
    return fallback;   // jamais d'exception : la génération ne doit pas dépendre de la table de styles
  }
}

// Catalogue de reference : tous les styles musicaux curés POUR UNE AMBIANCE (× Cadeau/Memoire), avec leur
// « Prompt Complet » (accent adapte a la langue). Sert d'INSPIRATION a l'IA quand le client veut un autre
// style. Best-effort : renvoie [] si la table/le reseau echoue. Cap a 30 lignes (une ambiance ~13 styles).
async function cataloguePourAmbiance({ mood, cadeau, language }) {
  try {
    if (!mood || !BASE_ID || !AT_TOKEN) return [];
    const mo = formulaLiteral(mood);
    const cm = formulaLiteral(cadeau ? 'Cadeau' : 'Mémoire');
    if (mo === null || cm === null) return [];
    const formula = `AND({Ambiance}=${mo},{Cadeau/Mémoire}=${cm})`;
    const url = `${API}/${encodeURIComponent(TABLE)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=30`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    if (!r.ok) return [];
    const swap = ACCENT_SWAP[language];
    return (((await r.json()).records) || []).map((rec) => {
      const f = rec.fields || {};
      let prompt = String(f['Prompt Complet'] || '').trim();
      if (swap && prompt) prompt = prompt.split(QC_ACCENT).join(swap);
      return { style: f['Style Musical'] || '', prompt };
    }).filter((x) => x.style && x.prompt);
  } catch (_) {
    return [];
  }
}

module.exports = { styleFor, cataloguePourAmbiance };
