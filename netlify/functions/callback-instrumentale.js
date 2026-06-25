// netlify/functions/callback-instrumentale.js
//
// Reçoit le callback Suno vocal-removal (separate_vocal) -> écrit instrumental_url + vocal_url sur la
// GENERATION qui porte ce instrumental_task_id (posé par lancer-instrumentale). Repli sur Projects (legacy).
// NOTE : separate_vocal renvoie 2 pistes (instrumental + voix isolée). On stocke les DEUX (vocal_url en
//   PATCH séparé best-effort). Webhook public : matche par task_id Suno (non devinable) -> faible risque.
// Répond TOUJOURS 200 à Suno (pour ne pas déclencher de réessais).
//
// PERMANENCE : les URLs Suno expirent (~15 j) -> on RÉ-HÉBERGE chaque piste sur Cloudinary (copie
//   permanente) avant de l'écrire. Repli sur l'URL Suno si Cloudinary échoue/non configuré.
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
  const vocalUrl        = (info && info.vocal_url) || '';   // separate_vocal renvoie AUSSI la voix isolée

  if (!taskId) return { statusCode: 200, body: '{}' };
  if (body.code != null && Number(body.code) !== 200) {
    console.error('[callback-instrumentale] Suno échec:', body.code, body.msg);  // pas d'audio -> on n'écrit rien
    return { statusCode: 200, body: '{}' };
  }
  if (!instrumentalUrl && !vocalUrl) return { statusCode: 200, body: '{}' };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const lit = formulaLiteral(taskId);
    if (lit === null) return { statusCode: 200, body: '{}' };
    const f = encodeURIComponent(`{instrumental_task_id}=${lit}`);

    // Cible = la GENERATION qui porte ce task_id (nouveau modèle). Repli sur Projects (legacy).
    let table = 'Generations';
    let rec = (((await (await fetch(`${API}/Generations?filterByFormula=${f}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
    if (!rec) {
      rec = (((await (await fetch(`${API}/Projects?filterByFormula=${f}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
      table = 'Projects';
    }
    if (!rec) return { statusCode: 200, body: '{}' };   // rien à matcher (déjà nettoyé / inconnu)

    // 1. INSTRUMENTAL -> ré-héberge (permanent) + écrit instrumental_url. PATCH dédié : c'est la
    //    livraison de l'upsell, elle ne doit jamais échouer à cause d'un autre champ.
    if (instrumentalUrl) {
      const hosted = await rehost(instrumentalUrl, { folder: 'instrumentales', publicId: `instrumental_${taskId}`, resourceType: 'video' });
      await fetch(`${API}/${table}/${rec.id}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { instrumental_url: hosted || instrumentalUrl } })
      });
    }

    // 2. VOIX ISOLÉE -> ré-héberge + écrit vocal_url. PATCH SÉPARÉ best-effort : si le champ
    //    vocal_url manque sur la table ciblée, l'instrumental (ci-dessus) reste livré.
    if (vocalUrl) {
      try {
        const hostedV = await rehost(vocalUrl, { folder: 'vocals', publicId: `vocal_${taskId}`, resourceType: 'video' });
        await fetch(`${API}/${table}/${rec.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { vocal_url: hostedV || vocalUrl } })
        });
      } catch (_) { /* ne casse jamais la livraison de l'instrumental */ }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 200, body: '{}' };   // un callback ne doit jamais renvoyer une erreur à Suno
  }
};
