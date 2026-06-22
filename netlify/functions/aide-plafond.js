// netlify/functions/aide-plafond.js
// Capture le courriel d'un client qui a atteint le PLAFOND de versions (popup apercu « on veut t'aider »).
// PAS de gating `purchased` : le plafond est PRÉ-achat. Token-gated. Écrit cap_help_email + cap_help_at.
// Maxime/Brigitte recontacte (alerte = vue ou automatisation Airtable sur ces champs).
// Sécurité : POST, UUID v4 strict, formule échappée, secrets en env.

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  const email = (body.email || '').toString().trim().slice(0, 120);
  if (!UUID_V4.test(token))               return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!email || email.indexOf('@') < 1)   return { statusCode: 400, body: JSON.stringify({ error: 'Courriel invalide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // Project par token (token validé UUID -> littéral sûr). Pas de gate purchased (plafond = pré-achat).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };   // 404 nu
    }
    const projet = dP.records[0];

    const r = await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { cap_help_email: email, cap_help_at: new Date().toISOString() } })
    });
    if (!r.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Enregistrement impossible' }) };
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
