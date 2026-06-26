// netlify/functions/lancer-paroles-vivantes.js
//
// Enclenche la vidéo PAROLES VIVANTES (add-on payant) : paroles animées en fondu sur la chanson achetée.
// Appelé par MAKE D quand l'add-on est payé (token en paramètre), ou manuellement / par la page.
//   1. Récupère les paroles HORODATÉES : d'abord le timing STOCKÉ (lyrics_timing, capté à l'achat,
//      permanent) ; sinon fetch live Suno (si encore < ~15 j) ; sinon cadence douce.
//   2. Construit le RenderScript Creatomate (module partagé _lib/paroles-vivantes-timeline).
//   3. Lance le rendu Creatomate (async) -> callback-paroles-vivantes.js stockera l'URL de la vidéo.
//
// - Idempotent : si déjà rendu (video_url) -> renvoie ; si rendu en cours (video_task_id) -> 'pending'.
// - Sécurité : POST, UUID v4 strict, gaté Project 'purchased'. Clés en env (jamais en dur).
//   CREATOMATE_API_KEY, CREATOMATE_API_VERSION (v2 défaut), SUNO_API_KEY, CLOUDINARY_API_SECRET.

const crypto = require('crypto');
const { buildEditFromLyrics } = require('./_lib/paroles-vivantes-timeline');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_VERSION = process.env.CREATOMATE_API_VERSION || 'v1';   // v1 = { source, webhook_url, metadata } (doc) ; v2 = RenderScript au top-level
const SUNO_API_KEY       = process.env.SUNO_API_KEY;
const CLD_SECRET         = process.env.CLOUDINARY_API_SECRET;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// ── URL audio Cloudinary (chanson COMPLÈTE, signée si 'authenticated') — même logique que lire-projet ──
function parseCloudinary(url) {
  const m = /res\.cloudinary\.com\/([^/]+)\/video\/(upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(\.\w+)?$/.exec(url || '');
  return m ? { cloud: m[1], type: m[2], publicId: m[3], ext: m[4] || '' } : null;
}
function fullAudioUrl(stored) {
  const p = parseCloudinary(stored);
  if (!p) return '';
  if (p.type === 'authenticated' && CLD_SECRET) {
    const toSign = p.publicId + p.ext;   // pas de transformation -> chanson complète
    const sig = crypto.createHash('sha1').update(toSign + CLD_SECRET).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 8);
    return `https://res.cloudinary.com/${p.cloud}/video/authenticated/s--${sig}--/${p.publicId}${p.ext}`;
  }
  return `https://res.cloudinary.com/${p.cloud}/video/upload/${p.publicId}${p.ext}`;
}

// Timing stocké (capté à l'achat) -> permanent. Renvoie [] si absent/illisible.
function storedTiming(gen) {
  try { const a = JSON.parse(gen.fields.lyrics_timing || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

// Paroles horodatées Suno EN DIRECT (best-effort). Renvoie [] en cas d'échec -> cadence fixe.
async function alignedWordsLive(taskId, audioId) {
  if (!SUNO_API_KEY || !taskId || !audioId) return [];
  try {
    const r = await fetch('https://api.sunoapi.org/api/v1/generate/get-timestamped-lyrics', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUNO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, audioId })
    });
    const d = await r.json();
    const words = d && d.data && d.data.alignedWords;
    return Array.isArray(words) ? words : [];
  } catch (_) { return []; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!CREATOMATE_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration vidéo manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // 1. Project par token — doit être acheté.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // 3. Version achetée -> sa Generation (paroles, titre, source audio + ids Suno + timing stocké).
    const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
    if (!Number.isInteger(purchasedNo)) return { statusCode: 409, body: JSON.stringify({ error: 'Version achetée inconnue' }) };
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = dG.records && dG.records[0];
    if (!gen || !gen.fields.lyrics) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles introuvables' }) };

    // 2. Idempotence PAR VERSION : déjà livré -> renvoie l'URL ; rendu en cours -> 'pending'.
    //    Repli sur le Project (legacy) pour les données pas encore migrées.
    const vUrl  = gen.fields.video_url     || projet.fields.video_url;
    const vTask = gen.fields.video_task_id || projet.fields.video_task_id;
    if (vUrl)  return { statusCode: 200, body: JSON.stringify({ ok: true, video_url: vUrl, already: true }) };
    if (vTask) return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true }) };

    const audioUrl = fullAudioUrl(gen.fields.cloudinary_audio_url || '');
    if (!audioUrl) return { statusCode: 409, body: JSON.stringify({ error: 'Audio source introuvable' }) };

    // 4. Timing : stocké (permanent) en priorité, sinon live Suno, sinon cadence -> RenderScript.
    let alignedWords = storedTiming(gen);
    if (!alignedWords.length) alignedWords = await alignedWordsLive(gen.fields.suno_task_id, gen.fields.song_id);

    const clipStart = Number(body.clipStart) > 0 ? Number(body.clipStart) : 0;   // démo : démarrer à X s (couplet 2)
    const edit = buildEditFromLyrics({
      titre:  gen.fields.song_title || '',
      prenom: projet.fields.deceased_name || '',
      cadeau: projet.fields.song_type === 'cadeau',
      lyrics: gen.fields.lyrics || '',
      alignedWords, audioUrl, clipStart
    });
    if (!edit) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles vides' }) };

    // DRY-RUN (debug) : renvoie le texte+timings générés SANS rien rendre (0 crédit Creatomate).
    // Sert à vérifier l'alignement sur le vrai texte avant de dépenser un rendu.
    if (body.dryRun) {
      const tr = (edit.elements.find(e => Array.isArray(e.transcript_source)) || {}).transcript_source || [];
      const au = edit.elements.find(e => e.type === 'audio') || {};
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        ok: true, dryRun: true, count: tr.length, clipStart,
        titles: edit.elements.filter(e => e.track === 3).map(e => e.text),
        audio_time: au.time || 0, audio_trim_start: au.trim_start || 0,
        text: tr.map(w => w.value).join(' '),
        first: tr.slice(0, 8), last: tr.slice(-8)
      }) };
    }

    // 5. Lance le rendu Creatomate (async). webhook + metadata=token -> le callback retrouve la version achetée.
    //    v1 : { source, webhook_url, metadata } (forme documentée) ; v2 : RenderScript au top-level.
    const extra = { webhook_url: `${SITE}/api/callback-paroles-vivantes${process.env.CALLBACK_SECRET ? '?s=' + encodeURIComponent(process.env.CALLBACK_SECRET) : ''}`, metadata: token };
    const payload = (CREATOMATE_VERSION === 'v1')
      ? Object.assign({ source: edit }, extra)
      : Object.assign({}, edit, extra);
    const rC = await fetch(`https://api.creatomate.com/${CREATOMATE_VERSION}/renders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CREATOMATE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const dC = await rC.json();
    const render = Array.isArray(dC) ? dC[0] : dC;          // Creatomate renvoie un tableau de renders
    const renderId = render && render.id;
    if (!rC.ok || !renderId) {
      console.error('[lancer-paroles-vivantes] Creatomate a refusé. Détail:',
        (dC && (dC.message || dC.error)) || `HTTP ${rC.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Lancement de la vidéo échoué' }) };
    }

    // 6. Stocke l'ID de rendu SUR LA GENERATION -> le callback matche par ce champ (en plus du metadata).
    await fetch(`${API}/Generations/${gen.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { video_task_id: String(renderId) } })
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true }) };
  } catch (err) {
    console.error('[lancer-paroles-vivantes]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
