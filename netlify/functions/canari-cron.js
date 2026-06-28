// canari-cron.js — Test CANARI (synthetic monitoring). Rejoue periodiquement les points critiques
// du parcours et ALERTE (courriel + Sentry) au moindre echec, AVANT que des vrais clients tombent dessus.
// Heartbeat Healthchecks a la fin -> on detecte aussi si le canari lui-meme s'arrete.
//
// Checks (lecture seule, ne cree aucune donnee) :
//   1. capi-pageview repond ok:true   -> la CAPI Meta (token/dataset) est vivante.
//   2. Airtable joignable             -> la base repond.
//   3. insights-cron ne renvoie pas d'erreur Meta -> le pull de depense pub fonctionne.

const { alerte } = require('./_lib/alerte');
const { beat } = require('./_lib/heartbeat');

const SITE = 'https://chansonmemoire.ca';

exports.handler = async () => {
  const echecs = [];

  // 1. CAPI vivante.
  try {
    const r = await fetch(`${SITE}/api/capi-pageview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: 'canari-' + Date.now(), src: '/canari' })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) echecs.push('capi-pageview KO: ' + JSON.stringify(d).slice(0, 200));
  } catch (e) { echecs.push('capi-pageview exception: ' + (e && e.message)); }

  // 2. Airtable joignable.
  try {
    const r = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Projects?maxRecords=1`,
      { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
    if (!r.ok) echecs.push('Airtable KO: HTTP ' + r.status);
  } catch (e) { echecs.push('Airtable exception: ' + (e && e.message)); }

  // 3. Insights : on n'alerte que sur une vraie ERREUR Meta (pas sur rows:0 = pubs en pause = normal).
  try {
    const r = await fetch(`${SITE}/.netlify/functions/insights-cron`);
    const d = await r.json().catch(() => ({}));
    if (d && d.metaError) echecs.push('insights-cron erreur Meta: ' + String(d.metaError).slice(0, 200));
  } catch (_) { /* invocation directe peut etre bloquee selon la config : non bloquant pour le canari */ }

  if (echecs.length) {
    await alerte('canari-cron', `${echecs.length} verification(s) critique(s) en echec`, { echecs });
    await beat('canari-cron', true);
    return { statusCode: 200, body: JSON.stringify({ ok: false, echecs }) };
  }
  await beat('canari-cron');
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
