# Lot 4 — Cockpit corrections : plan de build

> Branche `feat/lot4-cockpit` (depuis `origin/main` #239, 5e8c9bb).
> Spec source : maquette validée par Maxime le 2026-06-30 (#18 avant/après, #19 revoir avant d'envoyer).
> Ce document = plan détaillé À VALIDER avant de coder le backend sensible (pipeline cover en direct).

---

## 0. État vérifié (2026-06-30)

- Aucun WIP Lot 4 préexistant (branches, worktrees, stash : rien). Le « entamé » = spec + maquette.
- **Spike interface Airtable via API : négatif (attendu).**
  - `create_field` (MCP) n'expose PAS le type `lookup`/`rollup` (seulement texte, select, formule, lien, nombre, date…). Donc les 3 champs avant/après (des lookups) **ne sont pas créables par l'API**.
  - `create_page` ne monte que des pages `visualization`/`dashboard`. La page cockpit « Boîte de support → Conversations » (`pagrb4C4GZstijBBy`) est de type **`list`** ; **aucun outil n'édite le layout d'un record détail**.
  - => l'avant/après est un **montage manuel** dans le concepteur d'interface (recette en §3). C'est la branche « à la main » que la spec anticipait.
- **Le modèle Generation-level est déjà à moitié en place** : `version_status` (proposée → en_production → prête → publiée → remplacée) existe (`fldOCozXx5HV4LScf`) et `_lib/cover.livrerCover` pose déjà `publiée` à la livraison + `remplacée` sur l'ancienne. Il manque le DÉBUT du cycle (la proposition = une Gen `proposée`).

---

## 1. Architecture actuelle (slots model)

### Où vit la « proposition » aujourd'hui
- **Source de vérité unique = la Conversation** : `paroles_corrigees` + `prompt_style` (éditables par l'équipe), `generation_a_travailler` (version source).
- Le **Projet** ne reçoit `adjusted_lyrics` / `adjusted_style_prompt` qu'au moment d'**appliquer** (transitoire, consommé par lancer-cover, puis périmé).

### Flux post-achat (équipe, cockpit)
1. `decortique.js` enregistre la demande brute + crée la ligne Conversations.
2. `decortique-background.js` (15 min) : `analyserModif` (Claude) → écrit `correction_request` + `mode_correction` sur le **Projet**, et `paroles_corrigees` + `prompt_style` + `brouillon_ia` + `generation_a_travailler` sur la **Conversation**. NE duplique plus `adjusted_lyrics` (commentaire L92-95). `approval_status='pending'`.
3. Équipe relit/édite dans le cockpit, choisit le menu `action_modif` (`fldwNjOjZIt3DC63i`).
4. `appliquer-cron` détecte `action_modif` → POST `appliquer-modification`.
5. `appliquer-modification.js` : lit la Conversation, déduit `refaire` (Régénérer / Refaire le cover) depuis `action_modif` ou `mode_correction`, **PATCH Projet** : `adjusted_lyrics`, `adjusted_style_prompt`, `refaire`, `cover_source_no`. Pose `action_modif='Appliquée ✓'`.
6. `cover-cron.js` (chaque minute) lit `refaire` (ou `approval_status='approved'` + `cover_launched_at` vide) → `approval_status='approved'`, vide les champs cover, POST `lancer-cover` (`regenerate` selon `refaire`).
7. `lancer-cover.js` : trouve la Gen source (override `cover_source_no` > achetée > dernière), `prompt = Projet.adjusted_lyrics || gen.lyrics_phonetique || gen.lyrics`, `style = Projet.adjusted_style_prompt || styleFor(...)`. Lance Suno (`/upload-cover` ou `/generate`). **Crée la Gen cover en `audio_pending` + `version_status='en_production'`** (L150-175), en copiant `adjusted_lyrics` dans `lyrics`.
8. `callback-cover.js` → `_lib/cover.livrerCover` : ré-héberge l'audio, Gen → `audio_generated` + `version_status='publiée'`, **bascule `purchased_generation_no`** (post-achat), ancienne version → `remplacée`, **envoie le courriel « nouvelle version prête » (AUTO)**.

### Flux pré-achat / self-serve (client, /revision)
- `demander-modif-client.js` : `analyserModif` → route `prononciation` / `regen` / `cover`. Route cover : **PATCH Projet** `adjusted_lyrics` + `mode_correction='cover'` + `approval_status='pending'`, crée la ligne Conversations (`paroles_corrigees`). Action `lancer` (client accepte) : `approval_status='approved'` + `refaire='Refaire le cover'`. Pas de revue équipe (le client a déjà accepté).

### Slots Projet « correction » à terme à retirer
`adjusted_lyrics`, `adjusted_style_prompt`, `approval_status`, `refaire`, `cover_source_no`, `cover_task_id`, `cover_launched_at`, `pending_cover_style`. (`mode_correction` peut rester : c'est de la métadonnée d'analyse, pas un slot de proposition.)

### Garde-fous actuels qui dépendent du slot unique
- `coverEnVol` / `coverGenEnAttente` (`_lib/cover.js`) : « une seule cover `audio_pending` par projet ». Anti-collision basé sur l'unicité du slot Projet. À repenser avec des Gens `proposée`.

---

## 2. Cible : Generation-level complet

**Principe** : une proposition de correction n'est plus un slot Projet, c'est une **Generation `version_status='proposée'`** (paroles + style proposés, liée à la version source et à la Conversation). Le cycle de vie d'UNE version :

```
proposée  ──(équipe applique)──▶  en_production (audio_pending, Suno en vol)
   ▲                                      │
 (decortique/                       (callback-cover)
  appliquer crée)                          ▼
                              prête  ──(équipe a revu + envoie)──▶  publiée  ──▶  (l'ancienne) remplacée
```

- **proposée** : créée par `decortique-background` (post-achat) ou `demander-modif-client` (self-serve). `lyrics` = paroles proposées, `gen_style_prompt` = style proposé, `type` = cover|regeneration, lien source + lien Conversation.
- **en_production** : `lancer-cover` PROMEUT la `proposée` existante (au lieu d'en créer une nouvelle). Plus de lecture de `Projet.adjusted_lyrics` : on lit la Gen `proposée`.
- **prête** (NOUVEAU palier, pour #19) : audio livré mais PAS encore annoncé au client. Post-achat équipe uniquement.
- **publiée** : après revue + envoi équipe → bascule `purchased_generation_no` + courriel client.

Le cockpit #18/#19 référence directement la Gen liée : `lyrics`/`gen_style_prompt`/`gen_voice` = le « proposé », `version_status` = l'état, et l'avant/après compare à `generation_a_travailler`.

---

## 3. Bloc A — #18 avant/après (NON destructif, montage manuel)

L'API ne peut pas le faire (cf §0). **DÉCIDÉ (2026-06-30)** : Maxime crée les 3 lookups + le layout à la main (recette ci-dessous, ~5 min). Le champ `type_correction` (A3), lui, est créé et alimenté par code (FAIT : `fldg1TDQ7grDQQVZw`).

### A1. Créer 3 champs lookup sur la table Conversations (`tbl3KBgXthCPromxF`), via le lien `generation_a_travailler` :
| Champ à créer | Lookup de (table Generations) | Champ source |
|---|---|---|
| `paroles_actuelles` | `generation_a_travailler` → | `lyrics` (`fld9q1iqsYSx6iGaI`) |
| `voix` | `generation_a_travailler` → | `gen_voice` (`fld8gcBdP0smafuKR`) |
| `prompt_style_actuel` | `generation_a_travailler` → | `gen_style_prompt` (`fldgAJw6ssqj95vHT`) |

(Alternative : dans le record détail de l'interface, ajouter directement les champs du record lié `generation_a_travailler` sans créer de lookups. Les lookups restent plus propres et filtrables : choix recommandé.)

### A2. Layout avant/après dans la page « Boîte de support → Conversations » (`pagrb4C4GZstijBBy`), record détail :
- Colonne **ACTUEL** : `paroles_actuelles` | `prompt_style_actuel` | `voix`.
- Colonne **PROPOSÉ** : `paroles_corrigees` | `prompt_style`.
- Mettre la **voix** bien visible (demande explicite #18).
- Le prompt de style en avant/après comme les paroles (surtout quand le style change).

### A3. Indicateur « type de correction » (lecture seule)
`mode_correction` vit sur le **Projet** ('cover' / 'regeneration'). Deux options :
- **(reco) champ `type_correction` (singleSelect) sur la Conversation**, posé par le code (decortique-background / demander-modif-client) en même temps que `paroles_corrigees`. Valeurs : `paroles seules`, `cover (mélodie gardée)`, `nouvelle chanson (régé)`. Créable par API (singleSelect OK) + 2 lignes de code. Règle : `regeneration` → « nouvelle chanson » ; `cover` + style inchangé → « paroles seules » ; `cover` + style changé → « cover ».
- (alt) lookup `mode_correction` sur la Conversation (manuel) + formule d'affichage.

=> **Bloc A buildable côté code** = le champ `type_correction` (API singleSelect) + son écriture. Le reste (lookups + layout) = manuel/handoff.

---

## 4. Bloc C — state-move backend (SENSIBLE, pipeline cover en direct)

Refactor fonction par fonction. **Stratégie : compatibilité ascendante + bascule par flag** (comme `SURVEY_DIRECT`), pipeline jamais cassé.

### C1. Création de la Gen `proposée`
- **decortique-background.js** (post-achat) : après l'analyse, créer/mettre à jour une Gen `proposée` (lyrics=adjLyrics, gen_style_prompt=adjStyle, type=mode, source=genRec, Conversations=[convoId]). Lier la Conversation à cette Gen (nouveau champ lien `generation_proposee` OU réutiliser un champ).
- **demander-modif-client.js** (self-serve) : idem en route cover (remplace le PATCH `Projet.adjusted_lyrics`).
- Édition équipe : quand l'équipe édite `paroles_corrigees`/`prompt_style` dans le cockpit, il faut répercuter sur la Gen `proposée` au moment d'appliquer (lecture Conversation = source d'édition, la Gen `proposée` est (re)synchronisée à l'apply). => garder `paroles_corrigees`/`prompt_style` comme champ d'édition cockpit, et `appliquer-modification` écrit ces valeurs dans la Gen `proposée`.

### C2. Consommation par lancer-cover.js
- Trouver la Gen `proposée` du projet (au lieu de lire `Projet.adjusted_lyrics`).
- `prompt = proposee.lyrics`, `style = proposee.gen_style_prompt` (repli inchangé si absent).
- Source mélodie : `generation_a_travailler` de la proposée (porter le lien/numero source sur la Gen `proposée`).
- **Au lancement : PROMOUVOIR la Gen `proposée` → en_production (audio_pending, suno_task_id)** au lieu de créer une nouvelle Gen (L150-175 actuelles : remplacer « create » par « update la proposée »).

### C3. Déclencheur (cover-cron / appliquer)
- Aujourd'hui : `refaire` + `approval_status='approved'`. Demain : « le projet a une Gen `proposée` approuvée ». Option simple et sûre : garder `appliquer-modification` comme point d'approbation (il fait passer proposée → prête-à-lancer en posant un marqueur), et `cover-cron` cible les Gens `proposée` marquées approuvées. Détail à figer à l'implémentation.

### C4. Livraison (_lib/cover.livrerCover) + #19
- Voir Bloc B (le palier `prête` se code ici).

### C5. Retrait des slots Projet
- En DERNIER, une fois C1-C4 stables et vérifiés en prod : retirer `adjusted_lyrics`, `adjusted_style_prompt`, `approval_status`, `refaire`, `cover_source_no`, `pending_cover_style` du code, puis (optionnel) masquer/supprimer les champs Airtable. `coverEnVol`/`coverGenEnAttente` re-câblés sur les Gens.

### Surface complète touchée (grep `adjusted_lyrics|approval_status|adjusted_style_prompt`)
`sentinelle-cron.js`, `prononciation.js`, `lancer-chanson.js`, `lancer-cover.js`, `decortique-background.js`, `decortique.js`, `demander-modif-client.js`, `cover-cron.js`, `callback-cover.js`, `appliquer-modification.js`, `brouillon-cron.js`, `_lib/cover.js`, `_lib/analyse-modif.js`. Chacun à auditer (13 fichiers).

---

## 5. Bloc B — #19 revoir avant d'envoyer

### B1. Palier `prête` (décorrélation livraison ↔ annonce)
Aujourd'hui `livrerCover` (post-achat) fait TOUT d'un coup : `publiée` + bascule `purchased_generation_no` + **courriel auto**. Pour #19, scinder :
- Cover livré (post-achat équipe) → `version_status='prête'`, audio prêt, **PAS de courriel auto**, pas encore promu version active.
- Équipe écoute + relit dans le cockpit (bloc « version régénérée à revoir »).
- Équipe envoie (`envoi_reponse`) → `publiée` + bascule `purchased_generation_no` + courriel « nouvelle version prête ».

**Conditionnel** : seul le post-achat équipe passe par `prête`. Le self-serve pré-achat (client a déjà accepté sur /revision) et les autres chemins restent directs (`publiée` + courriel). À garder pour ne rien casser.

### B2. Cockpit #19 (montage interface, manuel)
- Bloc « version régénérée à revoir » : lecteur audio de la Gen `prête` (`cloudinary_audio_url`) + ses `lyrics`, + `version_status`.
- Nécessite un lien Conversation → Gen régénérée (le `generation_proposee` de C1 sert, une fois promue).

### B3. Garde-fou « version oubliée » — DÉCIDÉ (2026-06-30) : auto-envoi
Si une Gen reste `version_status='prête'` > ~24h, `watchdog-cron` **envoie au client + passe en `publiée`** (le client n'est jamais privé de sa version payée). Alerte équipe en parallèle. Délai exact à confirmer à l'implémentation (défaut 24h).

---

## 6. Risques & garde-fous

- **Pipeline cover EN DIRECT** : toute régression casse la livraison des corrections payées. => flag de bascule, compat ascendante, tests.
- **Idempotence / multi-tours** : `coverEnVol`, retry sentinelle, callback rejoué. La promotion proposée→en_production doit être idempotente.
- **Pré-achat vs post-achat** : ne PAS imposer le palier `prête` au self-serve.
- **Tests** : `tests/cover-promotion.test.js` existe (helper `versionPlusRecenteAPublier`). Étendre pour la promotion proposée→en_production et le palier `prête`.
- **Réconciliation** `sentinelle-cron` (anti-version-fantôme) : vérifier sa cohérence avec le nouveau cycle.

---

## 7. Séquencement proposé

1. **Bloc A** (sûr, visible) : champ `type_correction` (API) + recette lookups/layout (handoff ou navigateur). [EN COURS]
2. **Plan validé par Maxime** (ce document) + décision #19 (B3).
3. **Bloc C** par étapes flag-gées, pipeline jamais cassé :
   - C1 créer la Gen `proposée` (sans encore la consommer) — observable, non destructif.
   - C2 lancer-cover consomme la `proposée` derrière un flag.
   - C3 déclencheur.
   - C4/B1 palier `prête` + envoi équipe.
   - C5 retrait des slots (dernier).
4. **Bloc B** interface #19 (manuel) une fois C stable.
5. Vérif prod sur un projet test à chaque palier.
