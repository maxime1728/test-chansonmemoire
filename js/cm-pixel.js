/* cm-pixel.js — Pixel Meta + consentement, PARTAGÉ par toutes les pages (#13).
 *
 * - PageView sur CHAQUE page, mais SEULEMENT si le client a consenti (localStorage cm_consent='yes').
 * - Affiche une bannière de consentement si le choix n'a pas encore été fait (et si la page n'a pas
 *   déjà sa propre bannière, ex. index).
 * - Expose window.cmTrack(eventName, evtKey, token, custom) pour les events (Lead, Purchase,
 *   InitiateCheckout, PreviewPlayed…), avec eventID = sha256(token.evtKey) pour la dédup Pixel<->CAPI.
 *
 * Idempotent : garde window._px (partagée avec le code inline des pages déjà équipées) -> jamais de
 * double chargement ni double PageView. Clé cm_consent commune à tout le site.
 */
(function () {
  if (window._cmPixelShared) return;
  window._cmPixelShared = true;
  var PIXEL_ID = '909919758755200';

  // Courriels équipe / tests : on ne les envoie JAMAIS à Meta (pixel + CAPI). Doit rester synchronisé
  // avec netlify/functions/_lib/courriels-internes.js (côté serveur).
  var COURRIELS_INTERNES = window.CM_COURRIELS_INTERNES = [
    'maximeblanchet.mb@gmail.com',
    'maxime@labmarketing.ca',
    'roxannetrudel.rt@gmail.com'
  ];
  function estCourrielInterne(email) {
    return !!email && typeof email === 'string' && COURRIELS_INTERNES.indexOf(email.trim().toLowerCase()) !== -1;
  }

  // Flag « ne rien tracker » (appareil/navigateur), persistant. Posé automatiquement quand un courriel
  // interne est saisi (voir window.cmSetNoTrack), ou manuellement via ?cm_no_track=1 (0 pour réactiver).
  function noTrack() { try { return localStorage.getItem('cm_no_track') === '1'; } catch (e) { return false; } }
  function setNoTrack(on) { try { on ? localStorage.setItem('cm_no_track', '1') : localStorage.removeItem('cm_no_track'); } catch (e) {} }

  // Toggle par URL : ?cm_no_track=1 (silence total sur cet appareil) / ?cm_no_track=0 (réactive).
  try {
    var qp = new URLSearchParams(location.search);
    if (qp.has('cm_no_track')) setNoTrack(qp.get('cm_no_track') !== '0');
  } catch (e) {}

  // Appelé par le funnel (ex. survey) avec le courriel saisi : si interne -> pose le flag no-track.
  window.cmSetNoTrack = function (email) { if (estCourrielInterne(email)) setNoTrack(true); return noTrack(); };

  function consent() { try { return localStorage.getItem('cm_consent'); } catch (e) { return null; } }

  function getCookie(n) { var m = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)'); return m ? m.pop() : ''; }
  function loadPixel() {
    if (noTrack()) return;   // équipe/tests -> aucun pixel, aucun PageView, aucun appel CAPI
    if (window._px) return; window._px = true;
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', PIXEL_ID);
    // PageView avec eventID partagé -> dédup avec le PageView CAPI serveur (capi-pageview).
    var evid; try { evid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2)); } catch (e) { evid = String(Date.now()); }
    fbq('track', 'PageView', {}, { eventID: evid });
    try {
      var p = new URLSearchParams(location.search);
      fetch('/api/capi-pageview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ event_id: evid, fbclid: p.get('fbclid') || '', fbp: getCookie('_fbp'), fbc: getCookie('_fbc'), src: location.pathname })
      }).catch(function () {});
    } catch (e) {}
  }

  async function eid(s) {
    try {
      var bb = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s).trim().toLowerCase()));
      return Array.prototype.map.call(new Uint8Array(bb), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    } catch (e) { return ''; }
  }

  // API events (consentement requis). PreviewPlayed = event personnalisé.
  window.cmTrack = async function (eventName, evtKey, tok, custom) {
    if (noTrack() || consent() !== 'yes' || !tok) return;
    loadPixel();
    var o = {}; if (evtKey) { var id = await eid(tok + '.' + evtKey); if (id) o.eventID = id; }
    try { if (eventName === 'PreviewPlayed') fbq('trackCustom', eventName, custom || {}, o); else fbq('track', eventName, custom || {}, o); } catch (e) {}
  };

  window.cmReopenConsent = function () { var b = document.getElementById('cm-consent-banner'); if (b) b.style.display = 'block'; };

  // Permet aux pages avec leur PROPRE bannière (ex. index #consent) de fixer le consentement
  // et de déclencher le pixel via ce module partagé (au lieu d'un loader inline dupliqué).
  window.cmConsentSet = function (ok) {
    try { localStorage.setItem('cm_consent', ok ? 'yes' : 'no'); } catch (e) {}
    var injected = document.getElementById('cm-consent-banner'); if (injected) injected.remove();
    if (ok) loadPixel();
  };

  function injectBanner() {
    // Ne pas injecter si une bannière existe déjà (index a #consent / .consent) ou si déjà injectée.
    if (document.querySelector('#consent, .consent, #cm-consent-banner')) return;
    var css = '#cm-consent-banner{position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;background:#2E1A28;color:#F5F0EA;border-radius:12px;padding:16px 18px;box-shadow:0 8px 30px rgba(0,0,0,.25);font-family:Georgia,serif;font-size:14px;line-height:1.55;max-width:680px;margin:0 auto;}#cm-consent-banner a{color:#E8C9DC;}#cm-consent-banner .cm-c-row{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;}#cm-consent-banner button{border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer;}#cm-consent-banner .cm-c-yes{background:#5C2D4A;color:#F5F0EA;}#cm-consent-banner .cm-c-no{background:transparent;color:#F5F0EA;border:1px solid rgba(245,240,234,.4);}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var d = document.createElement('div');
    d.id = 'cm-consent-banner'; d.setAttribute('role', 'region'); d.setAttribute('aria-label', 'Consentement aux témoins');
    d.innerHTML = '<p style="margin:0;">Nous utilisons des témoins (cookies) et des outils de mesure pour améliorer le site et nos publicités. Tu peux accepter ou refuser. Détails dans notre <a href="https://chansonmemoire.ca/politique-de-confidentialite">politique de confidentialité</a>.</p><div class="cm-c-row"><button type="button" class="cm-c-yes">Accepter</button><button type="button" class="cm-c-no">Refuser</button></div>';
    document.body.appendChild(d);
    d.querySelector('.cm-c-yes').addEventListener('click', function () { try { localStorage.setItem('cm_consent', 'yes'); } catch (e) {} d.remove(); loadPixel(); });
    d.querySelector('.cm-c-no').addEventListener('click', function () { try { localStorage.setItem('cm_consent', 'no'); } catch (e) {} d.remove(); });
  }

  function boot() {
    if (noTrack()) return;          // équipe/tests -> ni pixel ni bannière
    var c = consent();
    if (c === 'yes') loadPixel();   // PageView gated, sur chaque page
    else if (!c) injectBanner();    // pas encore choisi -> bannière (refus = rien)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
