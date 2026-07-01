// _lib/courriels-internes.js — Courriels de l'équipe / de tests.
//
// On ne les envoie JAMAIS à Meta (ni pixel navigateur ni CAPI serveur) : ça évite de
// polluer le dataset et les conversions Meta avec nos propres tests du funnel.
//
// Source de vérité côté SERVEUR. Le pendant navigateur (même liste) est dans js/cm-pixel.js
// (window.CM_COURRIELS_INTERNES) : penser à garder les deux synchronisés.

const COURRIELS_INTERNES = [
  'maximeblanchet.mb@gmail.com',
  'maxime@labmarketing.ca',
  'roxannetrudel.rt@gmail.com'
];

// true si le courriel appartient à l'équipe / aux tests (comparaison normalisée : trim + minuscule).
function estCourrielInterne(email) {
  if (!email || typeof email !== 'string') return false;
  return COURRIELS_INTERNES.includes(email.trim().toLowerCase());
}

module.exports = { COURRIELS_INTERNES, estCourrielInterne };
