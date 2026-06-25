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

const { rehost } = require('./_lib/cloudinary-rehost');

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
    // Idempotence : déjà enregistrée pour ce task_id ?
    const lit = formulaLiteral(taskId);
    if (lit === null) return { statusCode: 200, body: '{}' };
    const rEx = await fetch(`${API}/Generations?filterByFormula=${encodeURIComponent(`{suno_task_id}=${lit}`)}&maxRecords=1`, { headers });
    const dEx = await rEx.json();
    if (dEx.records && dEx.records.length) return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };

    // Project par cover_task_id.
    const rP = await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{cover_task_id}=${lit}`)}&maxRecords=1`, { headers });
    const dP = await rP.json();
    const projet = dP.records && dP.records[0];
    if (!projet) return { statusCode: 200, body: '{}' };   // rien à matcher
    const p = projet.fields;
    const projLit = formulaLiteral(p.project);
    if (projLit === null) return { statusCode: 200, body: '{}' };

    // Version source (achetée) : titre + paroles/style de repli + numéro max.
    const purchasedNo = parseInt(p.purchased_generation_no, 10);
    let src = {};
    if (Number.isInteger(purchasedNo)) {
      const rS = await fetch(`${API}/Generations?filterByFormula=${encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`)}&maxRecords=1`, { headers });
      const dSg = await rS.json();
      src = (dSg.records && dSg.records[0] && dSg.records[0].fields) || {};
    }
    // Nouveau generation_no = max + 1.
    const rMax = await fetch(`${API}/Generations?filterByFormula=${encodeURIComponent(`{project}=${projLit}`)}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
    const dMax = await rMax.json();
    const maxNo = (dMax.records && dMax.records[0] && Number(dMax.records[0].fields.generation_no)) || 0;
    const newNo = maxNo + 1;

    // 1. Ré-héberge l'audio (permanent). Repli sur l'URL Suno si Cloudinary échoue.
    const hosted = await rehost(audioUrl, { folder: 'covers', publicId: `cover_${p.token}_${newNo}`, resourceType: 'video' }) || audioUrl;

    // 2. Crée la nouvelle Generation (cover).
    const fields = {
      project: [projet.id],
      generation_no: newNo,
      type: 'cover',
      lyrics: (p.adjusted_lyrics && p.adjusted_lyrics.trim()) || src.lyrics || '',
      song_title: src.song_title || track.title || 'Pour toujours',
      cloudinary_audio_url: hosted,
      song_id: track.id || '',
      suno_task_id: taskId,
      post_purchase: true,
      generation_status: 'audio_generated'
    };
    if (src.gen_music_style) fields.gen_music_style = src.gen_music_style;
    if (src.gen_mood)        fields.gen_mood        = src.gen_mood;
    if (src.gen_voice)       fields.gen_voice       = src.gen_voice;
    await fetch(`${API}/Generations`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });

    // 3. Livre cette version + ferme la boucle (prêt pour un éventuel tour suivant).
    //    purchased_generation_no n'est basculé qu'en POST-achat ; en pré-achat (cover d'aperçu) la
    //    nouvelle génération devient simplement la plus récente (lire-projet sert la dernière).
    const projPatch = { approval_status: 'published', cover_task_id: null, cover_launched_at: null };
    if (Number.isInteger(purchasedNo)) projPatch.purchased_generation_no = newNo;
    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: projPatch })
    });

    // 4. Courriel « nouvelle version prête » (best-effort, voix de marque).
    try {
      const to = await emailClient(projet, headers);
      const html = `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;">` +
        `<p style="font-size:18px;color:#5C2D4A;">Votre nouvelle version est prête.</p>` +
        `<p>On a appliqué votre demande de modification. Écoutez et téléchargez la version mise à jour sur votre page :</p>` +
        `<p style="margin:22px 0;"><a href="${p.page_url || (SITE + '/page-memoire?id=' + encodeURIComponent(p.token))}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;">Écouter ma nouvelle version</a></p>` +
        `<p style="color:#7A6070;">— L'équipe Chanson Mémoire</p></div>`;
      await envoyerCourriel(to, 'Votre nouvelle version est prête', html);
    } catch (_) { /* le courriel ne bloque pas la livraison */ }

    return { statusCode: 200, body: JSON.stringify({ ok: true, generation_no: newNo }) };
  } catch (err) {
    console.error('[callback-cover]', err && err.message);
    return { statusCode: 200, body: '{}' };   // un callback ne renvoie jamais d'erreur à Suno
  }
};
