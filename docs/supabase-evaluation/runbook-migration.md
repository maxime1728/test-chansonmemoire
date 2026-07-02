# Runbook de migration Supabase — exécutable par Claude Code

> Document d'exécution. Deux lecteurs :
> - **Claude Code** exécute les tâches marquées **[CLAUDE]**.
> - **Toi (Maxime)** ne fais QUE les tâches marquées **[TOI]** (regroupées en fin de doc).
> Objectif : maximum délégué, minimum de travail humain, zéro perte de données, réversible
> à chaque étape. Ancré dans le vrai projet (voir [`plan-integration.md`](plan-integration.md)).

## Observation qui allège tout le plan

**CONFIRMÉ par Maxime (2026-07-01) : 0 donnée à transférer.** Le système .ca est pré-lancement,
la base est vide. Donc ce n'est PAS une migration de données : c'est un **démarrage propre** sur
Supabase.

Conséquences majeures qui simplifient tout :
- **Pas de coexistence, pas de double-écriture, pas de contrôle de parité.** (Ces mécanismes des
  Phases 2-7 servaient à synchroniser des données existantes ; sans données, ils disparaissent.)
- On **construit directement sur Supabase** par tranches verticales, puis on bascule. Le scénario
  le moins risqué qui existe.
- L'ordre n'est plus « le moins risqué d'abord » (pertinent avec des données) mais **« la valeur
  d'abord »** : on livre le parcours qui te débloque en premier (le funnel pré-achat).

## Intégration du nouveau design (Claude Design)

Contexte Maxime : le **design du site a été refait** avec Claude Design. **Le post-achat est déjà
intégré** ; il reste le **funnel AVANT l'achat** (accueil, souvenirs, révision, attente, aperçu).

Comme on part de 0 donnée, on ne rebâtit pas une version Airtable du funnel pour la jeter ensuite :
on construit le **funnel pré-achat nouveau design directement câblé sur Supabase**. Deux volets
frontend :
- **Post-achat (déjà fait, nouveau design)** : on **re-pointe seulement ses appels** vers les
  nouvelles fonctions Supabase (pas de refonte visuelle).
- **Pré-achat (à bâtir)** : pages nouveau design + câblage Supabase, d'un coup. C'est du greenfield,
  donc rapide et propre.

Cela réordonne le plan : la **tranche funnel** (backend + pages pré-achat + re-point post-achat)
passe en priorité, avant l'admin et les analytics.

## Comment lire une phase

Chaque phase a : **objectif**, **[TOI]**, **[CLAUDE]**, **erreurs long terme + parade**,
**preuve que ça marche (visible par toi)**, **réversibilité**. Une phase ne démarre que si la
précédente a passé sa preuve. Tout est sur branches + PR (tu merges).

---

## Phase 0 — Décisions et comptes (surtout [TOI])

**Objectif :** poser les fondations que seul un humain peut créer.

**[TOI] (bloquant, ~30-45 min une seule fois) :**
1. Créer un compte **Supabase** (supabase.com) → nouveau projet, région **Canada (Central)**.
2. Copier 3 secrets depuis Supabase (Settings → API et Database) : `SUPABASE_URL`, la clé
   **service_role**, et la **connection string** (pooler, mode transaction). Me les donner
   pour que je les mette dans Netlify, OU les poser toi-même dans Netlify (Site settings →
   Environment variables). Recommandation : tu les poses toi-même (tu ne partages jamais un
   secret service_role dans un chat).
3. ~~Confirmer s'il y a des données réelles à conserver~~ → **RÉPONDU : 0 donnée.** Démarrage
   propre, pas de migration de données. (Item retiré de ta checklist.)

**[CLAUDE] :** rien tant que le projet Supabase n'existe pas. Une fois les secrets posés, je
vérifie la connexion par une fonction de test.

**Erreurs long terme + parade :**
- *Mauvaise région (données hors Canada)* → choisir Canada Central **maintenant** : changer de
  région plus tard = recréer le projet. Parade : le valider en Phase 0, pas après.
- *Secret service_role qui fuit* → ne jamais le mettre dans le code ni un chat ; Netlify env
  seulement ; RLS activé (Phase 1) pour que même une fuite de la clé anon soit contenue.

**Preuve :** je te montre une réponse `{ ok: true }` d'une fonction `db-ping` qui lit l'heure Postgres.
**Réversibilité :** totale (rien touché à l'existant).

---

## Phase 1 — Fondations base de données ([CLAUDE], validation [TOI])

**Objectif :** un schéma propre, versionné, typé, sécurisé, réversible.

**[CLAUDE] :**
1. Init `supabase/` dans le repo + **migrations versionnées** (chaque changement = un fichier SQL en PR).
2. Écrire le schéma v2 exécutable (à partir de [`schema.sql`](schema.sql)) : tables + enums +
   contraintes `unique` (anti-doublons) + FK + vues de plafonds.
3. **Soft-delete** (`deleted_at`) sur toutes les tables + **`audit_log`** (qui/quoi/quand) via triggers.
4. **RLS activé** table par table, avec policies ; les fonctions Netlify utilisent la clé
   service_role (bypass RLS), l'app admin passe par les rôles.
5. **Générer les types TypeScript** depuis Supabase (`supabase gen types`) → source unique de vérité.
6. `_lib/db.ts` : client SQL partagé via le **pooler** (mode transaction) + Drizzle.
7. CI : `node --check` déjà là + ajout d'un test de connexion sur une base éphémère.

**[TOI] (léger) :** relire/approuver le schéma en PR (je te l'explique en français, table par table).

**Erreurs long terme + parade :**
- *Dérive de schéma* → migrations + types générés = le schéma est la seule vérité, les types suivent.
- *Verrouillage RLS (plus personne ne lit)* → policies écrites AVANT d'activer RLS, testées ; fonctions en service_role.
- *Épuisement des connexions Postgres (piège serveur sans-état)* → **pooler transaction obligatoire** dès le jour 1, jamais de connexion directe depuis une fonction.
- *Argent en float* → `numeric`, jamais `float`. *Dates* → `timestamptz` en UTC, formatage à l'affichage (Québec).

**Preuve :** je te montre le schéma qui se déploie + une écriture/lecture test qui respecte une contrainte (un doublon rejeté).
**Réversibilité :** totale (Airtable intact, Supabase isolé).

---

## Phase 2 — Premier domaine réel : analytics (pubs) ([CLAUDE])

**Objectif :** valider Supabase sur du **non-critique, write-heavy**, là où Airtable fait mal (doublons, rate limit). Nathalie n'édite jamais ces tables → risque quasi nul.

**[CLAUDE] :**
1. Migrer `insights-cron`, `pub-join-cron`, `suivi-funnel`, `capi-pageview`, `clic` vers Supabase.
2. **Coexistence** : pendant la transition, écrire dans Supabase ET garder Airtable en lecture,
   avec un **contrôle de parité** (compter les lignes des deux côtés) pour prouver l'équivalence.
3. Idempotence **par contrainte** (`unique(pub_id, jour)`, `unique(project_id, event_name)`) →
   remplace les drapeaux `_sent`. Fin structurelle des doublons.

**[TOI] :** rien (sauf regarder la preuve).

**Erreurs long terme + parade :**
- *Double comptage pendant la coexistence* → clés d'idempotence ; le contrôle de parité détecte tout écart.
- *Perte d'attribution* → conserver `cm-attrib.js` côté client inchangé ; jointure en SQL.

**Preuve :** un tableau « Airtable vs Supabase » avec les mêmes totaux, et zéro doublon Pubs.
**Réversibilité :** on coupe l'écriture Supabase, Airtable reste la source. Facile.

---

## Phase 3 — File d'attente native ([CLAUDE])

**Objectif :** remplacer les 5 crons/minute par une vraie file, **sans** ajouter de service externe.

**[CLAUDE] :**
1. Utiliser le **natif Supabase** : `pg_cron` (planification) + **Queues (pgmq)** (jobs). Aucun compte de plus.
2. Convertir `cover-cron`, `envoyer-cron`, `brouillon-cron`, `modif-cron`, `appliquer-cron` en producteurs/workers.
3. `keepwarm-cron` et `recompter-comptage` **supprimés** (plus de polling à vide ; comptage = vue SQL).

**[TOI] :** rien.

**Erreurs long terme + parade :**
- *Jobs perdus / rejoués en double* → sémantique de queue (accusé de réception + retry) + clé d'idempotence par job.
- *Empoisonnement (un job qui échoue en boucle)* → nombre max de tentatives + file « morts » + alerte Sentry.

**Preuve :** un job lancé démarre en < 2 s (au lieu de 60 s) ; le tableau de santé montre 0 échec.
**Réversibilité :** garder les crons de polling en veille jusqu'à validation, puis les retirer.

---

## Phase 4 — Générations, corrections, plafonds ([CLAUDE])

**Objectif :** le cœur métier de la chanson, avec des règles fiables.

**[CLAUDE] :**
1. Migrer `lancer-chanson`, `callback-chanson`, `lancer-cover`, `callback-cover`, `decortique`, `prononciation`.
2. **Plafonds = vue SQL** (fin des rollups fragiles et de `PLAFOND_V2`/recomptage).
3. Corrections = **machine à états** (`proposée → approuvée → en cours → livrée`) au lieu de drapeaux épars.
4. Brancher les callbacks Suno/Creatomate sur Supabase ; **retirer les fallbacks Make en dur** (`CALLBACK_CHANSON`).

**[TOI] :** rien, sauf tester une régénération de bout en bout quand je te le demande (clic).

**Erreurs long terme + parade :**
- *Callback qui repart vers Make (chanson perdue)* → suppression des URLs Make par défaut ; test canari sur le vrai endpoint.
- *Coûts Suno pendant les tests* → réutiliser les patterns canari/test existants, pas de génération réelle en boucle.
- *Course entre 2 callbacks* → clé d'idempotence sur `suno_task_id` (contrainte unique).

**Preuve :** tu écoutes une version A/B régénérée depuis la nouvelle chaîne.
**Réversibilité :** coexistence sur Generations jusqu'à validation.

---

## Phase 5 — Back-office : d'abord Studio, puis Refine ([CLAUDE], usage [TOI])

**Objectif :** ton admin et l'espace de Nathalie, avec le minimum de code sur mesure.

**[CLAUDE] :**
1. **Étape 5a (gratuite) :** activer le **Supabase Studio** comme back-office intérimaire (grille intégrée, zéro build). Utilisable tout de suite pour consulter/éditer.
2. **Étape 5b :** monter l'app **Refine + TypeScript** + **Supabase Auth** (lien magique) + rôles `ops`/`admin` :
   - grille générique (Refine, quasi gratuite) pour la consultation/édition brute ;
   - **fiche client 360 sur mesure** (la maquette Nathalie) : projets, versions A/B, corrections, conversations, livraison ;
   - **console système** pour toi (KPIs, santé queue, funnel, flags).
3. **Recherche client** plein texte (Postgres `tsvector` + trigram).

**[TOI] (léger mais réel) :** tester l'app avec Nathalie (elle clique son vrai parcours) et me remonter ce qui coince. C'est le seul moment où j'ai besoin de vos retours d'usage.

**Erreurs long terme + parade :**
- *Construire l'UI sur un schéma qui bouge* → Refine seulement après stabilisation (Phases 1-4).
- *Sur-ingénierie de l'admin* → Studio couvre déjà le brut ; Refine seulement pour le workflow qui te différencie.
- *Accès trop large* → rôles en RLS (Nathalie ne voit pas les finances/flags).

**Preuve :** Nathalie ouvre une fiche client et traite une correction de bout en bout, dans la nouvelle UI.
**Réversibilité :** l'ancien cockpit reste dispo en parallèle jusqu'à ce que la nouvelle UI soit adoptée.

---

## Phase 6 — Clients / Projets + droits Loi 25 sur demande ([CLAUDE], décisions [TOI])

**Objectif :** le noyau transactionnel, en dernier (le plus sensible), + les droits Loi 25 manquants.

**[CLAUDE] :**
1. Migrer `soumettre-survey`, `lire-projet`, `accepter-livraison`, `creer-checkout`, `stripe-webhook`, `stripe-refund`, courriels.
2. Achat = **transaction SQL** atomique (statut cohérent garanti).
3. **Droits Loi 25 sur demande** (aujourd'hui absents) : fonctions `exporter_client(id)` (droit d'accès), `anonymiser_client(id)` (droit d'effacement immédiat), boutons réservés au rôle admin, tout tracé dans `audit_log`. Purge auto conservée via `pg_cron`.

**[TOI] (bloquant, non technique) :**
- Faire **valider par un professionnel** les durées de rétention et le texte d'effacement (portée juridique Loi 25 / LPC). Je code le mécanisme, je ne donne pas d'avis juridique.
- Si des **données réelles** existent (réponse Phase 0), approuver le plan de transport keyé sur `token`/courriel + le contrôle de parité avant bascule.

**Erreurs long terme + parade :**
- *Effacement irréversible par erreur* → soft-delete + audit ; l'anonymisation est tracée et confirmée.
- *Mapping d'identifiants* (record IDs Airtable ≠ UUID) → clé stable = `token` et courriel ; table de correspondance pendant la coexistence.
- *Achat à moitié écrit* → transaction atomique.
- *Consentement retiré ignoré* → `consent_status` respecté en SQL (aucun courriel si `withdrawn`).

**Preuve :** un achat test complet + un export et un effacement d'un client test, tracés.
**Réversibilité :** coexistence + soft-delete ; on ne coupe Airtable qu'après parité verte.

---

## Phase 7 — Bascule et retrait d'Airtable ([CLAUDE], go/no-go [TOI])

**Objectif :** Supabase devient la seule source, Airtable est retiré table par table.

**[CLAUDE] :** couper l'écriture Airtable domaine par domaine (dans l'ordre inverse du risque),
retirer le code Airtable + les **derniers fallbacks Make**, garder les canaris pointés pendant la bascule.

**[TOI] (bloquant) :** donner le **go/no-go** de bascule (je te montre la parité verte + les canaris OK avant chaque coupe).

**Erreurs long terme + parade :**
- *Bascule irréversible ratée* → coupe par domaine, pas tout d'un coup ; possibilité de re-pointer sur Airtable tant que la table Airtable existe (on la supprime en dernier).
- *Trou d'observabilité pendant la bascule* → Sentry + canaris + Healthchecks maintenus tout du long.

**Preuve :** chaque domaine tourne 48-72 h sur Supabase seul, canaris verts, avant de retirer Airtable.
**Réversibilité :** dégressive (haute au début, on la réduit sciemment domaine par domaine).

---

## Phase 8 — Pages funnel + préparation au lancement ([CLAUDE] + [TOI])

**Objectif :** re-pointer le public en dernier, préparer le vrai lancement (remplacer le .com GHL+Make).

**[CLAUDE] :** re-pointer les appels des pages funnel statiques vers les nouvelles fonctions
(les pages restent **statiques**, SEO intact) ; checklist de lancement automatisable.

**[TOI] (bloquant, jour du lancement) :**
- Passer Stripe de **test → live** (clé live + prix live).
- Activer les flags de prod (`PURGE_ACTIF=1` après vérif sauvegardes, etc.).
- Décider et exécuter le **remplacement du .com** (redirections / bascule DNS) — étape business.

**Erreurs long terme + parade :**
- *Oublier un flag de prod (ex. Stripe test en prod)* → checklist de lancement automatisée + canari e2e.
- *SEO cassé* → pages funnel jamais transformées en app ; uniquement leurs appels re-pointés.

**Preuve :** un parcours e2e complet en conditions de prod (canari) + Nathalie opérationnelle.
**Réversibilité :** le .com reste jusqu'à ce que le .ca soit prouvé stable.

---

## TA checklist minimale (tout ce que TOI tu dois faire, regroupé)

| # | Quand | Action [TOI] | Bloquant ? |
|---|---|---|---|
| 1 | Phase 0 | Créer le projet Supabase (région Canada) | Oui |
| 2 | Phase 0 | Poser 3 secrets Supabase dans Netlify | Oui |
| ~~3~~ | ~~Phase 0~~ | ~~Confirmer données~~ → **RÉPONDU : 0 donnée, démarrage propre** | — |
| 4 | Phase 1 | Approuver le schéma en PR (je te l'explique) | Oui |
| 5 | Phase 5 | Tester l'app avec Nathalie, remonter les blocages | Oui |
| 6 | Phase 6 | Faire valider Loi 25 (rétention/effacement) par un pro | Oui |
| 7 | Phases 6-7 | Donner les go/no-go de bascule (sur preuve) | Oui |
| 8 | Phase 8 | Stripe test→live, flags prod, remplacement du .com | Oui |
| — | Toutes | Merger les PRs | Oui |

Tout le reste (schéma, migrations, réécriture des 77 fonctions, queue, admin, tests,
coexistence, bascule) est **délégué à Claude Code**. Ton travail se résume à : créer un compte,
poser des secrets, approuver, tester avec Nathalie, valider le légal, dire go.

---

## Prompt de handoff (à copier-coller à Claude Code pour démarrer)

> « Exécute la migration décrite dans `docs/supabase-evaluation/runbook-migration.md`. Commence
> par la Phase 1 (le projet Supabase et les secrets Netlify sont posés). Travaille par phases,
> une branche + PR par phase, dans l'ordre du runbook. À chaque fin de phase : montre-moi la
> preuve visible décrite, ne démarre pas la phase suivante sans mon go, et n'active jamais rien
> de destructif (PURGE_ACTIF, coupe d'Airtable, Stripe live) sans me le demander. Respecte :
> migrations versionnées, types générés, soft-delete + audit, idempotence par contrainte,
> pooler transaction, RLS avec policies avant activation. Ne touche pas au travail non commité
> des autres branches. »

---

## Seconde autocritique (points forts / faibles + améliorations)

**Points forts du plan :**
- Strangler ordonné, cœur en dernier, réversibilité explicite à chaque phase.
- Aucune donnée réelle en jeu (pré-lancement) → risque de fond très bas.
- Une seule source de vérité (schéma), un seul stack typé, natif Supabase (peu de systèmes).
- Chaque phase se termine par une **preuve visible par toi**, pas juste « les tests passent ».

**Points faibles détectés → améliorations apportées :**
1. *Faiblesse : dépendance à des actions humaines qui peuvent bloquer.* → **Amélioration :**
   checklist unique de 8 items, chacun marqué bloquant, avec chemins concrets ; tout le reste délégué.
2. *Faiblesse : « démarrage propre vs migration » laissé en suspens.* → **Amélioration :** une
   seule question en Phase 0 tranche tout ; si tout est test, on saute la lourde Phase 6-données.
3. *Faiblesse : Maxime ne peut pas juger la correction technique.* → **Amélioration :** chaque
   phase livre une preuve qu'un non-technicien constate (un son, un écran, un nombre, un doublon rejeté).
4. *Faiblesse : risque d'enlisement (trop de phases).* → **Amélioration :** chaque phase a une
   valeur autonome et est réversible ; on peut s'arrêter après n'importe laquelle sans casse.
5. *Faiblesse : pièges techniques classiques (connexions, RLS, argent/dates).* → **Amélioration :**
   inscrits comme règles dures dès la Phase 1 (pooler, policies avant RLS, numeric, timestamptz).
6. *Faiblesse : coûts de test (Suno) et bugs silencieux.* → **Amélioration :** réutiliser les
   canaris existants, garder Sentry/Healthchecks pointés pendant toute la bascule.
7. *Faiblesse : la bascule finale reste le moment le plus tendu.* → **Amélioration :** bascule
   par domaine avec 48-72 h de fonctionnement prouvé + go/no-go humain avant chaque coupe.

**Ce que je surveillerais quand même :** la Phase 5 (l'app admin) est celle qui peut gonfler en
temps si on cède à la tentation du sur-mesure partout. Garde-fou : Studio couvre le brut, Refine
seulement pour la fiche client 360. Si on tient cette ligne, le plan reste sobre et durable.
