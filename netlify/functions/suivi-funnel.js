// netlify/functions/suivi-funnel.js
// Suivi de parcours (funnel) pour les 2 événements CLIENT que Make ne peut pas capter :
//   - preview_played   : le client a écouté l'aperçu (≠ aperçu seulement généré)
//   - checkout_started : le client a cliqué « payer » (intention) avant de compléter Stripe
//
// EXCEPTION ASSUMÉE à « Make écrit, Netlify lit » (écriture ponctuelle, champs dédiés, best-effort).
// PRINCIPE : le suivi NE DOIT JAMAIS casser l'UX → tout est best-effort, on répond 200 quoi qu'il arrive.
//
// ⚠️ funnel_step est écrit dans un PATCH SÉPARÉ : si l'option single-select n'existe pas encore
//    dans Airtable (422), les horodatages (preview_played_at, checkout_started_at) sont quand même écrits.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Événements autorisés → valeur funnel_step correspondante.
const EVENTS = {
  preview_played:   'preview_played',
  checkout_started: 'checkout_started'
};

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

async function patchProject(id, fields, headers) {
  return fetch(`${API}/Projects/${id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: '{}' }; }

  const token = (body.token || '').trim();
  const evt   = (body.event || '').trim();
  if (!UUID_V4.test(token) || !EVENTS[evt]) return { statusCode: 400, body: '{}' };

  const headers = { Authorization: `Bearer ${TOKEN}` };
  const now = new Date().toISOString();

  try {
    // Project par token.
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: '{}' };
    const projet = dP.records[0];
    const f = projet.fields;

    // 1. Horodatages dédiés (toujours sûrs, pas de dépendance single-select).
    const stamp = {};
    if (evt === 'preview_played') {
      if (!f.preview_played_at) stamp.preview_played_at = now;       // 1er play seulement
      stamp.preview_play_count = (Number(f.preview_play_count) || 0) + 1;
    } else if (evt === 'checkout_started') {
      if (!f.checkout_started_at) stamp.checkout_started_at = now;   // 1re intention seulement
    }
    if (Object.keys(stamp).length) await patchProject(projet.id, stamp, headers);

    // 2. funnel_step — PATCH séparé best-effort (un 422 « option inexistante » n'impacte pas les horodatages).
    try { await patchProject(projet.id, { funnel_step: EVENTS[evt] }, headers); } catch (_) {}

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (_) {
    // Le suivi ne casse jamais l'UX.
    return { statusCode: 200, body: '{}' };
  }
};
