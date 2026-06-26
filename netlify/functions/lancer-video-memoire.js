// netlify/functions/lancer-video-memoire.js
//
// Enclenche la VIDÉO MÉMOIRE (add-on) : diaporama des photos du client (memoire_photos) porté par la
// chanson achetée. Même mécanique que lancer-paroles-vivantes :
//   1. Project acheté + au moins MIN_PHOTOS photos.
//   2. Generation achetée -> paroles (pour la durée), timing Suno (stocké/live), audio Cloudinary.
//   3. RenderScript via _lib/video-memoire-timeline -> rendu Creatomate (async) -> callback.
//
// Idempotent (video_memoire_url / video_memoire_task_id). Sécurité : POST, UUID v4, gaté purchased.
// `clipStart` (sec) optionnel = démo (démarre à un couplet, comme paroles vivantes).

const crypto = require('crypto');
const { buildVideoMemoire } = require('./_lib/video-memoire-timeline');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_PHOTOS = 10;

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_VERSION = process.env.CREATOMATE_API_VERSION || 'v1';
const SUNO_API_KEY       = process.env.SUNO_API_KEY;
const CLD_SECRET         = process.env.CLOUDINARY_API_SECRET;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// ── URL audio Cloudinary COMPLÈTE (signée si authenticated) — même logique que lancer-paroles-vivantes ──
function parseCloudinary(url) {
  const m = /res\.cloudinary\.com\/([^/]+)\/video\/(upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(\.\w+)?$/.exec(url || '');
  return m ? { cloud: m[1], type: m[2], publicId: m[3], ext: m[4] || '' } : null;
}
function fullAudioUrl(stored) {
  const p = parseCloudinary(stored);
  if (!p) return '';
  if (p.type === 'authenticated' && CLD_SECRET) {
    const toSign = p.publicId + p.ext;
    const sig = crypto.createHash('sha1').update(toSign + CLD_SECRET).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 8);
    return `https://res.cloudinary.com/${p.cloud}/video/authenticated/s--${sig}--/${p.publicId}${p.ext}`;
  }
  return `https://res.cloudinary.com/${p.cloud}/video/upload/${p.publicId}${p.ext}`;
}

function storedTiming(gen) {
  try { const a = JSON.parse(gen.fields.lyrics_timing || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
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

function readPhotos(projet) {
  try { const a = JSON.parse(projet.fields.memoire_photos || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!CREATOMATE_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration vidéo manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  const clipStart = Number(body.clipStart) > 0 ? Number(body.clipStart) : 0;

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    // 1. Project acheté.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || !dP.records.length) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // 2. Photos.
    const photos = readPhotos(projet);
    if (photos.length < MIN_PHOTOS) {
      return { statusCode: 409, body: JSON.stringify({ error: `Ajoute au moins ${MIN_PHOTOS} photos`, count: photos.length, min: MIN_PHOTOS }) };
    }

    // 3. Generation achetée (paroles + timing + audio).
    const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
    if (!Number.isInteger(purchasedNo)) return { statusCode: 409, body: JSON.stringify({ error: 'Version achetée inconnue' }) };
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = dG.records && dG.records[0];
    if (!gen || !gen.fields.lyrics) return { statusCode: 409, body: JSON.stringify({ error: 'Chanson introuvable' }) };

    // 4. Idempotence PAR VERSION (sauf force = aperçus multi-styles).
    if (!body.force && gen.fields.video_memoire_url)     return { statusCode: 200, body: JSON.stringify({ ok: true, video_memoire_url: gen.fields.video_memoire_url, already: true }) };
    if (!body.force && gen.fields.video_memoire_task_id) return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true }) };

    const audioUrl = fullAudioUrl(gen.fields.cloudinary_audio_url || '');
    if (!audioUrl) return { statusCode: 409, body: JSON.stringify({ error: 'Audio source introuvable' }) };

    let alignedWords = storedTiming(gen);
    if (!alignedWords.length) alignedWords = await alignedWordsLive(gen.fields.suno_task_id, gen.fields.song_id);

    const edit = buildVideoMemoire({
      titre:  gen.fields.song_title || '',
      prenom: projet.fields.deceased_name || '',
      cadeau: projet.fields.song_type === 'cadeau',
      photos, lyrics: gen.fields.lyrics || '', alignedWords, audioUrl, clipStart,
      style:       body.style || 'fullscreen',
      maxDuration: Number(body.maxDuration) > 0 ? Number(body.maxDuration) : 0,
      naissance:   body.naissance || '',
      deces:       body.deces || '',
      citation:    body.citation || ''
    });
    if (!edit) return { statusCode: 409, body: JSON.stringify({ error: 'Diaporama vide' }) };

    if (body.dryRun) {
      const imgs = edit.elements.filter(e => e.type === 'image').length;
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, photos: photos.length, slots: imgs, clipStart }) };
    }

    // 5. Rendu Creatomate (async) -> callback-video-memoire. Le webhook doit tomber sur CE déploiement
    //    (branch deploy en test, prod en prod) via DEPLOY_PRIME_URL -> le callback existe forcément là.
    const self = process.env.DEPLOY_PRIME_URL || process.env.URL || SITE;
    const extra = { webhook_url: `${self}/api/callback-video-memoire${process.env.CALLBACK_SECRET ? '?s=' + encodeURIComponent(process.env.CALLBACK_SECRET) : ''}`, metadata: token };
    const payload = (CREATOMATE_VERSION === 'v1') ? Object.assign({ source: edit }, extra) : Object.assign({}, edit, extra);
    const rC = await fetch(`https://api.creatomate.com/${CREATOMATE_VERSION}/renders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CREATOMATE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const dC = await rC.json();
    const render = Array.isArray(dC) ? dC[0] : dC;
    const renderId = render && render.id;
    if (!rC.ok || !renderId) {
      console.error('[lancer-video-memoire] Creatomate a refusé. Détail:', (dC && (dC.message || dC.error)) || `HTTP ${rC.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Lancement de la vidéo échoué' }) };
    }

    // 6. Stocke l'ID de rendu sur la Generation (clé de match du callback). Pas en mode force (aperçus).
    if (!body.force) {
      await fetch(`${API}/Generations/${gen.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { video_memoire_task_id: String(renderId) } })
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true, renderId: String(renderId) }) };
  } catch (err) {
    console.error('[lancer-video-memoire]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
