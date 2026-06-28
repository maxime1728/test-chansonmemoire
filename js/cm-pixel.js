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

  function consent() { try { return localStorage.getItem('cm_consent'); } catch (e) { return null; } }

  function getCookie(n) { var m = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)'); return m ? m.pop() : ''; }
  function loadPixel() {
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
    if (consent() !== 'yes' || !tok) return;
    loadPixel();
    var o = {}; if (evtKey) { var id = await eid(tok + '.' + evtKey); if (id) o.eventID = id; }
    try { if (eventName === 'PreviewPlayed') fbq('trackCustom', eventName, custom || {}, o); else fbq('track', eventName, custom || {}, o); } catch (e) {}
  };

  window.cmReopenConsent = function () { var b = document.getElementById('cm-consent-banner'); if (b) b.style.display = 'block'; };

  function injectBanner() {
    // Ne pas injecter si une bannière existe déjà (index a #consent / .consent) ou si déjà injectée.
    if (document.querySelector('#consent, .consent, #cm-consent-banner')) return;
    var css = '#cm-consent-banner{position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;background:#2E1A28;color:#F5F0EA;border-radius:12px;padding:16px 18px;box-shadow:0 8px 30px rgba(0,0,0,.25);font-family:Georgia,serif;font-size:14px;line-height:1.55;max-width:680px;margin:0 auto;}#cm-consent-banner a{color:#E8C9DC;}#cm-consent-banner .cm-c-row{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;}#cm-consent-banner button{border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer;}#cm-consent-banner .cm-c-yes{background:#5C2D4A;color:#F5F0EA;}#cm-consent-banner .cm-c-no{background:transparent;color:#F5F0EA;border:1px solid rgba(245,240,234,.4);}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var d = document.createElement('div');
    d.id = 'cm-consent-banner'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Consentement aux témoins');
    d.innerHTML = '<p style="margin:0;">Nous utilisons des témoins (cookies) et des outils de mesure pour améliorer le site et nos publicités. Tu peux accepter ou refuser. Détails dans notre <a href="https://chansonmemoire.ca/politique-de-confidentialite">politique de confidentialité</a>.</p><div class="cm-c-row"><button type="button" class="cm-c-yes">Accepter</button><button type="button" class="cm-c-no">Refuser</button></div>';
    document.body.appendChild(d);
    d.querySelector('.cm-c-yes').addEventListener('click', function () { try { localStorage.setItem('cm_consent', 'yes'); } catch (e) {} d.remove(); loadPixel(); });
    d.querySelector('.cm-c-no').addEventListener('click', function () { try { localStorage.setItem('cm_consent', 'no'); } catch (e) {} d.remove(); });
  }

  function boot() {
    var c = consent();
    if (c === 'yes') loadPixel();   // PageView gated, sur chaque page
    else if (!c) injectBanner();    // pas encore choisi -> bannière (refus = rien)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
