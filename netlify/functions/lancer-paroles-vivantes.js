// netlify/functions/lancer-paroles-vivantes.js
//
// Enclenche la vidéo PAROLES VIVANTES (add-on payant) : paroles animées en fondu sur la chanson achetée.
// Appelé par MAKE D quand l'add-on est payé (token en paramètre), ou manuellement / par la page.
//   1. Récupère les paroles HORODATÉES de Suno (startS/endS par mot) pour caler chaque ligne sur la voix.
//   2. Construit l'« edit » Shotstack (module partagé _lib/paroles-vivantes-timeline).
//   3. Lance le rendu Shotstack (async) -> callback-paroles-vivantes.js stockera l'URL de la vidéo.
//
// - Idempotent : si déjà rendu (video_url) -> renvoie ; si rendu en cours (video_task_id) -> 'pending'.
// - Sécurité : POST, UUID v4 strict, gaté Project 'purchased'. Clés en env (jamais en dur).
//   SHOTSTACK_API_KEY (x-api-key), SHOTSTACK_ENV ('stage' sandbox | 'v1' prod), SHOTSTACK_RESOLUTION.
//   SUNO_API_KEY (paroles horodatées), CLOUDINARY_API_SECRET (URL audio signée).

const crypto = require('crypto');
const { buildEditFromLyrics } = require('./_lib/paroles-vivantes-timeline');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY;
const SHOTSTACK_ENV     = process.env.SHOTSTACK_ENV || 'stage';        // 'stage' (sandbox gratuit) | 'v1' (prod)
const RESOLUTION        = process.env.SHOTSTACK_RESOLUTION || 'hd';
const SUNO_API_KEY      = process.env.SUNO_API_KEY;
const CLD_SECRET        = process.env.CLOUDINARY_API_SECRET;

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

// Paroles horodatées Suno (best-effort). Renvoie [] en cas d'échec -> le module retombe sur une cadence fixe.
async function alignedWordsFrom(taskId, audioId) {
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
  if (!SHOTSTACK_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration vidéo manquante' }) };

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

    // 2. Idempotence : déjà livré -> renvoie l'URL ; rendu en cours -> 'pending' (pas de relance).
    if (projet.fields.video_url) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, video_url: projet.fields.video_url, already: true }) };
    }
    if (projet.fields.video_task_id) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true }) };
    }

    // 3. Version achetée -> sa Generation (paroles, titre, source audio + ids Suno).
    const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
    if (!Number.isInteger(purchasedNo)) return { statusCode: 409, body: JSON.stringify({ error: 'Version achetée inconnue' }) };
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = dG.records && dG.records[0];
    if (!gen || !gen.fields.lyrics) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles introuvables' }) };

    const audioUrl = fullAudioUrl(gen.fields.cloudinary_audio_url || '');
    if (!audioUrl) return { statusCode: 409, body: JSON.stringify({ error: 'Audio source introuvable' }) };

    // 4. Paroles horodatées (best-effort) -> edit Shotstack.
    const alignedWords = await alignedWordsFrom(gen.fields.suno_task_id, gen.fields.song_id);
    const edit = buildEditFromLyrics({
      titre:        gen.fields.song_title || '',
      prenom:       projet.fields.deceased_name || '',
      lyrics:       gen.fields.lyrics || '',
      alignedWords,
      audioUrl,
      resolution:   RESOLUTION
    });
    if (!edit) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles vides' }) };
    edit.callback = `${SITE}/api/callback-paroles-vivantes`;

    // 5. Lance le rendu Shotstack (async). x-api-key, jamais en dur.
    const rS = await fetch(`https://api.shotstack.io/edit/${SHOTSTACK_ENV}/render`, {
      method: 'POST',
      headers: { 'x-api-key': SHOTSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(edit)
    });
    const dS = await rS.json();
    const renderId = dS && dS.response && dS.response.id;
    if (!rS.ok || !renderId) {
      console.error('[lancer-paroles-vivantes] Shotstack a refusé. Détail:',
        (dS && (dS.message || (dS.response && dS.response.message))) || `HTTP ${rS.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Lancement de la vidéo échoué' }) };
    }

    // 6. Stocke l'ID de rendu -> le callback matchera le Project par ce champ.
    await fetch(`${API}/Projects/${projet.id}`, {
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
