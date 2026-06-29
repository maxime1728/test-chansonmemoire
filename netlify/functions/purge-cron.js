// netlify/functions/purge-cron.js
//
// Loi 25 — purge quotidienne (voir _lib/purge.js) : supprime les fichiers audio des projets NON
// achetés à 60 j, anonymise leurs PII à 6 mois. Les projets achetés ne sont JAMAIS touchés.
//
// SÉCURITÉ : DRY-RUN par défaut (ne supprime/écrit RIEN, journalise seulement ce qui SERAIT purgé).
// La purge RÉELLE n'a lieu que si la variable d'env PURGE_ACTIF='1'. -> on peut merger + observer
// les comptes en dry-run avant d'activer.

const { purger } = require('./_lib/purge');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;

exports.handler = async () => {
  if (!AT_TOKEN) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_airtable' }) };
  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  const dryRun = process.env.PURGE_ACTIF !== '1';   // réel UNIQUEMENT si PURGE_ACTIF=1
  try {
    const res = await purger(API, headers, dryRun);
    console.log('[purge-cron]', JSON.stringify(res));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...res }) };
  } catch (err) {
    console.error('[purge-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};

// Observabilite : heartbeat Healthchecks (dead man's switch) + capture Sentry. Voir _lib/cron.js.
const { withCron } = require('./_lib/cron');
exports.handler = withCron('purge-cron', exports.handler);
