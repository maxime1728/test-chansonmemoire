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

async function rehost(remoteUrl, { folder, publicId, resourceType = 'video' }) {
  if (!CLOUD || !KEY || !SECRET || !remoteUrl || !folder || !publicId) return null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    // Signature = sha1 des params signés (ordre alphabétique : folder, public_id, timestamp) + secret.
    // `file`, `api_key`, `signature`, `resource_type` ne sont JAMAIS signés.
    const toSign = `folder=${folder}&public_id=${publicId}&timestamp=${ts}`;
    const signature = crypto.createHash('sha1').update(toSign + SECRET).digest('hex');

    const form = new URLSearchParams();
    form.append('file', remoteUrl);          // Cloudinary télécharge la source lui-même
    form.append('api_key', KEY);
    form.append('timestamp', String(ts));
    form.append('public_id', publicId);
    form.append('folder', folder);
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

module.exports = { rehost, rename, parseCloudinaryUrl };
