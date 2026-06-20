# HANDOFF — Chanson Mémoire · production musicale (état au 2026-06-20, fin de session)

> À lire EN PREMIER par la nouvelle session, avec `CLAUDE.md`, `CM_spine_spec.md`,
> `CM_mapping_airtable.md`, `CM_make_plan.md`. Ce fichier = état réel + ce qui reste.
> La mémoire auto (`MEMORY.md` → `cm-production-musicale-build.md`) contient le détail granulaire.

---

## 0. Contexte
- Repo : `maxime1728/chansonmemoire` · dossier local : `C:\Users\PC\cm-audit`.
- Produit : chansons hommage IA, B2C Québec, domaine **`.ca` (jamais `.com`)**.
- **Le parcours fonctionne** : survey → paroles → revision → confirmation → chanson (Suno) →
  callback → Cloudinary → page d'attente → **aperçu signé qui joue (preview 60 s testé OK le 2026-06-20)**.

## 1. Garde-fous (NON négociables — voir CLAUDE.md)
- **Loi 25 / légal** : prix, témoignages, allégations de résultats = STOP + signaler. Aucun témoignage/prix fabriqué.
- **Credentials test-only** : jamais Stripe live, jamais la prod du freelancer, jamais le flux live sans go humain.
- **`.ca` par défaut partout** (jamais `.com`).
- **Voix solution-first** : jamais ouvrir un copy sur le deuil/la perte.
- **GitHub : branche + PR toujours, jamais de commit direct sur `main`. Aucun effet de bord sans diff + « go ».**
- Tags de confiance : [Certain] / [Probable] / [Spéculation].
- **🚫 Dossier Make « SONG » = NE JAMAIS TOUCHER.** On travaille dans **« Chanson Mémoire »** (folderId 321788).
- Airtable base `appIADNKzDOVtpjWj` = **pré-lancement, traitée comme test** (OK d'écrire).

---

## 2. Infra / IDs utiles
- **Make** : org 1059466, team 422966, dossier « Chanson Mémoire » 321788.
  - **MAKE A — Lyrics** : id `4789787`, hook `2749752`.
  - **C-gen — generate song** : id `4792851`, hook `2751751`, webhook `…amlfm9tapjjewz2kec1eirs8oylb812g` (callback Suno).
  - **C-cb — callback Suno** : id `4792855`, hook `2751754`.
  - **MAKE D — Stripe (achat)** : **BÂTI mais PAS encore importé/activé** (blueprint `CM-D-REBUILD.blueprint.json`).
  - Connexions Make : Airtable `4766682`, Cloudinary `4732918` (cloud `dcx1tfm47`), Gmail `3661126`, keychain Anthropic `92227`.
  - Data Store « Songs styles » `86715` (clé Style Musical × Ambiance × Cadeau/Mémoire → `Prompt Complet`).
- **Airtable** `appIADNKzDOVtpjWj` : Clients `tblQbF1OlE3uRxFra`, Projects `tblh7O8eoog7RyTMJ`,
  Generations `tblfrHFe1zH9apNlp`, Upsells `tbl0Z52D8l4555Has`.
- **Env vars Netlify** : `AIRTABLE_BASE_ID`, `AIRTABLE_TOKEN`, `ANTHROPIC_API_KEY`,
  `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (tous présents).
  `netlify.toml` → `SECRETS_SCAN_OMIT_KEYS = "CLOUDINARY_CLOUD_NAME"` (cloud name public, sinon le build échoue).
- Clés (Suno, Stripe) vivent **dans Make** (header / connexion), **jamais dans le repo**.

---

## 3. CE QUI A ÉTÉ FAIT cette session (toutes les PR sont mergées dans `main`)
- **Phase 1 — http→https** ✅ : helper `toHttps` (lire-projet, telecharger) + C-cb `secure_url`.
- **Phase 2 — suggestions fixes + type C-gen** ✅ : `revision.html` boutons « Allonger »/« Raccourcir » (injectent une
  consigne, réutilisent `ajouterSuggestion`) ; C-gen `type` = formule `if(mode=cover…; if(song_regenerations_count>=1; song_regeneration; song))`.
- **Phase 4 A+B — rebuild MAKE A** ✅ : plus de doublon de Project (Search Project par token → router NEW vs REGEN),
  `generation_no` correct (NEW `{{0+1}}`, REGEN `{{parseNumber(ifempty(10.generation_no;0);".")+1}}`),
  dédup Client par email (`email` primaire) + `consent_date`/`first_contact_date` préservés via `formatDate(ifempty(2.x; now); "YYYY-MM-DD")`.
- **Phase 3 — funnel** ✅ (partiel) : audit single-select = **chemin Mémoire PROPRE** (survey↔Airtable↔Data Store
  identiques ; Data Store = 195 records = grille complète 13 styles × (7 Cadeau + 8 Mémoire)). `funnel_step` redéfini
  (lyrics_generated → lyrics_approved? → song_generating → preview_ready → preview_played → checkout_started → purchased
  → delivery_accepted, + refunded). Écritures : `suivi-funnel.js` (preview_played + checkout_started via sendBeacon),
  `accepter-livraison.js` (delivery_accepted), `generate-lyrics.js` (lyrics_generated), MAKE A (lyrics_generated),
  C-gen (song_generating, module 13), C-cb (preview_ready, module 7). **`purchased` = en attente de MAKE D.**
- **MAKE D — Stripe** : blueprint bâti avec **anti-forge** (re-fetch de la session Stripe via HTTP GET authentifié avant
  de marquer `purchased`), anti-double webhook, courriel de livraison `.ca`. `apercu.html` passe le **token** comme
  `client_reference_id` à Stripe. **PAS encore activé** (voir §5).
- **Phase 5 — Cloudinary signé** ✅ **TESTÉ** : assets uploadés en **`authenticated`** (C-cb module 4) ; `lire-projet`/
  `telecharger` génèrent des **URL signées côté serveur** (crypto natif `require('crypto')`, SHA-1, `du_60` inclus dans
  la signature → non contournable). `buildAudioUrl` détecte le type (`upload` public ancien vs `authenticated` nouveau).
  **Le preview 60 s joue ✅** (signature SHA-1 validée). `apercu.html` ne tronque plus côté client.
- **Fixes divers** : prompt `invalid_input` assoupli (dernier recours seulement) + garde-fous page/retry ;
  bouton « Réessayer » de revision = **vraie relance** (`generate-lyrics` mode `retry`, anti-doublon) ;
  `netlify.toml` SECRETS_SCAN ; `require('crypto')` (pas `node:crypto`).
- **Champs Airtable créés** : `checkout_started_at`, `preview_played_at`, `preview_play_count` (Projects),
  `cloudinary_public_id` (Generations), `page_url` (Projects, **formule dynamique** → lien vers l'étape courante selon `funnel_step`).
- **Scénarios réparés via MCP `scenarios_update`** (2026-06-20 après-midi) :
  - **C-cb** : module 5 écrit `cloudinary_audio_url` + `cloudinary_public_id` + **`song_id`** + **`generation_status=audio_generated`**
    (par field ID) ; upload `authenticated` ; module 7 `funnel_step=preview_ready` ; email fallback propre.
  - **C-gen** : réécrit proprement, **mappings par field ID** (stables), logique préservée. **⚠️ clé Suno = PLACEHOLDER.**

---

## 4. ⚠️ EN SUSPENS / NON RÉSOLU / À SURVEILLER (le plus important)

1. **🔑 RÉSOLU (2026-06-20) — clé Suno en place.** Le header du **module 8 (HTTP api.sunoapi.org)** porte désormais une vraie
   clé `Bearer …` (plus de placeholder). **Prouvé par usage** : exéc. C-gen `4792851` du 2026-06-20 17:28 (9 ops, vrai appel
   Suno) → callback C-cb `4792855` OK → Project test `guigluig` (token `29ddc7fc…`) arrivé à `funnel_step=preview_played`.

2. **🔧 RÉSOLU (2026-06-20) — scope `schema.bases:read` présent.** La connexion câblée dans TOUS les scénarios CM est
   `4766682` « Maxime's Connection » (**Airtable OAuth**, pas un PAT). Scopes réels vérifiés via MCP : `schema.bases:read` +
   `data.records:read` + `data.records:write`. → L'éditeur Make affiche désormais les champs ; **éditer/sauver un module
   Airtable ne vide plus les mappings** ; garde-fou « ne pas toucher les modules Airtable » = **LEVÉ**.
   (Hygiène : 2 connexions Airtable orphelines `4804199`/`4804205` créées pendant le fix, non utilisées — à supprimer.)

3. **MAKE D pas activé.** À faire : importer `CM-D-REBUILD.blueprint.json` → créer le webhook (module 1) → coller son URL
   dans **Stripe Dashboard → Webhooks** (événement `checkout.session.completed`) → mettre la **clé Stripe restreinte TEST**
   dans le module 2 → re-lier connexions. Tant que non fait : `commercial_status=purchased` et `funnel_step=purchased`
   ne sont jamais écrits → la livraison ne se débloque pas.

4. **CAPI Meta en attente** : « Lead » (MAKE A, branche NEW seulement) + « Purchase » (MAKE D) + remboursement (`refunded`).
   Nécessite **Pixel ID + access token Meta** (placeholders dans les blueprints). ⚠️ **Flag Loi 25** (CAPI = transfert de
   données à Meta, email hashé sha256 + fbc/fbp → doit être couvert par consentement + politique de confidentialité).

5. **Garde-fou `invalid_input` dans MAKE A — à CONFIRMER appliqué.** Blueprint `CM-A-REBUILD.blueprint.json` ajoute :
   filtre `{{5.statusCode}} number:equal 200` sur les Create Generation (modules 8 NEW + 11 REGEN) + 3e route email d'alerte
   (`{{5.statusCode}} != 200`). **But** : ne pas écrire `{"error":"invalid_input"}` comme paroles quand l'API refuse.
   Vérifier que Maxime l'a bien appliqué (sinon un survey « charabia » peut encore créer une Generation cassée).
   *(NB : `generate-lyrics` retourne la 422 invalid_input en `text/plain` → côté Make `{{5.data}}` est une STRING, d'où le
   filtre sur `statusCode` et non sur `data.lyrics`.)*

6. **Phase 5 — VÉRIFIÉE ✅ (tests live 2026-06-20, token `29ddc7fc…`).** Trois GET en direct :
   (a) URL signée `…/authenticated/s--…--/du_60/cm_….mp3` → **200** (le preview joue) ;
   (b) même URL **sans** `/du_60/` → **401** (signature cassée — fuite fermée, `du_60` est dans le `toSign`) ;
   (c) `/api/telecharger` sur projet `preview_only` → **403** (chanson complète gatée `purchased`).
   **Reste 1 geste manuel** : dismiss les **2 alertes CodeQL « weak crypto »** (SHA-1 sur `lire-projet.js`~l.52 et
   `telecharger.js`~l.43) en **« Won't fix »** — SHA-1 est imposé par le schéma d'URL signée Cloudinary (faux positif).
   **NE PAS** accepter la suggestion Copilot HMAC/SHA-256 (casserait la signature → 401 sur tous les previews).
   Si un jour 401 sur un preview légitime : ajuster le `toSign` (le plus probable = enlever `.mp3`).

7. **Phase 6 — choix de version à l'achat** : pas commencé. Garder toutes les versions, `lire-projet` renvoie la liste,
   sélecteur sur apercu, l'achat enregistre la version choisie. ⚠️ touche la chaîne argent → incrémental.

8. **Proxy `lancer-chanson.js` toujours contourné** (appels webhook directs depuis les pages). Durcissement serveur
   (secret webhook côté serveur, env `MAKE_C_GEN_WEBHOOK_URL` + `MAKE_WEBHOOK_SECRET`) = phase sécurité séparée.
   (Le filtre « secret valide / VOTRE_SECRET » placeholder a été RETIRÉ de C-gen — il bloquait tout.)

9. **Hygiène Airtable** : `preview_slug` + `full_slug` (Generations) et `regenerations_count` (Projects) = vestiges à
   supprimer (le MCP ne peut pas supprimer un champ → manuel UI). `contact_name` (Clients) = gardé (jamais écrit, le
   survey ne capte pas de nom). À confirmer si Maxime les a supprimés.

10. **Champs à tracker plus tard (analyse faite, pas créés)** : `checkout_started_at`/`preview_played_at` créés ✅ ;
    restent **`replay_generation`+`force_delivery`** (cases admin Brigitte §6 spine), `delivery_email_sent_at`,
    `last_error`/`error_step`, `refund_date`/`refund_reason`.

11. **Vraie chaîne COVER (post-achat)** : C-gen module 8 appelle TOUJOURS `/api/v1/generate`, jamais
    `/api/v1/generate/upload-cover`. Donc `mode:'cover'` génère une chanson normale, pas un vrai cover (mélodie gardée +
    paroles changées + `uploadUrl` Cloudinary + décortique Anthropic). **À faire quand les phases seront finies** (décidé avec Maxime).

12. **Données de test à ignorer/nettoyer** : Projects à `generations_count=0` = runs MAKE A échoués (orphelins) ;
    anciennes Generations avec `{"error":"invalid_input"}` ; anciens assets Cloudinary en `upload` (public) qui resteront
    lisibles en public (buildAudioUrl les sert en `/upload/`). Tout ça = données de test pré-correctifs, sans impact.

---

## 5. PROCHAINES ÉTAPES (ordre recommandé)
1. ✅ **FAIT** — clé Suno en place dans C-gen module 8 (génère, vérifié 2026-06-20).
2. ✅ **FAIT** — `schema.bases:read` présent sur la connexion Airtable `4766682` (éditeur Make sûr).
3. ✅ **FAIT** — end-to-end NOUVELLE chanson vert : Project `guigluig` arrivé à `preview_played` (preview signé joué).
4. ✅ **VÉRIFIÉE** — Phase 5 : tests live 200 / 401 / 403 OK (voir §4.6). *Reste : dismiss manuel des 2 alertes CodeQL.*
5. **→ PROCHAIN : Activer MAKE D** (webhook Stripe + clé restreinte TEST) → tester un achat 1 $ → `purchased` + courriel + déblocage livraison.
6. **CAPI** « Lead » (MAKE A) puis « Purchase » (MAKE D) quand les identifiants Meta sont dispo (+ valider le flag Loi 25).
7. **Phase 6** (choix de version) + chaîne **cover** réelle.

---

## 6. MÉTHODE DE TRAVAIL ATTENDUE
- Plan court d'abord → attendre « go » → **diff avant tout commit**, puis branche + PR (jamais `main` direct) → additif et testé.
- **Make** : `scenarios_get` pour LIRE l'état réel AVANT d'éditer. Livrer les rebuilds en `*.blueprint.json`
  (placeholders pour clé/secret, jamais de credential dans le repo ; ils sont **gitignorés** via `*.blueprint*.json`).
  Quand l'éditeur Make est cassé (champs vides), patcher via **MCP `scenarios_update`** (valider avec
  `validate_blueprint_schema` AVANT) — sûr pour C-cb (pas de clé) ; pour C-gen, mettre la clé Suno en placeholder.
- **NE JAMAIS** committer un `.blueprint.json` avec une vraie clé. **NE JAMAIS** demander/exiger un accès MCP non branché
  (Airtable/Make peuvent être déconnectés selon la session — nommer le MCP + pourquoi, ne pas supposer l'accès).
- Tags de confiance sur les affirmations. Pour un bug de build/déploiement Netlify : **exiger le log** (ne pas inférer).

---

## 7. ÉTAT DES SCÉNARIOS MAKE (résumé)
| Scénario | État | Note |
|---|---|---|
| MAKE A (4789787) | ✅ rebuild A+B + funnel ; garde invalid_input **à confirmer appliqué** | `{{0+1}}`, parseNumber, formatDate |
| C-gen (4792851) | ✅ réécrit (field IDs) ; **clé Suno en place** (génère, vérifié 2026-06-20) | OK |
| C-cb (4792855) | ✅ patché (status + song_id + authenticated + funnel + email) | OK |
| MAKE D | ⏳ bâti, **pas importé/activé** | webhook Stripe + clé TEST requis |
