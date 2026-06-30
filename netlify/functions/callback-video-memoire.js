// netlify/functions/callback-video-memoire.js
//
// Webhook Creatomate en fin de rendu de la VIDÉO MÉMOIRE -> écrit video_memoire_url sur la GENERATION
// achetée. Matching : metadata (= token -> Project -> version achetée) en priorité, sinon
// video_memoire_task_id sur Generations. Ré-héberge sur Cloudinary (permanent). Répond TOUJOURS 200.

const { rehost } = require('./_lib/cloudinary-rehost');

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  // Sécurité : si CALLBACK_SECRET est défini, exiger ?s=<secret> (posé par lancer-video-memoire).
  { const _s = (event.queryStringParameters && event.queryStringParameters.s) || ''; if (process.env.CALLBACK_SECRET && _s !== process.env.CALLBACK_SECRET) return { statusCode: 200, body: '{}' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, body: '{}' }; }

  const renderId = (body.id || '').trim();
  const status   = (body.status || '').trim();
  const videoUrl = (body.url || '').trim();
  const meta     = (body.metadata || '').toString().trim();

  if (status !== 'succeeded' || !videoUrl) {
    if (status === 'failed') console.error('[callback-video-memoire] Creatomate échec:', renderId, body.error || '');
    return { statusCode: 200, body: '{}' };
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    let genId = null, projetId = null;   // projetId -> suivi order bump : extra_video_memoire = 'livre'

    if (UUID_V4.test(meta)) {
      const projet = (((await (await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{token}=${formulaLiteral(meta)}`)}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
      if (projet) {
        projetId = projet.id;
        const no = parseInt(projet.fields.purchased_generation_no, 10);
        const projLit = formulaLiteral(projet.fields.project);
        if (Number.isInteger(no) && projLit !== null) {
          const fg = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${no})`);
          const gen = (((await (await fetch(`${API}/Generations?filterByFormula=${fg}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
          if (gen) genId = gen.id;
        }
      }
    } else if (renderId) {
      const lit = formulaLiteral(renderId);
      if (lit !== null) {
        const fr = encodeURIComponent(`{video_memoire_task_id}=${lit}`);
        const gen = (((await (await fetch(`${API}/Generations?filterByFormula=${fr}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
        if (gen) {
          genId = gen.id;
          // Résout le Projet depuis la Generation (chemin de repli) pour le suivi order bump.
          const pl = formulaLiteral(gen.fields.project);
          if (pl !== null) {
            const pr = (((await (await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{project}=${pl}`)}&maxRecords=1`, { headers })).json()) || {}).records || [])[0] || null;
            if (pr) projetId = pr.id;
          }
        }
      }
    }
    if (!genId) return { statusCode: 200, body: '{}' };

    const hosted = await rehost(videoUrl, { folder: 'video-memoire', publicId: `memoire_${renderId || meta}`, resourceType: 'video' });

    await fetch(`${API}/Generations/${genId}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { video_memoire_url: hosted || videoUrl } })
    });
    // Suivi order bump (Phase 2) : vidéo livrée -> 'livre' sur le Projet (vue admin). Best-effort + typecast.
    if (projetId) { try { await fetch(`${API}/Projects/${projetId}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ typecast: true, fields: { extra_video_memoire: 'livre' } }) }); } catch (_) {} }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 200, body: '{}' };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
