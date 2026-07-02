# Plan de migration Supabase v2 : Chanson Mémoire

> Document maître. Il consolide et CORRIGE `runbook-migration.md`.
> En cas de conflit entre ce document et le runbook d'origine, CE DOCUMENT GAGNE.
> Emplacement suggéré : `docs/supabase-evaluation/plan-migration-supabase-v2.md`
> Le prompt de démarrage à copier-coller est à la fin (section "Prompt de démarrage").

---

## 1. Contexte et état confirmé

- Projet Supabase créé, région Canada Central. Secrets `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` posés dans Netlify.
- **0 donnée à migrer.** Le .ca est pré-lancement, base vide. Démarrage propre.
- Le nouveau système (.ca) vit à 100% dans du JavaScript, HTML et Netlify Functions.
  Airtable est la couche de données actuelle du nouveau système : on la remplace
  par Supabase AVANT le lancement.
- Make n'est plus utilisé (ancien système .com seulement). Des références Make
  peuvent survivre dans le code : elles sont traitées par l'audit de l'Étape 0.
- Le pipeline d'analyse IA (Anthropic) est branché et fonctionnel sur le .ca
  avec les prompts réels de Maxime. C'est un PORTAGE, pas une conception.
- Plusieurs plafonds ont déjà été migrés en code 100% JS.
- Migrations appliquées par CI (GitHub Actions), jamais de copier-coller manuel.
- MCP Supabase PAS branché : Claude Code travaille depuis le code et la CI,
  ne touche pas la base directement, ne voit pas la data client.
- Nouveau design (Claude Design) : post-achat intégré, funnel pré-achat à bâtir,
  câblé Supabase directement.
- Maxime opère seul les premières commandes. Nathalie arrive plus tard.
- Les demandes de modification arrivent aujourd'hui par courriel. Décision :
  le canal officiel devient le formulaire de la page de révision par token.
  Le courriel reste toléré via saisie manuelle rapide dans le cockpit.

## 2. Corrections au runbook d'origine (décisions verrouillées)

Le runbook contient des contradictions héritées. Les règles suivantes remplacent
son contenu partout où elles s'appliquent.

1. **Aucune coexistence, nulle part.** Les mécanismes de double-écriture,
   contrôle de parité et table de correspondance des Phases 2, 4, 6 et 7 du
   runbook sont SUPPRIMÉS. 0 donnée = on construit directement sur Supabase.
2. **La valeur d'abord, pour vrai.** Le funnel et le cockpit passent devant
   analytics, queue et admin complet. Voir le nouvel ordre des phases.
3. **RLS n'est pas la couche de sécurité applicative.** Le runbook admet
   lui-même que les fonctions passent en service_role (bypass RLS). RLS reste
   activé avec policies écrites AVANT activation (défense en profondeur,
   protège la surface PostgREST), mais la sécurité réelle du runtime est le
   code des fonctions. Documenter noir sur blanc, et proposer soit un rôle
   applicatif à privilèges réduits, soit la fermeture de l'API data PostgREST.
4. **Deux connection strings, jamais une seule.**
   - Runtime (fonctions Netlify) : pooler transaction, port 6543, avec
     `prepare: false` obligatoire (postgres.js casse en silence sur le pooler
     transaction avec des prepared statements).
   - Migrations (drizzle-kit en CI) : connexion directe ou session, port 5432.
     Le DDL n'est pas fiable sur le pooler transaction.
5. **Idempotence Stripe et Suno par contrainte.** `stripe_event_id` UNIQUE,
   le webhook vérifie et insère l'event AVANT de traiter. Doublon = no-op
   loggé. Même principe : `unique(suno_task_id)`.
6. **audit_log dégonflé en Phase 1.** Triggers d'audit seulement sur les
   tables argent, commande et demandes. Le reste après la mise en prod.
7. **Aucun fallback silencieux vers Make.** Tout fallback détecté est soit
   supprimé (code mort prouvé), soit remplacé par un échec bruyant.

## 3. Nouvel ordre des phases (remplace l'ordre du runbook)

| Phase | Contenu | Pourquoi cet ordre |
|---|---|---|
| 1 | Fondations : inventaire, schéma, migrations CI, types, db, observabilité de base | Rien ne tient sans ça |
| 2 | Tranche verticale complète : funnel pré-achat, paiement, génération, livraison, cockpit file de demandes, pipeline IA porté | C'est ce qui génère le revenu ET ce qui arrête la douleur quotidienne |
| 3+ | Analytics pubs, queue pgmq, Refine/fiche 360, droits Loi 25 outillés, retrait final d'Airtable | Après que la Phase 2 tourne en prod seulement |

Règle : une phase ne démarre pas sans le go explicite de Maxime sur la preuve
visible de la phase précédente.

## 4. PHASE 1 : Fondations

### Étape 0 (AVANT le schéma) : inventaire de contamination

Scanner toutes les fonctions Netlify du nouveau système (.ca). Produire un
tableau : fonction, dépendances Airtable (appels API, noms de champs en string,
filterByFormula, rollups/lookups lus, record IDs qui circulent dans les URLs,
courriels ou logs, retries liés au rate limit), équivalent Supabase proposé,
risque. Maxime l'approuve AVANT l'écriture du schéma : c'est lui qui valide
que `schema.sql` couvre tout ce que le code consomme.

**Audit Make (obligatoire, même inventaire) :** grep de toutes les URLs
`hook.make.com` / `integromat`, variables d'environnement Make, branches de
fallback (ex. `CALLBACK_CHANSON`). Verdict binaire par occurrence :

- code mort : supprimé dans la PR de portage, ou
- fallback actif : remplacé par un échec BRUYANT (log structuré + alerte P1).

INTERDIT : un rabattement silencieux vers Make. "Plus utilisé, je crois"
n'est pas un état acceptable : tout devient prouvé mort ou prouvé vivant.

**Plafonds :** vérifier si le code 100% JS lit encore des données Airtable pour
compter. Si oui, réexprimer en requête ou vue SQL avec test. Si le compteur
est autonome, mapper directement.

**Règles du portage :**

- Aucun record ID Airtable ne survit : identifiants = UUID/token Supabase.
- Aucun accès champ par string : types Drizzle générés partout.
- Chaque filterByFormula est réexprimé en SQL et couvert par un test.
- Rollups/lookups restants deviennent des vues SQL, inventoriés explicitement.
- Retirer les retries et sleeps hérités du rate limit Airtable.

### Étapes 1 à 6

1. **Init `supabase/` + migrations SQL versionnées** à partir de
   `docs/supabase-evaluation/schema.sql` (raffiné, exécutable).
   AVANT d'implémenter : lister tout désaccord avec `schema.sql`
   (contraintes manquantes, types, index) et attendre le go de Maxime.

   **Ajouts obligatoires au schéma :**

   Table `demandes` (machine à états, objet central du cockpit) :
   - états : `recue`, `analysee_ia`, `en_validation`, `approuvee`,
     `en_generation`, `prete`, `livree`, `confirmee_recue`, `rejetee_ia`,
     `expiree`. Enum ou CHECK, transitions horodatées (timestamptz UTC).
   - type : `paroles`, `chanson`, `video`, `cover` (enum extensible ;
     seul le flux chanson a une UI et un pipeline en v1).
   - colonnes : `analyse_ia jsonb` (catégories + confiance par catégorie),
     `paroles_proposees text`, `courriel_propose text`,
     `confiance_globale numeric`, `modifications_humaines jsonb`
     (diff entre proposé et approuvé, capturé à CHAQUE validation),
     `cout_ia_cents integer`, lien projet, version A/B.
   - contrainte : une seule analyse par demande et par version
     (`unique(demande_id, version_analyse)`).

   Table `evenements_livraison` (les 4 signaux de réception) :
   - `courriel_envoye` (Mailgun accepted), `courriel_ouvert`
     (webhooks Mailgun delivered/opened), `page_visitee_at`
     (ping serveur au chargement de la page token),
     `lecture_demarree_at` (événement play du lecteur audio/vidéo).

   Table `dictionnaire_prononciation` :
   - `mot`, `graphie_phonetique`, `contexte`, `source_demande_id`,
     `created_at`. `UNIQUE(mot, contexte)`.
   - Appliqué par une passe de remplacement AVANT chaque appel de
     génération de paroles. Alimenté depuis le cockpit en un clic
     lors d'une correction de prononciation.

2. **Règles dures du schéma :**
   - Pooler transaction pour le runtime, `prepare: false`, jamais de
     connexion directe depuis une fonction.
   - RLS activé, policies écrites AVANT activation (portée réelle :
     section 2, point 3).
   - Soft-delete (`deleted_at timestamptz`) sur toutes les tables métier.
     Toute lecture applicative filtre `deleted_at IS NULL` via helper de
     requête ou vues, pour que le filtre ne puisse PAS être oublié.
   - `audit_log` via triggers SEULEMENT sur tables argent, commande,
     demandes en Phase 1.
   - `numeric` pour l'argent (revient en STRING de postgres.js,
     interdiction de parseFloat sur de l'argent), NOT NULL,
     CHECK (montant >= 0).
   - `timestamptz` UTC partout, `created_at` + `updated_at` (trigger).
   - Contraintes qui échouent FORT : UNIQUE sur token/UUID,
     `stripe_event_id`, `suno_task_id`. FK avec ON DELETE explicite
     (jamais de cascade silencieuse non voulue). Enum ou CHECK pour
     `song_type` (CM/CPT) et tous les états.

3. **Types TypeScript générés depuis le schéma** (source unique de vérité).
   Le build casse si les types sont désynchronisés.

4. **`_lib/db` avec Drizzle** sur le pooler transaction, `prepare: false`.
   Aucune requête brute non paramétrée.

5. **GitHub Actions :** migrations appliquées au merge sur main
   (drizzle-kit migrate, secret de connexion DIRECTE port 5432, pas le
   pooler). Le job migrate prod tourne dans un GitHub Environment protégé
   avec approbation manuelle : une migration cassée ne s'auto-applique
   jamais sans clic de Maxime.

6. **CI sur chaque PR :** `node --check`, tests, drizzle-kit check
   (détection de drift), migrations-depuis-zéro sur Postgres éphémère
   dans le runner (bloquant si échec), smoke test de connexion réelle.

## 5. Observabilité et alertes (règle transversale, exigence numéro 1)

**Principe :** aucune erreur avalée. Chaque opération critique finit dans UN
de ces trois états : confirmée, échouée avec alerte, ou en attente SURVEILLÉE
par watchdog. L'état "on ne sait pas" est interdit par design.

### Trois niveaux de gravité (obligatoire, sinon alert fatigue)

- **P1 (alerte immédiate)** : webhook Stripe en échec, écriture commande
  ratée, génération Suno échouée ou expirée, livraison client ratée,
  `/health` rouge, canari e2e en échec.
- **P2 (digest quotidien)** : retries qui ont fini par réussir, events
  ignorés (idempotence), bounces courriel isolés, erreurs JS front non
  bloquantes, échec d'analyse IA retombée en `recue`.
- **P3 (log structuré seulement)** : tout le reste, consultable.

### Mécanismes obligatoires

- **Wrapper commun** sur TOUTES les fonctions Netlify : catch global, log
  JSON structuré (fonction, token/projet, message, stack), Sentry, réponse
  5xx. Interdits : catch vide, console.log seul, erreur retournée en 200.
  La CI échoue si une fonction n'utilise pas le wrapper.
- **Watchdog pg_cron aux 5 minutes** : tout état intermédiaire trop vieux
  (demande, génération, checkout) passe en `expiree` avec alerte P1, seuil
  par type de job. C'est LA parade au callback Suno qui n'arrive jamais :
  un try/catch ne capte pas un silence.
- **Retries bornés** puis état mort avec alerte P1. Jamais de retry infini.
- **Sentry browser** sur les pages funnel : erreurs JS et fetch échoués
  capturés. Tout submit échoué = message visible au client ET loggé serveur.
- **Webhooks Mailgun** (delivered, opened, bounce, failure) écrits en base.
  Bounce d'un courriel de livraison de chanson = P1.
- **`/health`** : connexion pooler + SELECT trivial + profondeur de file,
  200/500, pingé par le monitoring externe (Healthchecks existant).
- **Canari e2e quotidien** par cron : parcours complet en mode test
  (survey, génération TEST, page aperçu). Échec = P1. Seul mécanisme qui
  détecte une panne quand aucun client n'est sur le site.
- **Stripe** : chaque event reçu/traité/ignoré loggé. Signature invalide =
  P1. Checkout créé sans paiement après 24 h = P2 (signal funnel).
- **Pipeline IA** : échec API ou JSON invalide = retry borné puis retour en
  `recue` avec flag P2. Une demande ne peut JAMAIS se perdre entre deux
  états. Log tokens et coût par appel, digest hebdo.

**Livrable exigé :** chaque PR liste les modes de panne silencieux du domaine
touché et le mécanisme (wrapper, watchdog, contrainte, canari) qui les rend
bruyants.

## 6. Cockpit v1 : la file de demandes (spec verrouillée, codée en Phase 2)

Une seule page. Objet central : LA DEMANDE, pas le client.

- **Inbox de demandes** triée par urgence automatique : les plus vieilles
  en `recue` remontent en rouge. Zéro décision mentale sur l'ordre.
- **Pastilles des 4 signaux de réception** par ligne (envoyé, ouvert,
  page visitée, lecture démarrée). "Courriel envoyé" ne prouve rien :
  la boucle est fermée seulement à la preuve de réception.
- **Écran de validation** (le cœur) : demande brute du client, analyse IA,
  diff paroles avant/après, courriel proposé. Trois boutons : approuver
  tel quel (lance génération + envoi), modifier puis approuver, rejeter
  l'analyse. Toute modification avant approbation est stockée en diff :
  c'est le jeu d'évaluation qui débloquera l'automatisation par catégorie.
- **Compteur de révisions visible** (ex. 2/3), bouton désactivé au plafond,
  override possible et tracé dans `audit_log`.
- **Bouton "nouvelle demande"** : collage manuel d'un courriel, choix du
  projet et du type, 15 secondes. Pour les courriels de transition.
- **Bouton "ajouter au dictionnaire de prononciation"** contextuel lors
  d'une correction.
- **Login simple**, pas de multi-rôles. Supabase Studio couvre les
  consultations brutes en attendant.
- **Watchdog branché** : livrée depuis 48 h sans visite de page = relance
  auto ou alerte P2 pour relance manuelle.

**INTERDIT en v1 :** fiche client 360, Refine, recherche plein texte, KPIs
marketing, UI pour les types video et autres (prévus dans l'enum seulement).
Chaque item de cette liste retarde le jour où la douleur quotidienne s'arrête.
On rediscute après la vingtième commande traitée sur le nouveau système.

## 7. Pipeline IA (Phase 2) : portage + structuration

**Cadrage :** l'analyse IA est un PORTAGE du code Netlify existant (prompts
et logique conservés, prouvés en usage réel). La structuration est du NEUF :
JSON validé par schéma, scores de confiance, diff des corrections,
idempotence, dictionnaire de prononciation.

**Règles dures :**

- Analyse Anthropic déclenchée à l'entrée d'une demande de type chanson :
  décomposition en catégories (paroles à ajuster, mélodie, style, voix,
  prononciation), JSON strict validé par schéma à la réception, output
  complet écrit en base. Jamais de texte libre non structuré.
- Génération automatique des nouvelles paroles et du courriel client
  personnalisé, écrits en base comme PROPOSITIONS.
- Confiance basse ou ambiguïté entre catégories = demande flaggée
  "lecture humaine", aucune proposition auto.
- **AUCUN envoi client ni génération Suno sans approbation humaine en v1.**
  L'automatisation par catégorie se débloque plus tard sur preuve chiffrée
  (taux d'approbation sans modification sur les N dernières demandes),
  jamais par décision de confort. Asymétrie de risque : le clic coûte
  10 secondes, une erreur auto-envoyée à une famille endeuillée coûte
  la marque.
- Les prompts vivent dans `_lib/prompts/` comme fichiers versionnés,
  jamais en dur dans une fonction. Chaque modification de prompt passe
  en PR et se teste contre le jeu d'exemples réels (régression).
- Passe dictionnaire de prononciation appliquée AVANT chaque appel de
  génération de paroles.

## 8. Conventions de travail

- Français, tutoiement, jamais de tiret cadratin, tags
  [Certain] / [Probable] / [Spéculation].
- Toujours branche + PR, une PR par phase, Maxime merge lui-même.
  Jamais de commit sur main.
- Ne pas toucher au travail non commité d'autres sessions
  (ex. `cockpit-data.js`, `lire-projet.js`).
- Rien de destructif (PURGE_ACTIF, coupe Airtable, Stripe live) sans
  demander à Maxime.
- Une phase ne démarre pas sans le go explicite de Maxime.

## 9. Matériel à fournir par Maxime (avant la Phase 2)

1. **5 à 10 exemples réels** du processus manuel actuel : demande brute du
   client, décomposition faite, paroles corrigées, courriel envoyé. Sert
   de few-shot et de jeu de régression pour le prompt d'analyse porté.
2. **Confirmer où vivent les prompts IA actuels** : strings dans les
   fonctions (à extraire vers `_lib/prompts/`) ou déjà en fichiers séparés
   (à pointer).
3. **Vérifier** si des résultats du pipeline IA sont aujourd'hui consultés
   via des vues Airtable : si oui, Studio devient le seul écran entre la
   bascule et le cockpit Phase 2.

## 10. Definition of Done : Phase 1

- [ ] Runbook corrigé en PR (contradictions coexistence retirées, nouvel
      ordre des phases, corrections d'archi intégrées) OU ce document
      adopté comme source de vérité à sa place
- [ ] Inventaire de contamination Airtable + audit Make approuvés
- [ ] `supabase/` + migrations versionnées, appliquées en CI depuis zéro
- [ ] Tables `demandes`, `evenements_livraison`,
      `dictionnaire_prononciation` dans le schéma
- [ ] Types TS générés, build vert
- [ ] `_lib/db` (Drizzle, pooler, prepare: false) opérationnel
- [ ] GH Actions migrate derrière environment protégé
- [ ] CI verte : node --check, tests, drizzle-kit check,
      migrations-depuis-zéro, smoke test connexion
- [ ] Wrapper d'erreur commun créé et imposé par la CI
- [ ] RLS activé + policies, doc claire de sa portée réelle
- [ ] Idempotence Stripe et Suno dans le schéma
- [ ] Liste des pannes silencieuses neutralisées, PR par PR

## 11. Risques résiduels assumés

- [Probable] La tentation de gonfler le cockpit v1 est le risque numéro 1
  du projet. Garde-fou : la liste INTERDIT de la section 6.
- [Probable] La prononciation restera le point dur du produit. Le
  dictionnaire auto-alimenté est un actif cumulatif : chaque correction
  devient permanente au lieu de jetable.
- [Spéculation] Le volume courriel mettra 2 à 3 semaines à se déplacer
  vers le formulaire de révision. La réponse auto et le lien dans chaque
  courriel de livraison accélèrent la transition.

---

## Prompt de démarrage (à copier-coller dans Claude Code)

```
On démarre la migration vers Supabase du projet Chanson Mémoire.

Source de vérité : docs/supabase-evaluation/plan-migration-supabase-v2.md.
Lis-le EN ENTIER en premier, ainsi que les autres docs de
docs/supabase-evaluation/ et ma mémoire. En cas de conflit avec
runbook-migration.md, le plan v2 GAGNE (le runbook contient des
contradictions héritées sur la coexistence : il y en a ZÉRO, partout).

État confirmé : projet Supabase créé (Canada Central), secrets
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL posés dans
Netlify, 0 donnée à migrer, MCP Supabase PAS branché (tu travailles
depuis le code et la CI, jamais la base directement), migrations
appliquées par GitHub Actions uniquement.

Démarre la PHASE 1 (Fondations) telle que définie dans le plan v2 :

0. Étape 0 : inventaire de contamination Airtable de toutes les
   fonctions Netlify du .ca (appels, champs en string, filterByFormula,
   rollups, record IDs, retries rate-limit) + audit Make (grep
   hook.make.com / integromat / fallbacks type CALLBACK_CHANSON,
   verdict binaire : mort et supprimé, ou remplacé par échec bruyant).
   Tableau à me faire approuver AVANT le schéma.
1. Init supabase/ + migrations versionnées depuis schema.sql raffiné,
   avec les tables demandes (machine à états + analyse_ia jsonb +
   modifications_humaines), evenements_livraison (4 signaux) et
   dictionnaire_prononciation. Signale tout désaccord avec schema.sql
   AVANT de coder.
2. Règles dures : pooler transaction port 6543 avec prepare:false pour
   le runtime, connexion directe port 5432 pour les migrations (JAMAIS
   l'inverse), RLS activé avec policies écrites avant activation ET doc
   de sa portée réelle (service_role bypasse RLS : la sécurité runtime
   est le code), soft-delete partout avec filtre impossible à oublier,
   audit_log sur argent/commande/demandes seulement, numeric pour
   l'argent (string en JS, pas de parseFloat), timestamptz UTC,
   UNIQUE sur token / stripe_event_id / suno_task_id, FK ON DELETE
   explicites.
3. Types TypeScript générés depuis le schéma, build cassé si désync.
4. _lib/db avec Drizzle sur le pooler (prepare:false).
5. GitHub Actions : drizzle-kit migrate au merge sur main avec la
   connexion DIRECTE, dans un Environment protégé à approbation
   manuelle.
6. CI : node --check, tests, drizzle-kit check, migrations-depuis-zéro
   sur Postgres éphémère (bloquant), smoke test de connexion.
7. Observabilité dès la Phase 1 : wrapper d'erreur commun obligatoire
   sur toutes les fonctions (imposé par la CI, zéro catch vide, zéro
   erreur en 200), niveaux P1/P2/P3, endpoint /health. Le watchdog
   pg_cron et le canari e2e sont spécifiés maintenant, branchés en
   Phase 2.

Mes conventions : français, tutoiement, jamais de tiret cadratin, tags
[Certain]/[Probable]/[Spéculation]. Branche + PR, une PR par phase, je
merge moi-même, jamais de commit sur main. Ne touche pas au travail non
commité d'autres sessions (cockpit-data.js, lire-projet.js). Rien de
destructif (PURGE_ACTIF, coupe Airtable, Stripe live) sans me demander.

Avant de coder : lis le plan v2 et propose-moi le plan précis de la
Phase 1, Étape 0 comprise. À la fin de la phase : dis-moi la SEULE
action manuelle que je dois faire (quels secrets DB créer dans GitHub
Actions, en précisant lequel est la connexion directe pour les
migrations vs le pooler pour le runtime) et montre-moi une preuve
VISIBLE que les tables se créent dans Supabase (sortie du job CI
listant les tables via information_schema). Ne démarre pas la Phase 2
sans mon go. La spec du cockpit file de demandes et du pipeline IA
(sections 6 et 7 du plan v2) se code en Phase 2, PAS maintenant.
```

---

## AMENDEMENTS (2026-07-02, approuvés par Maxime après contre-analyse)

Ces amendements complètent le plan sans le renverser. En cas de conflit, l'amendement gagne.

1. **Contexte prod rectifié.** L'ancien système (GHL + Make + un Airtable DISTINCT de
   celui de ce repo) est ENCORE en production et génère le revenu. « Make éteint » vaut
   pour le nouveau .ca uniquement. Le dossier `make/` (docs de l'ancien système) est
   conservé jusqu'à l'extinction du .com.
2. **Lancement flexible, stratégie confirmée = ce plan.** Lancement du .ca à FAIBLE
   volume directement sur Supabase après la Phase 2 (le rodage, c'est le lancement
   progressif) ; le .com continue de payer pendant la construction. Zéro migration de
   données, zéro coexistence, zéro cutover. Le remplacement du .com reste la dernière
   étape (décision business de Maxime). Question ouverte à trancher AVANT ce
   remplacement : sort des données/clients de l'ancien système (historique, modifs
   tardives, droits Loi 25 sur l'ancien stock).
3. **Auth + rôles dès le cockpit v1** (Nathalie arrive ≤3 mois) : Supabase Auth avec
   rôles ops/admin remplace le « login simple » du §6. L'INTERDIT du §6 (fiche 360,
   Refine, KPIs...) reste inchangé.
4. **Cockpit : l'âge de chaque demande est AFFICHÉ** (le mur n°1 de Maxime = vitesse de
   réponse client) ; la file auto-triée du §6 reste la règle.
5. **Alertes P1 = push mobile Sentry + courriel** (choix Maxime). P2 digest quotidien,
   P3 logs. Détail : docs/supabase-evaluation/observabilite.md.
6. **Analytics scindé.** Le tracking transactionnel (suivi funnel, attribution UTM,
   dédup CAPI) est cousu aux projets : il se porte DANS la tranche verticale Phase 2.
   Seuls insights-cron / pub-join (tables Pubs autonomes) restent en Phase 3+, avec
   leurs tables dans une migration dédiée au moment du portage (pas dans la migration
   initiale).
7. **Loi 25.** Lancement faible volume permis avec procédure MANUELLE documentée pour
   les demandes d'accès/effacement (réponse sous 30 jours) ; l'outillage (export,
   anonymisation en un clic, tracé dans audit_log) se code en fin de Phase 2, AVANT la
   montée en volume. Validation des textes/durées par un professionnel = action Maxime.
8. **IA progressive sur preuve** (choix Maxime, = §7 du plan) : aucun envoi client ni
   génération sans clic en v1 ; l'auto-envoi se débloque par catégorie sur preuve
   chiffrée, jamais par confort. `demandes.modifications_humaines` capture le diff à
   chaque validation ; `demande_analyses` trace coût et version de prompt par appel.
9. **Réalité du code intégrée au schéma.** `analyse_ia` épouse le JSON réel de
   `_lib/analyse-modif` (5 catégories EXACTES : paroles, style_ambiance, prononciation,
   souvenirs, titre ; mode cover/regeneration ; nouvelle_chanson ; prononciations[]).
   `song_type` réel = hommage/cadeau (le « CM/CPT » du §4 était périmé). Les prompts
   vivent inline dans 11 fichiers : extraction vers `_lib/prompts/` au portage Phase 2.
