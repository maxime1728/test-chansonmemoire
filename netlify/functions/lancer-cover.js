// netlify/functions/lancer-cover.js
//
// VRAIE COVER (mélodie préservée) après APPROBATION d'une correction (boucle décortique).
// Appelé par MAKE (Search approval_status=approved ET cover_launched_at vide) -> POST { token }.
// Utilise Suno « Upload & Cover » : POST /api/v1/generate/upload-cover { uploadUrl, prompt, style,
//   title, customMode, instrumental, model, vocalGender, callBackUrl } -> garde la mélodie, change
//   les paroles. Async -> callback-cover.js stocke le résultat (nouvelle version livrée).
// NE passe PAS par C-gen (donc rien à modifier dans C-gen). Tout est ici (comme l'instrumentale).
//
// Idempotent : pose cover_task_id + cover_launched_at ; le callback les vide à la livraison (multi-tours OK).
// Sécurité : POST, UUID v4, gaté purchased + approval_status=approved. Clés en env (SUNO_API_KEY, CLOUDINARY).

const crypto = require('crypto');
const { styleFor } = require('./_lib/style');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUNO_API_KEY = process.env.SUNO_API_KEY;
const CLD_SECRET   = process.env.CLOUDINARY_API_SECRET;
const MODEL        = 'V5_5';

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// URL audio Cloudinary COMPLÈTE (signée si 'authenticated') — sert de source à couvrir. (= lire-projet)
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!SUNO_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration Suno manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  const regenerate = !!body.regenerate;   // true = chanson COMPLÈTE (nouvelle mélodie, /generate) ; false = cover (mélodie préservée)

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // 1. Project par token.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    const p = projet.fields;

    // 2. Garde-fous + idempotence. La cover n'est déclenchée que sur une demande APPROUVÉE
    //    (post-achat OU pré-achat : prononciation/paroles sur l'aperçu). Plus de garde « purchased ».
    if (p.approval_status !== 'approved')       return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not_approved' }) };
    if (p.cover_task_id || p.cover_launched_at) return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };

    // 3. Mélodie source à couvrir : version ACHETÉE si connue, sinon DERNIÈRE génération (aperçu pré-achat).
    const projLit = formulaLiteral(p.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    // Version source : override manuel (cover_source_no, choisi dans le cockpit) > version achetée > dernière génération.
    const overrideNo  = parseInt(p.cover_source_no, 10);
    const purchasedNo = parseInt(p.purchased_generation_no, 10);
    const sourceNo    = Number.isInteger(overrideNo) ? overrideNo
                      : (Number.isInteger(purchasedNo) ? purchasedNo : null);
    async function trouverGen(no) {
      const fG  = Number.isInteger(no) ? `AND({project}=${projLit},{generation_no}=${no})` : `{project}=${projLit}`;
      const tri = Number.isInteger(no) ? '' : '&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc';
      const r = await fetch(`${API}/Generations?filterByFormula=${encodeURIComponent(fG)}${tri}&maxRecords=1`, { headers });
      const d = await r.json();
      return d.records && d.records[0];
    }
    let gen = await trouverGen(sourceNo);
    if (!gen && Number.isInteger(overrideNo)) gen = await trouverGen(null);   // version demandée introuvable -> dernière génération
    if (!gen) return { statusCode: 409, body: JSON.stringify({ error: 'Version source introuvable' }) };
    const g = gen.fields;

    const uploadUrl = fullAudioUrl(g.cloudinary_audio_url || '');
    if (!regenerate && !uploadUrl) return { statusCode: 409, body: JSON.stringify({ error: 'Audio source introuvable' }) };

    // Paroles ajustées (decortique) -> sinon paroles d'origine. Style ajusté -> sinon style d'origine.
    const prompt = (p.adjusted_lyrics && p.adjusted_lyrics.trim()) || (g.lyrics_phonetique && g.lyrics_phonetique.trim()) || g.lyrics || '';   // #12 : phonétique si présente
    if (!prompt.trim()) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles introuvables' }) };
    const style = (p.adjusted_style_prompt && p.adjusted_style_prompt.trim())
      || await styleFor({ music_style: g.gen_music_style || p.music_style, mood: g.gen_mood || p.mood, cadeau: p.song_type === 'cadeau', language: p.language });
    const vocalGender = /Masculin/i.test(g.gen_voice || p.voice || '') ? 'm' : 'f';

    // 4. Suno (async -> callback-cover). regenerate=true : /generate (NOUVELLE mélodie, sans source) ;
    //    sinon : /upload-cover (mélodie PRÉSERVÉE, à partir de l'audio source).
    const sunoPayload = {
      customMode: true,
      instrumental: false,
      model: MODEL,
      prompt: prompt.slice(0, 5000),
      style: style.slice(0, 1000),
      title: (g.song_title || 'Pour toujours').slice(0, 100),
      vocalGender,
      callBackUrl: `${SITE}/api/callback-cover${process.env.CALLBACK_SECRET ? '?s=' + encodeURIComponent(process.env.CALLBACK_SECRET) : ''}`
    };
    if (!regenerate) sunoPayload.uploadUrl = uploadUrl;   // la cover a besoin de l'audio source
    const sunoEndpoint = regenerate
      ? 'https://api.sunoapi.org/api/v1/generate'
      : 'https://api.sunoapi.org/api/v1/generate/upload-cover';
    const rS = await fetch(sunoEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUNO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sunoPayload)
    });
    const dS = await rS.json();
    const taskId = dS && dS.data && dS.data.taskId;
    if (!rS.ok || !taskId) {
      console.error('[lancer-cover] Suno upload-cover refusé:', (dS && dS.msg) || `HTTP ${rS.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Lancement de la cover échoué' }) };
    }

    // 5. Marque (idempotence + matching callback). pending_cover_style = prompt EXACT envoye a Suno ->
    //    callback-cover le copie sur gen_style_prompt de la nouvelle version (historique du style).
    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { cover_task_id: String(taskId), cover_launched_at: new Date().toISOString(), pending_cover_style: style } })
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true }) };
  } catch (err) {
    console.error('[lancer-cover]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
