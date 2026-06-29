// netlify/functions/ranger-achat.js
//
// Déplace les assets Cloudinary d'UN projet acheté vers cm_purchased (voir _lib/ranger.js).
// Sert à TESTER le déplacement sur un projet précis avant d'activer le cron. Réutilisable par
// MAKE D (à l'achat) si tu préfères un déclenchement immédiat plutôt que le cron.
// Sécurité : POST, token UUID v4, gaté `purchased`, secret OPTIONNEL (RANGER_SECRET) inerte tant
// que non posé. Idempotent (cloudinary_range).

const { rangerProjet, rangerRevert } = require('./_lib/ranger');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET   = process.env.RANGER_SECRET || '';

function formulaLiteral(v) { const s = String(v); if (!s.includes('"')) return `"${s}"`; if (!s.includes("'")) return `'${s}'`; return null; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  if (SECRET && body.secret !== SECRET) return { statusCode: 401, body: JSON.stringify({ error: 'Non autorisé' }) };

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || !dP.records.length) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') return { statusCode: 403, body: JSON.stringify({ error: 'Réservé aux projets achetés' }) };

    // Mode REVERT : remet les assets à la racine + restaure les URLs (annule un rangement).
    if (body.revert) {
      const res = await rangerRevert(API, headers, projet);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, reverted: true, ...res }) };
    }

    if (projet.fields.cloudinary_range) return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };
    const res = await rangerProjet(API, headers, projet);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...res }) };
  } catch (err) {
    console.error('[ranger-achat]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
