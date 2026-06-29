// netlify/functions/statut-render.js
//
// DEBUG TEMPORAIRE : interroge Creatomate pour connaître le statut/erreur d'un rendu.
// À retirer une fois la vidéo mémoire stabilisée. Usage : /api/statut-render?id=<renderId>

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;

exports.handler = async (event) => {
  const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id manquant' }) };
  try {
    const r = await fetch(`https://api.creatomate.com/v1/renders/${id}`, {
      headers: { Authorization: `Bearer ${CREATOMATE_API_KEY}` }
    });
    const d = await r.json();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      http: r.status, status: d.status || null,
      error_message: d.error_message || d.error || null,
      url: d.url || null
    }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e && e.message }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
