// netlify/functions/nurture-cron.js
//
// MOTEUR de la séquence marketing « rattrapage » (non-acheteurs). Fonction PLANIFIÉE (cron horaire,
// déclarée dans netlify.toml). À chaque passage :
//   1. INSCRIT les nouveaux leads (Project sans nurture_status, non acheté, créé < 48 h) -> step 0,
//      1er courriel dû à created_date + 1 h.
//   2. ENVOIE le courriel dû (nurture_next_at <= maintenant) via Mailgun MARKETING, avance l'étape.
//   3. ARRÊTE ceux qui ont acheté (-> converted) — le désabonnement est géré par desabonnement.js.
//
// Sécurité/UX : best-effort, jamais d'exception qui casse le cron. On n'avance l'étape QUE si l'envoi
//   a réussi (si Mailgun marketing pas configuré -> on réessaie au prochain passage). Plafond par run.
//
// Env : MAILGUN_API_KEY (compte, partagé) + MAILGUN_DOMAIN_MARKETING + MAILGUN_FROM_MARKETING
//       + CM_POSTAL_ADDRESS (adresse postale, exigée par la LCAP).

const { ENROLL_DELAY_H, GAP_AFTER_H, TOTAL, build } = require('./_lib/nurture-emails');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_MARKETING;
const MG_FROM   = process.env.MAILGUN_FROM_MARKETING || 'Chanson Mémoire <info@chansonmemoire.ca>';
const POSTAL    = process.env.CM_POSTAL_ADDRESS || '';

const MAX_PER_RUN = 40;
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

async function atList(formula, max) {
  const r = await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${max}`, {
    headers: { Authorization: `Bearer ${AT_TOKEN}` }
  });
  const d = await r.json();
  return (d && d.records) || [];
}
async function atPatch(id, fields) {
  return fetch(`${API}/Projects/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}
async function emailOf(projet) {
  try {
    const link = projet.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/Clients/${recId}`, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

// Envoi Mailgun marketing + en-têtes de désabonnement (livrabilité + 1-clic Gmail/Outlook).
async function envoyer(to, subject, html, unsub) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM);
  form.append('to', to);
  form.append('subject', subject);
  form.append('html', html);
  form.append('h:List-Unsubscribe', `<${unsub}>`);
  form.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  try {
    const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form });
    if (!r.ok) console.error('[nurture-cron] Mailgun:', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('[nurture-cron] envoi:', e && e.message); return false; }
}

exports.handler = async () => {
  try {
    // 1. INSCRIPTION des nouveaux leads (fenêtre 48 h -> n'enrôle jamais l'historique au déploiement).
    const aEnroler = await atList(
      `AND({nurture_status}=BLANK(), {commercial_status}!='purchased', {commercial_status}!='refunded', IS_AFTER({created_date}, DATEADD(NOW(),-48,'hours')))`,
      MAX_PER_RUN
    );
    for (const p of aEnroler) {
      const created = p.fields.created_date ? new Date(p.fields.created_date).getTime() : Date.now();
      const nextAt = new Date(created + ENROLL_DELAY_H * 3600 * 1000).toISOString();
      try { await atPatch(p.id, { nurture_status: 'active', nurture_step: 0, nurture_next_at: nextAt }); } catch (_) {}
    }

    // 2. ARRÊT de ceux pour qui la relance n'a plus de sens : achat -> converted ; remboursement -> done.
    const aConvertir = await atList(`AND({nurture_status}='active', {commercial_status}='purchased')`, MAX_PER_RUN);
    for (const p of aConvertir) { try { await atPatch(p.id, { nurture_status: 'converted' }); } catch (_) {} }
    const aStopper = await atList(`AND({nurture_status}='active', {commercial_status}='refunded')`, MAX_PER_RUN);
    for (const p of aStopper) { try { await atPatch(p.id, { nurture_status: 'done' }); } catch (_) {} }

    // 3. ENVOI des courriels dus.
    const aEnvoyer = await atList(
      `AND({nurture_status}='active', {commercial_status}!='purchased', {commercial_status}!='refunded', IS_BEFORE({nurture_next_at}, NOW()))`,
      MAX_PER_RUN
    );
    let sent = 0;
    for (const p of aEnvoyer) {
      const step = Number(p.fields.nurture_step) || 0;
      const n = step + 1;
      if (n > TOTAL) { try { await atPatch(p.id, { nurture_status: 'done' }); } catch (_) {} continue; }

      const to = await emailOf(p);
      if (!to) { try { await atPatch(p.id, { nurture_status: 'done' }); } catch (_) {} continue; }  // pas d'email -> on arrête

      const token = p.fields.token || '';
      const unsub = `${SITE}/api/desabonnement?id=${encodeURIComponent(token)}`;
      const lien  = `${SITE}/apercu?id=${encodeURIComponent(token)}`;
      const { subject, html } = build(n, { prenom: p.fields.deceased_name, lien, unsub, postal: POSTAL });

      const ok = await envoyer(to, subject, html, unsub);
      if (!ok) continue;   // Mailgun pas prêt -> on n'avance pas, on réessaiera au prochain passage
      sent++;

      const fields = (n >= TOTAL)
        ? { nurture_step: n, nurture_status: 'done' }
        : { nurture_step: n, nurture_next_at: hoursFromNow(GAP_AFTER_H[n] || 48) };
      try { await atPatch(p.id, fields); } catch (_) {}
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, enrolled: aEnroler.length, converted: aConvertir.length, sent }) };
  } catch (err) {
    console.error('[nurture-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};

// Observabilite : heartbeat Healthchecks (dead man's switch) + capture Sentry. Voir _lib/cron.js.
const { withCron } = require('./_lib/cron');
exports.handler = withCron('nurture-cron', exports.handler);
