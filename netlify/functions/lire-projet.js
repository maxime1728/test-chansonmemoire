// netlify/functions/lire-projet.js
// LECTURE seule. Trouve le Project par token, puis sa Generation la plus récente.
// Ne renvoie au navigateur QUE ce que la page affiche — jamais email, Stripe, attribution.

const BASE_ID = process.env.AIRTABLE_BASE_ID;   // variable d'environnement Netlify
const TOKEN   = process.env.AIRTABLE_TOKEN;     // variable d'environnement Netlify
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

// Format d'un token légitime : UUID v4 généré par crypto.randomUUID() côté page.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Échappe une valeur pour un littéral filterByFormula Airtable.
// Airtable n'offre PAS d'échappement type \" : on encadre avec le guillemet
// absent de la valeur. Si la valeur contient les deux types, on retourne null
// plutôt que de produire une formule ambiguë (défense en profondeur).
function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Force le https sur l'URL audio servie au navigateur. Filet défensif : certaines
// Generations existantes ont pu stocker une URL Cloudinary en http (avant le fix
// `secure_url` côté Make C-cb) -> cadenas barré « contenu non sécurisé ». Cloudinary
// sert le même chemin en https, donc la réécriture est sûre. No-op si déjà https/vide.
function toHttps(u) {
  return (typeof u === 'string') ? u.replace(/^http:\/\//i, 'https://') : u;
}

const crypto = require('crypto');

// Extrait {cloud, type, publicId, ext} d'une URL Cloudinary. Gère /upload/ (public, anciens assets)
// ET /authenticated/ déjà signée (s--sig--/ + version éventuelle à ignorer).
function parseCloudinary(url) {
  const m = /res\.cloudinary\.com\/([^/]+)\/video\/(upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(\.\w+)?$/.exec(url || '');
  return m ? { cloud: m[1], type: m[2], publicId: m[3], ext: m[4] || '' } : null;
}

// Construit l'URL audio servie, selon le TYPE de l'asset stocké :
//  - 'authenticated' (nouveaux assets, Phase 5) -> URL SIGNÉE côté serveur. La transformation
//    (du_60 = preview 60s) est INCLUSE dans la signature -> impossible de la retirer (401).
//  - 'upload' (anciens assets publics, transition) -> URL publique avec la transformation (joue ;
//    contournable, mais ce sont des données de test pré-Phase-5).
// transformation = 'du_60' (preview) ou '' (chanson complète). Signature sha1 déterministe, sans expiration.
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
  // On accepte seulement le POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }

  // Lire le token envoyé par la page
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
  }

  // Valide le format AVANT tout appel Airtable. Ferme l'injection de formule
  // filterByFormula (un token légitime ne contient ni guillemet ni opérateur)
  // et garantit l'inguessabilité (UUID v4 = 122 bits). Un token malformé ne
  // peut être qu'invalide ou malveillant -> 400 nu, sans révéler pourquoi.
  if (!UUID_V4.test(token)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  }

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Trouver le Project par token (token déjà validé UUID -> littéral sûr)
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();

    if (!dP.records || dP.records.length === 0) {
      // 404 nu : on ne révèle jamais pourquoi (sécurité)
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }

    const projet  = dP.records[0];
    const projetId = projet.id;

    // 2. Choisir la bonne Generation : après achat -> la version ACHETÉE (purchased_generation_no) ;
    //    sinon -> la plus récente. {project} vient d'Airtable mais on l'échappe (défense en profondeur).
    const isPaid   = (projet.fields.commercial_status || 'preview_only') === 'purchased';
    const boughtNo = isPaid ? parseInt(projet.fields.purchased_generation_no, 10) : NaN;

    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    }
    const formuleG = Number.isInteger(boughtNo)
      ? encodeURIComponent(`AND({project}=${projLit}, {generation_no}=${boughtNo})`)   // version achetée
      : encodeURIComponent(`{project}=${projLit}`);                                     // sinon la plus récente
    const triG = Number.isInteger(boughtNo)
      ? ''
      : '&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc';
    const rG = await fetch(`${API}/Generations?filterByFormula=${formuleG}${triG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = (dG.records && dG.records[0]) ? dG.records[0].fields : {};

    // Audio = URL Cloudinary SIGNÉE générée côté serveur. Si payé -> complète ; sinon -> preview 60s
    // (du_60 inclus DANS la signature -> non contournable). L'URL complète n'est jamais exposée avant achat.
    const audioUrl = buildAudioUrl(gen.cloudinary_audio_url || '', isPaid ? '' : 'du_60');

    // 3. Réponse FILTRÉE — uniquement l'utile pour l'affichage
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titre:             gen.song_title || '',
        paroles:           gen.lyrics || '',
        statut:            gen.generation_status || '',     // lyrics_generated / audio_generated / validated
        audio_url:         audioUrl,
        suggestions:       gen.suggestions || '[]',         // bulles dynamiques — exposition INTENTIONNELLE (au-delà des 5 champs §6 ; à refléter dans CLAUDE.md §6)
        commercial_status: projet.fields.commercial_status || 'preview_only',
        style:             gen.gen_music_style || projet.fields.music_style || '',   // affichage acceptation (titre + style + ambiance)
        ambiance:          gen.gen_mood        || projet.fields.mood        || '',
        cadeaux_requested: !!projet.fields.pdf_template,            // a déjà choisi ses modèles -> état 'en préparation' tant que les URLs sont absentes
        pdf_url:           toHttps(projet.fields.pdf_url || ''),    // PDF paroles (Canva) — propriété du client, token-gaté ; posé par Make au fulfillment
        signet_url:        toHttps(projet.fields.signet_url || ''), // signet commémoration (Canva)
        instrumental_url:  toHttps(projet.fields.instrumental_url || '')  // add-on instrumentale livrée (Suno vocal-removal) — propriété du client, token-gaté
        // PAS d'email, PAS de stripe_*, PAS d'attribution. Volontaire.
      })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
