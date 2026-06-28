// netlify/functions/callback-paroles-vivantes.js
//
// Reçoit le webhook Creatomate en fin de rendu -> écrit video_url sur la GENERATION achetée.
// Matching : par `metadata` (= token -> Project -> sa version achetée) en priorité ; sinon par
//   `video_task_id` sur Generations (repli Projects, legacy). Webhook public -> on ne pose que video_url.
// Répond TOUJOURS 200 (un webhook ne doit jamais renvoyer d'erreur au fournisseur).
//
// PERMANENCE : l'URL Creatomate est conservée ~30 j -> on RÉ-HÉBERGE la vidéo sur Cloudinary (copie
//   permanente) avant de l'écrire. Si Cloudinary échoue/non configuré -> repli sur l'URL Creatomate.
//
// Payload Creatomate : { id, status:"succeeded"|"failed"|…, url, metadata, … }

const { rehost } = require('./_lib/cloudinary-rehost');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  // Sécurité (T8) : si CALLBACK_SECRET est défini, exiger ?s=<secret> (posé par lancer-paroles-vivantes). Inerte sinon. 200 silencieux si invalide.
  { const _s = (event.queryStringParameters && event.queryStringParameters.s) || ''; if (process.env.CALLBACK_SECRET && _s !== process.env.CALLBACK_SECRET) return { statusCode: 200, body: '{}' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, body: '{}' }; }

  const renderId = (body.id || '').trim();
  const status   = (body.status || '').trim();
  const videoUrl = (body.url || '').trim();
  const meta     = (body.metadata || '').toString().trim();

  if (status !== 'succeeded' || !videoUrl) {
    if (status === 'failed') console.error('[callback-paroles-vivantes] Creatomate échec:', renderId, body.error || '');
    return { statusCode: 200, body: '{}' };   // pas prêt / échec -> on n'écrit rien
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    // Cible = la GENERATION achetée. Deux chemins : metadata=token (-> Project -> sa version achetée),
    // sinon video_task_id (-> directement la Generation ; repli Projects pour le legacy).
    let target = null;   // { table, id }

    if (UUID_V4.test(meta)) {
      const projet = (((await (await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{token}=${formulaLiteral(meta)}`)}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
      if (projet) {
        const no = parseInt(projet.fields.purchased_generation_no, 10);
        const projLit = formulaLiteral(projet.fields.project);
        if (Number.isInteger(no) && projLit !== null) {
          const fg = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${no})`);
          const gen = (((await (await fetch(`${API}/Generations?filterByFormula=${fg}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
          if (gen) target = { table: 'Generations', id: gen.id };
        }
        if (!target) target = { table: 'Projects', id: projet.id };   // repli legacy
      }
    } else if (renderId) {
      const lit = formulaLiteral(renderId);
      if (lit !== null) {
        const fr = encodeURIComponent(`{video_task_id}=${lit}`);
        const gen = (((await (await fetch(`${API}/Generations?filterByFormula=${fr}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
        if (gen) target = { table: 'Generations', id: gen.id };
        else {
          const projet = (((await (await fetch(`${API}/Projects?filterByFormula=${fr}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
          if (projet) target = { table: 'Projects', id: projet.id };
        }
      }
    }
    if (!target) return { statusCode: 200, body: '{}' };   // rien à matcher (inconnu / déjà nettoyé)

    // Ré-héberge sur Cloudinary (permanent). Repli sur l'URL Creatomate si non configuré / échec.
    const hosted = await rehost(videoUrl, { folder: 'paroles-vivantes', publicId: `video_${renderId || meta}`, resourceType: 'video' });

    await fetch(`${API}/${target.table}/${target.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { video_url: hosted || videoUrl } })
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 200, body: '{}' };   // un callback ne renvoie jamais d'erreur au fournisseur
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
