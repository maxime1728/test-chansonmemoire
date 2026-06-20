# HANDOFF — Chanson Mémoire · production musicale (état au 2026-06-20)

> À lire EN PREMIER par la nouvelle session, avec `CLAUDE.md`, `CM_spine_spec.md`,
> `CM_mapping_airtable.md`, `CM_make_plan.md`. Ce fichier = état réel + tâches restantes.

## 0. Contexte
- Repo : `maxime1728/chansonmemoire` · dossier local de travail : `C:\Users\PC\cm-audit`.
- Produit : chansons hommage IA (Chanson Mémoire), B2C Québec, `.ca`.
- **🎉 LE PARCOURS COMPLET FONCTIONNE** : survey → paroles → revision → confirmation →
  chanson (Suno) → callback → Cloudinary → page d'attente → **aperçu qui joue**.

## 1. Garde-fous (NON négociables — voir CLAUDE.md)
- Loi 25 / légal (prix, témoignages = STOP), credentials test-only, **`.ca` jamais `.com`**, voix solution-first.
- **Branche + PR toujours, jamais commit direct sur `main`. Aucun effet de bord sans diff + « go ».**
- Tags de confiance : [Certain] / [Probable] / [Spéculation].
- **🚫 Dossier Make « SONG » = NE JAMAIS TOUCHER.** On travaille dans le dossier **« Chanson Mémoire »**.
- Airtable base `appIADNKzDOVtpjWj` = base pré-lancement, **traitée comme test** (OK d'écrire, ce n'est PAS la prod du freelancer).

## 2. Connecteurs (MCP) à brancher au démarrage
- **Make** : org `labmarketing.ca` (id 1059466), team « My Team » (id 422966). Le MCP a maintenant les
  outils de **lecture** (`scenarios_get`, `scenarios_list`, `executions_*`, `hooks_*`) → on peut LIRE les scénarios.
- **Airtable** : base `appIADNKzDOVtpjWj` (tables Clients `tblQbF1OlE3uRxFra`, Projects `tblh7O8eoog7RyTMJ`,
  Generations `tblfrHFe1zH9apNlp`, Upsells `tbl0Z52D8l4555Has`).
- Clés Cloudinary / Anthropic / Suno vivent **dans Make** (connexions / header). Connexion Airtable Make = 4766682.

## 3. Architecture actuelle
**Fonctions Netlify** (repo) : `lire-projet.js` (durci UUID+échappement), `lire-survey.js` (pré-remplissage,
champs minimisés), `generate-lyrics.js` (Anthropic, CREATE + regenerate), `accepter-livraison.js`,
`telecharger.js`, `lancer-chanson.js` (proxy — **actuellement contourné**, voir §5).

**Scénarios Make (dossier « Chanson Mémoire ») :**
- **CM - MAKE A - Lyrics** : webhook survey → upsert Client → create Project → HTTP generate-lyrics → create Generation.
- **CM - MAKE C- generate song** (C-gen, id **4792851**, webhook `uxpwxw1xqjm3x7mt35qjvdm2t8y9fvv4`).
- **CM - MAKE C-cb** (callback, id **4792855**, webhook `amlfm9tapjjewz2kec1eirs8oylb812g`).
Data Stores : **Songs styles** (86715, clé style×ambiance→`Prompt Complet`), **Suno Task ID** (84453).

**Flux :** souvenirs → MAKE A (paroles) → `/revision?id=TOKEN` → « Ces paroles sont parfaites » →
webhook C-gen → Suno generate → callback → C-cb (garde piste [0], upload Cloudinary) → Generation
`audio_generated` → `/attente` poll → `/apercu?id=TOKEN` joue (preview 60s `du_60`).

## 4. GOTCHAS critiques (lus à la dure)
- **Single-select Airtable = correspondance EXACTE** (casse/accents/ponctuation) sinon erreur **422**.
  Audit survey↔option Airtable↔clé Data Store **encore à faire** (corrigé : music_style, relationship, type).
- **Callback Suno = par-requête ; l'audio est DANS le callback** : `{{1.data.data[1].source_audio_url}}`
  (et `.id`, `.title`). Utiliser **`secure_url`** (https) au upload Cloudinary, pas `url` (http) → sinon « non sécurisé ».
- **Éditer un scénario Make via MCP réécrit tout** (efface la clé Suno saisie en UI). Maintenant on peut
  `scenarios_get` d'abord et préserver. La clé Suno vit dans le header de C-gen (placeholder `Bearer VOTRE_CLE_SUNO`).
- **`generation_no`** doit être `max+1` ; MAKE A le met **« 1 » en dur** (bug, voir §5).
- `lire-projet` renvoie la **dernière Generation par `generation_no`**.
- Rebuilds importables (placeholders, sans secret) : `CM-C-gen-REBUILD.blueprint.json`,
  `CM-C-cb-REBUILD.blueprint.json` (locaux ; les exports bruts contiennent la vraie clé → **gitignorés**, ne pas committer).

## 5. TÂCHES RESTANTES — plan validé (ordre sûr → lourd)
**Phase 1 — Sécurité http→https** : C-cb stocke `secure_url` (pas `url`) ; `apercu`/`telecharger`/`page-chanson`
forcent `http:`→`https:`. (Règle le cadenas barré.)
**Phase 2 — 2 suggestions fixes** (« Allonger » / « Raccourcir » les paroles, cliquables, côté `revision.html`)
+ **`type` représentatif** (C-gen calcule lui-même : cover / song_regeneration si une chanson existe déjà / song).
**Phase 4 — Rebuild MAKE A** (le gros morceau, diagnostic confirmé) :
  - 🔴 Obs 7 (anciennes paroles) : MAKE A crée **toujours** un nouveau Project même en régén (même token) →
    **doublons de projets** → `lire-projet` tombe sur le mauvais. **Fix** : brancher sur `regeneration` →
    si token existe, retrouver le Project + créer Generation `gen_no=max+1`, **sans** recréer de Project.
  - 🔴 Obs 4 (last_activity) : l'Upsert Client n'a **ni email ni champ de fusion** → dédup cassée.
    **Fix** : ajouter `email` + `fieldsToMergeOn=email`, garder `last_activity=now`, ne pas écraser `consent_date`.
  - Obs 8 (CAPI) : ajouter événement **Facebook CAPI « Form Submitted »** uniquement sur **nouveau** projet (pas régén).
**Phase 3 — Funnel exact** (`funnel_step` à chaque étape) — après l'audit single-select + création des options.
**Phase 5 — Cloudinary signé** (vraie faille preview→complète : upload privé/authenticated, preview 60s signé,
  complète signée post-paiement via `telecharger.js`).
**Phase 6 — Choix de version à l'achat** (garder toutes les versions, `lire-projet` renvoie la liste, sélecteur
  sur apercu, l'achat enregistre la version choisie). ⚠️ touche la chaîne argent → incrémental.

**Obs 5 corrigée d'avance** : les suggestions sont déjà stockées par MAKE A ; il reste juste les 2 fixes (Phase 2).

## 6. Branches / PR
- `main` contient le travail fusionné (parcours fonctionnel).
- À fusionner si pas déjà fait : **`fix/survey-labels`** (libellés survey + audio apercu par token),
  **`fix/revert-proxy-direct`** (retour aux appels webhook directs ; le proxy `lancer-chanson` est en attente
  de Phase « sécurité » avec les env vars `MAKE_C_GEN_WEBHOOK_URL` + `MAKE_WEBHOOK_SECRET`).

## 7. Méthode de travail attendue
Plan court d'abord → attendre « go » → diff avant commit/import → additif et testé (ne jamais casser ce qui marche)
→ tags de confiance. Pour Make : `scenarios_get` pour lire l'état réel AVANT d'éditer ; livrer les rebuilds en
fichier `*.blueprint.json` à importer (placeholders pour clé/secret, jamais de credential dans le repo).
