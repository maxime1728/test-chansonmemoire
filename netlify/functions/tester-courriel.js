// netlify/functions/tester-courriel.js
//
// DIAGNOSTIC Mailgun (health-check). Envoie un courriel de test pour valider la config :
// clé, sous-domaine, FROM, région (US = api.mailgun.net). Renvoie l'erreur EXACTE de Mailgun si échec
// (domaine introuvable, FROM non vérifié, clé invalide…), pour débloquer sans deviner.
//
// Gaté par le SECRET partagé (MAKE_WEBHOOK_SECRET) -> non abusable. À garder comme outil d'ops.
// POST { "secret": "<MAKE_WEBHOOK_SECRET>", "to": "optionnel@exemple.com" }
//   -> envoie à `to`, sinon à TEAM_NOTIFY_EMAIL. Réponse = { ok, status, mailgun, config:{...} }.

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;
const MG_FROM   = process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';
const TEAM      = process.env.TEAM_NOTIFY_EMAIL || '';
const SECRET    = process.env.MAKE_WEBHOOK_SECRET || '';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  // Garde-fou : secret partagé obligatoire (évite tout usage abusif comme relais d'envoi).
  if (!SECRET || body.secret !== SECRET) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };
  }

  // État de la config (booléens seulement — jamais les valeurs des secrets).
  const config = { has_key: !!MG_KEY, domain: MG_DOMAIN || null, from: MG_FROM, team: TEAM || null };
  if (!MG_KEY || !MG_DOMAIN) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'Config Mailgun incomplète', config }) };
  }

  const to = (body.to || TEAM || '').trim();
  if (!to || !to.includes('@')) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'Aucun destinataire (mets TEAM_NOTIFY_EMAIL ou "to")', config }) };
  }

  try {
    const form = new FormData();
    form.append('from', MG_FROM);
    form.append('to', to);
    form.append('subject', 'Test Chanson Mémoire — Mailgun OK');
    form.append('html', '<p style="font-family:Georgia,serif;color:#2E1A28;">Si vous lisez ceci, la configuration Mailgun (transactionnel) fonctionne. ✅</p>');

    const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
    const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form });
    const text = await r.text();   // Mailgun renvoie un message clair en cas d'erreur

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: r.ok, status: r.status, sent_to: to, mailgun: text.slice(0, 400), config })
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'Appel Mailgun échoué', detail: err && err.message, config }) };
  }
};
