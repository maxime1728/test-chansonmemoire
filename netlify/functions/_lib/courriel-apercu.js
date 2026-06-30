// netlify/functions/_lib/courriel-apercu.js
//
// Courriel TRANSACTIONNEL « votre aperçu est prêt » (chemin heureux). Envoyé par callback-chanson
// à la 1re bascule en preview (pré-achat), pour ne PAS dépendre uniquement de l'onglet d'attente
// resté ouvert (timers JS suspendus en arrière-plan sur mobile -> redirection ratée -> client sans
// nouvelle). Le chemin LENT (popup délai 8 min -> signaler-echec -> recovery-cron) reste séparé :
// l'appelant skippe ce courriel si recovery_pending / recovery_email_sent_at est posé (anti-doublon).
//
// Voix de marque : digne, solution-first, jamais ouvrir sur le deuil. Vouvoiement (convention courriels
// clients). Pas de tiret cadratin. Best-effort : ne lève jamais (try/catch côté appelant aussi).

const { envoyerCourriel: mgEnvoyer } = require('./courriel');

const SITE = 'https://chansonmemoire.ca';

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// Gabarit HTML commun (même style que courriel-achat : papier crème, titre serif mauve, bouton).
function gabarit({ intro, corps, lien, cta }) {
  return `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;margin:auto;">` +
    `<p style="font-size:18px;color:#5C2D4A;margin:0 0 14px;">${intro}</p>` +
    `<p style="margin:0 0 22px;">${corps}</p>` +
    `<p style="margin:0 0 26px;"><a href="${lien}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;">${cta}</a></p>` +
    `<p style="color:#7A6070;margin:0;">Au plaisir, l'équipe Chanson Mémoire</p></div>`;
}

// Courriel du client lié au Projet (jamais exposé au navigateur). Best-effort -> '' si indisponible.
async function emailDuClient(API, headers, projetFields) {
  try {
    const link  = projetFields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/Clients/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

// Envoie le courriel « aperçu prêt ». Le GATING (1re fois, pré-achat, hors récupération, flag) est
// géré par l'appelant (callback-chanson). Renvoie { ok, sent }. Best-effort : ne lève jamais.
async function envoyerApercuPret({ API, headers, projetId, projetFields, songTitle }) {
  try {
    const to = (await emailDuClient(API, headers, projetFields) || '').trim();
    if (!to || !to.includes('@')) return { ok: false, sent: 0 };
    const token = (projetFields.token || '').trim();
    if (!token) return { ok: false, sent: 0 };

    const lien  = `${SITE}/apercu?id=${encodeURIComponent(token)}`;
    const titre = (songTitle || '').trim();
    const subject = titre ? `Votre aperçu est prêt : « ${titre} »` : 'Votre aperçu est prêt';
    const html = gabarit({
      intro: 'Votre aperçu est prêt.',
      corps: `Vous pouvez écouter la chanson dès maintenant${titre ? `, « <strong>${esc(titre)}</strong> »` : ''}. Prenez le temps qu'il vous faut. Si vous souhaitez ajuster un mot ou un détail, dites-le nous, on s'en occupe.`,
      lien,
      cta: 'Écouter l’aperçu'
    });

    const { ok } = await mgEnvoyer({ to, subject, html, type: 'apercu', projetId, token });
    return { ok, sent: ok ? 1 : 0 };
  } catch (_) {
    return { ok: false, sent: 0 };   // le courriel ne doit jamais casser le callback Suno
  }
}

module.exports = { envoyerApercuPret };
