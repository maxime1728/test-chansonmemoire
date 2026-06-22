# HANDOFF — Chanson Mémoire · production musicale (état au 2026-06-21)

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

OÙ ON EN EST (voir HANDOFF.md §3-4) : le parcours complet fonctionne, achat (MAKE D) testé,
order bumps au checkout faits. Phases A+B (titre + page acceptation refondue) MERGÉES.
Phase C (page-memoire : livraison + cadeaux + teasers) BÂTIE, branche `feat/page-memoire`
à merger. Prochain bloqueur = Phase D (fulfillment Canva des cadeaux).

PROTOCOLE (strict) : branche + PR, jamais de commit direct sur main. Aucun effet de bord sans
me montrer un diff et attendre mon « go ». Tags [Certain]/[Probable]/[Spéculation]. Pour Make :
scenarios_get pour LIRE avant d'éditer ; ne jamais scenarios_update un scénario qui contient une
vraie clé (C-gen=Suno, MAKE D=Stripe) → édition manuelle. Dossier Make « SONG » = NE PAS TOUCHER.
Les MCP (Airtable/Make) peuvent être déconnectés : ne suppose pas l'accès, nomme le MCP + pourquoi.
Bug build/déploiement Netlify : exige le log, n'infère pas.

Commence par : confirmer les garde-fous, puis propose un PLAN COURT pour la prochaine étape
prioritaire (merger Phase C, puis Phase D) et attends mon go.
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
+ **GitHub branche + PR toujours** · **diff avant tout effet de bord, attendre « go »** · tags **[Certain]/[Probable]/[Spéculation]** · **dossier Make « SONG » = NE PAS TOUCHER** (on travaille dans « Chanson Mémoire », folderId 321788) · flag sécurité **énumération clients** (audit avant launch).

## 3. CE QUI EST FAIT + MERGÉ dans `main`
- **Parcours complet** : survey → paroles (Anthropic) → revision → chanson (Suno V5_5) → callback → Cloudinary → attente → **aperçu signé qui joue**.
- **Phase 5 — Cloudinary signé** ✅ : URLs signées SHA-1 côté serveur, `du_60` dans la signature (preview non contournable, **401** si on le retire), `telecharger` gaté `purchased` (403 avant achat). Alerte CodeQL SHA-1 = faux positif (« Won't fix »).
- **MAKE D — chaîne argent** ✅ ACTIVÉ + TESTÉ (achat 1$ → `purchased` + `funnel_step=purchased` + amount + stripe IDs + courriel livraison ; anti-forge re-fetch session + anti-double). Lien Stripe = **TEST** (`buy.stripe.com/test_…`) ; flip LIVE = juste la clé/lien au launch.
- **Achat par version (Phase 3)** ✅ : session Checkout **serveur** `creer-checkout.js` (prix fixé serveur, libellé « Chanson Mémoire — V{rang} », metadata `generation_no`/bumps) ; `purchased_generation_no` (livre la version achetée). TEST/LIVE piloté par `STRIPE_SECRET_KEY` (env).
- **Order bumps au checkout** ✅ : 2 cases indépendantes — **Version instrumentale 19,99 $** + **Paroles vivantes 13,99 $** (vidéo des paroles) ; metadata Stripe. Fulfillment = à venir (couche B).
- **Sélecteur de versions** sur l'aperçu (lire-versions) + **régénération** « Essayer un autre style » (popup style/voix/ambiance + souvenirs) + « Créer pour quelqu'un d'autre ».
- **Phase A** ✅ : **titre généré depuis les DÉTAILS** (pas les paroles), stable aux régén ; affiché dans le lecteur de l'aperçu.
- **Phase B** ✅ : **page acceptation `page-chanson` refondue** — version achetée seulement (titre+style+ambiance), lecteur de l'aperçu plein format + message de chargement, **PAS de download ici**, **PAS de signature**, bouton « Accepter cette version et télécharger » → popup → redirige `/page-memoire`. `accepter-livraison` sans signature ni sélection de version ; `lire-projet` expose `style`+`ambiance`.

## 4. EN COURS — branche NON mergée
- **`feat/page-memoire` (Phase C)** — **À MERGER.** Nouvelle `page-memoire.html` (livraison finale) : lecteur aperçu + **download** chanson (`fl_attachment`, seule page de download) + **cadeaux** (choix de 5 modèles PDF + 5 signets = placeholders « Modèle 1-5 » ; phrases suggérées via `phrases-signet.js` Claude ; message libre ; bouton « Préparer mes cadeaux » → `choix-memoire.js`) + **teaser Mémoire vivante** (waitlist) + **upsell vidéo** (waitlist). Endpoints `choix-memoire.js` + `phrases-signet.js`. +5 champs Projects (`pdf_template`, `signet_template`, `signet_text`, `waitlist_memoire`, `waitlist_video`).

## 5. PLAN POST-ACHAT VALIDÉ (roadmap — détail dans `cm-post-achat-plan.md`)
- **A. Aperçu** ✅ : titre depuis détails, stable ; fonctions régén inchangées ; titre modifiable seulement post-achat via le box.
- **B. Page acceptation** ✅ : version achetée seulement, pas de signature (bouton + popup → /page-memoire), fulfillment **bumps payés** au clic accepter (à brancher en D).
- **C. page-memoire** (BÂTIE, à merger) : livraison + download + cadeaux (templates Canva) + teasers.
- **D. Fulfillment cadeaux** (PROCHAIN) : génération **Canva** (5 PDF + 5 signets) du PDF paroles + signet → stockage → affiché téléchargeable + courriel « prêt » (24-48 h). Bumps payés : instrumentale (Suno stem-separation) + paroles vivantes (API que Maxime choisira) — au clic accepter (~24 h, réel ~1 h).
- **E/F. Décortique + cover + approbation** : UN grand box → **Claude (API, 5 catégories** : paroles / style+ambiance / prononciation / souvenirs / titre**) + adapte le PROMPT STYLE** (règles dures : JAMAIS de noms d'artistes, TOUJOURS « Quebec French accent, Canadian French », rien qui contredise) → courriel client **Mailgun** (réf `[token8·V#]`) → **le client répond par courriel** → Make lit l'entrant → Claude génère paroles + prompt → **DIRECT Suno** (cover `upload-cover` par défaut, ou régén si `mode_correction`) → Airtable « à approuver » → **1 SEULE approbation Maxime** (édite + relance au besoin ; Brigitte idem) → publication site + courriel « version modifiée prête ». Champs Airtable à créer : `mode_correction`, `requested_changes`, `adjusted_lyrics`, `adjusted_style_prompt`, `approval_status`, `ref_id`.
- **Plafond (versions SUNO only)** : pré-achat **4/projet** · global client pré-achat **10** (+10 par achat, bloqué au-delà) · **post-achat illimité**. **Popup au cap projet (4)** : « limite atteinte pour cette personne » + box courriel « on veut t'aider à créer ta version de rêve » + alerte Maxime. (À implémenter dans C-gen + rollups Client.)
- **G. Upsells** : vidéo perso = **waitlist** d'abord (consentement photos explicite + géré AI), workflow vite après. Mémoire vivante = **waitlist** + features.
- **CAPI Meta (serveur seul)** : Lead (MAKE A) + preview_played + « purchased link clicked » (InitiateCheckout) + Purchase (MAKE D), avec fbc/fbp + email haché. ⚠️ Loi 25 (transfert Meta) + token-safe (ne jamais envoyer le token). Pas encore branché.

## 6. ARCHITECTURE & DONNÉES
- **Make** (org 1059466, team 422966, dossier « Chanson Mémoire » 321788) :
  - **MAKE A — Lyrics** id `4789787` (webhook `…1dyhk11x…`).
  - **C-gen — generate song** id `4792851`, webhook trigger `…uxpwxw1x…`. **⚠️ contient la vraie clé Suno (module 8) → édition MANUELLE, jamais scenarios_update sans préserver la clé.** Module 10 écrit `gen_music_style`/`gen_mood`/`gen_voice` par version.
  - **C-cb — callback Suno** id `4792855`, webhook callback `…amlfm9t…`.
  - **MAKE D — Stripe (achat)** id `4793505`, hook `2752092`. **⚠️ contient la vraie clé Stripe restreinte TEST (module 2) → édition MANUELLE.**
  - Connexions : Airtable OAuth `4766682` (scopes `schema.bases:read` + `data.records:read/write`), Cloudinary `4732918` (cloud `dcx1tfm47`), Gmail/Google `3661126`, keychain Anthropic `92227`. Data Store « Songs styles » `86715`.
- **Airtable** base `appIADNKzDOVtpjWj` (pré-launch = test, OK d'écrire) : Clients `tblQbF1OlE3uRxFra`, Projects `tblh7O8eoog7RyTMJ`, Generations `tblfrHFe1zH9apNlp`, Upsells `tbl0Z52D8l4555Has`. Schéma autoritaire = `CM_mapping_airtable.md` + champs ajoutés en session (voir mémoire build).
- **Netlify Functions** (`netlify/functions/`) : `lire-projet`, `lire-versions`, `lire-survey`, `generate-lyrics` (create/regenerate/retry), `telecharger` (fl_attachment), `creer-checkout`, `essayer-style`, `accepter-livraison`, `choix-memoire`, `phrases-signet`. Pages : `index`, `souvenirs`, `revision`, `attente-chanson`, `apercu`, `page-chanson`, `page-memoire`.
- **Env vars Netlify** : `AIRTABLE_BASE_ID`, `AIRTABLE_TOKEN`, `ANTHROPIC_API_KEY`, `CLOUDINARY_CLOUD_NAME`/`_API_KEY`/`_API_SECRET`, `STRIPE_SECRET_KEY` (restreinte TEST). `netlify.toml` → `SECRETS_SCAN_OMIT_KEYS = "CLOUDINARY_CLOUD_NAME"`. **À AJOUTER (Phase D/E)** : Mailgun + Canva.

## 7. PRÉREQUIS MAXIME (à compléter pour la suite)
- **Canva** (Phase C/D) : finir setup Autofill API + **designer les 5 PDF + 5 signets**.
- **Mailgun** (Phase E) : finir setup + clé API (compte + domaine déjà vérifiés).
- **Validation légale** (un pro) : retrait de la signature (preuve plus faible, LPC/droit de résolution), wording cadeaux/waitlist, consentement photos (vidéo).
- **Vraie chaîne cover Suno** (`/api/v1/generate/upload-cover`) : pas encore branchée.

## 8. PROCHAINES ÉTAPES (ordre)
1. **Merger `feat/page-memoire`** (Phase C).
2. **Phase D** : fulfillment Canva des cadeaux + fulfillment des bumps payés.
3. **Phase E/F** : décortique + cover + approbation (Claude + Mailgun + Make).
4. **Plafond 4/10** (C-gen + rollups Client) + popup au cap.
5. **G** : upsells (waitlists branchées) + CAPI Meta serveur.

## 9. MÉTHODE DE TRAVAIL
- Plan court → « go » → **diff avant tout commit** → branche + PR (jamais `main` direct) → additif et testé.
- **Make** : `scenarios_get` pour LIRE avant d'éditer. **Ne jamais `scenarios_update` un scénario qui contient une vraie clé** (C-gen=Suno, MAKE D=Stripe) — éditer à la main (l'éditeur est sûr, scope `schema.bases:read` présent). Pour les scénarios sans clé : `scenarios_update` OK après `validate_blueprint_schema`.
- **Git** : toujours `git fetch origin` JUSTE AVANT de créer une branche / tester l'ancestry (les squash-merges changent le SHA → `merge-base --is-ancestor` donne des faux négatifs).
- **MCP** (Airtable/Make) peuvent être déconnectés selon la session : nommer le MCP + pourquoi, ne pas supposer l'accès.
- Tags de confiance. Bug build/déploiement Netlify : **exiger le log**, ne pas inférer. `node` souvent absent localement → pas de lint, valider sur le deploy.

## 10. RÉFÉRENCES
- **Mémoire auto** (se charge seule) : `MEMORY.md` (index) → `cm-production-musicale-build.md` (état build granulaire + gotchas), `cm-post-achat-plan.md` (roadmap post-achat validée), `project-guardrails.md`, `working-protocol.md`, `mcp-test-scoped.md`, `confidence-tags.md`, `user-maxime.md`.
- **Docs repo** : `CLAUDE.md` (garde-fous autoritaires), `CM_spine_spec.md` (parcours), `CM_mapping_airtable.md` (schéma), `CM_make_plan.md` (scénarios Make).
