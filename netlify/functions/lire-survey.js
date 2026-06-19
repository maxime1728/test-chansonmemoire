// netlify/functions/lire-survey.js
// LECTURE seule. Pré-remplissage du formulaire (régénération chanson) par token.
// Renvoie UNIQUEMENT les champs du survey. JAMAIS email/Stripe/attribution/consentement.
// Sécurité identique à lire-projet.js : POST, UUID v4 strict, 404 nu, formule échappée.

const BASE_ID = process.env.AIRTABLE_BASE_ID;   // variable d'environnement Netlify
const TOKEN   = process.env.AIRTABLE_TOKEN;     // variable d'environnement Netlify
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Échappe une valeur pour un littéral filterByFormula Airtable (pas d'échappement \" natif).
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
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
  }
  if (!UUID_V4.test(token)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  }

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();

    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }

    const f = dP.records[0].fields;

    // Réponse MINIMISÉE — strictement les champs du formulaire pour le pré-remplissage.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prenom_defunt:   f.deceased_name    || '',
        relation:        f.relationship     || '',
        style_musical:   f.music_style       || '',
        ambiance:        f.mood             || '',
        voix:            f.voice            || '',
        unicite:         f.what_made_unique  || '',
        souvenirs:       f.memories         || '',
        souvenir_garder: f.memory_to_keep   || ''
        // JAMAIS email, stripe_*, utm_*/fb*, consentement. Volontaire (Loi 25).
      })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
