// netlify/functions/courriel-achat.js
//
// Courriels TRANSACTIONNELS de confirmation, via Mailgun (remplace les modules Gmail de MAKE D).
// Appelé par MAKE D en HTTP POST après l'enregistrement :
//   - achat principal : { token, kind:"purchase" }
//   - upsell          : { token, kind:"upsell", upsell_type:"instrumental"|"paroles_vivantes" }
// Destinataire : l'email Stripe passé en `email` (optionnel) sinon le Client lié (Airtable).
//
// Sécurité : POST, UUID v4 strict, gaté `purchased`, secrets en env. Best-effort : ne bloque jamais
//   MAKE D (on répond 200 même si Mailgun n'est pas prêt — le courriel ne doit pas casser l'achat).
// Voix de marque : solution-first, digne, jamais ouvrir sur le deuil.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MG_KEY    = process.env.MAILGUN_API_KEY;       // no-op si absent
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;        // sous-domaine TRANSACTIONNEL
const MG_FROM   = process.env.MAILGUN_FROM_ACHAT || process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';   // post-achat -> sous-domaine achat

const UPSELL_LABEL = { instrumental: 'la version instrumentale', paroles_vivantes: 'les paroles vivantes en vidéo' };

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

async function envoyerCourriel(to, subject, html) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM);
  form.append('to', to);
  form.append('subject', subject);
  form.append('html', html);
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form });
  return r.ok;
}

async function emailClient(projet, headers) {
  try {
    const link  = projet.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/Clients/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

// Gabarit HTML commun (papier crème, titre serif mauve, bouton doré vers la page de livraison).
function gabarit({ intro, corps, lien }) {
  return `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;margin:auto;">` +
    `<p style="font-size:18px;color:#5C2D4A;margin:0 0 14px;">${intro}</p>` +
    `<p style="margin:0 0 22px;">${corps}</p>` +
    `<p style="margin:0 0 26px;"><a href="${lien}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;">Accéder à ma page</a></p>` +
    `<p style="color:#7A6070;margin:0;">— L'équipe Chanson Mémoire</p></div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  const kind = (body.kind === 'upsell') ? 'upsell' : 'purchase';

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // Project par token — doit être acheté.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // Destinataires. ACHAT : on envoie au courriel du FORMULAIRE (Client, principal) ET au courriel
    // Stripe (payeur) s'il diffère — le 1er courriel doit atteindre les deux. UPSELL : un seul.
    const clientEmail = (await emailClient(projet, headers) || '').trim();
    const stripeEmail = (body.email || '').toString().trim();
    const valide = (e) => e && e.includes('@');
    const recipients = (kind === 'upsell')
      ? [valide(stripeEmail) ? stripeEmail : clientEmail].filter(valide)
      : [...new Set([clientEmail, stripeEmail].filter(valide))];   // achat -> les deux, dédupliqués

    const lien = `${SITE}/page-memoire?id=${encodeURIComponent(token)}`;

    let subject, html;
    if (kind === 'upsell') {
      const label = UPSELL_LABEL[body.upsell_type] || 'votre complément';
      subject = 'Votre complément est confirmé';
      html = gabarit({
        intro: 'Merci — c’est confirmé.',
        corps: `Nous préparons ${esc(label)} pour votre chanson. Vous le retrouverez sur votre page dès qu’il est prêt.`,
        lien
      });
    } else {
      // Titre de la version achetée (best-effort) pour personnaliser.
      let titre = '';
      try {
        const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
        const projLit = formulaLiteral(projet.fields.project);
        if (Number.isInteger(purchasedNo) && projLit !== null) {
          const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
          const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
          const dG = await rG.json();
          titre = (dG.records && dG.records[0] && dG.records[0].fields.song_title) || '';
        }
      } catch (_) { /* titre facultatif */ }
      subject = titre ? `Votre chanson « ${titre} » vous attend` : 'Votre chanson vous attend';
      html = gabarit({
        intro: 'Merci, et bienvenue.',
        corps: `Votre chanson${titre ? ` « <strong>${esc(titre)}</strong> »` : ''} est à vous : écoutez-la, téléchargez-la et découvrez vos cadeaux et compléments sur votre page personnelle.`,
        lien
      });
    }

    let sent = 0;
    for (const r of recipients) { if (await envoyerCourriel(r, subject, html)) sent++; }
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent, recipients: recipients.length }) };
  } catch (err) {
    console.error('[courriel-achat]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: false }) };  // ne bloque jamais MAKE D
  }
};
