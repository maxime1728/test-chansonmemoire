// netlify/functions/_lib/nurture-emails.js
//
// Séquence marketing « rattrapage » (5 courriels) pour les non-acheteurs ayant rempli le formulaire.
// Voix de marque (copy v2, validé 2026-06-26) : « émotion & mémoire », on ouvre sur la personne honorée
// et le souvenir, JAMAIS sur la mort ; vouvoiement ; aucun mot promo ; aucune fausse urgence. Conforme LCAP.
// Délivrabilité (viser le Primary de Gmail) : pas de gros bouton, un simple LIEN TEXTE ; signature
// « Nathalie, Chanson Mémoire » ; objets courts. Le prénom de la personne honorée personnalise quand il existe.
//
// Cadence (heures) :
//   - inscription -> +1 h     : courriel 1
//   - après courriel 1 -> +24 h : courriel 2  (J+1)
//   - après courriel 2 -> +48 h : courriel 3  (J+3)
//   - après courriel 3 -> +48 h : courriel 4  (J+5)
//   - après courriel 4 -> +72 h : courriel 5  (J+8)
'use strict';

const ENROLL_DELAY_H = 1;                       // délai avant le 1er courriel
const GAP_AFTER_H = { 1: 24, 2: 48, 3: 48, 4: 72 };   // délai vers le courriel suivant après l'envoi n
const TOTAL = 5;

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// Gabarit allégé (v2) : pas de bouton (signal « Promotions »), un lien texte mauve, signature Nathalie,
// pied LCAP (désabonnement + adresse). Si `cta` est vide, aucun lien n'est affiché (courriel #4 invite à répondre).
function layout({ corps, lien, cta, unsub, postal }) {
  const lienTexte = cta
    ? `<p style="margin:0 0 24px;"><a href="${lien}" style="color:#5C2D4A;text-decoration:underline;font-weight:bold;">👉 ${cta}</a></p>`
    : '';
  return `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;font-size:16px;max-width:560px;margin:auto;">` +
    `<p style="margin:0 0 18px;">${corps}</p>` +
    lienTexte +
    `<p style="margin:0;color:#5C2D4A;">Nathalie, Chanson Mémoire</p>` +
    `<hr style="border:none;border-top:1px solid #E5DAE0;margin:22px 0 12px;">` +
    `<p style="font-size:12px;color:#9A8A96;margin:0;">` +
    `Vous recevez ce message parce que vous avez créé une chanson sur chansonmemoire.ca.<br>` +
    `Chanson Mémoire${postal ? ', ' + esc(postal) : ''}<br>` +
    `<a href="${unsub}" style="color:#9A8A96;">Se désabonner</a></p></div>`;
}

// Retourne { subject, html } du courriel n (1..5). ctx = { prenom, lien, unsub, postal }.
// prenom = prénom de la personne honorée ; peut être vide -> repli neutre (jamais de variable visible).
function build(n, ctx) {
  const prenomRaw = (ctx.prenom || '').trim();   // pour l'objet (texte d'en-tête, pas de HTML)
  const prenom = esc(prenomRaw);                  // pour le corps (HTML échappé)
  const base = { lien: ctx.lien, unsub: ctx.unsub, postal: ctx.postal };

  switch (n) {
    case 1: return {
      subject: prenomRaw ? `La chanson pour ${prenomRaw} est prête` : 'Votre chanson est prête',
      html: layout({ ...base,
        corps: prenomRaw
          ? `La chanson personnalisée pour ${prenom} existe maintenant, façonnée à partir des souvenirs que vous avez partagés. Prenez un moment, au calme, pour l'écouter.`
          : `Votre chanson, façonnée à partir des souvenirs que vous avez partagés, est prête. Prenez un moment, au calme, pour l'écouter.`,
        cta: 'Écouter la chanson' })
    };
    case 2: return {
      subject: 'Vos souvenirs, devenus mélodie',
      html: layout({ ...base,
        corps: `Votre chanson est née des souvenirs que vous avez confiés : une mélodie unique, une voix, en français d'ici. Réécoutez-la quand le moment vous appartient.`,
        cta: 'Réécouter ma chanson' })
    };
    case 3: return {
      subject: 'Un souvenir qui se partage',
      html: layout({ ...base,
        corps: prenomRaw
          ? `Une chanson, ça se garde et ça se partage : un rassemblement, une date qui compte, un moment où vous pensez à ${prenom}. La vôtre est toujours là.`
          : `Une chanson, ça se garde et ça se partage : un rassemblement, une date qui compte. La vôtre est toujours là.`,
        cta: 'Revenir à ma chanson' })
    };
    case 4: return {
      subject: 'Une question ? Répondez-moi',
      html: layout({ ...base,
        corps: `Quelque chose vous retient, ou n'est pas clair ? Répondez simplement à ce message : je vous lis, et je vous accompagne pour aller au bout de votre projet.`,
        cta: '' })   // pas de lien : on invite à répondre (signal humain fort pour le Primary)
    };
    default: return {
      subject: 'Elle vous attend, sans presse',
      html: layout({ ...base,
        corps: `Sans pression : votre chanson reste là, prête le jour où vous le serez. Elle n'aura pas bougé.`,
        cta: 'Écouter ma chanson' })
    };
  }
}

module.exports = { ENROLL_DELAY_H, GAP_AFTER_H, TOTAL, build };
