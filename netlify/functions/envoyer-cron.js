// netlify/functions/envoyer-cron.js
//
// SUPPORT — DÉCLENCHEUR D'ENVOI (fonction planifiée). Repère les conversations dont la case `envoyer`
// est cochée dans la Boîte de support et appelle repondre-courriel pour chacune (envoi de marque, dans
// le fil, puis statut=repondu + décoche `envoyer`).
//
// POURQUOI un cron : Airtable n'expose AUCUNE API pour créer des automatisations / boutons d'interface.
// Plutôt que d'exiger une config manuelle, on laisse Maxime simplement COCHER `envoyer` dans l'interface
// -> la réponse part au prochain passage (≈ 1 min). Rien à activer côté Airtable/Make.
//
// Best-effort : jamais d'exception qui casse le cron. Env : MAKE_WEBHOOK_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.MAKE_WEBHOOK_SECRET;
const SITE     = process.env.SITE_URL || 'https://chansonmemoire.ca';
const CONVOS   = 'tbl3KBgXthCPromxF';
const MAX_PER_RUN = 10;

exports.handler = async () => {
  if (!SECRET) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_secret' }) };
  let envoyes = 0, echecs = 0;
  try {
    // Conversations à envoyer : le menu `envoi_reponse` = « Envoyer la réponse ». repondre-courriel
    // pose « Envoyé ✓ » après un envoi réussi (idempotence : ne re-déclenche pas).
    const formula = encodeURIComponent('{envoi_reponse}="Envoyer la réponse"');
    const r = await fetch(`${API}/${CONVOS}?filterByFormula=${formula}&maxRecords=${MAX_PER_RUN}`, {
      headers: { Authorization: `Bearer ${AT_TOKEN}` }
    });
    const d = await r.json().catch(() => ({}));
    const recs = (d && d.records) || [];

    for (const rec of recs) {
      try {
        const res = await fetch(`${SITE}/api/repondre-courriel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: rec.id, secret: SECRET })
        });
        if (res.ok) { envoyes++; }
        else { echecs++; console.error('[envoyer-cron] repondre-courriel', res.status, await res.text().catch(() => '')); }
      } catch (e) { echecs++; console.error('[envoyer-cron]', e && e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, trouve: recs.length, envoyes, echecs }) };
  } catch (err) {
    console.error('[envoyer-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};

// Observabilite : heartbeat Healthchecks (dead man's switch) + capture Sentry. Voir _lib/cron.js.
const { withCron } = require('./_lib/cron');
exports.handler = withCron('envoyer-cron', exports.handler);
