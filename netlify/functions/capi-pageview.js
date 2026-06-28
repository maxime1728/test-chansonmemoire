// capi-pageview.js — PageView Meta cote SERVEUR (CAPI), des la 1re page vue.
//
// Le pixel navigateur envoie deja PageView ; ce endpoint envoie le MEME PageView cote serveur
// (meilleure qualite de matching : IP/UA/fbc/fbp/fbclid), dedup via le meme event_id genere par le
// navigateur. Appele par cm-pixel.js UNIQUEMENT apres consentement (la capture UTM, elle, est avant
// consentement dans cm-attrib.js ; ici c'est de l'envoi a Meta -> consentement requis).
//
// Pas de token, pas d'email a ce stade (le visiteur vient d'arriver) : matching via fbc/fbp/IP/UA.
// Best-effort, token-safe, no-op si les secrets ne sont pas poses. Ne casse jamais rien (200 toujours).

const crypto       = require('crypto');
const CAPI_TOKEN   = process.env.META_CAPI_TOKEN;     // secret Netlify
const CAPI_DATASET = process.env.META_DATASET_ID;     // ex. 909919758755200

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  if (!CAPI_TOKEN || !CAPI_DATASET) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'capi-off' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 200, body: '{}' }; }

  const eventId = (body.event_id || '').trim();
  if (!eventId) return { statusCode: 200, body: '{}' };   // pas d'event_id -> pas de dedup possible -> on s'abstient

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ua = event.headers['user-agent'] || '';

  const user_data = {};
  // fbc : cookie si fourni, sinon reconstruit depuis fbclid (fb.1.<ts_ms>.<fbclid>) -> attribution clic paye.
  let fbc = (body.fbc || '').trim();
  if (!fbc && body.fbclid) fbc = `fb.1.${Date.now()}.${String(body.fbclid).trim()}`;
  if (fbc)        user_data.fbc = fbc;
  if (body.fbp)   user_data.fbp = String(body.fbp).trim();
  if (ip)         user_data.client_ip_address = ip;
  if (ua)         user_data.client_user_agent = ua;

  const src = typeof body.src === 'string' ? body.src : '/';
  const payload = { data: [{
    event_name:       'PageView',
    event_time:       Math.floor(Date.now() / 1000),
    action_source:    'website',
    event_id:         eventId,                                         // = eventID du pixel navigateur -> dedup
    event_source_url: 'https://chansonmemoire.ca' + (src.startsWith('/') ? src : '/'),
    user_data:        user_data
  }] };

  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${CAPI_DATASET}/events?access_token=${encodeURIComponent(CAPI_TOKEN)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    return { statusCode: 200, body: JSON.stringify({ ok: resp.ok }) };
  } catch (_) {
    return { statusCode: 200, body: '{}' };   // la CAPI ne casse jamais l'UX
  }
};
