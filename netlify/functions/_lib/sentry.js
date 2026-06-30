// _lib/sentry.js — Capture d'exceptions Sentry pour les Netlify Functions.
// INERTE si SENTRY_DSN n'est pas posee (aucune dependance chargee, aucun envoi) -> deployable sans risque.
//
// Usage : exports.handler = withSentry(async (event) => { ... });  // toute exception est capturee + relancee.
// Ou, dans un bloc best-effort : try { ... } catch (e) { await capture(e, { contexte }); }
//
// PERF (cold start) : @sentry/node v8 est lourd (~0,5-1 s a charger + init). On le charge PARESSEUSEMENT,
// seulement a la PREMIERE capture d'erreur (rare) -> le chemin normal (sans erreur) ne paie jamais Sentry,
// donc tous les demarrages a froid sont plus rapides. Comportement inchange : les erreurs restent capturees.

const DSN = process.env.SENTRY_DSN || '';
let Sentry = null, initDone = false;

// Charge + initialise Sentry au premier besoin (idempotent). Renvoie le module ou null (inerte).
function ensureSentry() {
  if (initDone) return Sentry;
  initDone = true;
  if (!DSN) return null;
  try {
    Sentry = require('@sentry/node');
    Sentry.init({ dsn: DSN, environment: process.env.CONTEXT || 'production', tracesSampleRate: 0 });
  } catch (_) { Sentry = null; }   // dependance absente ou init ratee -> on reste inerte, jamais bloquant
  return Sentry;
}

// Capture une erreur (best-effort). flush() est ESSENTIEL en serverless : la fonction peut geler avant
// que Sentry ait envoye en arriere-plan.
async function capture(err, extra) {
  const Sentry = ensureSentry();
  if (!Sentry) return;
  try {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), extra ? { extra } : undefined);
    await Sentry.flush(2000);
  } catch (_) {}
}

// Wrappe un handler : journalise toute exception non geree dans Sentry, puis la relance (comportement inchange).
function withSentry(handler) {
  return async (event, context) => {
    try { return await handler(event, context); }
    catch (err) { await capture(err, { path: event && event.path, httpMethod: event && event.httpMethod }); throw err; }
  };
}

module.exports = { capture, withSentry };
