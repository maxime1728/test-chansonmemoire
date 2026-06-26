// netlify/functions/supprimer-photo-memoire.js
//
// Retire UNE photo de la liste memoire_photos du Project (le client se ravise avant de générer).
// On retire de la liste -> la photo n'ira pas dans la vidéo. Le fichier Cloudinary lui-même est
// purgé plus tard (cron, par préfixe cm_memoire/<token>). Gaté purchased.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  const url = (body.url || '').trim();
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'Photo manquante' }) };

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

    let photos;
    try { photos = JSON.parse(projet.fields.memoire_photos || '[]'); if (!Array.isArray(photos)) photos = []; }
    catch (_) { photos = []; }
    const next = photos.filter(u => u !== url);

    if (next.length !== photos.length) {
      const rU = await fetch(`${API}/Projects/${projet.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { memoire_photos: JSON.stringify(next) } })
      });
      if (!rU.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Suppression échouée' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, count: next.length }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
