# HANDOFF — Tracking, CAPI & Sécurité (Chanson Mémoire)

> **Doc d'implémentation pour Claude Code.** Objectif : que tous les leads soient trackés via l'API Meta (CAPI) et mergés avec les ads, proprement et en sécurité, avant de scaler.
> **Pour reprendre :** lis ce fichier + `CLAUDE.md` (contexte projet) + `docs/AUDIT-tracking-2026-06-24.md` (preuves brutes, file:line). Le code réel est dans `_repo/` (clone de `maxime1728/chansonmemoire`).
> Daté 2026-06-24.

---

## 0. Garde-fous (NON négociables)
- **Loi 25** : consentement + minimisation + divulgation. Le token client n'est **jamais** envoyé brut à Meta (toujours haché).
- **Produit = personnes DÉCÉDÉES** uniquement ; voix **solution-first** (jamais ouvrir sur le deuil).
- **Credentials = test only.** Maxime seul pose les secrets, **déploie** (git push → Netlify) et **active** les scénarios Make en prod.
- **« Make écrit, Netlify lit. Jamais l'inverse »** (1 exception approuvée : preuves de livraison `accepter-livraison.js`, `telecharger.js`).
- **`lire-projet.js` / `lire-versions.js` / `lire-survey.js` ne doivent JAMAIS exposer l'attribution** (utm/fbc/fbp/event_id) ni l'email/Stripe.
- Domaine **`.ca`** par défaut. ⚠️ Important : **toute modif de `_repo/` doit être pushée et déployée par Maxime** (Claude ne déploie pas).

---

## 1. Environnement & accès

### Repo (`_repo/`)
- Pages : `index.html` (landing+Pixel+consentement), `souvenirs.html` (survey = LEAD), `revision.html` (paroles), `attente-chanson.html`, `apercu.html` (preview+checkout), `page-chanson.html` (post-achat), `page-memoire.html` (livraison/cadeaux/upsells).
- Backend : `netlify/functions/*.js` (+ `_lib/` helpers). Le SEUL fichier qui parle à Meta = **`netlify/functions/suivi-funnel.js`**.
- `netlify.toml` (crons : nurture @hourly, sentinelle */30, alerte, cover).

### Airtable — base `appIADNKzDOVtpjWj`
- `Projects` `tblh7O8eoog7RyTMJ` — champs tracking : `utm_*`, `fbclid`, `fbc`, `fbp`, `event_id`, `landing_page`, **`capi_lead_sent`/`capi_checkout_sent`/`capi_purchase_sent`/`capi_last_response`** (⚠️ inutilisés), `Pub` (`flds2b9ClA5MZkeTv`, lien créatif), `commercial_status`, `amount`, `cgv_acceptees_at`.
- `Pubs` `tblF68heKEIpyMuQW`, `Pubs_Performance` `tblR0fNh6mIoVlC9V`, `Hook_Bank` `tblIzORbTNaoAhJ0b`.
- Interface dashboard `pbdbeTuq1qPHEXMmz`.

### Make — team `422966`, dossier CM `321788`, connexion Airtable `4766682`
| Scénario | ID | Rôle |
|---|---|---|
| MAKE A - Lyrics | `4789787` | crée Client+Project depuis le survey (= **point Lead**) |
| MAKE C-gen | `4792851` | Suno generate |
| MAKE C-cb | *(à confirmer via scenarios_list)* | callback Suno |
| **MAKE D - Stripe (achat)** | `4793505` | marque `purchased` (= **point Purchase**) |
| Sentinelle | `4794995` | relance chansons bloquées |
| Cadeaux | `4794401` | (à désactiver, superseded par `lancer-cadeau.js`) |
| Insights (dépense Meta) | `4796178` | pull coût Meta → Airtable (✅ actif) |
| **Jointure Pub** | `4797135` | utm_content→lien Pub (✅ valide, à activer) |
- Webhook MAKE A : `https://hook.us1.make.com/1dyhk11x8yf1biy8mawnepdt3k1rcqvq` (`souvenirs.html:276`).

### Meta
- Compte pub : `act_1045674522960266`. **Dataset CAPI : `909919758755200`** (`HANDOFF.md:65`).
- **Pixel navigateur : ID = placeholder `TON_PIXEL_ID`** (`index.html:782`) → à remplacer. (Probablement = le dataset `909919758755200` en datasets unifiés — **à confirmer avec Maxime**.)

### Env vars Netlify (référencées par le code)
`META_DATASET_ID` (=909919758755200), `META_CAPI_TOKEN`, `MAKE_WEBHOOK_SECRET`, `AIRTABLE_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`, `MAILGUN_API_KEY/_DOMAIN/_FROM`, `MAILGUN_DOMAIN_MARKETING/_FROM_MARKETING`, `CM_POSTAL_ADDRESS`.

---

## 2. Parcours A-Z & modèle d'event (vérifié dans le code)

| Étape | Page / fonction | Champ Airtable | Event Meta attendu | Réalité |
|---|---|---|---|---|
| Landing | `index.html` | — (pose cookies `_fbp`/`_fbc`) | PageView | ⚠️ Pixel = placeholder → rien |
| **LEAD** | `souvenirs.html` → MAKE A `4789787` | crée Project (token=UUID v4, utm/fbclid/fbc/fbp, `cgv_acceptees_at`) | **Lead** | ❌ codé, **non branché** |
| Preview joué | `apercu.html` → `suivi-funnel.js` | `preview_played_at` | PreviewPlayed | ✅ envoyé |
| Clic payer | `apercu.html` → `suivi-funnel.js` | `checkout_started_at` | InitiateCheckout | ✅ envoyé |
| **ACHAT** | Stripe → MAKE D `4793505` | `commercial_status=purchased`, `amount` | **Purchase** | ❌ codé, **non branché** |
| ROAS interne | robots Jointure + Insights | rollup `revenue_total`/`ROAS` | — | ✅ fiable une fois ON |

**2 pipelines :** **A** = ROAS réel (Airtable : revenu × dépense Meta, coût seulement tiré de Meta) — fiable. **B** = signal CAPI vers Meta (optimisation/scale) — **incomplet** (c'est l'objet de ce handoff).

**`suivi-funnel.js` (le moteur CAPI déjà en place) :**
- POST `https://graph.facebook.com/v21.0/${META_DATASET_ID}/events?access_token=${META_CAPI_TOKEN}` (`:83`). No-op si env absentes (`:61`).
- Map events (`:42`) : `{preview_played:'PreviewPlayed', checkout_started:'InitiateCheckout', purchase:'Purchase', lead:'Lead'}` — **les 4 sont codés**.
- `user_data` (`:63`) : `em=[sha256(email)]`, `fbc`, `fbp`, `client_ip_address`+`client_user_agent` (depuis les **headers de la requête**), `action_source:'website'`.
- `event_id = sha256(projet.id + '.' + evt)` (`:75`) — ⚠️ basé sur `projet.id` (le navigateur ne peut pas le reproduire → dédup cassée).
- Purchase ajoute `custom_data:{currency:'CAD', value:Number(amount)}` (`:80`).
- Appelé seulement par `apercu.html` (`:1257` preview_played, `:1483` checkout_started). **Rien n'appelle `purchase` ni `lead`.**

---

## 3. État vérifié (audit) — résumé
- **CAPI** : PreviewPlayed + InitiateCheckout ✅ ; **Lead ❌ non branché**, **Purchase ❌ non branché** (code prêt, aucun appelant).
- **Pixel** : `index.html` seulement, **ID placeholder**, PageView seul, pas d'`eventID`, pas de `user_data`.
- **`fbc`** : lu seulement du cookie `_fbc` (`souvenirs.html:313`), **jamais reconstruit depuis `fbclid`** → souvent vide.
- **Dédup** Pixel↔CAPI : non fonctionnelle.
- **`capi_*`** : écrits nulle part (placeholders).
- **MAKE D anti-forge** : ✅ **VÉRIFIÉ OK** — re-fetch `api.stripe.com/v1/checkout/sessions/{id}` (blueprint l.114) + check `payment_status='paid'` (l.339) + anti-double-webhook. (Durcissement optionnel : vérifier aussi `Stripe-Signature`.)
- **Socle sécurité** : solide (UUID v4, `formulaLiteral()` anti-injection, prix serveur, refund signé, pas de secret en dur, pas de CORS *, reads token-gatés sans fuite d'attribution).

---

## 4. BACKLOG D'IMPLÉMENTATION (playbook détaillé)

> Convention : pour chaque tâche → **Objectif · Fichiers/scénarios · Approche · Test · Qui active.** Les modifs `_repo/` = PR/commits que **Maxime déploie**. Les modifs Make = via MCP (scénario laissé **inactif**, Maxime active).

### 🎯 Design cible commun (à respecter partout)
- **event_id partagé** = `sha256(token + '.' + eventName)`, calculé **identiquement** au navigateur (Pixel `eventID`) et au serveur (`suivi-funnel`). Token-safe (haché). → Remplace `projet.id` par `token` à `suivi-funnel.js:75`.
- **IP/UA réels en server-to-server** : étendre `suivi-funnel.js` pour accepter `client_ip_address`, `client_user_agent` (et `event_id`) **optionnels dans le body** ; si présents (appel serveur Make), les utiliser au lieu des headers de la requête. MAKE A/D liront l'IP/UA réels du webhook entrant. Pour Purchase, alternative plus simple : déclencher depuis le navigateur sur `page-chanson` (IP/UA réels « gratuits »).
- **Consentement** : tout déclenchement Pixel reste gaté ; pour le CAPI, voir T11 (base légale à valider).

---

### T1 — 🔴 Brancher `Purchase` en CAPI  *(le plus important)*
**Objectif.** Envoyer l'achat à Meta (optimisation + lookalikes valeur).
**Fichiers/scénarios.** `suivi-funnel.js` (déjà prêt), MAKE D `4793505`, idéalement `page-chanson.html`.
**Approche (recommandée : double, dédupliquée).**
1. **Serveur (fiable)** : dans MAKE D, après le module qui écrit `purchased`, ajouter un module **HTTP POST** vers `https://<DOMAINE.ca>/api/suivi-funnel` body `{ "token":"{{token}}", "event":"purchase", "client_ip_address":"<IP du webhook entrant si dispo>", "client_user_agent":"<UA>" }`.
2. **Navigateur (match quality)** : sur `page-chanson.html` (chargée après redirection Stripe avec `?id=token`), fire `fbq('track','Purchase',{currency:'CAD',value:139.97},{eventID: sha256(token+'.purchase')})` **+** POST `/api/suivi-funnel {token,event:'purchase'}`. Les deux passent par `suivi-funnel` → même `event_id` → Meta dédup.
**Idempotence.** À la fin de `suivi-funnel`, si `evt==='purchase'`, écrire `capi_purchase_sent=true` + `capi_last_response` ; ne pas renvoyer si déjà `true` (voir T6).
**Test.** Achat Stripe **test** → Meta Events Manager → Purchase reçu (Test Events), valeur=montant, `capi_last_response` rempli, pas de doublon.
**Qui active.** Maxime déploie le code + active la modif MAKE D.

### T2 — 🔴 Brancher `Lead` en CAPI
**Objectif.** Tracker l'entrée de funnel.
**Fichiers/scénarios.** `suivi-funnel.js`, MAKE A `4789787` (et/ou `souvenirs.html`).
**Approche.** Dans MAKE A, **après** la création du Project, POST `/api/suivi-funnel {token, event:'lead', client_ip_address, client_user_agent}` (IP/UA = ceux du webhook entrant MAKE A = le vrai client). *(Éviter de tirer le Lead du navigateur juste après le POST survey : race condition, le Project peut ne pas exister encore.)*
**Idempotence.** `capi_lead_sent` (T6).
**Test.** Soumettre le survey en test → Meta reçoit `Lead` avec `em`/`fbc`/`fbp`.
**Qui active.** Maxime.

### T3 — 🔴 Vrai Pixel ID + Pixel sur les pages funnel
**Objectif.** Activer le signal navigateur (redondant Pixel+CAPI).
**Fichiers.** `index.html:782` (remplacer `TON_PIXEL_ID`), + ajouter le snippet Pixel **gaté consentement** sur `souvenirs.html`, `apercu.html`, `page-chanson.html`.
**Approche.** Init Pixel avec l'ID réel (probablement `909919758755200`, à confirmer). Fire les events standard avec `eventID = sha256(token+'.'+evt)` pour matcher le CAPI : `Lead` (souvenirs, au submit), `InitiateCheckout` (apercu, au clic payer), `Purchase` (page-chanson, au load). PageView partout.
**Test.** Meta Pixel Helper voit les events ; Events Manager montre « dédupliqué avec serveur ».
**Qui active.** Maxime (ID Pixel) + déploiement.

### T4 — 🟠 Reconstituer `fbc` depuis `fbclid`
**Objectif.** Ne plus perdre l'attribution des clics payants quand le cookie `_fbc` manque.
**Fichiers.** `suivi-funnel.js` (build `user_data`) ; `Projects.fbclid` déjà stocké.
**Approche.** Dans `suivi-funnel`, si `projet.fbc` vide et `projet.fbclid` présent → `fbc = 'fb.1.' + <timestamp_ms> + '.' + fbclid` (timestamp = approx. `created_date` du Project, sinon `Date.now()`). Préférer la repro serveur (le navigateur n'a pas toujours le cookie).
**Test.** Lead sans cookie `_fbc` mais avec `fbclid` → CAPI envoie un `fbc` reconstruit ; EMQ remonte dans Events Manager.
**Qui active.** Déploiement Maxime.

### T5 — 🟠 Dédup Pixel↔CAPI
**Objectif.** Que Pixel et CAPI du même event soient fusionnés par Meta.
**Fichiers.** `suivi-funnel.js:75` + les pages (T3).
**Approche.** `event_id = sha256(token + '.' + evt)` côté serveur ; même formule au navigateur pour le `eventID` du Pixel. (Le token est connu des deux côtés ; haché = token-safe.)
**Test.** Events Manager → « X events deduplicated ».
**Dépend de** T3.

### T6 — 🟡 Utiliser les champs `capi_*` (idempotence + observabilité)
**Objectif.** Ne pas double-compter ; débugger le matching.
**Fichiers.** `suivi-funnel.js`.
**Approche.** Avant envoi : si `capi_<evt>_sent === true`, skip. Après envoi : `update_record` Project → `capi_<evt>_sent=true`, `capi_last_response = <réponse Meta tronquée>`. (Respecter « Netlify écrit ici » = ok, c'est de l'observabilité, pas de l'orchestration ; sinon faire écrire par Make.)
**Test.** Renvoyer 2× le même event → 1 seul reçu côté Meta.

### T7 — 🔴(sécurité) Verrouiller `generate-lyrics.js` mode `create`
**Objectif.** Empêcher le cost-bombing Anthropic.
**Fichiers.** `generate-lyrics.js:401` (path `create`).
**Approche.** Exiger `MAKE_WEBHOOK_SECRET` (header ou body), même pattern que `lancer-chanson.js:38` / `courriel-entrant.js:133` → 401 sinon. + règle de rate-limit Netlify sur `/api/generate-lyrics`. (MAKE A devra envoyer le secret.)
**Test.** POST sans secret → 401 ; MAKE A (avec secret) → 200.
**Qui active.** Déploiement Maxime + ajout du secret dans MAKE A.

### T8 — 🟠(sécurité) Signer les callbacks providers
**Objectif.** Empêcher l'injection d'URL/audio via faux callback.
**Fichiers.** `callback-paroles-vivantes.js:47`, `callback-cover.js`, `callback-instrumentale.js`.
**Approche.** Vérifier un secret partagé (header) ou un **nonce par tâche** (généré au `lancer-*`, stocké, exigé en retour). Matcher uniquement sur le `*_task_id` provider, pas sur le token.
**Test.** Faux callback sans secret → rejeté.

### T9 — ✅ MAKE D anti-forge (vérifié) — durcissement optionnel
Déjà sûr (re-fetch session + `payment_status=paid`). **Optionnel** : ajouter la vérif `Stripe-Signature` (defense-in-depth).

### T10 — 🟡 Net des remboursements
**Objectif.** Ne pas sur-déclarer le ROAS / les ventes.
**Fichiers.** `stripe-refund.js` (passe `refunded`).
**Approche.** Au choix : exclure les `refunded` du rollup revenu (Airtable), et/ou envoyer un event de remboursement à Meta. Documenter la décision.

### T11 — 🟡 Loi 25 : consentement CAPI + rétention PII
**Objectif.** Base légale solide.
**Actions.** (1) Faire **valider par un juriste** que « consentement inclus dans les CGV » couvre le transfert CAPI (sinon : consentement explicite + gate serveur du CAPI). (2) Bannière de consentement sur **toutes** les pages (pas juste index). (3) **Politique de rétention + cron de purge** pour `acceptance_ip`, `acceptance_user_agent`, fils d'email (`courriel-entrant`).
**Qui.** Maxime + juriste.

### T12 — 🟡 Petits correctifs
- Ajouter `.env` / `.env.*` au `.gitignore`.
- Retirer `?email=` de l'URL `/apercu` (fuite logs/historique).
- `generate-lyrics.js:356/379` : ne pas renvoyer les erreurs upstream brutes au client.
- Cohérence domaine `.ca` (la bannière `index.html:706` pointe `chansonmemoire.com`).

---

## 5. Priorisation
**Bloquant avant +budget :** T7 (cost-bomb) · T1 (Purchase CAPI) · T3 (vrai Pixel).
**Important :** T2 (Lead CAPI) · T4 (fbc) · T5 (dédup) · T6 (idempotence) · T8 (callbacks).
**Légal (bloquant scale) :** T11.
**Confort :** T10 · T12 · T9-opt.

> 90 % du travail CAPI = **branchement** (MAKE A/D appellent `suivi-funnel`) + petites modifs de `suivi-funnel.js` (event_id token-based, IP/UA en body, fbc reconstruit, idempotence `capi_*`) + vrai Pixel. Pas de reconstruction.

## 6. Demande à Maxime
- Vrai **Pixel ID** (≈ dataset `909919758755200` ?).
- Confirmer/poser env : `META_CAPI_TOKEN`, `MAKE_WEBHOOK_SECRET`.
- **Déployer** les modifs `_repo/` (git push → Netlify) et **activer** les modifs Make.
- Validation **juridique** Loi 25 / CGV / divulgation IA (bloquant scale).

## 7. Questions ouvertes
- Pixel ID = dataset ? (à confirmer)
- IP/UA du client : MAKE A/D peuvent-ils lire l'IP du webhook entrant ? (sinon, capter au navigateur)
- Remboursements : exclure du ROAS et/ou event Meta ? (décision business)
- Domaine canonique `.ca` final (pour les URLs CAPI `event_source_url` et la bannière).
