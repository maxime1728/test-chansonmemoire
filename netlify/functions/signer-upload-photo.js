// netlify/functions/signer-upload-photo.js
//
// Signe un upload Cloudinary DIRECT (navigateur -> Cloudinary) pour les photos de la VIDÉO MÉMOIRE.
// Le client appelle cet endpoint (gaté : Project 'purchased'), reçoit une signature courte, puis POST
// chaque photo DIRECTEMENT à Cloudinary -> aucun passage par Netlify (pas de limite 6 Mo / photo).
// L'URL renvoyée par Cloudinary est ensuite enregistrée via ajouter-photo-memoire.js.
//
// Dossier Cloudinary = cm_memoire/<token> -> suppression facile par préfixe (purge après vidéo / 14 j).
// Sécurité : POST, token UUID v4 strict, Project acheté. Clés Cloudinary en env (jamais en dur).

const crypto = require('crypto');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const CLD_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLD_KEY    = process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!CLD_CLOUD || !CLD_KEY || !CLD_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration upload manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    // Gate : le Project doit exister et être acheté (la vidéo mémoire est un add-on post-achat).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || !dP.records.length) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    if (dP.records[0].fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // Signature Cloudinary (mêmes params que le client enverra, triés alphabétiquement).
    const ts = Math.floor(Date.now() / 1000);
    const folder = `cm_memoire/${token}`;
    const toSign = `folder=${folder}&timestamp=${ts}`;
    const signature = crypto.createHash('sha1').update(toSign + CLD_SECRET).digest('hex');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_name: CLD_CLOUD, api_key: CLD_KEY, timestamp: ts, folder, signature })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
