# HANDOFF — Chanson Mémoire · production musicale (état au 2026-06-22)

> **À LIRE EN PREMIER** par toute nouvelle session Claude Code, AVANT d'agir.
> Ordre de lecture : ce fichier → `CLAUDE.md` → `CM_spine_spec.md` → `CM_mapping_airtable.md` → `CM_make_plan.md`.
> La **mémoire auto** (`MEMORY.md` → `cm-production-musicale-build.md`, `cm-post-achat-plan.md`, `project-guardrails.md`, `working-protocol.md`) contient le détail granulaire et se charge automatiquement.

---

## 0. PROMPT DE REDÉMARRAGE (à coller comme premier message)

```
Je reprends le projet Chanson Mémoire. Dossier : C:\Users\PC\cm-audit · Repo : maxime1728/chansonmemoire.

AVANT TOUTE ACTION : lis HANDOFF.md (le plus à jour), puis CLAUDE.md, CM_spine_spec.md,
CM_mapping_airtable.md, CM_make_plan.md. Lis aussi ta mémoire (cm-production-musicale-build.md
et cm-post-achat-plan.md). Reformule les 4 garde-fous critiques du CLAUDE.md pour confirmer
qu'ils sont chargés.

OÙ ON EN EST (voir HANDOFF.md §3-4) : parcours complet OK, achat (MAKE D) testé, order bumps
au checkout Stripe, Phases A→C MERGÉES. Décortique (E/F) + popup plafond + CAPI serveur +
popups d'échec (attente 8 min, paroles 60 s) MERGÉS. Reste : la SENTINELLE (relance auto des
chansons bloquées, §9), le fulfillment des cadeaux/bumps, la boucle décortique complète, et
quelques actions manuelles Maxime (Make + Airtable, voir §7).

PROTOCOLE (strict) : branche + PR, jamais de commit direct sur main. Aucun effet de bord sans
me montrer un diff et attendre mon « go ». Tags [Certain]/[Probable]/[Spéculation]. Pour Make :
scenarios_get pour LIRE avant d'éditer ; ne JAMAIS scenarios_update un scénario qui contient une
vraie clé (C-gen=Suno, MAKE D=Stripe, Sentinelle=Suno) → édition manuelle. Dossier Make « SONG »
= NE PAS TOUCHER. Les MCP (Airtable/Make/Canva) peuvent être déconnectés : ne suppose pas l'accès,
nomme le MCP + pourquoi. Bug build/déploiement Netlify : exige le log, n'infère pas.

Commence par : confirmer les garde-fous, puis propose un PLAN COURT pour la prochaine étape
prioritaire et attends mon go.
```

---

## 1. Contexte produit
- **Chanson Mémoire** : chansons hommage IA, ~139,97 $ CAD, produit digital. B2C **Québec francophone** (deuil/commémoration), sous LabMarketing.
- Domaine **`.ca` (jamais `.com`)** partout. Repo `maxime1728/chansonmemoire`, local `C:\Users\PC\cm-audit`.
- **Équipe** : Maxime (stratégie+build, seul à promouvoir en prod) · Freelancer (backend, owner Airtable prod) · Brigitte (non-technique, relation client).
- **Voix de marque** : identité québécoise, **SOLUTION-FIRST** (jamais ouvrir sur le deuil), sobre/digne, palette mauve/papier pâle.

## 2. Garde-fous (NON négociables — voir CLAUDE.md)
1. **Loi 25 / légal = BLOQUANT** : prix, témoignages, allégations de résultats → STOP + signaler. Jamais fabriquer témoignage/avis/prix de référence. `cgv_acceptees_at` = preuve consentement, minimisation des données.
2. **Credentials test/preview seulement** : jamais Stripe live, jamais la base Airtable de prod du freelancer, jamais le flux live sans go humain. Aucun secret committé.
3. **`.ca` par défaut** partout (URLs, canonical, courriels, redirections).
4. **Voix solution-first** (jamais ouvrir sur la perte).
+ **GitHub branche + PR toujours** · **diff avant tout effet de bord, attendre « go »** · tags **[Certain]/[Probable]/[Spéculation]** · **dossier Make « SONG » = NE PAS TOUCHER** (on travaille dans « Chanson Mémoire », folderId 321788) · flag sécurité **énumération clients** (audité — voir §3, seul `generate-lyrics` avait une vraie faille, corrigée).

## 3. CE QUI EST FAIT + MERGÉ dans `main`
**Parcours de base** (déjà solide avant cette série de sessions) :
- survey → paroles (Anthropic via MAKE A) → `revision` → chanson (Suno V5_5 via C-gen) → callback (C-cb) → Cloudinary → `attente-chanson` → **aperçu signé qui joue**.
- **Cloudinary signé** ✅ : URLs SHA-1 serveur, `du_60` dans la signature (preview non contournable, **401** si retiré), `telecharger` gaté `purchased` (403 avant achat). Alerte CodeQL SHA-1 = faux positif assumé.
- **MAKE D — achat** ✅ activé + testé (achat → `purchased` + `funnel_step=purchased` + montant + IDs Stripe + courriel livraison ; anti-forge re-fetch session + anti-double). Lien Stripe = **TEST** ; flip LIVE = juste la clé/lien au launch.
- **Achat par version** ✅ : `creer-checkout.js` (prix fixé serveur 139,97 $, libellé « V{rang} », metadata `generation_no`). `purchased_generation_no` livre la bonne version.
- **Phase A** ✅ : titre généré depuis les DÉTAILS (stable aux régén). **Phase B** ✅ : `page-chanson` refondue (version achetée seule, pas de signature, bouton → `/page-memoire`).
- **Phase C** ✅ MERGÉE : `page-memoire.html` (livraison + **download** chanson `fl_attachment` = seule page de download + **cadeaux** + teasers waitlist). Endpoints `choix-memoire.js`, `phrases-signet.js`.

**Ajouté/durci dans la série de sessions juin (tout MERGÉ sauf mention) :**
- **Order bumps DÉPLACÉS sur la page Stripe** ✅ : `creer-checkout.js` utilise `optional_items` (cliquables sur la page de paiement) **si** `STRIPE_PRICE_SONG` est défini (sinon repli `price_data` sans bumps). ⚠️ `optional_items` exige des **Prix Stripe** (pas de montant custom). Les bumps ne sont **plus** en metadata → le fulfillment lira les **line_items de la session complétée**. (Cases à cocher de l'aperçu = retirées.)
- **Popup confirmation d'achat** ✅ : sur l'aperçu, si >1 version jouable, clic « acheter » → popup « V{n} · Style · Ambiance » à confirmer (`#cm-buy-overlay`). Ancien sélecteur pré-bouton retiré.
- **Popup plafond** ✅ : `aide-plafond.js` (écrit `cap_help_email` + `cap_help_at`, token-gated, PAS de gate `purchased` car le cap est pré-achat) + overlay `#cm-cap-help` sur l'aperçu.
- **Décortique E/F (analyse)** ✅ : `netlify/functions/decortique.js` — Claude catégorise en **5 catégories** (`paroles`/`style_ambiance`/`prononciation`/`souvenirs`/`titre`), produit `adjusted_style_prompt` (règles dures) + `adjusted_lyrics`, écrit la correction pendante sur le Project. **Gaté `purchased`**, UUID strict, `formulaLiteral`. **Le prompt style NE mentionne JAMAIS la voix** (male/female) — la voix vient du choix client (vocalGender Suno).
- **CAPI Meta serveur** ✅ : `suivi-funnel.js` envoie **PreviewPlayed** + **InitiateCheckout** côté serveur (email **sha256**, **token-safe** : jamais le token à Meta, `event_id`=sha256(`recId.evt`), `event_source_url` générique sans `?id=`). Lit `META_CAPI_TOKEN` + `META_DATASET_ID` (dataset = `909919758755200`) en env (no-op si absents). Consentement = inclus dans les CGV (confirmé Maxime).
- **Popups d'échec (principe : tout pépin → client informé + envoi/redirection auto une fois réglé)** ✅ :
  - `attente-chanson.html` : à **8 min** sans audio (24×20s) → **popup digne** (« petit délai, on t'envoie par courriel dès que prêt ») + la page **continue de sonder ~30 min** → redirige automatiquement si la chanson arrive tard (relance sentinelle).
  - `revision.html` (paroles) : timeout **60 s** (au lieu de 2 min) + **fausse promesse de courriel RETIRÉE** (aucun courriel de paroles n'est envoyé ; le courriel-filet existe pour la CHANSON seulement). *(PR `fix/revision-timing-message` — à merger.)*
- **`generate-lyrics.js`** ✅ durci : UUID strict + `formulaLiteral` en modes regenerate/retry (était la seule vraie faille d'injection du flag §10 sécurité).

## 4. EN COURS / branches non mergées
- **PR `fix/revision-timing-message`** — timeout paroles 60 s + retrait fausse promesse courriel. *(poussée, à merger.)*
- Tout le reste de la série juin est mergé.

## 5. PLAN POST-ACHAT (roadmap — détail dans `cm-post-achat-plan.md`)
- **A. Aperçu** ✅ · **B. Page acceptation** ✅ · **C. page-memoire** ✅ MERGÉE.
- **D. Fulfillment cadeaux + bumps** (EN COURS) : cadeau v1 = **paroles (PDF) seulement** sur page-memoire (signets gardés pour plus tard, le temps de créer + tester tous les modèles). Squelette Make **Cadeaux** créé (scénario `4794401`) : à finir (export Canva Autofill → stockage Cloudinary → `pdf_url` → courriel « prêt » → activer). Bumps payés (couche B) : instrumentale (Suno **stem-separation** `/api/v1/vocal-removal/generate`) + paroles vivantes (vidéo) — au clic « accepter », lus depuis les line_items Stripe.
- **E/F. Décortique + cover + approbation** : analyse Claude ✅ (decortique.js). RESTE la boucle : courriel client (**Gmail maintenant, Mailgun plus tard**) avec réf `[token8·V#]` → le client répond → Make lit l'entrant → Claude (déjà branché) → **Suno cover** (`/api/v1/generate/upload-cover`, HTTP + callback, doc docs.sunoapi.org) ou régén si `mode=regeneration` → Airtable « à approuver » → **1 seule approbation** Maxime → publication + courriel « version modifiée prête ».
- **Plafond (versions Suno only)** : pré-achat **4/projet** **OU** **10/client** total · **+10 par achat** · **post-achat illimité**. Logique dans C-gen (route plafond → `WebhookRespond {status:plafond}`). Popup au cap → `aide-plafond.js` + alerte Maxime.
- **G. Upsells** : vidéo perso = waitlist (consentement photos) ; Mémoire vivante = waitlist. Branchés en placeholders sur page-memoire.
- **CAPI Meta** : PreviewPlayed + InitiateCheckout ✅ serveur. RESTE **Lead** (MAKE A) + **Purchase** (MAKE D) — en attente.

## 6. ARCHITECTURE & DONNÉES
- **Make** (org 1059466, team 422966, dossier « Chanson Mémoire » 321788) :
  - **MAKE A — Lyrics** id `4789787` (webhook `…1dyhk11x…`). Appel **Anthropic** pour les paroles. Garde-fou : discriminateur `{{statusCode}}=200` → Create Generation filtré (n'écrit pas une génération cassée) ; 3ᵉ route = courriel **alerte Maxime** si `statusCode ≠ 200`. ⚠️ **MANQUE un retry auto sur l'appel Anthropic** (voir §9 — cause de l'échec transitoire observé le 22/06).
  - **C-gen — generate song** id `4792851`, webhook trigger `…uxpwxw1x…` (= `WEBHOOK_MAKE_B` dans revision.html + `C_GEN_WEBHOOK` dans apercu.html). **⚠️ contient la vraie clé Suno (module 8) → édition MANUELLE.** Contient la logique **plafond** (Search Projects → SetVariables → Search Generations → Data Store → BasicRouter : route « génération » = WebhookRespond ok + Suno HTTP + routeur imbriqué ; route « plafond » module 12 = WebhookRespond `{status:plafond}`).
  - **C-cb — callback Suno** id `4792855`, webhook callback `…amlfm9t…`. Reçoit l'audio Suno → Cloudinary → met `cloudinary_audio_url` + `generation_status=audio_generated`.
  - **MAKE D — Stripe (achat)** id `4793505`, hook `2752092`. **⚠️ vraie clé Stripe restreinte TEST (module 2) → édition MANUELLE.**
  - **Cadeaux** id `4794401` — squelette (à finir, Phase D).
  - **Sentinelle** — **À BÂTIR** (voir §9).
  - Connexions : Airtable OAuth `4766682`, Cloudinary `4732918` (cloud `dcx1tfm47`), Gmail/Google `3661126`, keychain Anthropic `92227`. Data Store « Songs styles » `86715`.
- **Airtable** base `appIADNKzDOVtpjWj` (pré-launch = test, OK d'écrire) :
  - Clients `tblQbF1OlE3uRxFra` · Projects `tblh7O8eoog7RyTMJ` · Generations `tblfrHFe1zH9apNlp` · Upsells `tbl0Z52D8l4555Has`.
  - **Plafond — rollups/lookups** : sur **Clients** `client_songs_preachat` + `client_purchases` ✅ ; sur **Projects** `client_songs_preachat` (lookup) ✅. **⚠️ MANQUE le lookup `client_purchases` sur Projects** (via le lien `Client`) — sans lui, le « +10 par achat » est inactif (allocation figée à 10).
  - Generations clés : `generation_no`, `type` (lyrics/regeneration/song/song_regeneration), `lyrics`, `song_title`, `generation_status` (lyrics_generated/audio_pending/audio_generated/validated), `suno_task_id`, `song_id`, `cloudinary_audio_url`, `gen_music_style`, `gen_mood`, `gen_voice`, `requested_changes`, `created_date`, `project`.
  - `create_field` (MCP) **ne peut PAS** créer rollup/lookup/count (seulement formula + simples) → ces champs se font à la MAIN dans l'UI.
- **Netlify Functions** (`netlify/functions/`) : `lire-projet`, `lire-versions`, `lire-survey`, `generate-lyrics` (create/regenerate/retry), `telecharger` (fl_attachment), `creer-checkout`, `essayer-style`, `accepter-livraison`, `choix-memoire`, `phrases-signet`, `decortique`, `aide-plafond`, `suivi-funnel`. Pages : `index`, `souvenirs`, `revision`, `attente-chanson`, `apercu`, `page-chanson`, `page-memoire`.
- **Env vars Netlify** : `AIRTABLE_BASE_ID`, `AIRTABLE_TOKEN`, `ANTHROPIC_API_KEY`, `CLOUDINARY_CLOUD_NAME`/`_API_KEY`/`_API_SECRET`, `STRIPE_SECRET_KEY` (restreinte TEST), `META_CAPI_TOKEN`, `META_DATASET_ID` (909919758755200). **À AJOUTER** : `STRIPE_PRICE_SONG` + `STRIPE_PRICE_INSTRUMENTAL` + `STRIPE_PRICE_PAROLES_VIVANTES` (Prix Stripe, pour activer les bumps `optional_items`) ; Mailgun + Canva (Phase D/E). `netlify.toml` → `SECRETS_SCAN_OMIT_KEYS = "CLOUDINARY_CLOUD_NAME"`.

## 7. PRÉREQUIS / ACTIONS MAXIME (à compléter — côté Make / Airtable / Stripe)
1. **Airtable** : ajouter le **lookup `client_purchases` sur Projects** (via le lien `Client`). Sans lui, `+10 par achat` ne fonctionne pas.
2. **C-gen — plafond (module 12)** : vérifier que le filtre = **2 groupes** (OR entre eux), **chaque** groupe avec `commercial_status ≠ purchased` **ET** sa condition de cap (`{{2.}}` project `< 4` pour l'un, client `< 10+10×achats` pour l'autre). Opérateur de comptage = **≥/<**, pas `text:equal`. Test comportemental : aperçu 0 version → doit **générer** ; acheté → génère ; preview à 4 → plafond.
3. **C-gen — retry lancement Suno** : error handler **3 essais** sur le module HTTP Suno (échec au lancement).
4. **MAKE A — retry Anthropic** *(NOUVEAU, voir §9)* : error handler avec retries sur l'appel Anthropic des paroles (les échecs transitoires d'API ne doivent pas atteindre le client).
5. **Stripe** : créer 3 **Prix** (chanson 139,97 $, instrumentale 19,99 $, paroles vivantes 13,99 $) + poser les 3 env `STRIPE_PRICE_*` sur Netlify → active les order bumps sur la page de paiement.
6. **Make Cadeaux** (`4794401`) : finir (export Canva → Cloudinary → `pdf_url` → courriel → activer).
7. **Canva** : créer les modèles (paroles ✅ 3 beaux ; **signet** concept retenu = options **#1 et #4**, gardé pour plus tard ; 5 pâles + 3 foncés à finaliser + tester avant d'exposer les signets).
8. **Mailgun** : finir setup + clé (Phase E, boucle décortique).
9. **Validation légale** (un pro) : retrait signature, wording cadeaux/waitlist, consentement photos (vidéo), CGV (consentement CAPI inclus).

## 8. PROCHAINES ÉTAPES (ordre)
1. **Merger** `fix/revision-timing-message`.
2. **SENTINELLE** (§9) — la robustesse manquante : relance auto des chansons bloquées + (avec MAKE A retry + C-gen retry) « tout pépin → réglé tout seul ».
3. **Phase D** : finir Make Cadeaux (paroles PDF) + fulfillment des bumps payés.
4. **Boucle décortique complète** (E/F) : Gmail envoi/lecture + Suno upload-cover + approbation.
5. **CAPI Purchase (MAKE D) + Lead (MAKE A)**.
6. **Signets v2** (Canva) ; **flip Stripe TEST→LIVE** ; validations légales.

## 9. ROBUSTESSE & ÉCHECS — principe + SENTINELLE (à bâtir)
**Principe acté (Maxime) : tout pépin de génération → le client est TOUJOURS informé (popup) + la chanson est envoyée / la page redirige automatiquement une fois le problème réglé.** Deux types d'échec, trois filets :

- **Échec au LANCEMENT** (Suno refuse l'appel) → **retry 3×** dans C-gen (action Maxime §7.3). MAKE A (paroles) → **retry Anthropic** (§7.4).
- **Échec de CALLBACK** (Suno lancé OK, `suno_task_id` posé, mais le callback C-cb n'arrive jamais → Generation reste `audio_pending` sans `cloudinary_audio_url`) → **SENTINELLE**.
- **Côté client** : `attente-chanson` (popup 8 min + sonde 30 min, redirige si recovery) et `revision` (60 s) sont déjà en place.

### Diagnostic du 22/06 (à retenir)
Projet « sdgf » : le **1er appel Anthropic de MAKE A a échoué transitoirement** (pas un `invalid_input` — l'input était valide). MAKE A a alerté Maxime + créé le Project **sans** Generation (et a posé `funnel_step=lyrics_generated`, trompeur). Un retry manuel ~10 min plus tard a réussi (g1). **Leçon** : MAKE A a besoin d'un **retry auto** sur Anthropic (§7.4) ; et la page paroles ne doit pas promettre un courriel (corrigé). *(Note : MAKE A pose `funnel_step=lyrics_generated` même en échec — à durcir un jour : ne le poser que si `statusCode=200`.)*

### SENTINELLE — spécification à bâtir (nouveau scénario Make)
**But** : rattraper les chansons bloquées en `audio_pending` (callback perdu), **sans brûler de version**.

- **Déclencheur** : scheduler **toutes les 30 min**.
- **Module 1 — Search Generations** (Airtable) : `generation_status = "audio_pending"` **ET** `cloudinary_audio_url` vide **ET** `created_date` antérieur à **~12 min** (`DATEADD(NOW(),-12,'minutes')`, pour ne pas attraper les générations fraîches encore normales). *(Optionnel : un compteur `sentinel_retries` pour plafonner à ~3 relances et éviter une boucle infinie sur une chanson définitivement morte → au-delà, route « alerte Maxime ».)*
- **Pour chaque** Generation trouvée :
  - **Re-lancer Suno** : `POST` vers l'endpoint Suno generate **identique à C-gen module 8** (récupérer l'URL + les headers exacts via `scenarios_get 4792851`, ne pas deviner), `Authorization: Bearer <CLÉ SUNO>`, modèle **V5_5**, custom mode, `prompt` = `{{lyrics}}` de la Generation (échappement : `replace(replace(lyrics; '"'; "'"); newline; "\n")`), `style` = prompt style depuis le **Data Store « Songs styles » (86715)** selon `gen_music_style` × `gen_mood`, `title` = `{{song_title}}`, `vocalGender` depuis `{{gen_voice}}`, **`callBackUrl` = le webhook C-cb** (`…amlfm9t…`).
  - **Update la MÊME Generation** (PAS de create) : écrire le nouveau `suno_task_id` (et incrémenter `sentinel_retries` si on l'ajoute). Réutiliser la même ligne = ne pas gonfler `generations_count` / le plafond.
- **Récupération** : le callback repart vers C-cb (existant) → `cloudinary_audio_url` + `audio_generated` → la page `attente-chanson` encore ouverte redirige (sonde 30 min) **et** (à venir) un courriel-filet part.
- **⚠️ Contient la clé Suno** → comme C-gen / Cadeaux : **bâtir le squelette via MCP, Maxime colle la clé + relie les connexions à la main** ; ne jamais `scenarios_update` ce scénario ensuite sans préserver la clé. Réutiliser **verbatim** la structure du module 8 de C-gen (lue via `scenarios_get 4792851`) pour le bloc Suno — c'est la partie fragile (échappement de la chaîne data).

## 10. MÉTHODE DE TRAVAIL
- Plan court → « go » → **diff avant tout commit** → branche + PR (jamais `main` direct) → additif et testé.
- **Make** : `scenarios_get` pour LIRE avant d'éditer. **Ne jamais `scenarios_update` un scénario qui contient une vraie clé** (C-gen=Suno, MAKE D=Stripe, Sentinelle=Suno) — éditer à la main. Pour les filtres BasicRouter : OR = entre groupes, AND = dans un groupe. Pour les scénarios sans clé : `scenarios_update` OK après `validate_blueprint_schema`. Un nouveau scénario à clé = bâtir le **squelette**, Maxime branche la clé.
- **Git** : toujours `git fetch origin` JUSTE AVANT de créer une branche (les squash-merges changent le SHA → `merge-base --is-ancestor` donne des faux négatifs). gh CLI **non installé** + pas de token → ouvrir les PR via URL `compare`.
- **MCP** (Airtable/Make/Canva) peuvent être déconnectés selon la session : nommer le MCP + pourquoi, ne pas supposer l'accès. **Les IDs de serveur MCP changent d'une session à l'autre** — repérer le bon préfixe dans les outils disponibles.
- **Canva** : `generate-design` produit ~1 candidat sur 4 « aplati » (texte/QR cuits dans une image → inutilisable pour l'autofill) → **toujours inspecter** via `start-editing-transaction` (texte éditable + QR image séparée) avant de productionniser. Flux : tag → commit → resize → publish (les tags survivent au resize).
- Tags de confiance. Bug build/déploiement Netlify : **exiger le log**, ne pas inférer. `node` souvent absent localement → pas de lint, valider sur le deploy.

## 11. RÉFÉRENCES
- **Mémoire auto** (se charge seule) : `MEMORY.md` (index) → `cm-production-musicale-build.md` (état build granulaire + gotchas), `cm-post-achat-plan.md` (roadmap), `project-guardrails.md`, `working-protocol.md`, `mcp-test-scoped.md`, `confidence-tags.md`, `user-maxime.md`.
- **Docs repo** : `CLAUDE.md` (garde-fous autoritaires), `CM_spine_spec.md` (parcours), `CM_mapping_airtable.md` (schéma), `CM_make_plan.md` (scénarios Make).
- **Externes** : Suno API `docs.sunoapi.org` (generate / upload-cover / vocal-removal) · Meta CAPI `graph.facebook.com/v21.0` (dataset 909919758755200).
