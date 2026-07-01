# Plan d'intégration — Refonte du Cockpit (design Claude)

_Rédigé 2026-07-01. Source design : `docs/cockpit-refonte/cockpit-prototype.html` (export « Bundled Page » de Claude Design ; se dessine au runtime, rendu vérifié en offline)._

## 0. Décisions lockées (Q&A avec Maxime, 2026-07-01)

- **Stack** : vanilla, 1 fichier (`cockpit.html`) + `cockpit-data.js`. Pas de framework, pas de build.
- **Bascule** : remplacement direct de `cockpit.html`. Mécanique sûre retenue : tout se construit sur **une branche `ui/cockpit-refonte`**, vérifié en Deploy Preview par jalons ; **un seul merge final = le swap** (la prod garde l'ancien cockpit jusque-là).
- **Nouveaux éléments retenus (tous en v1)** : recherche globale, compteurs/tableau de bord, historique par projet/client, lexique global dédié, **simplicité d'usage = fil conducteur**, + versions A/B, vraie fusion des courriels, changement de voix, ton du courriel, lien perso.
- **Commande + échéance** : dérivés de l'existant (pas de nouveau système SLA).
- **Sécurité** : on garde le mot de passe `COCKPIT_SECRET`.

## 1. Ce que contient le design (rendu + extrait, `[Certain]`)

- **Barre du haut** : marque ✦ « Chanson Mémoire · Cockpit de révisions », **recherche globale** (client/commande), **compteurs** (✉ courriels, ◷ en attente, ✓ fait, ♪ chansons, ⚙ réglages), avatar.
- **Liste « À traiter »** (tri Échéance) : cartes = client, échéance (31 h / 2 j / hier), titre «…», extrait de la demande, **badge type** (MODIFICATION / SUPPORT), **no commande** (CM-2041), compteur courriels (✉ 3).
- **Détail** :
  - En-tête : type · no commande · 🎙️ voix · titre + **✎ Renommer** · client/courriel · ⏳ échéance.
  - **FIL CLIENT · N COURRIELS FUSIONNÉS** (repliable) : les courriels datés d'un même client/projet regroupés.
  - **Paroles** avant/après (compteur « X retraits · Y ajouts ») + boutons **↻ Regénérer** / **Accepter**.
  - **Prononciation · corrections Suno** : dictionnaire, colonnes **Mot d'origine / Graphie envoyée à Suno / Source** (Dictionnaire | Manuel) + Override / Revert-dict / Supprimer + note « ces graphies ne changent que le son, l'affiché client reste clair ».
  - **Prompt de création** : Chanson actuelle vs ✦ Suggéré (prochaine chanson).
  - **STUDIO IA** : Voix (Actuelle 🔒 vs Nouvelle : Masculin/Féminin) · Regénérer les paroles / Créer un cover · **Versions à comparer** (Version actuelle + lecteur, « Générer version A », « Générer une 2ᵉ version » optionnelle).
  - **Courriel client** : ✦ rédigé par l'IA, **ton** (Chaleureux / Factuel), À/Objet, **lien perso inséré auto**, corps éditable, **Envoyer** / **Enregistrer le brouillon**.

## 2. Charte / tokens (extraits du rendu)

- Polices : **Instrument Sans** (UI, dominante) + **Newsreader** (éditorial : titres, paroles). → à **auto-héberger** dans `/fonts` (pas de CDN Google, cohérent perf/SEO).
- Canvas `#F0ECEF` (mauve-gris), encre `#2B2430`, mauves `#9587A3` / `#8567A6`, rose `#B25A72`, vert `#4A7A44` (ajouts / accepter), cartes blanches.
- Plus clair et plus « studio » que l'actuel (plum `#5C2D4A` / cream `#F5F0EA`). C'est une **nouvelle direction visuelle**, pas la charte accueil telle quelle.

## 3. Mapping design → backend

| Élément design | État backend | Détail |
|---|---|---|
| Liste + badge type | ✅ existe | `cockpit-data` liste (statut a_verifier, type_correction, categorie_ia) |
| Avant/après paroles (diff au mot) | ✅ existe | `paroles_actuelles` vs `paroles_corrigees`, `_lib/word-diff.js` |
| Avant/après style (prompt) | ✅ existe | `prompt_style_actuel` vs `prompt_style` |
| Prononciation phonétique | ✅ existe | `lyrics_phonetique`, action `appliquer_prononciation` |
| Dictionnaire (lexique) | ✅ existe | `Lexique_Phonetique`, lex_save/lex_delete, override projet/global |
| Colonne **Source** (Dict/Manuel) | 🟡 petit | ajouter le champ `source` à l'affichage lexique |
| Lecteur version actuelle | ✅ existe | `audio_actuel` / `regen.audio_url` signés Cloudinary |
| Courriel éditable + Envoyer/Brouillon | ✅ existe | `brouillon_ia`/`reponse`, actions envoyer/save |
| Régé (méthodes) | ✅ existe | mapper les boutons design sur tes 3 méthodes (cover / régé / paroles) |
| Recherche globale | 🟡 petit | param `?q=` sur la liste (client/sujet/commande) |
| Compteurs header | 🟡 petit | endpoint agrégat (à traiter / en régé / en attente) |
| Échéance (31 h) | 🟡 petit | `recu_le` → âge, tri déjà par `recu_le` |
| No commande (CM-2041) | 🟡 petit | dériver (autonumber Projet si présent, sinon en ajouter un — non destructif) |
| ✎ Renommer titre | 🟡 petit | action `rename` → `song_title` (Generation/Projet) |
| « Accepter » par section | 🟡 petit | adopte la proposition IA dans le champ éditable (pas de régé auto) |
| **Fil fusionné** (N courriels) | 🔴 gros | affichage = siblings par `thread_key` ; **vraie fusion** = intake append + re-proposition combinée (decortique / courriel-entrant / prononciation / demander-modif) |
| **Changement de voix** | 🔴 moyen | `vocalGender` déjà envoyé à Suno (`lancer-cover:136`) ; poser la voix voulue avant régé |
| **Ton du courriel** | 🔴 moyen | régénérer le brouillon avec un param `ton` (logique brouillon-cron / analyse) |
| **Lien perso auto** | 🟡 petit | insérer le **vrai lien token** (PAS le slug devinable du proto ; slugs dépréciés au mapping) |
| **Versions A/B** | 🔴 à cadrer | Suno renvoie déjà **2 clips** (`callback-cover:64` ne garde que `data.data[0]`) → capter le 2ᵉ = quasi gratuit ; « 2ᵉ version » = soit révéler le clip B, soit vraie 2ᵉ génération |

## 4. Changements backend requis

- **`cockpit-data.js`** :
  - Liste enrichie : `expediteur`→client, `sujet`→titre, `message`→extrait, `recu_le`→âge, no commande dérivé, compteur courriels (thread), statut ; + param `?q=` (recherche) ; + endpoint `?counts=1` (compteurs).
  - Détail enrichi : courriels du fil (siblings `thread_key`), `song_title`, options voix, 2 audios (A/B), lien token de la page client.
  - Nouvelles actions : `rename`, `set_voice`, `regen_draft` (ton), `generate_version` (A/B), `accept`.
- **Airtable** (non destructif) : vérifier/ajouter un autonumber commande sur Projects ; éventuel champ pour le 2ᵉ clip (ou 2ᵉ Generation « version B »).
- **Pipeline** : `callback-cover.js` capte `data.data[1]` (clip B) pour l'A/B ; `lancer-cover.js` accepte un override de voix ; intake (fusion) append au lieu de créer une conversation neuve.
- **Fonts** : `Instrument Sans` + `Newsreader` auto-hébergées dans `/fonts` + `@font-face`.

## 5. Ordre de build (jalons sur `ui/cockpit-refonte`, un merge final = swap)

1. **Coquille + design system** : tokens, fonts self-host, layout 3 zones (topbar / liste / détail), branché sur `cockpit-data` existant (parité lecture).
2. **Parité des actions** : avant/après paroles+style + diff, prononciation + dictionnaire (colonne Source), régé (3 méthodes remappées), envoyer/brouillon, archiver, auto-save, confirmations in-page, collapse.
3. **Ajouts pas chers** : recherche, compteurs header, échéance=âge, no commande dérivé, renommer, accepter.
4. **Fil client fusionné** : (a) affichage par `thread_key` ; (b) vraie fusion à l'intake (append + re-proposition combinée). _Touche le live → diff + go avant merge._
5. **Studio +** : changement de voix, ton du courriel, lien perso (token).
6. **Versions A/B** : capter les 2 clips Suno + UI comparer/choisir ; (option) vraie 2ᵉ génération.
7. **Swap** : checklist de parité vérifiée en Deploy Preview → merge → `cockpit.html` remplacé en prod.

## 6. Décisions techniques à trancher (avec mes recos)

1. **Modèle A/B (LOCKÉ)** : « Générer une 2ᵉ version » = **vraie 2ᵉ génération indépendante** (rendu distinct), pas seulement le 2ᵉ clip natif. (On peut quand même capter le 2ᵉ clip natif en bonus, mais la 2ᵉ version voulue = régé indépendante.)
2. **A/B côté client (LOCKÉ) = client-facing** : Nathalie peut (a) choisir une version et l'envoyer, OU (b) **envoyer les 2 versions d'un coup sur la page client** ; le **client écoute et accepte** sa préférée → la version choisie devient la version livrée. ⇒ touche la **page client** (afficher 2 versions + bouton choisir/accepter) + suivi du choix (nouvel état / callback) + le cockpit (envoyer A / envoyer B / envoyer les 2). Surface notable, à cadrer au jalon 6.
3. **Voix** : la changer = plutôt une **régé (nouvelle mélodie)** avec la nouvelle voix (une cover garde la mélodie mais la voix source) — reco : voix → régé.
4. **« Accepter »** : adopte la proposition IA dans le champ (pas de régé auto) ; la régé reste explicite. À confirmer.
5. **No commande** : vérifier un autonumber Projet existant ; sinon en ajouter un (non destructif).

## 7. Risques / garde-fous

- **Pipeline en direct** : fusion + A/B + voix touchent la génération. Chaque jalon : flag si possible, diff + go avant merge, test en Deploy Preview.
- **Sécurité** : garder le lien **token UUID** (pas de slug devinable) ; ne pas régresser la défense anti-énumération.
- **Plafonds** : respecter les marqueurs `admin_triggered` / `cover_admin` (les régé équipe ne comptent pas dans les plafonds client).
- **`REVUE_AVANT_ENVOI` reste OFF** : la version post-achat part auto ; le cockpit ne retient QUE les demandes de modif + le brouillon de réponse.

## 8. État

- Maquette validée par Maxime (itérée : rail gauche, liste rétractable, paroles inline éditable, colonne droite = prononciation + studio, version de référence sélectionnable, versions A/B avec style/ambiance/voix + prompt par version). **GO donné pour le build sur `ui/cockpit-refonte`.**

## 9. Jalon 1 — features à PRÉSERVER (parité) et bugs à NE PAS reproduire

**Features existantes à réintégrer telles quelles (logique réutilisée du `cockpit.html` actuel, pas réécrite) :**
1. Gate `COCKPIT_SECRET` (header `x-cockpit-key`, sessionStorage).
2. Liste (statut ≠ repondu/archive/auto, tri `recu_le` desc) + **Archiver** + **liste rétractable**.
3. 2 modes selon `categorie_ia` : `modification` / `message` simple.
4. **Diff au mot** (miroir de `_lib/word-diff.js`, testé en CI) — nouveau design = un seul bloc inline éditable (retiré barré + ajouté).
5. Avant/après **style** (`prompt_style` vs `prompt_style_actuel`).
6. **Sauvegarde auto** (debounce) + règle « proposé == actuel → enregistre vide » (sert au bouton « Paroles uniquement »).
7. **Confirmations in-page** (pas de popup navigateur).
8. **Prononciation** (`lyrics_phonetique`, action `appliquer_prononciation`) + **dictionnaire lexique** (`lex_save`/`lex_delete`, override/désactiver, colonne source).
9. 3 méthodes de régé (`appliquer` → `action_modif`) : Nouvelle mélodie (`rege`) / Garder la mélodie (`cover`) / Paroles uniquement (`paroles`). Nouveau design = « Regénérer la mélodie » (rege) / « Cover » (cover) par version.
10. Bloc **version régénérée** (`regen` en_production/prête, badge, audio, paroles) + **lecteur « version actuelle » toujours visible** (`audio_actuel`).
11. **pollRegen** (auto-refresh après régé, marche flag ON et OFF, détecte le changement d'`audio_actuel`).
12. **Réponse client** éditable + **Envoyer** (grisé + 409 `rege_en_cours` si régé en cours) + Enregistrer le brouillon. Envoyer ≠ régé.

**Bugs déjà corrigés à NE PAS reproduire :**
- Proposé vide → afficher tout l'actuel barré rouge (PR #255). **Fix : proposé part des valeurs ACTUELLES** quand pas de proposition IA.
- « Aucune place pour écouter la chanson » (PR #277). **Fix : lecteur version actuelle toujours visible.**
- Après régé, restait bloqué sur « en cours » (fallait recharger) (PR #277). **Fix : pollRegen.**
- « Box dans box » + textarea resize moche (PR #260). **Fix : le champ éditable EST la carte.**
- Bascule liste (☰) qui fait disparaître tout le détail (bug trouvé en maquette : `display:none` sur la liste met le détail dans la piste 0px). **Fix : `grid 0 1fr` + liste `overflow:hidden`, jamais `display:none`.**
- Vider un singleSelect Airtable avec `''` → 422 (boucle recovery-cron). **Ne jamais poser `''` sur un singleSelect** (`action_modif`/`envoi_reponse` reçoivent des valeurs valides ; `prompt_style` est du texte, `''` OK).
- `REVUE_AVANT_ENVOI` reste **OFF** : ne pas construire d'UI qui suppose un palier « prête » bloquant ; la version post-achat part auto.

**Découpe du build :**
- **Jalon 1 (ce build)** : nouveau design + layout + **100 % des features ci-dessus** rebranchées sur le `cockpit-data.js` EXISTANT (contrat inchangé). Studio en style neuf avec les capacités actuelles (version de référence = version en ligne, prompt éditable, 3 méthodes, bloc régé).
- **Jalon 2+ (backend)** : sélecteur multi-générations en vrai, **versions A/B** (2ᵉ génération + choix client), **style/ambiance/voix + prompt PAR version**, **ton du courriel**, **lien token inséré**, **vraie fusion** des courriels à l'intake. Chacun = sa PR.

## 10. Jalon 2 — fiche client COMPLÈTE (décidé 2026-07-01)

Décision Maxime : **le cockpit gère 100 % de la fiche client.** Même si le client ne demande que des paroles, l'admin a accès à TOUT en lecture + édition. Séquence : **#280 (jalon 1) se merge d'abord**, la fiche = **PR dédiée** ensuite (partir de `main` à jour).

**Structure de la fiche (détail) :**
1. **Client + commande** : nom, courriel, no commande, date, montant, statut (`commercial_status` : aperçu / acheté / livré / remboursé).
2. **Chanson (tout éditable)** : titre, paroles, style + ambiance, voix, prononciation + dictionnaire, versions (studio A/B).
3. **Add-ons / upsells achetés (TOUS)** — mode **voir + relancer** (édition des paramètres = plus tard) : instrumentale, vidéo mémoire, paroles vivantes, PDF, karaoké, photos mémoire. Lus via `Projects.upsells` → table **Upsells** (`type` = video / lyrics_pdf / instrumental / plaque_indoor / plaque_outdoor, `delivery_url`) + champs `extra_*` + photos. Par item : statut (acheté / en cours / livré / échoué), écouter ou voir le rendu, **relancer/régénérer** (branché sur `lancer-instrumentale` / `lancer-video-memoire` / `lancer-paroles-vivantes` / `commander-bump`), + **ajouter un add-on**.
4. **Courriel client** (ton, lien token).
5. **Historique** : versions + conversations (fil fusionné).

**Backend** : `cockpit-data` étendu (lecture fiche : Projet + Client + Upsells + Generations) + actions de relance gatées `COCKPIT_SECRET` → mêmes fonctions/déclencheurs existants (rien de dupliqué). Non destructif. Champs exacts (Upsells vs `extra_*` vs order bumps) à confirmer au build.
