// netlify/functions/_lib/cloudinary-rehost.js
//
// Ré-héberge un fichier DISTANT sur Cloudinary (copie permanente), via un upload signé par URL :
// on passe l'URL distante en `file=` et Cloudinary va chercher le fichier lui-même (pas de stream
// du binaire à travers la Lambda). Sert à rendre PERMANENTES les sorties d'add-ons dont les URLs
// d'origine expirent (instrumentale Suno ~15 j, vidéo Creatomate ~30 j).
//
// Renvoie le secure_url Cloudinary, ou null si non configuré / échec -> l'appelant garde l'URL d'origine
// (on ne casse jamais la livraison).

const crypto = require('crypto');

const CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const KEY    = process.env.CLOUDINARY_API_KEY;
const SECRET = process.env.CLOUDINARY_API_SECRET;

async function rehost(remoteUrl, { folder, publicId, resourceType = 'video', type } = {}) {
  if (!CLOUD || !KEY || !SECRET || !remoteUrl || !publicId) return null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    // `folder` optionnel (racine si absent). `type` optionnel : 'authenticated' pour l'audio protégé
    // (aperçu signé). `file`, `api_key`, `signature`, `resource_type` ne sont JAMAIS signés.
    const signed = { public_id: publicId, timestamp: ts };
    if (folder) signed.folder = folder;
    if (type && type !== 'upload') signed.type = type;
    const signature = signParams(signed);

    const form = new URLSearchParams();
    form.append('file', remoteUrl);          // Cloudinary télécharge la source lui-même
    form.append('api_key', KEY);
    Object.keys(signed).forEach(k => form.append(k, String(signed[k])));
    form.append('signature', signature);

    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/${resourceType}/upload`, {
      method: 'POST', body: form
    });
    const d = await r.json();
    if (!r.ok || !d.secure_url) {
      console.error('[cloudinary-rehost] échec:', (d && d.error && d.error.message) || `HTTP ${r.status}`);
      return null;
    }
    return d.secure_url;
  } catch (err) {
    console.error('[cloudinary-rehost]', err && err.message);
    return null;
  }
}

// Signature Cloudinary générique : tous les params SAUF file/api_key/resource_type/signature,
// triés alphabétiquement, joints en k=v&…, puis sha1(… + secret).
function signParams(params) {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + SECRET).digest('hex');
}

// Déplace/renomme un asset Cloudinary DANS le même compte (pas de re-téléchargement).
// `type` doit matcher la livraison réelle ('authenticated' pour l'audio CM, sinon 'upload').
// Renvoie l'objet réponse Cloudinary (avec secure_url, public_id) ou null.
async function rename(fromPublicId, toPublicId, { resourceType = 'video', type = 'upload' } = {}) {
  if (!CLOUD || !KEY || !SECRET || !fromPublicId || !toPublicId) return null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const signed = { from_public_id: fromPublicId, to_public_id: toPublicId, timestamp: ts, type };
    const signature = signParams(signed);
    const form = new URLSearchParams();
    Object.keys(signed).forEach(k => form.append(k, String(signed[k])));
    form.append('api_key', KEY);
    form.append('signature', signature);
    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/${resourceType}/rename`, { method: 'POST', body: form });
    const d = await r.json();
    if (!r.ok || !d.public_id) { console.error('[cloudinary rename] échec:', (d && d.error && d.error.message) || `HTTP ${r.status}`); return null; }
    return d;
  } catch (err) { console.error('[cloudinary rename]', err && err.message); return null; }
}

// Décompose une URL Cloudinary -> { cloud, resourceType, type, publicId, ext } ou null.
// Tolère le segment de signature (s--…--) et la version (v123…) des URLs livrées.
function parseCloudinaryUrl(url) {
  const m = /res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/(upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(\.\w+)?$/.exec(url || '');
  return m ? { cloud: m[1], resourceType: m[2], type: m[3], publicId: decodeURIComponent(m[4]), ext: m[5] || '' } : null;
}

// Supprime DÉFINITIVEMENT un asset Cloudinary (Loi 25). `type` doit matcher la livraison réelle
// ('authenticated' pour l'audio CM). invalidate=true purge aussi le CDN. Renvoie true si supprimé
// (ou déjà absent), false sinon.
async function destroy(publicId, { resourceType = 'video', type = 'upload', invalidate = true } = {}) {
  if (!CLOUD || !KEY || !SECRET || !publicId) return false;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const signed = { public_id: publicId, timestamp: ts };
    if (type && type !== 'upload') signed.type = type;
    if (invalidate) signed.invalidate = 'true';
    const signature = signParams(signed);
    const form = new URLSearchParams();
    Object.keys(signed).forEach(k => form.append(k, String(signed[k])));
    form.append('api_key', KEY);
    form.append('signature', signature);
    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/${resourceType}/destroy`, { method: 'POST', body: form });
    const d = await r.json();
    return !!(d && (d.result === 'ok' || d.result === 'not found'));
  } catch (err) { console.error('[cloudinary destroy]', err && err.message); return false; }
}

module.exports = { rehost, rename, parseCloudinaryUrl, destroy };
