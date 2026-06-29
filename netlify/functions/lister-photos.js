// netlify/functions/lister-photos.js
//
// DEBUG TEMPORAIRE : explore Cloudinary (Admin API) pour retrouver les photos déposées.
//   /api/lister-photos?folders=1                 -> dossiers racine
//   /api/lister-photos?folders=cm_purchased      -> sous-dossiers de cm_purchased
//   /api/lister-photos?prefix=cm_purchased&type=upload|authenticated  -> images du dossier
// À retirer après le chantier vidéo mémoire.

const CLD_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLD_KEY    = process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET;

exports.handler = async (event) => {
  if (!CLD_CLOUD || !CLD_KEY || !CLD_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Config Cloudinary manquante' }) };
  const q = event.queryStringParameters || {};
  const auth = Buffer.from(`${CLD_KEY}:${CLD_SECRET}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };
  const base = `https://api.cloudinary.com/v1_1/${CLD_CLOUD}`;
  try {
    // Liste de dossiers : ?folders=1 (racine) ou ?folders=<chemin> (sous-dossiers)
    if (q.folders) {
      const path = q.folders === '1' ? '' : '/' + q.folders.replace(/^\/+/, '');
      const r = await fetch(`${base}/folders${path}`, { headers });
      const d = await r.json();
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ http: r.status, folders: (d.folders || []).map(f => f.path), error: d.error || null }) };
    }
    // Liste d'images
    const type = q.type || 'upload';                 // upload | authenticated | private
    const prefix = q.prefix || '';
    const url = `${base}/resources/image?type=${encodeURIComponent(type)}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}&max_results=500`;
    const r = await fetch(url, { headers });
    const d = await r.json();
    const urls = (d.resources || []).map(x => x.secure_url);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ http: r.status, type, prefix, count: urls.length, urls, error: d.error || null }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e && e.message }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
