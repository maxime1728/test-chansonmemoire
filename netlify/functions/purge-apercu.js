// netlify/functions/purge-apercu.js
//
// Aperçu DRY-RUN de la purge Loi 25 (voir _lib/purge.js), à la demande : renvoie ce qui SERAIT
// supprimé (audio à 60 j) et anonymisé (PII à 6 mois), SANS rien modifier. Sert à vérifier avant
// d'activer la purge réelle (PURGE_ACTIF=1 sur le cron). Lecture seule -> sûr.
// Secret OPTIONNEL (PURGE_SECRET) inerte tant que non posé.

const { purger } = require('./_lib/purge');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.PURGE_SECRET || '';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }
  if (SECRET && body.secret !== SECRET) return { statusCode: 401, body: JSON.stringify({ error: 'Non autorisé' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const res = await purger(API, headers, true);   // dry-run forcé : ne supprime jamais rien
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res) };
  } catch (err) {
    console.error('[purge-apercu]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
