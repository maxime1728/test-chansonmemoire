// netlify/functions/ajouter-photo-memoire.js
//
// Enregistre l'URL d'UNE photo (déjà poussée sur Cloudinary via signer-upload-photo) dans le champ
// memoire_photos du Project (JSON array d'URLs). Idempotent, plafonné à MAX_PHOTOS.
//
// Sécurité : POST, token UUID v4, Project 'purchased'. L'URL DOIT être une image Cloudinary du
// dossier cm_memoire/<token> (sinon on refuse -> pas d'injection d'URL arbitraire).

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PHOTOS = 60;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

function readPhotos(projet) {
  try { const a = JSON.parse(projet.fields.memoire_photos || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const url = (body.url || '').trim();
  // Seules les images Cloudinary de NOTRE dossier signé sont acceptées (anti-injection).
  if (!/^https:\/\/res\.cloudinary\.com\/[^\s]+$/.test(url) || !url.includes(`/cm_memoire/${token}/`)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Photo invalide' }) };
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || !dP.records.length) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    const photos = readPhotos(projet);
    if (photos.includes(url)) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, count: photos.length, already: true }) };
    }
    if (photos.length >= MAX_PHOTOS) {
      return { statusCode: 409, body: JSON.stringify({ error: `Maximum ${MAX_PHOTOS} photos`, count: photos.length, max: MAX_PHOTOS }) };
    }
    photos.push(url);

    const rU = await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { memoire_photos: JSON.stringify(photos) } })
    });
    if (!rU.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Enregistrement échoué' }) };

    return { statusCode: 200, body: JSON.stringify({ ok: true, count: photos.length, max: MAX_PHOTOS }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
