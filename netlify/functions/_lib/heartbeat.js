// _lib/heartbeat.js — « Dead man's switch » via Healthchecks.io.
// Chaque cron ping son slug a la FIN d'un run reussi. Si un ping manque (cron en panne, non planifie,
// timeout...), Healthchecks ALERTE tout seul. C'est le seul moyen de detecter un cron qui ne tourne PLUS.
//
// INERTE sans HC_PING_KEY. Un seul env var pour tous les crons : la cle de ping projet Healthchecks.
// ?create=1 -> le check se cree automatiquement au 1er ping (pas de config manuelle par cron).

const KEY = process.env.HC_PING_KEY || '';

// beat(slug)         -> signale un succes.
// beat(slug, true)   -> signale un echec (Healthchecks le marque DOWN immediatement).
async function beat(slug, fail) {
  if (!KEY || !slug) return;
  const url = `https://hc-ping.com/${KEY}/${encodeURIComponent(slug)}${fail ? '/fail' : ''}?create=1`;
  try { await fetch(url, { method: 'POST' }); } catch (_) {}
}

module.exports = { beat };
