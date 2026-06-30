// netlify/functions/nurture-cron.js
//
// MOTEUR de la séquence marketing « rattrapage » (non-acheteurs). Fonction PLANIFIÉE (cron horaire,
// déclarée dans netlify.toml). À chaque passage :
//   1. INSCRIT les nouveaux leads (Project sans nurture_status, non acheté, créé < 48 h) -> step 0,
//      1er courriel dû à created_date + 1 h. JAMAIS un client désabonné (nurture_optout, #13).
//   2. ENVOIE le courriel dû (nurture_next_at <= maintenant) via Mailgun MARKETING, avance l'étape.
//   3. SORT ceux pour qui la relance n'a plus de sens : achat (-> converted), remboursement (-> done),
//      désabonnement client (-> unsubscribed, #13). Le désabonnement est posé par desabonnement.js.
//
// Sécurité/UX : best-effort, jamais d'exception qui casse le cron. On n'avance l'étape QUE si l'envoi
//   a réussi (si Mailgun marketing pas configuré -> on réessaie au prochain passage). Plafond par run.
//
// Env : MAILGUN_API_KEY (compte, partagé) + MAILGUN_DOMAIN_MARKETING + MAILGUN_FROM_MARKETING
//       + CM_POSTAL_ADDRESS (adresse postale, exigée par la LCAP).

const { ENROLL_DELAY_H, GAP_AFTER_H, TOTAL, build } = require('./_lib/nurture-emails');
const { dejaClientAchete, clientDesabonne } = require('./_lib/nurture-state');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';

const MG_KEY    = process.env.MAILGUN_API_KEY;
const { envoyerCourriel: mgEnvoyer } = require('./_lib/courriel');   // nurture = marketing -> From racine affiché, envoi via sous-domaine info. (Lot 6)
const POSTAL    = process.env.CM_POSTAL_ADDRESS || '';

const MAX_PER_RUN = 40;
// #11 (option stricte) : si activé, un client DÉJÀ acheteur (sur n'importe quel projet) n'est jamais
// (ré)inscrit à la relance non-acheteurs. Défaut OFF = un nouveau projet est relancé selon SON propre
// stade (honore la ré-entrée #13). Le désabonnement client reste bloquant dans les deux cas.
const EXCLURE_CLIENTS = process.env.RATTRAPAGE_EXCLURE_CLIENTS === '1';
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
// Email + désabonnement marketing du client lié (1 GET). Best-effort : valeurs vides si indisponible.
async function clientInfo(projet) {
  try {
    const link = projet.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return { email: '', optout: false };
    const r = await fetch(`${API}/Clients/${recId}`, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    if (!r.ok) return { email: '', optout: false };
    const f = (await r.json()).fields || {};
    return { email: f.email || '', optout: clientDesabonne(f) };
  } catch (_) { return { email: '', optout: false }; }
}

// Envoi Mailgun marketing via le wrapper central (_lib/courriel) : POST + journalisation Courriels
// (type 'nurture') + en-têtes de désabonnement (livrabilité + 1-clic Gmail/Outlook).
async function envoyer(to, subject, html, unsub, projetId) {
  const { ok } = await mgEnvoyer({
    to, subject, html, type: 'nurture', projetId,
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  });
  return ok;
}

exports.handler = async () => {
  try {
    // 1. INSCRIPTION des nouveaux leads (fenêtre 48 h -> n'enrôle jamais l'historique au déploiement).
    const aEnroler = await atList(
      `AND({nurture_status}=BLANK(), {commercial_status}!='purchased', {commercial_status}!='refunded', IS_AFTER({created_date}, DATEADD(NOW(),-48,'hours')))`,
      MAX_PER_RUN
    );
    let enrolled = 0;
    for (const p of aEnroler) {
      // #13 LCAP : un client désabonné n'est JAMAIS (ré)inscrit, même sur un nouveau projet.
      const { optout } = await clientInfo(p);
      if (optout) continue;
      // #11 (option stricte, env) : exclure les clients déjà acheteurs.
      if (EXCLURE_CLIENTS && dejaClientAchete(p.fields)) continue;
      const created = p.fields.created_date ? new Date(p.fields.created_date).getTime() : Date.now();
      const nextAt = new Date(created + ENROLL_DELAY_H * 3600 * 1000).toISOString();
      try { await atPatch(p.id, { nurture_status: 'active', nurture_step: 0, nurture_next_at: nextAt }); enrolled++; } catch (_) {}
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

      const { email: to, optout } = await clientInfo(p);
      // #13 LCAP : désabonnement client -> on sort de la relance (et on n'envoie rien).
      if (optout) { try { await atPatch(p.id, { nurture_status: 'unsubscribed' }); } catch (_) {} continue; }
      if (!to) { try { await atPatch(p.id, { nurture_status: 'done' }); } catch (_) {} continue; }  // pas d'email -> on arrête

      const token = p.fields.token || '';
      const unsub = `${SITE}/api/desabonnement?id=${encodeURIComponent(token)}`;
      // Lien = ÉTAPE COURANTE (formule page_url) : la relance est différée sur plusieurs jours, le client a
      // pu acheter entre-temps -> on l'envoie à sa page (page-chanson/page-memoire), pas le racheter. Repli aperçu.
      const lien  = p.fields.page_url || `${SITE}/apercu?id=${encodeURIComponent(token)}`;
      const { subject, html } = build(n, { prenom: p.fields.deceased_name, lien, unsub, postal: POSTAL });

      const ok = await envoyer(to, subject, html, unsub, p.id);
      if (!ok) continue;   // Mailgun pas prêt -> on n'avance pas, on réessaiera au prochain passage
      sent++;

      const fields = (n >= TOTAL)
        ? { nurture_step: n, nurture_status: 'done' }
        : { nurture_step: n, nurture_next_at: hoursFromNow(GAP_AFTER_H[n] || 48) };
      try { await atPatch(p.id, fields); } catch (_) {}
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, enrolled, converted: aConvertir.length, sent }) };
  } catch (err) {
    console.error('[nurture-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};

// Observabilite : heartbeat Healthchecks (dead man's switch) + capture Sentry. Voir _lib/cron.js.
const { withCron } = require('./_lib/cron');
exports.handler = withCron('nurture-cron', exports.handler);
