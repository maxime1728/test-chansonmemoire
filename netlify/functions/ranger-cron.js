// netlify/functions/ranger-cron.js
//
// #3 — Range automatiquement les assets Cloudinary des projets ACHETÉS dans cm_purchased
// (chanson + régé/cover post-achat + upsells), via _lib/ranger.js. Couvre l'historique ET les
// futures corrections/upsells, sans toucher MAKE D ni les callbacks.
//
// DORMANT par défaut : ne fait RIEN tant que la variable d'env RANGER_CLOUDINARY_ACTIF n'est pas
// posée. -> on peut merger sans risque, tester via /api/ranger-achat sur un projet, vérifier que
// les liens fonctionnent, PUIS activer le cron. Best-effort : jamais d'exception qui casse le cron.

const { rangerProjet } = require('./_lib/ranger');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const ACTIF    = process.env.RANGER_CLOUDINARY_ACTIF;   // dormant tant que non posé
const MAX_PER_RUN = 8;   // prudence : peu de projets par passage (déplacements + écritures)

exports.handler = async () => {
  if (!ACTIF)    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'inactif' }) };
  if (!AT_TOKEN) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_airtable' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  let traites = 0, moved = 0, failed = 0;
  try {
    const f = encodeURIComponent(`AND({commercial_status}="purchased", NOT({cloudinary_range}))`);
    const r = await fetch(`${API}/${PROJECTS}?filterByFormula=${f}&maxRecords=${MAX_PER_RUN}`, { headers });
    const recs = (((await r.json()) || {}).records) || [];
    for (const projet of recs) {
      const res = await rangerProjet(API, headers, projet);
      traites++; moved += res.moved; failed += res.failed;
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, traites, moved, failed }) };
  } catch (err) {
    console.error('[ranger-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
