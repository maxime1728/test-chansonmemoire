// netlify/functions/repondre-courriel.js
//
// SUPPORT — ENVOI de la réponse depuis Airtable (Phase 2). Déclenché par le BOUTON « Envoyer » de
// l'interface Boîte de support -> Automation Airtable -> POST ici { id, secret }.
//
// Envoie au client le texte de `reponse` (ou, à défaut, le `brouillon_ia`) :
//   - depuis l'adresse de support CM (nathalie@chansonmemoire.ca) ;
//   - enveloppé dans un TEMPLATE de marque (papier, serif mauve) -> courriel propre ;
//   - DANS LE FIL d'origine (In-Reply-To / References = message_id) ;
//   - sujet « Re: … ».
// Puis marque la conversation : statut=repondu, repondu_le=now, reponse=ce qui a été envoyé.
//
// SÉCURITÉ : gate par `secret` == MAKE_WEBHOOK_SECRET. id doit être un recordId valide.
// Env : MAKE_WEBHOOK_SECRET, MAILGUN_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID,
//       MAILGUN_DOMAIN_SUPPORT (défaut chansonmemoire.ca), MAILGUN_FROM_SUPPORT (défaut nathalie@…).
//   NB : pour envoyer DEPUIS nathalie@chansonmemoire.ca, le domaine racine doit être VÉRIFIÉ en envoi
//        (DKIM/SPF) dans Mailgun. Sinon, pointer MAILGUN_DOMAIN_SUPPORT/FROM vers achat.chansonmemoire.ca.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.MAKE_WEBHOOK_SECRET;

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_SUPPORT || 'support.chansonmemoire.ca';  // sous-domaine d'ENVOI (protège la racine)
const MG_FROM   = process.env.MAILGUN_FROM_SUPPORT || 'Chanson Mémoire <nathalie@chansonmemoire.ca>';
const { logCourriel } = require('./_lib/courriel');

const CONVOS = 'tbl3KBgXthCPromxF';
const REC_ID = /^rec[A-Za-z0-9]{14}$/;

const { piedAuto } = require('./_lib/pied-courriel');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Liens markdown [texte](https://url) -> rendus. URLs http(s) uniquement (anti-injection javascript:).
const RE_LIEN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
function liensTexte(s) { return String(s || '').replace(RE_LIEN, '$1 ($2)'); }

// salutationHeure() + piedAuto() : centralises dans _lib/pied-courriel.js (partages avec les brouillons).

// Enveloppe le texte (saisi/édité par l'humain) dans le template de marque, liens markdown rendus cliquables.
// La signature est gérée par piedAuto() au moment de l'envoi (voir handler), pas ici.
function corpsHtml(texte) {
  const t = esc(texte)
    .replace(RE_LIEN, (m, txt, url) => `<a href="${url}" style="color:#7A4F9E;">${txt}</a>`)
    .replace(/\r?\n/g, '<br>');
  return `<div style="font-family:Georgia,'Times New Roman',serif;color:#2E1A28;line-height:1.7;font-size:16px;max-width:560px;">` +
    `<div>${t}</div>` +
    `<hr style="border:none;border-top:1px solid #E5DAE0;margin:24px 0 12px;">` +
    `<div style="color:#9A8A96;font-size:12px;letter-spacing:.3px;">Chanson Mémoire · chansonmemoire.ca</div>` +
    `</div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!SECRET) { console.error('[repondre-courriel] MAKE_WEBHOOK_SECRET manquant'); return { statusCode: 500, body: JSON.stringify({ error: 'Configuration manquante' }) }; }
  if (!MG_KEY)  return { statusCode: 500, body: JSON.stringify({ error: 'Mailgun non configuré' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }
  if ((body.secret || '') !== SECRET) return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };

  const id = (body.id || '').toString().trim();
  if (!REC_ID.test(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // 1. Lire la conversation.
    const rC = await fetch(`${API}/${CONVOS}/${id}`, { headers });
    if (!rC.ok) return { statusCode: 404, body: JSON.stringify({ error: 'Conversation introuvable' }) };
    const f = (await rC.json()).fields || {};

    const to = (f.expediteur || '').toString().trim();
    if (!to.includes('@')) return { statusCode: 409, body: JSON.stringify({ error: 'Destinataire invalide' }) };

    // 2. Le texte à envoyer : la réponse finale, sinon le brouillon IA.
    let corps = ((f.reponse && f.reponse.trim()) ? f.reponse : (f.brouillon_ia || '')).trim();
    if (!corps) return { statusCode: 409, body: JSON.stringify({ error: 'Aucun texte à envoyer (réponse et brouillon vides)' }) };

    // 2b. Pied automatique : salutation selon l'heure + signature Nathalie / L'équipe Chanson Mémoire.
    //     Sauté si le texte est déjà signé ainsi (évite le double-pied sur un texte rédigé à la main).
    if (!/l['']équipe chanson mémoire/i.test(corps)) corps = `${corps}\n\n${piedAuto()}`;

    // 3. Sujet « Re: … » (dédupliqué).
    let subject = (f.sujet || '').toString().trim() || 'votre message';
    if (!/^\s*re\s*:/i.test(subject)) subject = 'Re: ' + subject;

    // 4. « De » : l'adresse de repondre_de (pré-remplie = adresse d'arrivée, modifiable), sinon défaut.
    //    L'ENVOI réel passe toujours par MG_DOMAIN (sous-domaine support) -> la racine n'est pas « brûlée » ;
    //    le « De » peut afficher la racine (nathalie@chansonmemoire.ca) car l'alignement DMARC est relâché
    //    (sous-domaine et racine = même domaine d'organisation -> DKIM/SPF s'alignent).
    const deRaw = (f.repondre_de || '').toString().trim();
    const from  = deRaw ? (deRaw.includes('<') ? deRaw : `Chanson Mémoire <${deRaw}>`) : MG_FROM;

    // Envoi Mailgun, DANS LE FIL (In-Reply-To/References = message_id d'origine).
    const form = new FormData();
    form.append('from', from);
    form.append('to', to);
    form.append('subject', subject);
    form.append('text', liensTexte(corps));
    form.append('html', corpsHtml(corps));
    const msgId = (f.message_id || '').toString().trim();
    if (msgId) {
      const mid = msgId.startsWith('<') ? msgId : `<${msgId}>`;
      form.append('h:In-Reply-To', mid);
      form.append('h:References', mid);
    }
    const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
    const rM = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form });
    if (!rM.ok) {
      const detail = await rM.text().catch(() => '');
      console.error('[repondre-courriel] Mailgun', rM.status, detail);
      return { statusCode: 502, body: JSON.stringify({ error: 'Envoi échoué', mailgun_status: rM.status, detail }) };
    }

    // 4. Journalisation Courriels (type 'support') — best-effort, sur le Message-Id renvoyé par Mailgun.
    //    On récupère l'id de la ligne Courriels pour la rattacher au fil (champ Courriels de la Conversation).
    let courrielId = '';
    try {
      let mid = '';
      try { mid = ((await rM.json()).id || '').replace(/^<|>$/g, ''); } catch (_) {}
      const pid = (Array.isArray(f.projet_a_travailler) && f.projet_a_travailler[0])
               || (Array.isArray(f.Projet) && f.Projet[0]) || '';
      courrielId = await logCourriel({ type: 'support', to, subject, projetId: pid, messageId: mid });
    } catch (_) {}

    // 5. Marque la conversation répondue + ajoute le sortant au fil (historique ↑) + statut du dernier envoi
    //    + rattache la ligne Courriels (pour voir livré/ouvert depuis le fil).
    const horodatage = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const histoEntry = `↑ ${horodatage} — envoyé à ${to}\n${corps}`;
    const historique = ((f.historique || '') + '\n\n' + histoEntry).slice(-90000);
    const champs = {
      statut: 'repondu', repondu_le: new Date().toISOString(), reponse: corps, envoi_reponse: 'Envoyé ✓',
      historique, dernier_envoi_statut: 'envoyé'
    };
    if (courrielId) champs.Courriels = [...(Array.isArray(f.Courriels) ? f.Courriels : []), courrielId];
    await fetch(`${API}/${CONVOS}/${id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typecast: true, fields: champs })
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, to }) };
  } catch (err) {
    console.error('[repondre-courriel]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
