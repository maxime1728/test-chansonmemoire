# Plan d'intégration Supabase — état réel, mapping complet, autocritique

> Suite de [`README.md`](README.md), [`ui-et-stack.md`](ui-et-stack.md), [`schema.sql`](schema.sql), [`queue.md`](queue.md).
> Rédigé le 2026-07-01, ancré dans le code réel (77 fonctions, [`flux-complet.md`](../flux-complet.md), scan des flags).

---

## Partie A — État réel du build actuel (.ca, pré-lancement)

Ce que le code fait **aujourd'hui**, avec le niveau de confiance. Légende : ✅ fait · 🟡 fait mais
derrière un flag OFF (à activer/tester) · 🟠 partiel · 🔴 manque.

| Domaine | État | Note (vérifiée dans le code) |
|---|---|---|
| Tunnel sondage → paroles → révision | ✅ | `soumettre-survey` + `generate-lyrics-background`, réponse ~2 s `[Certain]` |
| Génération chanson (Suno) + callback | ✅ | `lancer-chanson` → `callback-chanson`, ré-héberge Cloudinary signé `[Certain]` |
| Robustesse génération | ✅ | `sentinelle-cron`, `alerte-cron`, `recovery-cron` `[Certain]` |
| Aperçu 60 s signé + achat Stripe | ✅ | `apercu`, `creer-checkout`, `stripe-webhook` (ex-MAKE D en code) `[Certain]` |
| Corrections + cover auto/approuvé | ✅ | `decortique` → `cover-cron` → `callback-cover` `[Certain]` |
| Prononciation (phonétique) | ✅ | `prononciation` + lexique `LEXIQUE_PHON` (flag) 🟡 |
| Plafonds régénérations | 🟡 | v1 en direct ; **v2 combiné derrière `PLAFOND_V2=1` (OFF)** `[Certain, cf. mémoire]` |
| Cockpit corrections (avant/après, A/B) | ✅ | refonte récente mergée ; `REVUE_AVANT_ENVOI` / `STATE_MOVE_PROPOSEE` (flags OFF) 🟡 |
| Courriels (achat, recovery, nurture, support) | ✅ | Mailgun sous-domaines ; `COURRIEL_APERCU_PRET` (OFF) 🟡 |
| Tracking pixel + CAPI + dédup | ✅ | `cm-pixel.js` + `capi-pageview` + `suivi-funnel` `[Certain]` |
| Attribution UTM first/last + jointure Pub | ✅ | `cm-attrib.js` + `pub-join-cron` `[Certain]` |
| Pubs + Pubs_Performance (dépense/ROAS) | ✅ | `insights-cron` (ex-Make Insights en code) `[Certain]` |
| Add-ons (instrumentale, vidéo, PDF, paroles vivantes) | ✅ | lanceurs + callbacks + `watchdog-cron` `[Certain]` |
| Livraison + preuve (signature, IP, UA) | ✅ | `accepter-livraison` écrit les champs de preuve `[Certain]` |
| Loi 25 — purge auto | ✅ | `purge-cron` ; **réel seulement si `PURGE_ACTIF=1`, sinon dry-run** `[Certain]` |
| Observabilité (Sentry, canaris, heartbeats, CI) | ✅ | `withSentry`/`withCron`, 3 canaris `[Certain]` |
| **Loi 25 — droit d'accès / effacement SUR DEMANDE** | 🔴 | rien trouvé ; seule la purge **auto** existe. Un client qui demande ses données ou leur effacement = manuel `[Probable]` |
| **Loi 25 — export / portabilité des données** | 🔴 | non trouvé `[Probable]` |
| **Recherche client / back-office unifié** | 🟠 | via Airtable + cockpit ; pas d'outil de recherche transverse `[Probable]` |
| **Auth admin (rôles) + journal d'audit** | 🟠 | `COCKPIT_SECRET` (secret partagé), pas de rôles ni « qui a fait quoi » `[Certain]` |

### Le piège n°1 à connaître avant tout

Plusieurs fonctions ont un **fallback Make en dur** : ex. `CALLBACK_CHANSON` par défaut =
`https://hook.us1.make.com/...`. Si la variable d'env n'est pas posée en prod, le callback
**repart vers Make** (éteint) → chanson perdue en silence. Idem logique `SURVEY_DIRECT`. Donc
« l'état réel » n'est correct **que si les bons flags d'env sont posés**. En Supabase, on
supprime ces fallbacks : plus de double-cerveau Airtable/Make. `[Certain]`

**Lecture d'ensemble :** le build est **fonctionnellement quasi complet**, mais (a) plusieurs
morceaux dorment derrière des flags OFF à activer/tester, (b) la correction dépend de flags
d'env, et (c) il manque des **droits Loi 25 sur demande** (accès/effacement/export) et un
**back-office avec rôles + audit**. Ce sont exactement des choses qu'une refonte pré-lancement
peut intégrer proprement plutôt que bricoler après.

---

## Partie B — Puis-je (Claude) t'aider facilement avec TypeScript, Drizzle, Refine ?

Réponse franche : **oui, et ça réduit mes erreurs plutôt que de les augmenter.** `[Certain]`

- **TypeScript** — mainstream, je le maîtrise. Surtout : ton code actuel est « stringly-typed »
  (`f.suno_task_id`, noms de champs en texte). C'est **plus dur à garder correct** pour moi que
  du typé, parce que rien ne m'avertit quand un nom dérive. TS + types générés = je me fais
  attraper mes propres fautes avant le déploiement.
- **Drizzle** — ORM léger, proche du SQL. Excellent pour ton profil et le mien : les requêtes
  sont typées d'après ton schéma, donc une colonne renommée casse **à la compilation**, pas en
  prod en silence.
- **Refine** — framework d'admin React très documenté. Je peux scaffolder et personnaliser.
  Seule vraie friction : la personnalisation avancée a une courbe. Mitigation dans l'autocritique (Partie D).

Le point clé : le stack actuel (JS vanilla, zéro build, zéro type) est en réalité **le plus
risqué** pour un mainteneur unique. Un stack typé est **plus facile à maintenir à deux** (toi +
moi), pas moins. La barrière n'est pas « est-ce que Claude peut aider », c'est « accepter une
étape de build » (que Netlify gère déjà).

---

## Partie C — Mapping complet des étapes (par domaine)

Pour chaque domaine : ce qu'il y a aujourd'hui → cible Supabase → étapes concrètes. Tu en
listais 10 ; j'en ajoute (auth/rôles/audit, plafonds, paiements/remboursements, add-ons,
file d'attente, idempotence, sauvegardes/migrations, droits Loi 25 sur demande, export,
cycle de vie média, flags, sécurité/RLS, tests).

### C1. Fiche client complète (client 360)
- Aujourd'hui : données éparpillées (Clients/Projects/Generations/Upsells/Conversations), lues par N fetchs.
- Cible : une requête avec `JOIN` renvoie tout le 360 ; RLS limite à ce que le rôle peut voir.
- Étapes : schéma FK (fait dans `schema.sql`) → vue `client_360` → endpoint `GET /client/:id` typé → écran Refine.

### C2. Tracking des étapes client (funnel_step)
- Aujourd'hui : `funnel_step` single-select + horodatages, écrits par patchs séparés (422 si option absente).
- Cible : `enum funnel_step` + colonnes `*_at` ; une ligne d'historique par transition (table `funnel_events`) pour la vraie chronologie.
- Étapes : enum + table d'événements → écrire à chaque transition → timeline dans la fiche client.

### C3. Tracking CAPI + Meta
- Aujourd'hui : `capi-pageview` + `suivi-funnel`, dédup par `event_id` haché, drapeaux `capi_*_sent`.
- Cible : idem, mais **idempotence par contrainte** (`unique(project_id, event_name)` sur une table `capi_events`) au lieu de drapeaux booléens → zéro double-envoi.
- Étapes : table `capi_events` → upsert `on conflict do nothing` → retrait des drapeaux `_sent`.

### C4. Pubs + C5. Pubs_Performance
- Aujourd'hui : upsert sans contrainte → **doublons** (bug connu).
- Cible : `pubs.meta_ad_id unique`, `pubs_performance unique(pub_id, jour)` → doublons impossibles.
- Étapes : tables (faites dans `schema.sql`) → `insights-cron` fait `on conflict update` → jointure ROAS en SQL.

### C6. UTM / attribution
- Aujourd'hui : `utm_*` + `last_utm_*` en colonnes plates, jointure Pub par cron.
- Cible : `attribution jsonb` (first + last) indexé GIN ; jointure Pub en SQL.
- Étapes : colonne jsonb → `cm-attrib.js` inchangé côté client → jointure en requête.

### C7. Recherche par client
- Aujourd'hui : `filterByFormula` (lent, échappement bricolé).
- Cible : recherche plein texte Postgres (`tsvector`) sur nom/courriel/défunt + index trigram.
- Étapes : colonnes de recherche + index → barre de recherche unique dans l'admin.

### C8. Emailing complet
- Aujourd'hui : achat, recovery, nurture, support (brouillon IA → envoi), sous-domaines Mailgun.
- Cible : Mailgun inchangé ; table `conversations` + `email_events` (ouvertures/clics via webhook Mailgun) ; désabonnement + `consent_status` respectés en SQL.
- Étapes : tables → `mailgun-events` écrit les events → fil de conversation dans la fiche client → séquences pilotées par requêtes (pas par scans).

### C9. Refonte / correction de chansons
- Aujourd'hui : `decortique` → routage (cover auto / approbation) → `cover-cron` → `callback-cover`, plafonds, phonétique.
- Cible : la demande devient un **job de queue** avec statut (`proposée/approuvée/en cours/livrée`) ; l'approbation est une transition d'état ; le cover est un worker.
- Étapes : table `corrections` + machine à états → producteur (bouton cockpit) → worker cover → courriel livraison. Plafonds = vue SQL (fin des rollups).

### C10. Suppression données Loi 25
- Aujourd'hui : purge **auto** (`purge-cron`, dry-run sauf `PURGE_ACTIF=1`). Pas de droit **sur demande**.
- Cible : (a) purge auto par `pg_cron` ; (b) **droit d'accès** (export des données d'un client), (c) **droit d'effacement sur demande** (anonymisation immédiate, bouton admin, tracé), (d) **soft-delete + journal** pour éviter les effacements irréversibles par erreur.
- Étapes : fonctions SQL `anonymiser_client(id)` / `exporter_client(id)` → boutons admin réservés au rôle admin → tout tracé dans le journal d'audit (C13).

### C11. Paiements et remboursements
- Aujourd'hui : `creer-checkout`, `stripe-webhook`, `stripe-refund`.
- Cible : achat = **transaction SQL** atomique (projet `purchased` + upsells + preuve) ; remboursement met à jour l'état ; `stripe_payment_intent unique` = anti double-traitement natif.
- Étapes : transactions dans les handlers → statut cohérent garanti.

### C12. Add-ons / livrables (instrumentale, vidéo, PDF, paroles vivantes)
- Aujourd'hui : lanceurs + callbacks + `watchdog-cron` (rattrape les échecs silencieux).
- Cible : chaque livrable = job de queue avec retry ; `watchdog` devient une requête sur les jobs en échec.
- Étapes : jobs par type d'add-on → `delivery_url` en base → statut visible dans la fiche client.

### C13. Auth, rôles et journal d'audit *(ajout)*
- Aujourd'hui : `COCKPIT_SECRET` (secret partagé, pas de rôles, pas de traçabilité).
- Cible : **Supabase Auth** (lien magique) + rôles `ops`/`admin` en RLS ; **table `audit_log`** (qui a changé quoi, quand) → indispensable pour Loi 25 **et** pour retrouver l'origine d'une erreur.
- Étapes : Auth + rôles → RLS par table → triggers d'audit sur les tables sensibles.

### C14. File d'attente / orchestration *(ajout)*
- Voir [`queue.md`](queue.md). Remplace les 5 crons/minute.

### C15. Sauvegardes, migrations, rollback *(ajout)*
- Aujourd'hui : pas de migrations (schéma Airtable édité à la main), sauvegardes = Airtable.
- Cible : **migrations SQL versionnées** (dans le repo) + sauvegardes quotidiennes Supabase + possibilité de restauration.
- Étapes : dossier `supabase/migrations` → chaque changement de schéma = un fichier revu en PR.

### C16. Sécurité / RLS *(ajout)*
- Cible : RLS activé partout ; clé service côté fonctions seulement ; token projet = clé d'accès applicative (jamais l'id interne) ; rate limiting sur les endpoints publics.

### C17. Tests / CI *(ajout)*
- Aujourd'hui : `node --check` + `node --test` en CI.
- Cible : garder la CI + ajouter des tests de type (TS) et des tests d'intégration sur une base Supabase de test éphémère.

---

## Partie D — Autocritique du plan (avant conclusion)

Je relis mon propre plan avec un œil critique « simplicité + maintenance minimale + moins
d'erreurs pour Maxime et l'équipe ». Voici ce que je changerais.

**Critique 1 — Trop de nouvelles pièces d'un coup (Refine + Drizzle + pg-boss + Auth).**
Risque : surface d'apprentissage et de panne. → **Correctif :** phaser. Commencer avec le
**Supabase Studio** (grille intégrée, zéro build) comme back-office intérimaire. N'ajouter
**Refine** que pour la fiche client 360 de Nathalie, une fois le schéma stable. On ne bâtit pas
d'UISUR sur un schéma qui bouge encore.

**Critique 2 — pg-boss / Inngest = une pièce de plus à surveiller.**
→ **Correctif :** privilégier le **natif Supabase** : `pg_cron` (planification) + **Queues
(pgmq)** intégrées à Postgres. Moins de services, moins de comptes, moins de secrets, tout au
même endroit. On garde Inngest en réserve **seulement si** on veut un tableau de bord de jobs
plus riche plus tard. Objectif : **minimiser le nombre de systèmes**.

**Critique 3 — Les types peuvent dériver du schéma.**
→ **Correctif :** générer les types TS **directement depuis Supabase** (`supabase gen types`).
Le schéma devient la **source unique de vérité** ; les types suivent automatiquement. Zéro
double saisie, zéro dérive (le problème même qui te fait mal aujourd'hui).

**Critique 4 — Effacements irréversibles = risque d'erreur humaine.**
→ **Correctif :** **soft-delete partout** + **journal d'audit** dès le jour 1. Une mauvaise
manip s'annule ; on sait qui a fait quoi. C'est un filet à la fois Loi 25 et anti-boulette.

**Critique 5 — Migrer le cœur (Clients/Projets) trop tôt = risque max.**
→ **Correctif :** ordre strangler strict, cœur en **dernier**, coexistence Airtable↔Supabase
pendant la transition, bascule table par table avec possibilité de revenir en arrière.

**Critique 6 — L'idempotence par drapeaux booléens laisse passer des doublons.**
→ **Correctif :** idempotence par **contraintes** (`unique` + `on conflict`) sur tous les
envois (CAPI, courriels, achats). La base **refuse** le doublon au lieu qu'on l'évite à la main.

**Critique 7 — « Facilité d'usage pour Maxime et l'équipe » sous-spécifiée.**
→ **Correctif :** un principe directeur = **une seule app, une seule recherche, un seul login,
des rôles**. Nathalie n'apprend qu'un outil. Toi tu as la même app + la console système. Le
Supabase Studio reste ton filet technique. Pas de multiplication d'onglets/outils.

---

## Partie E — Conclusion (plan révisé, ordonné)

Version corrigée par l'autocritique, du plus sûr au plus sensible :

1. **Fondations** : Supabase (région Canada) + `schema.sql` raffiné + **migrations versionnées** + **types générés** + RLS + **soft-delete + audit_log dès le départ**.
2. **TypeScript** progressif sur les fonctions (indépendant, gain immédiat).
3. **Tables analytics** (pubs, pubs_performance, capi_events, funnel_events) : write-heavy, non éditées par Nathalie → validation à faible risque, **fin des doublons**.
4. **File d'attente native** (pgmq + pg_cron) : remplace les 5 crons/minute.
5. **Generations + corrections** : plafonds en vue SQL, corrections en machine à états.
6. **Back-office** : d'abord **Supabase Studio** (zéro build), puis **Refine** pour la fiche client 360 + recherche + **Supabase Auth (rôles ops/admin)**.
7. **Clients/Projets + Loi 25 sur demande** (accès/effacement/export) : le cœur, en dernier, avec coexistence puis bascule.
8. **Retrait d'Airtable** table par table + suppression des **fallbacks Make** en dur.
9. **Pages funnel statiques** : re-pointées en dernier, restent statiques (SEO).

Principe de bout en bout : **une source de vérité (le schéma), une app (rôles), le moins de
systèmes possible (natif Supabase), tout réversible (soft-delete + audit + migrations).** C'est
ce qui donne une app **durable, simple, à maintenance minimale et à faible risque d'erreur**.

Étape suivante concrète : je peux (a) transformer les 🔴/🟡 de la Partie A en **backlog
priorisé**, ou (b) écrire le **`schema.sql` v2** exécutable avec migrations + audit + soft-delete,
ou (c) livrer un **squelette d'app Refine + Supabase Auth** (grille + fiche client) comme preuve.
