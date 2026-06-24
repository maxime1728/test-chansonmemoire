// netlify/functions/clic.js
//
// Redirection TRACÉE : enregistre un clic dans la table Clics, puis redirige (302) vers la destination.
//   GET /api/clic?c=<campagne>&t=<token>&u=<destination>
// Sécurité : redirige UNIQUEMENT vers notre domaine (anti open-redirect). Best-effort : un échec de log
// ne bloque JAMAIS la redirection (l'utilisateur arrive toujours à destination).
//
// Env : AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const CLICS    = 'tblD0RhAPnj4Dk3VE';
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}
// N'autorise que les destinations sur notre domaine (anti open-redirect).
function destSure(u) {
  const s = String(u || '');
  return /^https:\/\/(www\.)?chansonmemoire\.ca(\/|\?|#|$)/i.test(s) ? s : SITE;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const dest = destSure(q.u);
  const campagne = (q.c || '').toString().slice(0, 80);
  const token = (q.t || '').toString().trim();

  // Log best-effort -> ne bloque pas la redirection.
  try {
    let projId = null;
    if (UUID_V4.test(token)) {
      const lit = formulaLiteral(token);
      if (lit) {
        const r = await fetch(`${API}/${PROJECTS}?filterByFormula=${encodeURIComponent(`{token}=${lit}`)}&maxRecords=1`, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
        const d = await r.json().catch(() => ({}));
        projId = d.records && d.records[0] && d.records[0].id;
      }
    }
    const fields = { campagne, clicked_at: new Date().toISOString() };
    if (projId) fields.Projet = [projId];
    await fetch(`${API}/${CLICS}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
  } catch (_) {}

  return { statusCode: 302, headers: { Location: dest, 'Cache-Control': 'no-store' }, body: '' };
};
