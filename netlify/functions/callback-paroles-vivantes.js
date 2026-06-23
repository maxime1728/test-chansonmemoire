// netlify/functions/callback-paroles-vivantes.js
//
// Reçoit le webhook Shotstack en fin de rendu -> écrit l'URL de la vidéo sur le Project
// (matché par video_task_id, posé par lancer-paroles-vivantes.js).
// Webhook public : matche par render id Shotstack (non devinable) + n'écrit que video_url -> faible risque.
// Répond TOUJOURS 200 (un webhook ne doit jamais renvoyer d'erreur à Shotstack).
//
// ⚠️ v1 = on stocke l'URL Shotstack directement. À DURCIR avant le live : ré-héberger sur Cloudinary
//    (comme la chanson), car les URLs de sortie Shotstack ne sont pas permanentes. [voir callback-instrumentale]
//
// Payload Shotstack : { type:"edit", action:"render", id, owner, status:"done"|"failed", url, error, completed }

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, body: '{}' }; }

  const renderId = (body.id || '').trim();
  const status   = (body.status || '').trim();
  const videoUrl = (body.url || '').trim();

  if (!renderId) return { statusCode: 200, body: '{}' };
  if (status !== 'done' || !videoUrl) {
    if (status === 'failed') console.error('[callback-paroles-vivantes] Shotstack échec:', renderId, body.error);
    return { statusCode: 200, body: '{}' };   // pas prêt / échec -> on n'écrit rien
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const lit = formulaLiteral(renderId);
    if (lit === null) return { statusCode: 200, body: '{}' };
    const f = encodeURIComponent(`{video_task_id}=${lit}`);
    const r = await fetch(`${API}/Projects?filterByFormula=${f}&maxRecords=1`, { headers });
    const d = await r.json();
    const projet = d.records && d.records[0];
    if (!projet) return { statusCode: 200, body: '{}' };   // rien à matcher (inconnu / déjà nettoyé)

    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { video_url: videoUrl } })
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 200, body: '{}' };   // un callback ne renvoie jamais d'erreur à Shotstack
  }
};
