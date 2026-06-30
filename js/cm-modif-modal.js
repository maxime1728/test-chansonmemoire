/* js/cm-modif-modal.js
   MODALE DE MODIFICATION UNIFIÉE (post-achat) — même composant que l'aperçu, partagé entre
   page-chanson.html et page-memoire.html. Autonome : injecte son CSS scopé + son focus-trap,
   construit la modale une seule fois, et l'ouvre depuis un bouton déclencheur.

   Choix post-achat (locké avec Maxime) : 3 puces SANS « style/voix ». Le client a déjà entendu
   sa chanson complète ; un changement de style se demande en texte libre et part au MÊME endroit
   que tout le reste -> /api/decortique (analyse Claude en arrière-plan + cockpit Modifications).
   Pas de routage self-serve ici (contrairement à l'aperçu) : l'équipe prépare et te revient.

   Usage :
     cmModifModal.init({ token: token, trigger: btnElement });
   Options : endpoint ('/api/decortique'), champ texte ('demande'), titres/messages surchargés. */
(function () {
  if (window.cmModifModal) return;

  var CSS = '\
.cmm-overlay{position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(46,26,40,0.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}\
.cmm-overlay.show{display:flex;}\
.cmm-modal{position:relative;width:100%;max-width:420px;max-height:90vh;overflow-y:auto;background:var(--cm-white,#fff);border-radius:20px;padding:28px 24px;box-shadow:0 12px 48px rgba(46,26,40,0.30);font-family:"Mulish",sans-serif;}\
.cmm-close{position:absolute;top:10px;right:16px;background:none;border:none;font-size:26px;line-height:1;color:var(--cm-text-sub,#7A6070);cursor:pointer;}\
.cmm-title{font-family:"Fraunces","Newsreader",Georgia,serif;font-style:italic;font-size:22px;color:var(--cm-plum-dark,#5C2D4A);margin-bottom:6px;}\
.cmm-sub{font-size:14px;line-height:1.5;color:var(--cm-text-sub,#7A6070);margin-bottom:8px;}\
.cmm-chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px;}\
.cmm-chip{font:600 13px/1 "Mulish",sans-serif;padding:8px 13px;border-radius:999px;border:1.5px solid var(--cm-mauve,#C98BB0);background:var(--cm-white,#fff);color:var(--cm-plum-mid,#8B4A6E);cursor:pointer;}\
.cmm-textarea{width:100%;padding:12px 14px;border-radius:12px;border:1.5px solid var(--cm-mauve,#C98BB0);background:var(--cm-white,#fff);font-family:"Mulish",sans-serif;font-size:14px;color:var(--cm-text,#2E1A28);resize:vertical;margin-top:10px;}\
.cmm-textarea:focus{outline:none;border-color:var(--cm-plum-mid,#8B4A6E);}\
.cmm-hint{font-size:12px;line-height:1.5;color:var(--cm-text-sub,#7A6070);margin:8px 0 0;}\
.cmm-actions{display:flex;gap:12px;margin-top:22px;}\
.cmm-cancel,.cmm-confirm{flex:1;border-radius:999px;padding:13px 18px;font:700 15px/1 "Mulish",sans-serif;cursor:pointer;}\
.cmm-cancel{background:none;border:1.5px solid var(--cm-mauve,#C98BB0);color:var(--cm-plum-dark,#5C2D4A);}\
.cmm-confirm{background:var(--cm-plum-dark,#5C2D4A);border:none;color:#fff;}\
.cmm-confirm:disabled{opacity:.6;cursor:default;}\
.cmm-note{font-size:12px;color:var(--cm-text-sub,#7A6070);margin-top:12px;text-align:center;min-height:1em;}\
.cmm-done{font-size:14px;line-height:1.6;color:var(--cm-text,#2E1A28);}';

  /* Puces : ORIENTENT le placeholder (et le ton du suivi), ne décident pas seules. Pas de « style ». */
  var CHIPS = [
    { k: 'pron',     label: 'Un mot mal prononcé',     ph: 'Quel mot, et comment ça devrait sonner ? Ex. : « Ghislaine » se dit « Jislaine ».', hint: 'On corrige la prononciation et on te revient avec ta version.' },
    { k: 'souvenir', label: 'Ajouter un souvenir',     ph: 'Raconte le souvenir à ajouter. Ex. : ses étés au chalet avec les petits-enfants.',  hint: 'On réécrit les paroles et on te revient avec ta version.' },
    { k: 'paroles',  label: 'Un détail dans les paroles', ph: 'Quel détail corriger ? Ex. : elle est née en 1948, pas 1949.',                    hint: 'On corrige le détail et on te revient avec ta version.' }
  ];

  var DEFAULTS = {
    endpoint: '/api/decortique',
    champ:    'demande',
    title:    'Quelque chose à ajuster ?',
    sub:      "Dis-nous ce que tu veux changer, on s'en occupe.",
    hint:     'Choisis une option ci-dessus, ou écris-nous directement.',
    done:     "Demande reçue ✓ On prépare ta version et on te revient par courriel d'ici <strong>24 à 48 h</strong>.<br><br>Surveille tes courriels indésirables au cas où."
  };

  var built = false, els = null, cfg = null, lastFocus = null, onKey = null;

  function injectCss() {
    if (document.getElementById('cmm-style')) return;
    var s = document.createElement('style');
    s.id = 'cmm-style'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function focusables() {
    return [].filter.call(els.modal.querySelectorAll('button,textarea,a[href],[tabindex]'),
      function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  function build() {
    if (built) return;
    injectCss();

    var ov = document.createElement('div');
    ov.className = 'cmm-overlay'; ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML =
      '<div class="cmm-modal" role="dialog" aria-modal="true" aria-labelledby="cmm-title">' +
        '<button type="button" class="cmm-close" aria-label="Fermer">&times;</button>' +
        '<div class="cmm-title" id="cmm-title"></div>' +
        '<p class="cmm-sub"></p>' +
        '<div class="cmm-chips"></div>' +
        '<div class="cmm-form">' +
          '<textarea class="cmm-textarea" rows="3" placeholder="Décris ce que tu aimerais changer…"></textarea>' +
          '<p class="cmm-hint"></p>' +
          '<div class="cmm-actions">' +
            '<button type="button" class="cmm-cancel">Annuler</button>' +
            '<button type="button" class="cmm-confirm">Envoyer ma demande</button>' +
          '</div>' +
        '</div>' +
        '<div class="cmm-done" style="display:none;"></div>' +
        '<p class="cmm-note" role="status" aria-live="polite"></p>' +
      '</div>';
    document.body.appendChild(ov);

    els = {
      ov: ov,
      modal:  ov.querySelector('.cmm-modal'),
      title:  ov.querySelector('.cmm-title'),
      sub:    ov.querySelector('.cmm-sub'),
      chips:  ov.querySelector('.cmm-chips'),
      form:   ov.querySelector('.cmm-form'),
      ta:     ov.querySelector('.cmm-textarea'),
      hint:   ov.querySelector('.cmm-hint'),
      send:   ov.querySelector('.cmm-confirm'),
      cancel: ov.querySelector('.cmm-cancel'),
      close:  ov.querySelector('.cmm-close'),
      done:   ov.querySelector('.cmm-done'),
      note:   ov.querySelector('.cmm-note')
    };

    CHIPS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'cmm-chip'; b.textContent = c.label; b.dataset.k = c.k;
      b.addEventListener('click', function () { setActive(c.k); els.ta.focus(); });
      els.chips.appendChild(b);
    });

    els.close.addEventListener('click', closeModal);
    els.cancel.addEventListener('click', closeModal);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });
    els.send.addEventListener('click', submit);

    built = true;
  }

  function styleChip(b, on) {
    b.style.background  = on ? 'var(--cm-plum-dark,#5C2D4A)' : 'var(--cm-white,#fff)';
    b.style.color       = on ? '#fff' : 'var(--cm-plum-mid,#8B4A6E)';
    b.style.borderColor = on ? 'var(--cm-plum-dark,#5C2D4A)' : 'var(--cm-mauve,#C98BB0)';
  }

  function setActive(k) {
    [].forEach.call(els.chips.children, function (b) { styleChip(b, b.dataset.k === k); });
    var c = CHIPS.filter(function (x) { return x.k === k; })[0];
    if (c) { els.ta.setAttribute('placeholder', c.ph); els.hint.textContent = c.hint; }
  }

  function openModal() {
    if (!cfg) return;   // jamais ouvert avant init() (pas de token / config)
    if (!built) build();
    els.title.textContent = cfg.title;
    els.sub.textContent = cfg.sub;
    els.hint.textContent = cfg.hint;
    els.ta.value = '';
    els.ta.setAttribute('placeholder', 'Décris ce que tu aimerais changer…');
    [].forEach.call(els.chips.children, function (b) { styleChip(b, false); });
    els.form.style.display = '';
    els.done.style.display = 'none';
    els.note.textContent = '';
    els.send.disabled = false;
    els.ov.classList.add('show');
    els.ov.setAttribute('aria-hidden', 'false');

    lastFocus = document.activeElement;
    var f = focusables(); if (f.length) f[0].focus();
    onKey = function (e) {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key === 'Tab') {
        var ff = focusables(); if (!ff.length) return;
        var first = ff[0], last = ff[ff.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
  }

  function closeModal() {
    if (!built) return;
    els.ov.classList.remove('show');
    els.ov.setAttribute('aria-hidden', 'true');
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  function submit() {
    var texte = (els.ta.value || '').trim();
    if (texte.length < 4) { els.note.textContent = 'Décris en quelques mots ce que tu veux ajuster.'; els.ta.focus(); return; }
    els.send.disabled = true; els.note.textContent = 'Un instant, on enregistre ta demande…';

    var payload = { token: cfg.token };
    payload[cfg.champ] = texte;
    fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('ko');
        els.form.style.display = 'none';
        els.done.innerHTML = cfg.done;
        els.done.style.display = 'block';
        els.note.textContent = '';
      })
      .catch(function () { els.send.disabled = false; els.note.textContent = 'Un souci est survenu. Réessaie dans un instant.'; });
  }

  window.cmModifModal = {
    init: function (options) {
      options = options || {};
      cfg = {
        token:    options.token || '',
        endpoint: options.endpoint || DEFAULTS.endpoint,
        champ:    options.champ || DEFAULTS.champ,
        title:    options.title || DEFAULTS.title,
        sub:      options.sub || DEFAULTS.sub,
        hint:     options.hint || DEFAULTS.hint,
        done:     options.done || DEFAULTS.done
      };
      if (!cfg.token) return;   // pas de token -> rien à modifier
      var trig = options.trigger;
      if (typeof trig === 'string') trig = document.querySelector(trig);
      if (trig) trig.addEventListener('click', openModal);
    },
    open: openModal,
    close: closeModal
  };
})();
