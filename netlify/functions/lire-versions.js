// netlify/functions/lire-versions.js
// LECTURE seule. Renvoie TOUTES les versions jouables (= Generations ayant un audio) d'un
// projet, par token, pour le sélecteur de versions de l'aperçu. URLs preview SIGNÉES côté
// serveur (du_60). Sécurité identique à lire-projet.js : POST, UUID v4 strict, 404 nu,
// formule échappée, secrets en env. N'expose QUE ce que le menu déroulant affiche.
// JAMAIS email / Stripe / attribution / consentement.

const BASE_ID = process.env.AIRTABLE_BASE_ID;   // variable d'environnement Netlify
const TOKEN   = process.env.AIRTABLE_TOKEN;     // variable d'environnement Netlify
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Échappe une valeur pour un littéral filterByFormula Airtable (pas d'échappement \" natif).
function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

const crypto = require('crypto');

// Identique à lire-projet.js : extrait {cloud,type,publicId,ext} (gère /upload/ public ET /authenticated/ signée).
function parseCloudinary(url) {
  const m = /res\.cloudinary\.com\/([^/]+)\/video\/(upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(\.\w+)?$/.exec(url || '');
  return m ? { cloud: m[1], type: m[2], publicId: m[3], ext: m[4] || '' } : null;
}

// Identique à lire-projet.js : URL signée côté serveur. La transformation (du_60 = preview 60s)
// est INCLUSE dans la signature SHA-1 -> impossible de la retirer (401). 'upload' (ancien public) -> URL publique.
function buildAudioUrl(stored, transformation) {
  const p = parseCloudinary(stored);
  if (!p) return '';
  const tf = transformation ? transformation + '/' : '';
  if (p.type === 'authenticated' && process.env.CLOUDINARY_API_SECRET) {
    const toSign = tf + p.publicId + p.ext;
    const sig = crypto.createHash('sha1').update(toSign + process.env.CLOUDINARY_API_SECRET).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 8);
    return `https://res.cloudinary.com/${p.cloud}/video/authenticated/s--${sig}--/${tf}${p.publicId}${p.ext}`;
  }
  return `https://res.cloudinary.com/${p.cloud}/video/upload/${tf}${p.publicId}${p.ext}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
  }
  // Valide le format AVANT tout appel Airtable (anti-injection filterByFormula + inguessabilité).
  if (!UUID_V4.test(token)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  }

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token.
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };   // 404 nu (sécurité)
    }
    const projet = dP.records[0];
    const isPaid = (projet.fields.commercial_status || 'preview_only') === 'purchased';

    // Repli style/ambiance/voix au niveau Project tant que non stockés PAR version (Phase 2).
    const styleP    = projet.fields.music_style || '';
    const ambianceP = projet.fields.mood        || '';
    const voixP     = projet.fields.voice       || '';

    // 2. TOUTES les Generations du projet (tri generation_no asc).
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    }
    const formuleG = encodeURIComponent(`{project}=${projLit}`);
    const rG = await fetch(
      `${API}/Generations?filterByFormula=${formuleG}` +
      `&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=asc`,
      { headers }
    );
    const dG = await rG.json();
    const gens = dG.records || [];

    // 3. Ne garder QUE les versions avec un audio (preview jouable). Numérotation V1, V2…
    const versions = [];
    let v = 0;
    for (const rec of gens) {
      const g = rec.fields;
      if (!g.cloudinary_audio_url) continue;        // pas d'audio => pas une version jouable (ex. génération paroles)
      v += 1;
      versions.push({
        v: v,
        generation_no: g.generation_no || v,
        titre:    g.song_title || '',
        // gen_* = champs PAR version (Phase 2) ; repli sur le Project pour l'instant.
        style:    g.gen_music_style || styleP,
        ambiance: g.gen_mood        || ambianceP,
        voix:     g.gen_voice       || voixP,
        // Preview signé (du_60) tant que non payé ; complet si payé. Jamais l'URL brute avant achat.
        audio_url: buildAudioUrl(g.cloudinary_audio_url, isPaid ? '' : 'du_60')
      });
    }

    // 4. Réponse MINIMISÉE — uniquement ce que le menu déroulant affiche.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        versions:          versions,
        commercial_status: projet.fields.commercial_status || 'preview_only',
        accepted:          projet.fields.funnel_step === 'delivery_accepted',   // étape courante : apercu redirige un acheteur vers page-chanson/page-memoire (anti-rachat)
        song_type:         projet.fields.song_type || 'hommage'   // hommage|cadeau -> adapte le copy de l'aperçu (non-PII)
        // PAS d'email, PAS de stripe_*, PAS d'attribution. Volontaire (§6).
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
