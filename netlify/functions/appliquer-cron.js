// netlify/functions/appliquer-cron.js
//
// COCKPIT — DECLENCHEUR D'APPLICATION (fonction planifiee). Repere les conversations dont la case `appliquer`
// est cochee et appelle appliquer-modification pour chacune (pousse paroles/style + version source vers le
// Projet, arme la relance Suno via `refaire` ; appliquer-modification decoche `appliquer` ensuite).
//
// Meme logique que envoyer-cron : Airtable n'expose pas d'API d'automatisation, donc on sonde la coche chaque
// minute (rien a activer cote Airtable/Make). Best-effort : jamais d'exception qui casse le cron.
// Env : MAKE_WEBHOOK_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID, SITE_URL.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.MAKE_WEBHOOK_SECRET;
const SITE     = process.env.SITE_URL || 'https://chansonmemoire.ca';
const CONVOS   = 'tbl3KBgXthCPromxF';
const MAX_PER_RUN = 10;

exports.handler = async () => {
  if (!SECRET) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_secret' }) };
  let appliques = 0, echecs = 0;
  try {
    // Conversations a appliquer : le menu `action_modif` porte une valeur d'action (cover ou rege).
    // appliquer-modification execute puis pose « Appliquée ✓ » (idempotence : ne re-declenche pas).
    const formula = encodeURIComponent('OR({action_modif}="Refaire le cover (même mélodie)", {action_modif}="Régénérer (nouvelle mélodie)")');
    const r = await fetch(`${API}/${CONVOS}?filterByFormula=${formula}&maxRecords=${MAX_PER_RUN}`, {
      headers: { Authorization: `Bearer ${AT_TOKEN}` }
    });
    const d = await r.json().catch(() => ({}));
    const recs = (d && d.records) || [];

    for (const rec of recs) {
      try {
        const res = await fetch(`${SITE}/api/appliquer-modification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: rec.id, secret: SECRET })
        });
        if (res.ok) { appliques++; }
        else { echecs++; console.error('[appliquer-cron] appliquer-modification', res.status, await res.text().catch(() => '')); }
      } catch (e) { echecs++; console.error('[appliquer-cron]', e && e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, trouve: recs.length, appliques, echecs }) };
  } catch (err) {
    console.error('[appliquer-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};

// Observabilite : heartbeat Healthchecks (dead man's switch) + capture Sentry. Voir _lib/cron.js.
const { withCron } = require('./_lib/cron');
exports.handler = withCron('appliquer-cron', exports.handler);
