// netlify/functions/callback-cover.js
//
// Reçoit le callback Suno « Upload & Cover » -> enregistre la nouvelle version (cover, mélodie
// préservée) et la LIVRE au client. Matché par cover_task_id (posé par lancer-cover).
//   1. Ré-héberge l'audio sur Cloudinary (permanent).
//   2. Crée une nouvelle Generation (type=cover, post_purchase) avec les paroles ajustées.
//   3. Bascule purchased_generation_no -> cette version ; approval_status=published ; vide
//      cover_task_id/cover_launched_at (prêt pour un éventuel tour suivant).
//   4. Courriel client « votre nouvelle version est prête » (best-effort).
// Répond TOUJOURS 200. Agit uniquement sur callbackType="complete". Idempotent (suno_task_id unique).
//
// Payload : { code, data: { callbackType, task_id, data:[{ id, audio_url, title, duration, ... }] } }

const { livrerCover, prochainNo } = require('./_lib/cover');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;     // transactionnel
const MG_FROM   = process.env.MAILGUN_FROM_ACHAT || process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';   // post-achat -> sous-domaine achat

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

async function envoyerCourriel(to, subject, html) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM); form.append('to', to);
  form.append('subject', subject); form.append('html', html);
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  try { const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form }); return r.ok; }
  catch (_) { return false; }
}
async function emailClient(projet, headers) {
  try {
    const recId = Array.isArray(projet.fields.Client) ? projet.fields.Client[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/Clients/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  // Sécurité (T8) : si CALLBACK_SECRET est défini, exiger ?s=<secret> (posé par lancer-cover). Inerte sinon. 200 silencieux si invalide.
  { const _s = (event.queryStringParameters && event.queryStringParameters.s) || ''; if (process.env.CALLBACK_SECRET && _s !== process.env.CALLBACK_SECRET) return { statusCode: 200, body: '{}' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, body: '{}' }; }

  const data   = body.data || {};
  const taskId = (data.task_id || '').trim();
  const track  = (Array.isArray(data.data) && data.data[0]) || {};
  const audioUrl = (track.audio_url || '').trim();

  if (!taskId) return { statusCode: 200, body: '{}' };
  if (Number(body.code) !== 200 || data.callbackType !== 'complete' || !audioUrl) {
    if (body.code && Number(body.code) !== 200) console.error('[callback-cover] Suno échec:', body.code, body.msg);
    return { statusCode: 200, body: '{}' };   // on agit seulement quand la cover est COMPLÈTE
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const lit = formulaLiteral(taskId);
    if (lit === null) return { statusCode: 200, body: '{}' };

    // Generation portant ce task (créée en audio_pending par lancer-cover — modèle Generation-level).
    const rEx = await fetch(`${API}/Generations?filterByFormula=${encodeURIComponent(`{suno_task_id}=${lit}`)}&maxRecords=1`, { headers });
    let coverGen = (((await rEx.json()).records) || [])[0] || null;
    // Déjà livrée (idempotence) ?
    if (coverGen && (coverGen.fields || {}).generation_status === 'audio_generated') return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };

    // Project par cover_task_id.
    const rP = await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{cover_task_id}=${lit}`)}&maxRecords=1`, { headers });
    const projet = (((await rP.json()).records) || [])[0] || null;
    if (!projet) return { statusCode: 200, body: '{}' };   // rien à matcher
    const p = projet.fields;
    const projLit = formulaLiteral(p.project);
    if (projLit === null) return { statusCode: 200, body: '{}' };

    // Pas de Generation pré-créée (regenerate=true / legacy) -> on en crée une (audio_pending) avec les
    // infos de la version source, puis on la livre par le même chemin partagé.
    if (!coverGen) {
      // Plafond v2 : régé/cover déclenché par l'équipe (marqueur cover_admin) -> admin_triggered (ne compte pas).
      const adminCover = process.env.PLAFOND_V2 === '1' && !!p.cover_admin;
      const purchasedNo = parseInt(p.purchased_generation_no, 10);
      let src = {};
      if (Number.isInteger(purchasedNo)) {
        const rS = await fetch(`${API}/Generations?filterByFormula=${encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`)}&maxRecords=1`, { headers });
        src = ((((await rS.json()).records) || [])[0] || {}).fields || {};
      }
      const newNo = await prochainNo(API, headers, p.project);
      const fields = {
        project: [projet.id], generation_no: newNo, type: 'cover', generation_status: 'audio_pending',
        // Plafond v2 : post_purchase = vraie phase (régé d'aperçu compte AVANT achat). Flag OFF -> true en dur.
        post_purchase: (process.env.PLAFOND_V2 === '1') ? (p.commercial_status === 'purchased') : true,
        suno_task_id: taskId,
        lyrics: (p.adjusted_lyrics && p.adjusted_lyrics.trim()) || src.lyrics || '',
        song_title: src.song_title || track.title || 'Pour toujours'
      };
      if (src.gen_music_style) fields.gen_music_style = src.gen_music_style;
      if (src.gen_mood)        fields.gen_mood        = src.gen_mood;
      if (src.gen_voice)       fields.gen_voice       = src.gen_voice;
      if (p.pending_cover_style && p.pending_cover_style.trim()) fields.gen_style_prompt = p.pending_cover_style.trim();
      if (adminCover) fields.admin_triggered = true;
      const rC = await fetch(`${API}/Generations`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
      coverGen = await rC.json();
      if (!coverGen.fields) coverGen.fields = fields;
      // Vide le marqueur équipe (la régé l'avait laissé pour ce callback ; ne doit pas fuiter au prochain cover).
      if (adminCover) { try { await fetch(`${API}/Projects/${projet.id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { cover_admin: false } }) }); } catch (_) {} }
    }

    // Livraison PARTAGÉE (_lib/cover) : audio ré-hébergé, Generation -> audio_generated, version basculée si
    // post-achat, champs cover du Projet vidés, courriel client. Idempotent.
    const res = await livrerCover({ api: API, headers, projet, coverGen, audioUrl, songId: track.id || '' });
    return { statusCode: 200, body: JSON.stringify({ ok: true, generation_no: res.generation_no }) };
  } catch (err) {
    console.error('[callback-cover]', err && err.message);
    return { statusCode: 200, body: '{}' };   // un callback ne renvoie jamais d'erreur à Suno
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
