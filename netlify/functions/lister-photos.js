// netlify/functions/lister-photos.js
//
// DEBUG TEMPORAIRE : liste les images d'un dossier Cloudinary (Admin API) pour fabriquer des exemples.
// À retirer après. Usage : /api/lister-photos?prefix=cm_purchased

const CLD_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLD_KEY    = process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET;

exports.handler = async (event) => {
  const prefix = (event.queryStringParameters && event.queryStringParameters.prefix) || 'cm_purchased';
  if (!CLD_CLOUD || !CLD_KEY || !CLD_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Config Cloudinary manquante' }) };
  try {
    const auth = Buffer.from(`${CLD_KEY}:${CLD_SECRET}`).toString('base64');
    const url = `https://api.cloudinary.com/v1_1/${CLD_CLOUD}/resources/image?type=upload&prefix=${encodeURIComponent(prefix)}&max_results=100`;
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    const d = await r.json();
    const urls = (d.resources || []).map(x => x.secure_url);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ http: r.status, count: urls.length, urls }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e && e.message }) };
  }
};
