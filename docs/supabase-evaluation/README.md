# Évaluation : Airtable → Supabase pour le nouveau build (CM / CPT)

> Rédigé le 2026-07-01. Contexte : le système de ce repo (Netlify + Airtable, .ca) est
> **pré-lancement**. La prod qui génère du revenu = l'ancien **GHL + Make sur .com**.
> Objectif de Maxime : bâtir un système **durable long terme**. Donc c'est la bonne
> fenêtre pour choisir la fondation de données, **avant** le lancement.

Documents liés :
- [`schema.sql`](schema.sql) — le schéma Postgres équivalent
- [`queue.md`](queue.md) — remplacer les 5 crons/minute par une vraie file d'attente

---

## 0. Verdict

**Oui : bâtir le nouveau système sur Supabase (Postgres) + TypeScript avant le lancement.** `[Recommandation]`

Migrer une DB après le lancement, sous vraies commandes clients, est le pire moment. Tu es
dans la fenêtre où ce coût est le plus bas, et « durer longtemps » est exactement le critère
qui disqualifie Airtable comme **fondation** (c'est un plafond, pas un socle).

Trois décisions **séparées** :
1. **Données : Airtable → Supabase** → OUI, maintenant. Le gros du gain.
2. **TypeScript** → OUI, progressif. Meilleur ROI, plus bas risque.
3. **Hébergement : Netlify → Vercel** → NON. Aucun gain décisif, re-test de toute l'infra crons/functions.
4. **React** → seulement pour le cockpit (UI interne complexe). Les pages funnel restent statiques (SEO/perf).

---

## 1. Inventaire de l'existant (mesuré)

- **77 fonctions Netlify**, dont **73 tapent dans Airtable**, **71 usages de `filterByFormula`**.
- **18 crons**, dont **5 chaque minute** (`cover`, `envoyer`, `brouillon`, `modif`, `appliquer`) = file d'attente simulée par polling.
- **Modèle relationnel** : Clients 1→N Projects 1→N Generations ; + Upsells, Pubs, Pubs_Performance, Conversations.
- **Comptages (plafonds)** faits par **rollups Airtable filtrés** (fragiles, « manuel UI »).
- **Frontend** : HTML/JS statique, **zéro build**, 3 dépendances npm.

### Les 77 fonctions par rôle (buckets de migration)

| Bucket | Fonctions (exemples) | Nb | Effort unitaire | Ce qui change |
|---|---|---|---|---|
| **Lectures** | `lire-projet`, `lire-survey`, `lire-versions`, `lire-modifications`, `lister-photos`, `cockpit-data`, `statut-render`, `suno-status` | ~8 | Faible | `filterByFormula` → `SELECT` (souvent plus simple) |
| **Écritures / actions client** | `soumettre-survey`, `demander-modif-client`, `appliquer-modification`, `commander-bump`, `creer-upsell`, `accepter-livraison`, `choix-memoire`, `prononciation`, `essayer-style`, `capter-timing`, photos… | ~16 | Moyen | Insert/Update + contraintes (fini les upserts bricolés) |
| **Lanceurs de jobs** | `lancer-chanson`, `lancer-cover`, `lancer-instrumentale`, `lancer-paroles-vivantes`, `lancer-video-memoire`, `lancer-signet`, `lancer-cadeau` | 7 | Moyen | Deviennent des **producteurs de queue** |
| **Callbacks (async externes)** | `callback-chanson`, `callback-cover`, `callback-instrumentale`, `callback-paroles-vivantes`, `callback-video-memoire` | 5 | Moyen | Match par `suno_task_id` indexé (au lieu de `filterByFormula`) |
| **Background** | `decortique(-background)`, `generate-lyrics(-background)` | 4 | Moyen | Deviennent des **workers de queue** |
| **Crons "file déguisée"** | `cover-cron`, `envoyer-cron`, `brouillon-cron`, `modif-cron`, `appliquer-cron` | 5 | Élevé (redesign) | **Disparaissent** → workers de queue (voir `queue.md`) |
| **Crons périodiques légitimes** | `nurture`, `sequences`, `recovery`, `insights`, `pub-join`, `purge`, + monitoring (`canari*`, `sentinelle`, `alerte`, `watchdog`) | ~12 | Faible | Repointés sur SQL ; `pg_cron` possible |
| **Paiements** | `creer-checkout`, `stripe-webhook`, `stripe-refund`, `ranger-achat` | 4 | Moyen | Transactions SQL (atomicité achat) |
| **Courriels** | `courriel-entrant`, `repondre-courriel`, `mailgun-events`, `courriel-achat`, `desabonnement`, `tester-courriel` | 6 | Faible/Moyen | CRUD sur `conversations` |
| **Tracking** | `capi-pageview`, `suivi-funnel`, `clic`, `insights-cron`, `pub-join-cron` | 5 | Moyen | Contraintes `UNIQUE` → **fin des doublons Pubs** |
| **Utilitaires** | `telecharger`, `signer-upload-photo`, `aide-plafond`, `recompter-comptage`, `keepwarm-cron`, `signaler-echec` | ~6 | Faible | `recompter-comptage` et `keepwarm` **disparaissent** |

> À noter : 2 fonctions **disparaissent purement** (`recompter-comptage` → les comptages
> deviennent une vue SQL toujours juste ; `keepwarm-cron` → plus de cold-start à réchauffer si
> les workers ne sont plus des fonctions à la demande). Et 5 crons/minute fusionnent en workers.

---

## 2. Airtable vs Supabase, mappé sur tes douleurs réelles

| Enjeu (vécu dans ce repo) | Airtable | Supabase / Postgres |
|---|---|---|
| Plafonds (`song_regenerations_count`) | Rollups filtrés fragiles | Vue SQL / trigger, toujours juste `[Certain]` |
| Doublons Pubs (déjà subis) | Pas de contrainte d'unicité | `UNIQUE` + `ON CONFLICT` `[Certain]` |
| Jointures (`clientEmailOf` = 2e fetch) | N+1 fetchs | `JOIN` en 1 requête `[Certain]` |
| Dérive de schéma (le doc `CM_mapping` existe *pour ça*) | Casse en silence | Migrations SQL versionnées + types `[Certain]` |
| File d'attente | 5 crons/minute (~216k inv./mois) | Queue réactive (`queue.md`) `[Probable]` |
| Débit | **~5 req/s par base** `[Certain]` | Milliers de req/s `[Certain]` |
| Échappement requêtes (hack `formulaLiteral`) | Bricolage | Requêtes paramétrées `[Certain]` |
| UI d'ops (Nathalie) | ★ Excellente, gratuite | À fournir (NocoDB/Retool) `[Certain]` |
| Zéro-ops | ★ Géré | Géré aussi (Supabase = Postgres managé) `[Certain]` |
| Résidence données (Loi 25) | US only `[Certain]` | Région **Canada (Central)** possible `[Probable, à confirmer]` |

Presque tout penche Supabase. Le seul vrai contre — l'UI d'ops — se règle **par conception**
puisqu'on est pré-lancement (voir §4).

---

## 3. Plan de migration (strangler, ordonné par risque croissant)

Jamais en big-bang. Ordre suggéré, du plus sûr au plus sensible :

1. **TypeScript sur les fonctions** (indépendant de la DB). Gain immédiat, zéro risque data.
2. **Stand up Supabase** + `schema.sql` raffiné + un `_lib/db.js` (client SQL partagé, calqué sur le style actuel `_lib`).
3. **Tables analytics d'abord** : `pubs`, `pubs_performance`, tracking funnel. Write-heavy, souffrent des doublons + rate limit, **Nathalie ne les édite pas** → migration sans coût UI. Valide Supabase sur du non-critique.
4. **La queue** (voir `queue.md`) : remplace les 5 crons/minute. Fort gain, isolable.
5. **Generations** : les plafonds deviennent une vue/trigger fiable.
6. **Clients / Projects en dernier** : le cœur de l'ops. À migrer **seulement quand l'UI d'ops de remplacement est en place et validée par Nathalie**.
7. **Coexistence** pendant la transition (double-écriture ou sync sur les tables en cours), puis on coupe Airtable table par table.

### Effort (t-shirt, à mon rythme avec toi) `[Spéculation]`

| Phase | Taille | Commentaire |
|---|---|---|
| TypeScript progressif | M | Fichier par fichier, en continu |
| Supabase + schéma + `_lib/db` | S | Fondations |
| Tables analytics | S–M | Peu de logique |
| Queue | M | Le redesign le plus « nouveau » |
| Generations + plafonds | M | Cœur métier, tests requis |
| Clients/Projects + UI ops | L | Dépend de l'UI de remplacement |

Ce n'est pas gratuit : les ~73 fonctions style Airtable = du rework réel. Mais fait
**pré-lancement**, ce rework ne met **aucun revenu en jeu** et t'évite la même migration
plus tard **sous trafic** (bien pire).

---

## 4. L'UI d'ops (le seul vrai blocage) — réglé par conception

Airtable donne gratuitement à Nathalie une grille éditable. Il faut un équivalent :

- **NocoDB** (open-source) : se pose **par-dessus ta base Postgres/Supabase** et offre une grille type Airtable. Le pont le plus doux pour Nathalie. `[Probable, à tester]`
- **Retool / Appsmith** : plus puissants, plus de build. Bien si l'ops se complexifie.
- Le **cockpit** que tu as déjà couvre une partie de l'ops (corrections/A-B) — il lit déjà une couche serveur, donc repointable sur Supabase.

Pré-lancement = on choisit **bien** cette UI dès le départ, au lieu de la retrofit après.

---

## 5. Comparatif de coûts `[Probable — à confirmer au pricing du jour]`

Ordres de grandeur, pas des devis. À revalider aux tarifs courants.

| | Airtable | Supabase |
|---|---|---|
| Modèle | **Par siège** | **Par usage** (pas de siège) |
| Entrée de gamme utile | Team ~20–24 $/siège/mois | Pro ~25 $/mois **à plat** |
| Plafond d'enregistrements | Team ~50k / base, Business ~125k | Limité par le disque (Go), pas par nb de lignes |
| Sauvegardes | Gérées | Quotidiennes (Pro) |
| Piège de croissance | `pubs_performance` (lignes **par pub par jour**) explose le quota de records **et** le rate limit 5 req/s | Le disque grandit linéairement, pas de mur de records |

Lecture : Airtable est bon marché **au début, à petite équipe**. Il devient cher et
contraignant quand (a) tu ajoutes des collaborateurs (coût par siège) et (b) le tracking pubs
génère beaucoup de lignes (quota + rate limit). Supabase a un coût **plat plus prévisible** et
ne te met pas de mur de records. Pour un système « qui doit durer », l'économique **et** le
technique pointent dans la même direction.

Bonus indirect : la queue supprime ~216k invocations Netlify/mois de polling à vide.

---

## 6. Ce qu'on garde inchangé dans tous les cas

Netlify (hébergement + functions + crons restants), Stripe, Mailgun, Suno, Creatomate,
Cloudinary, Meta CAPI, l'observabilité (Sentry, canaris), les pages funnel statiques.

Nouveaux à-côtés débloqués par Postgres : **Drizzle** (ORM typé léger, recommandé) ou Prisma,
**Supabase Auth** (vrai login cockpit au lieu de `COCKPIT_SECRET`), **pg-boss / Inngest**
(queue), **NocoDB** (UI d'ops). Neon = alternative Postgres si tu ne veux que la DB.

---

## 7. Prochaine étape recommandée

Puisque tu n'es pas sûr de l'avancement exact du build, l'étape la plus rentable avant de
s'engager : **un inventaire fonctionnel** (quels parcours end-to-end marchent déjà, lesquels
sont en chantier). Ça transforme l'effort « t-shirt » ci-dessus en estimation ferme, et ça dit
si on démarre par la Phase 1 (TypeScript) tout de suite ou si on attend un jalon du build.
