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
.cmm-textarea{width:100%;padding:12px 14px;border-radius:12px;border:1.5px solid var(--cm-mauve,#C98BB0);background:var(--cm-white,#fff);font-family:"Mulish",sans-serif;font-size:16px;color:var(--cm-text,#2E1A28);resize:vertical;margin-top:10px;}\
.cmm-textarea:focus{outline:none;border-color:var(--cm-plum-mid,#8B4A6E);}\
.cmm-hint{font-size:12px;line-height:1.5;color:var(--cm-text-sub,#7A6070);margin:8px 0 0;}\
.cmm-actions{display:flex;gap:12px;margin-top:22px;}\
.cmm-cancel,.cmm-confirm{flex:1;border-radius:999px;padding:13px 18px;font:700 15px/1 "Mulish",sans-serif;cursor:pointer;}\
.cmm-cancel{background:none;border:1.5px solid var(--cm-mauve,#C98BB0);color:var(--cm-plum-dark,#5C2D4A);}\
.cmm-confirm{background:var(--cm-plum-dark,#5C2D4A);border:none;color:#fff;}\
.cmm-confirm:disabled{opacity:.6;cursor:default;}\
.cmm-note{font-size:12px;color:var(--cm-text-sub,#7A6070);margin-top:12px;text-align:center;min-height:1em;}\
.cmm-done{font-size:14px;line-height:1.6;color:var(--cm-text,#2E1A28);}\
.cmm-fullload{position:fixed;inset:0;z-index:1100;display:none;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:var(--cm-bg,#FBF7F2);text-align:center;padding:24px;}\
.cmm-fullload.show{display:flex;}\
.cmm-fullspin{width:44px;height:44px;border-radius:50%;border:3px solid var(--cm-mauve,#C98BB0);border-top-color:var(--cm-plum-dark,#5C2D4A);animation:cmmspin .8s linear infinite;}\
.cmm-fulltxt{font-family:"Mulish",sans-serif;font-size:16px;color:var(--cm-text-sub,#7A6070);max-width:340px;line-height:1.5;}\
@keyframes cmmspin{to{transform:rotate(360deg);}}';

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

    // #6 : overlay de chargement plein écran pendant l'analyse de la demande (paroles corrigées).
    var load = document.createElement('div');
    load.className = 'cmm-fullload'; load.setAttribute('aria-hidden', 'true');
    load.innerHTML = '<div class="cmm-fullspin" aria-hidden="true"></div><p class="cmm-fulltxt">Un instant, on prépare tes paroles corrigées…</p>';
    document.body.appendChild(load);

    els = {
      ov: ov,
      load: load,
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
    // #16 : on garde le brouillon de la demande tant qu'il n'est pas envoyé (par token).
    els.ta.addEventListener('input', function () { try { localStorage.setItem('cm_modif_draft_' + (cfg && cfg.token), els.ta.value); } catch (_) {} });

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
    // #16 : on garde aussi la pastille choisie (par token), pour qu'elle survive un close/reopen.
    try { localStorage.setItem('cm_modif_chip_' + (cfg && cfg.token), k || ''); } catch (_) {}
  }

  function openModal() {
    if (!cfg) return;   // jamais ouvert avant init() (pas de token / config)
    if (!built) build();
    els.title.textContent = cfg.title;
    els.sub.textContent = cfg.sub;
    els.hint.textContent = cfg.hint;
    try { els.ta.value = localStorage.getItem('cm_modif_draft_' + cfg.token) || ''; } catch (_) { els.ta.value = ''; }   // #16 : restaure le brouillon non envoyé
    // #16 : restaure aussi la pastille choisie (placeholder + hint de contexte), sinon retour à l'état neutre.
    var savedChip = '';
    try { savedChip = localStorage.getItem('cm_modif_chip_' + cfg.token) || ''; } catch (_) {}
    if (savedChip && CHIPS.some(function (c) { return c.k === savedChip; })) {
      setActive(savedChip);
    } else {
      els.ta.setAttribute('placeholder', 'Décris ce que tu aimerais changer…');
      [].forEach.call(els.chips.children, function (b) { styleChip(b, false); });
    }
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

  function showDone() {
    els.form.style.display = 'none';
    els.done.innerHTML = cfg.done;
    els.done.style.display = 'block';
    els.note.textContent = '';
  }
  function showErr() {
    els.send.disabled = false;
    els.note.textContent = 'Un souci est survenu. Réessaie dans un instant.';
  }
  // Capture la demande dans le cockpit (style/prononciation/cas limite), comme avant -> rien n'est perdu.
  function captureFallback(texte) {
    try {
      fetch('/api/decortique', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cfg.token, demande: texte }) });
    } catch (_) {}
  }

  // Mode SELF-SERVE post-achat (locké avec Maxime 2026-06-30) : on route via demander-modif-client.
  // Une demande de PAROLES (route 'cover') part en acceptation INLINE sur /revision, comme l'aperçu,
  // au lieu du « on te revient par courriel ». Style/prononciation restent capturés au cockpit (decortique).
  function clearDraft() { try { localStorage.removeItem('cm_modif_draft_' + cfg.token); localStorage.removeItem('cm_modif_chip_' + cfg.token); } catch (_) {} }
  function hideLoad() { if (els.load) els.load.classList.remove('show'); }

  function submitSelfServe(texte) {
    fetch('/api/demander-modif-client', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cfg.token, action: 'analyser', texte: texte })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !res.ok) { hideLoad(); captureFallback(texte); clearDraft(); showDone(); return; }
        if (res.route === 'cover') {
          clearDraft();   // #16 : la demande est partie en proposition -> on vide le brouillon
          try { sessionStorage.setItem('cm_cover_' + cfg.token, JSON.stringify({ lyrics: res.lyrics || '', titre: res.titre || '' })); } catch (_) {}
          window.location.href = '/revision?id=' + encodeURIComponent(cfg.token) + '&mode=cover';
          return;   // on navigue vers /revision : l'overlay de chargement reste affiché pendant la bascule
        }
        if (res.route === 'busy') {
          hideLoad();
          els.send.disabled = false;
          els.note.textContent = 'Une version est déjà en préparation. Laisse-nous finir celle-là, puis réessaie.';
          return;   // #16 : pas envoyé -> on garde le brouillon
        }
        if (res.route === 'plafond') {
          // Plafond atteint : la demande est DÉJÀ enregistrée côté serveur (Maxime la reçoit). On laisse le
          // client AJOUTER des détails s'il veut : ré-ouvre le champ, vide-le, et chaque nouvel envoi se greffe
          // à la même demande (côté serveur). Pas de double capture (clearDraft, pas de captureFallback).
          hideLoad(); clearDraft();
          els.send.disabled = false;
          if (els.ta) els.ta.value = '';
          els.note.textContent = 'On a bien reçu ta demande, on te revient ! Tu peux ajouter des détails ci-dessous si tu veux.';
          return;
        }
        // route 'regen' / 'prononciation' / cas inexploitable -> capture cockpit + message « on te revient ».
        hideLoad(); captureFallback(texte); clearDraft(); showDone();
      })
      .catch(function () { hideLoad(); captureFallback(texte); clearDraft(); showDone(); });
  }

  function submit() {
    var texte = (els.ta.value || '').trim();
    if (texte.length < 4) { els.note.textContent = 'Décris en quelques mots ce que tu veux ajuster.'; els.ta.focus(); return; }
    els.send.disabled = true; els.note.textContent = 'Un instant, on regarde ta demande…';

    if (cfg.selfServe) { if (els.load) els.load.classList.add('show'); submitSelfServe(texte); return; }

    var payload = { token: cfg.token };
    payload[cfg.champ] = texte;
    fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('ko');
        showDone();
      })
      .catch(showErr);
  }

  window.cmModifModal = {
    init: function (options) {
      options = options || {};
      cfg = {
        token:    options.token || '',
        endpoint: options.endpoint || DEFAULTS.endpoint,
        champ:    options.champ || DEFAULTS.champ,
        selfServe: !!options.selfServe,   // post-achat : route paroles -> /revision (accept inline)
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
