# Observabilité : zéro erreur silencieuse (règle transversale, exigence n°1)

> Plan v2 §5. Principe : chaque opération critique finit dans UN de ces trois états :
> confirmée, échouée AVEC alerte, ou en attente SURVEILLÉE par watchdog.
> L'état « on ne sait pas » est interdit par design.

## Niveaux de gravité (sinon alert fatigue)

| Niveau | Canal | Exemples |
|---|---|---|
| **P1** | **Push mobile Sentry + courriel, immédiat** | webhook Stripe en échec, écriture commande ratée, génération Suno échouée/expirée, livraison ratée, bounce d'un courriel de livraison, /health rouge, canari e2e rouge |
| **P2** | Digest quotidien | retries qui ont fini par réussir, events ignorés (idempotence), bounces isolés, échec d'analyse IA retombée en `recue` |
| **P3** | Log structuré seulement | tout le reste, consultable dans les logs Netlify |

Canal P1 choisi par Maxime (2026-07-02) : **notification push via l'app mobile Sentry**
+ courriel. Configuration : installer l'app Sentry, créer une Alert Rule « niveau P1 »
(les logs du wrapper taguent la fonction ; les captures Sentry portent le contexte).
Zéro système ajouté.

## Mécanismes livrés en Phase 1

1. **Wrapper commun** (`_lib/http.ts` + `_lib/journal.ts`) : catch global, log JSON
   structuré (niveau, fonction, message, stack et chemin NETTOYÉS des tokens/courriels),
   capture Sentry, réponse 5xx générique (aucun détail interne au client).
   **Imposé par la CI** (`scripts/verifier-wrapper.mjs`) : une fonction TS sans wrapper
   ou un catch vide = CI rouge. Les 78 fonctions .js legacy gardent `withSentry`
   jusqu'à leur portage.
2. **Contraintes qui échouent FORT** (migrations 0001/0002) : doublon de paiement,
   double callback Suno, génération orpheline, montant négatif = physiquement
   impossibles. Prouvé à chaque PR par `scripts/smoke-db.mjs` sur Postgres éphémère.
3. **`/health`** (`netlify/functions/health.ts`) : connexion pooler + SELECT trivial,
   200/500. À brancher sur le Healthchecks existant quand le runtime Supabase portera
   du vrai trafic (Phase 2). La profondeur de file s'ajoutera avec la file.
4. **audit_log** par triggers sur argent/commande/demandes (qui a changé quoi, quand).

## Spécifiés MAINTENANT, branchés en Phase 2

### Watchdog pg_cron (aux 5 minutes)

La parade au silence (un try/catch ne capte pas un callback qui n'arrive JAMAIS).
Fonction SQL exécutée par `pg_cron` dans Supabase :

- toute `demande` dont `etat` est intermédiaire (`recue`, `analysee_ia`, `en_validation`,
  `approuvee`, `en_generation`) et `etat_depuis` plus vieux que le seuil DE SON TYPE
  passe en `expiree` + ligne d'alerte P1 ;
- même logique pour `generations.status` (`lyrics_generated`, `audio_pending` trop
  vieux) et pour les checkouts sans paiement (>24 h = P2, signal funnel) ;
- seuils par type de job dans une table de config, pas en dur ;
- la colonne `demandes.etat_depuis` + le trigger `fn_demandes_etat_depuis` (migration
  0002) sont DÉJÀ en place : le watchdog n'aura qu'à lire.
- relance client : `livree` depuis 48 h sans `evenements_livraison.page_visitee`
  = relance auto ou alerte P2 (spec cockpit §6 du plan v2).

### Canari e2e quotidien

Parcours complet en mode test (survey → génération TEST → page aperçu) par cron,
comme l'actuel `e2e-canari-cron`, re-pointé sur les fonctions Supabase. Échec = P1.
Seul mécanisme qui détecte une panne quand personne ne visite le site. Le `canal`
'canari' existe déjà dans le CHECK de `demandes` pour marquer (et purger) ses données.

### Autres règles Phase 2 (contrat pour chaque PR de portage)

- Retries bornés puis état mort avec P1. Jamais de retry infini.
- Webhooks Mailgun écrits en base (`courriels` + `evenements_livraison`).
- Stripe : chaque event reçu/traité/ignoré loggé (`stripe_events`), signature invalide = P1.
- Pipeline IA : échec API ou JSON invalide = retry borné puis retour `recue` + P2 ;
  une demande ne peut JAMAIS se perdre entre deux états ; tokens et coût par appel
  dans `demande_analyses`.
- **Chaque PR de portage liste les modes de panne silencieux du domaine touché et le
  mécanisme qui les rend bruyants** (livrable exigé, plan v2 §5).

## Pannes silencieuses neutralisées par CETTE PR (Phase 1)

| Mode de panne silencieux | Neutralisé par |
|---|---|
| Fonction TS qui plante sans trace | wrapper obligatoire (CI) : log P1 + Sentry + 500 |
| Erreur « avalée » dans un catch vide | interdit par la CI (`verifier-wrapper.mjs`) |
| Token/courriel qui fuit dans les logs | `nettoyer()` appliqué au message, à la stack et au chemin (testé) |
| Migration qui casse la base en prod | migrations-depuis-zéro BLOQUANTES en CI + Environment protégé à approbation manuelle |
| Schéma et types qui divergent | `tsc --noEmit` + `drizzle-kit check` en CI |
| Doublon Stripe/Suno traité deux fois | contraintes UNIQUE prouvées par smoke test à chaque PR |
| Suppression accidentelle de données | soft-delete + vues `*_actifs` + audit_log par triggers |
| Runtime branché sur la mauvaise connexion | `_lib/db.ts` REFUSE le port 5432 ; le job migrate REFUSE le port 6543 |
