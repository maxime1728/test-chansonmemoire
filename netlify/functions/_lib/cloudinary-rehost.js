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

module.exports = { rehost };
