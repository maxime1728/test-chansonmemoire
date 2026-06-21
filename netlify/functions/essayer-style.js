// netlify/functions/essayer-style.js
// « Essayer un autre style » — régénération pour la MÊME personne (même Project, même token).
// Met à jour le style/voix/ambiance choisis SUR LE PROJECT, avant que la page (re)lance la chanson.
// C-gen lit déjà ces 3 champs depuis le Project (Data Store + vocalGender), donc aucun changement
// de logique côté Make. La page enchaîne ensuite :
//   - avec nouveaux souvenirs  -> /api/generate-lyrics (regenerate) -> /revision (accepter) -> C-gen
//   - sans nouveaux souvenirs   -> webhook C-gen direct -> /attente-chanson
//
// Écriture ponctuelle, sur des champs dédiés, sans concurrence avec la génération -> OK côté Netlify
// (même justification que accepter-livraison.js / telecharger.js — cf. CM_spine_spec §4).
// Sécurité : POST, UUID v4 strict, 404 nu, secrets en env. N'écrit QUE music_style/mood/voice.

const BASE_ID = process.env.AIRTABLE_BASE_ID;   // variable d'environnement Netlify
const TOKEN   = process.env.AIRTABLE_TOKEN;     // variable d'environnement Netlify
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Listes blanches = options EXACTES du survey (doivent matcher les single-selects Airtable au
// caractère près, sinon 422). Empêche aussi d'écrire une valeur arbitraire dans le Project.
const STYLES = ['Pop', 'Country', 'R&B', 'Rock', 'Jazz', 'Acoustique', 'Douce Mélodie',
  'Orchestre Gospel', 'Hip-Hop', 'Cinématographique', 'Latin / Salsa', 'Reggae', 'Électronique / Dance'];
const MOODS  = ['Émotionnelle', 'Tendre', 'Paisible', 'Inspirante', 'Reconnaissante', 'Festive', 'Optimiste', 'Mélancolique'];
const VOICES = ['Masculin', 'Féminin'];

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!token) return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  // Valide les choix contre la liste blanche (anti-écriture d'une option inexistante -> 422 Airtable).
  const music_style = body.music_style;
  const mood        = body.mood;
  const voice       = body.voice;
  if (!STYLES.includes(music_style) || !MOODS.includes(mood) || !VOICES.includes(voice)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Choix invalide' }) };
  }

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token (token déjà validé UUID -> littéral sûr).
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };   // 404 nu (sécurité)
    }
    const projet = dP.records[0];

    // 2. Met à jour les 3 champs (et RIEN d'autre). C-gen les relira au lancement.
    const r = await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { music_style, mood, voice } })
    });
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      return { statusCode: 502, body: JSON.stringify({ error: 'Mise à jour échouée', detail }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
