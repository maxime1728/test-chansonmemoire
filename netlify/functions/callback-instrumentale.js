// netlify/functions/callback-instrumentale.js
//
// Reçoit le callback Suno vocal-removal -> récupère l'URL instrumentale -> l'écrit sur le Project
// (matché par instrumental_task_id, posé par lancer-instrumentale.js).
// Webhook public : matche par task_id Suno (non devinable) + n'écrit qu'instrumental_url -> faible risque.
// Répond TOUJOURS 200 à Suno (pour ne pas déclencher de réessais).
//
// PERMANENCE : les URLs Suno expirent (~15 j) -> on RÉ-HÉBERGE l'audio sur Cloudinary (copie permanente)
//   avant de l'écrire. Si Cloudinary échoue/non configuré -> repli sur l'URL Suno (on ne perd pas la livraison).
//
// Payload : { code, msg, data: { task_id, vocal_removal_info: { instrumental_url, vocal_url, origin_url } } }

const { rehost } = require('./_lib/cloudinary-rehost');

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

  // Sécurité (T8) : si CALLBACK_SECRET est défini, exiger ?s=<secret> (posé par lancer-instrumentale). Inerte sinon. 200 silencieux si invalide.
  { const _s = (event.queryStringParameters && event.queryStringParameters.s) || ''; if (process.env.CALLBACK_SECRET && _s !== process.env.CALLBACK_SECRET) return { statusCode: 200, body: '{}' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, body: '{}' }; }

  const data   = body.data || {};
  const taskId = (data.task_id || '').trim();
  const info   = data.vocal_removal_info || {};
  const instrumentalUrl = (info && info.instrumental_url) || '';

  if (!taskId) return { statusCode: 200, body: '{}' };
  if (body.code != null && Number(body.code) !== 200) {
    console.error('[callback-instrumentale] Suno échec:', body.code, body.msg);  // pas d'audio -> on n'écrit rien
    return { statusCode: 200, body: '{}' };
  }
  if (!instrumentalUrl) return { statusCode: 200, body: '{}' };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const lit = formulaLiteral(taskId);
    if (lit === null) return { statusCode: 200, body: '{}' };
    const f = encodeURIComponent(`{instrumental_task_id}=${lit}`);
    const r = await fetch(`${API}/Projects?filterByFormula=${f}&maxRecords=1`, { headers });
    const d = await r.json();
    const projet = d.records && d.records[0];
    if (!projet) return { statusCode: 200, body: '{}' };   // rien à matcher (déjà nettoyé / inconnu)

    // Ré-héberge sur Cloudinary (permanent). Repli sur l'URL Suno si non configuré / échec.
    const pubId = `instrumental_${projet.fields.token || taskId}`;
    const hosted = await rehost(instrumentalUrl, { folder: 'instrumentales', publicId: pubId, resourceType: 'video' });

    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { instrumental_url: hosted || instrumentalUrl } })
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 200, body: '{}' };   // un callback ne doit jamais renvoyer une erreur à Suno
  }
};
