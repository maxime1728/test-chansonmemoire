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
const { coverGenEnAttente, prochainNo, trouverGenProposee } = require('./_lib/cover');
const { appliquerLexique, lireDictionnaire } = require('./_lib/lexique');   // dictionnaire phonétique (étape 3)

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
    const voixOverride = (g.adjusted_voice || '').toString().trim();   // override voix du studio A/B (jalon 3b), posé sur la Generation source

    const uploadUrl = fullAudioUrl(g.cloudinary_audio_url || '');
    if (!regenerate && !uploadUrl) return { statusCode: 409, body: JSON.stringify({ error: 'Audio source introuvable' }) };

    // STATE-MOVE Lot 4 (C2, flag-gated) : la proposition vit dans une Gen `proposée` (paroles+style édités),
    // qu'on consomme ici puis qu'on PROMEUT (5b). Flag OFF -> on lit l'ancien slot Projet adjusted_lyrics.
    const genProposee = (!regenerate && process.env.STATE_MOVE_PROPOSEE === '1')
      ? await trouverGenProposee(API, headers, p.project) : null;
    // Plafond v2 : ce cover est-il déclenché par l'équipe (cockpit, marqueur cover_admin) ? -> admin_triggered
    // sur la Gen (ne compte pas). Flag OFF -> faux, comportement inchangé. (régé = géré côté callback-cover.)
    const adminCover = process.env.PLAFOND_V2 === '1' && !!p.cover_admin;
    const propLyrics = genProposee ? ((genProposee.fields || {}).lyrics || '').trim() : '';
    const propStyle  = genProposee ? ((genProposee.fields || {}).gen_style_prompt || '').trim() : '';

    // Paroles CLAIRES (affichées) : Gen proposée (state-move) -> slot Projet adjusted_lyrics -> origine.
    const lyricsClean = propLyrics || (p.adjusted_lyrics && p.adjusted_lyrics.trim()) || g.lyrics || '';
    let prompt;
    if (process.env.LEXIQUE_PHON === '1') {
      // DICTIONNAIRE PHONÉTIQUE (étape 3) : Suno reçoit lyricsClean RÉÉCRIT par le dictionnaire (global langue
      // + override projet) -> corrections appliquées partout, pour toujours. L'affiché reste clair (la Gen
      // stocke adjusted_lyrics, pas ce prompt). Best-effort : le dictionnaire ne bloque jamais l'envoi.
      // BASCULE SÛRE (étape 5) : si le dictionnaire est VIDE (ex. vieux projet pas encore appris), on retombe
      // sur l'ancien lyrics_phonetique par-gen -> activer LEXIQUE_PHON ne peut PAS régresser une prononciation.
      prompt = (g.lyrics_phonetique && g.lyrics_phonetique.trim()) || lyricsClean;
      try {
        const dict = await lireDictionnaire(API, headers, { langue: p.language || 'fr-CA', projetId: projet.id });
        if (dict.size) prompt = appliquerLexique(lyricsClean, dict);
      } catch (_) {}
    } else {
      // Legacy (#270) : SUNO reçoit lyrics_phonetique par-gen en priorité (= nouvelles paroles + mots réécrits),
      // car un cover porte presque toujours un changement de paroles ET parfois une prononciation. Tenu à jour
      // par decortique (vidé si pas de prononciation) -> jamais périmé.
      prompt = propLyrics || (g.lyrics_phonetique && g.lyrics_phonetique.trim()) || (p.adjusted_lyrics && p.adjusted_lyrics.trim()) || g.lyrics || '';
    }
    if (!prompt.trim()) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles introuvables' }) };
    const style = propStyle || (p.adjusted_style_prompt && p.adjusted_style_prompt.trim())
      || await styleFor({ music_style: g.gen_music_style || p.music_style, mood: g.gen_mood || p.mood, cadeau: p.song_type === 'cadeau', language: p.language });
    // Voix : override cockpit A/B (adjusted_voice sur la Gen source, jalon 3b) EN PRIORITÉ, sinon la voix source.
    // Champ optionnel : absent -> '' -> repli inchangé.
    const vocalGender = /Masculin/i.test(voixOverride || g.gen_voice || p.voice || '') ? 'm' : 'f';

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
      body: JSON.stringify({ fields: { cover_task_id: String(taskId), cover_launched_at: new Date().toISOString(), pending_cover_style: style, ...(adminCover && !regenerate ? { cover_admin: false } : {}) } })
    });
    // Override voix consommé UNE FOIS : vidé sur la Generation source (best-effort, jalon 3b).
    if (voixOverride) { try { await fetch(`${API}/Generations/${gen.id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { adjusted_voice: '' } }) }); } catch (_) {} }

    // 5b. MODÈLE GENERATION-LEVEL (cover « mélodie préservée » seulement) : crée la Generation cover en
    //     audio_pending DÈS le lancement, pour qu'elle soit suivie/relancée/alertée comme une chanson
    //     (sentinelle + alerte-cron 10h). Sur un RETRY (sentinelle), on réutilise la même Generation
    //     (nouveau task) au lieu d'en créer une autre. regenerate=true (nouvelle mélodie) reste créé au
    //     succès par callback-cover. Best-effort : le suivi ne bloque pas le lancement.
    if (!regenerate) try {
      const existant = await coverGenEnAttente(API, headers, p.project);
      if (existant) {
        await fetch(`${API}/Generations/${existant.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { suno_task_id: String(taskId), incident_status: 'surveillance', version_status: 'en_production', ...(adminCover ? { admin_triggered: true } : {}) } })
        });
      } else if (genProposee) {
        // STATE-MOVE (C2) : PROMEUT la Gen `proposée` existante -> en_production (audio_pending) au lieu
        // d'en créer une neuve. Conserve ses paroles/style édités + son generation_no. Idempotent.
        await fetch(`${API}/Generations/${genProposee.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { suno_task_id: String(taskId), generation_status: 'audio_pending', version_status: 'en_production', incident_status: 'surveillance', ...(adminCover ? { admin_triggered: true } : {}) } })
        });
      } else {
        const newNo = await prochainNo(API, headers, p.project);
        const fields = {
          project: [projet.id], generation_no: newNo, type: 'cover', generation_status: 'audio_pending',
          version_status: 'en_production',
          // Plafond v2 : post_purchase = vraie phase (un cover d'aperçu compte AVANT achat). Flag OFF -> ancien
          // comportement (true en dur) pour rester byte-identique. Pré-achat (pas d'achat) -> false.
          post_purchase: (process.env.PLAFOND_V2 === '1') ? (p.commercial_status === 'purchased') : true,
          suno_task_id: String(taskId),
          lyrics: ((p.adjusted_lyrics && p.adjusted_lyrics.trim()) || g.lyrics || '').slice(0, 6000),
          song_title: (g.song_title || 'Pour toujours'),
          gen_style_prompt: style
        };
        const ms = g.gen_music_style || p.music_style; if (ms) fields.gen_music_style = ms;
        const md = g.gen_mood        || p.mood;        if (md) fields.gen_mood        = md;
        const vx = voixOverride || g.gen_voice || p.voice; if (vx) fields.gen_voice = vx;
        if (adminCover) fields.admin_triggered = true;
        await fetch(`${API}/Generations`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields })
        });
      }
    } catch (_) { /* le suivi Generation ne bloque jamais le lancement */ }

    return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true }) };
  } catch (err) {
    console.error('[lancer-cover]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
