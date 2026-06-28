/* cm-attrib.js — Capture d'attribution Meta (first-touch + last-touch).
 *
 * Donnee FIRST-PARTY (les UTM / fbclid que le visiteur apporte dans l'URL). Stockee en localStorage
 * des l'arrivee, AVANT le choix de consentement : la capture d'attribution n'est pas gatee
 * (decision Loi 25 : first-party). L'ENVOI vers Meta CAPI, lui, reste gate par cm-pixel.js.
 *
 * Deux paniers :
 *   - cm_first_touch : ecrit UNE seule fois, le 1er creatif qui a amene le visiteur. JAMAIS ecrase.
 *   - cm_last_touch  : mis a jour a CHAQUE visite portant une attribution (dernier creatif vu).
 *
 * Autonome (aucune dependance), a charger tot (head) sur TOUTES les pages d'entree. Idempotent.
 * Lu par souvenirs (ecrit first/last sur le Projet) et par apercu (rafraichit last-touch a l'achat).
 */
(function () {
  try {
    var q = new URLSearchParams(window.location.search);
    function g(n) { return (q.get(n) || '').trim(); }
    var touch = {
      utm_source:   g('utm_source'),
      utm_medium:   g('utm_medium'),
      utm_campaign: g('utm_campaign'),
      utm_content:  g('utm_content'),
      utm_term:     g('utm_term'),
      fbclid:       g('fbclid'),
      landing_page: window.location.pathname + window.location.search,
      referrer:     document.referrer || '',
      at:           new Date().toISOString()
    };
    // Un contact ATTRIBUABLE = au moins un UTM ou un fbclid. Sans ca (direct / organique / navigation
    // interne), on ne touche a rien : on ne veut pas ecraser le last-touch avec du vide.
    var hasAttr = !!(touch.utm_source || touch.utm_campaign || touch.utm_content || touch.fbclid);
    if (!hasAttr) return;
    if (!localStorage.getItem('cm_first_touch')) {
      localStorage.setItem('cm_first_touch', JSON.stringify(touch));
    }
    localStorage.setItem('cm_last_touch', JSON.stringify(touch));
  } catch (e) { /* localStorage bloque (mode prive) : pas d'attribution persistee, le repli URL gere */ }
})();
