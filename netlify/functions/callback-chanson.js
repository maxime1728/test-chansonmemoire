// netlify/functions/callback-chanson.js
//
// Callback Suno pour la GÉNÉRATION de chanson (REMPLACE le scénario MAKE C-cb). Matché par
// suno_task_id (posé par lancer-chanson / sentinelle). Mirroir Netlify de C-cb :
//   1. Ré-héberge l'audio sur Cloudinary en `authenticated` (aperçu protégé, comme C-cb).
//   2. Passe la Generation à audio_generated (+ cloudinary_audio_url / public_id / song_id).
//   3. Passe le Project à funnel_step=preview_ready ET recalcule le compteur (chansons_reussies_avant)
//      -> plus besoin du module « recompte » dans Make.
// Idempotent (ne refait rien si déjà audio_generated). Répond TOUJOURS 200 (un callback ne doit
// jamais renvoyer d'erreur à Suno). Best-effort.
//
// BASCULE : pointer MAKE_CCB_WEBHOOK_URL (lu par lancer-chanson + sentinelle) vers
// https://chansonmemoire.ca/api/callback-chanson. Par défaut, ça reste le webhook Make (sûr).

const { rehost } = require('./_lib/cloudinary-rehost');
const { recomputerProjet } = require('./_lib/comptage');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const GENS     = 'tblfrHFe1zH9apNlp';
const PROJECTS = 'tblh7O8eoog7RyTMJ';

function formulaLiteral(v) { const s = String(v); if (!s.includes('"')) return `"${s}"`; if (!s.includes("'")) return `'${s}'`; return null; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  // Sécurité optionnelle : si CALLBACK_SECRET est défini, exiger ?s=<secret>. Inerte sinon.
  { const _s = (event.queryStringParameters && event.queryStringParameters.s) || ''; if (process.env.CALLBACK_SECRET && _s !== process.env.CALLBACK_SECRET) return { statusCode: 200, body: '{}' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 200, body: '{}' }; }

  const data   = body.data || {};
  const taskId = (data.task_id || '').trim();
  const arr    = Array.isArray(data.data) ? data.data : [];
  const track  = arr[1] || arr[0] || {};                          // C-cb utilisait data.data[1]
  const audioUrl = (track.source_audio_url || track.audio_url || '').trim();

  if (!taskId) return { statusCode: 200, body: '{}' };
  if (Number(body.code) !== 200 || data.callbackType !== 'complete' || !audioUrl) {
    if (body.code && Number(body.code) !== 200) console.error('[callback-chanson] Suno échec:', body.code, body.msg);
    return { statusCode: 200, body: '{}' };
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const lit = formulaLiteral(taskId);
    if (lit === null) return { statusCode: 200, body: '{}' };
    const rG = await fetch(`${API}/${GENS}?filterByFormula=${encodeURIComponent(`{suno_task_id}=${lit}`)}&maxRecords=1`, { headers });
    const gen = (((await rG.json()).records) || [])[0];
    if (!gen) return { statusCode: 200, body: '{}' };                                   // rien à matcher
    if (gen.fields.generation_status === 'audio_generated') return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };

    // 1. Ré-héberge en authenticated (aperçu protégé). Repli sur l'URL Suno si Cloudinary échoue.
    const hosted = await rehost(audioUrl, { publicId: `cm_${taskId}`, resourceType: 'video', type: 'authenticated' }) || audioUrl;

    // 2. Generation -> audio_generated.
    await fetch(`${API}/${GENS}/${gen.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { cloudinary_audio_url: hosted, cloudinary_public_id: `cm_${taskId}`, song_id: track.id || gen.fields.song_id || '', generation_status: 'audio_generated' } })
    });

    // 3. Project -> preview_ready + recalcul du compteur (remplace le module recompte de C-cb).
    const pid = Array.isArray(gen.fields.project) ? gen.fields.project[0] : null;
    if (pid) {
      try {
        const rp = await fetch(`${API}/${PROJECTS}/${pid}`, { headers });
        const pf = rp.ok ? ((await rp.json()).fields || {}) : {};
        await fetch(`${API}/${PROJECTS}/${pid}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { funnel_step: 'preview_ready' } }) });
        await recomputerProjet(API, headers, pid, pf.project);
      } catch (_) {}
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[callback-chanson]', err && err.message);
    return { statusCode: 200, body: '{}' };
  }
};
