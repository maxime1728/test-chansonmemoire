// netlify/functions/telecharger.js
// Téléchargement gaté + journalisé. Vérifie l'achat côté serveur, log le download (bonus),
// puis renvoie l'URL Cloudinary COMPLÈTE. L'URL complète n'est jamais émise avant paiement.
// EXCEPTION ASSUMÉE à « Make écrit, Netlify lit » (écriture ponctuelle du compteur — voir §4 spine).

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Force le https sur l'URL audio servie au navigateur. Filet défensif : une
// Generation peut avoir stocké une URL Cloudinary en http (avant le fix
// `secure_url` côté Make C-cb) -> cadenas barré. Cloudinary sert le même chemin
// en https, donc la réécriture est sûre. No-op si déjà https/vide.
function toHttps(u) {
  return (typeof u === 'string') ? u.replace(/^http:\/\//i, 'https://') : u;
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

  const now = new Date().toISOString();
  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token.
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }
    const projet = dP.records[0];

    // 2. Garde-fou paiement (vérif serveur) — jamais l'URL complète avant achat.
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };
    }

    // 3. Generation la plus récente → URL Cloudinary complète.
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const formuleG = encodeURIComponent(`{project}=${projLit}`);
    const rG = await fetch(
      `${API}/Generations?filterByFormula=${formuleG}` +
      `&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`,
      { headers }
    );
    const dG = await rG.json();
    const gen = (dG.records && dG.records[0]) ? dG.records[0].fields : {};
    const audioUrl = gen.cloudinary_audio_url || '';
    if (!audioUrl) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Audio non disponible' }) };
    }

    // 4. Log download (bonus, best-effort — n'empêche pas le téléchargement si l'écriture échoue).
    try {
      const fields = {
        downloaded_at:  projet.fields.downloaded_at || now,   // 1er téléchargement
        download_count: (projet.fields.download_count || 0) + 1
      };
      await fetch(`${API}/Projects/${projet.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
    } catch (_) { /* le log ne doit jamais bloquer la possession */ }

    // 5. Renvoie l'URL complète (la page déclenche le téléchargement).
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: toHttps(audioUrl) })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
