// netlify/functions/desabonnement.js
//
// DÉSABONNEMENT de la séquence marketing (exigé par la LCAP). Lien dans chaque courriel :
//   GET  /api/desabonnement?id=TOKEN   -> désabonne + page de confirmation (clic humain)
//   POST /api/desabonnement?id=TOKEN   -> 1-clic Gmail/Outlook (en-tête List-Unsubscribe-Post)
// Pose nurture_status='unsubscribed' (le cron ne lui enverra plus rien). Frictionless : aucun autre
// garde-fou que le token UUID (un désabonnement doit toujours aboutir).

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

const PAGE = (msg) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8">` +
  `<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>Désabonnement — Chanson Mémoire</title></head>` +
  `<body style="font-family:Georgia,serif;background:#F5F0EA;color:#2E1A28;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;">` +
  `<div style="max-width:420px;text-align:center;padding:24px;">` +
  `<div style="font-size:22px;color:#5C2D4A;margin-bottom:10px;">Chanson<span style="color:#C4963A;">Mémoire</span></div>` +
  `<p style="line-height:1.7;">${msg}</p></div></body></html>`;

async function unsubscribe(token) {
  if (!UUID_V4.test(token)) return false;
  const lit = formulaLiteral(token);
  if (lit === null) return false;
  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  const r = await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{token}=${lit}`)}&maxRecords=1`, { headers });
  const d = await r.json();
  const projet = d.records && d.records[0];
  if (!projet) return false;
  await fetch(`${API}/Projects/${projet.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { nurture_status: 'unsubscribed' } })
  });
  return true;
}

exports.handler = async (event) => {
  const token = ((event.queryStringParameters && event.queryStringParameters.id) || '').trim();

  // 1-clic (Gmail/Outlook) : POST -> on désabonne sans page.
  if (event.httpMethod === 'POST') {
    try { await unsubscribe(token); } catch (_) {}
    return { statusCode: 200, body: 'unsubscribed' };
  }

  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Méthode non permise' };

  const html = (m) => ({ statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: PAGE(m) });
  try {
    const ok = await unsubscribe(token);
    return html(ok
      ? 'Vous êtes désabonné de nos courriels. Votre chanson reste disponible quand vous le souhaitez.'
      : 'Ce lien n’est plus valide. Si vous souhaitez vous désabonner, écrivez-nous et on s’en occupe.');
  } catch (_) {
    return html('Une erreur est survenue. Écrivez-nous et on vous retire de la liste manuellement.');
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
