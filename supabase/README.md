# supabase/ — migrations versionnées (la SEULE porte vers la base)

> Personne ne copie-colle du SQL dans le dashboard Supabase. Jamais.
> Tout changement de schéma = fichier de migration en PR, appliqué par GitHub Actions.

## Comment ça marche

1. **Source de vérité** : [`db/schema.ts`](../db/schema.ts) (Drizzle, TypeScript).
   Les types TS des tables en dérivent directement : une colonne renommée casse
   `tsc` (donc la CI), pas la prod en silence.
2. **Changer le schéma** : modifier `db/schema.ts`, puis `npm run db:generate`
   → un nouveau fichier SQL numéroté apparaît ici. Le relire, le commiter en PR.
   Pour du SQL manuel (trigger, vue, policy) : `npx drizzle-kit generate --custom --name=mon_nom`.
3. **CI de PR** (`.github/workflows/ci.yml`, job `fondations-supabase`) :
   types, contrat d'observabilité, `drizzle-kit check` (dérive schéma/migrations),
   **migrations depuis ZÉRO sur un Postgres éphémère (bloquant)**, preuve
   `information_schema`, smoke test des contraintes. Aucun secret.
4. **Prod** (`.github/workflows/migrations-prod.yml`) : au merge sur main, le job
   attend l'**approbation manuelle de Maxime** (Environment `production-db`), applique
   les migrations avec la connexion **DIRECTE port 5432** (secret
   `SUPABASE_DB_URL_DIRECT`), puis imprime la liste des tables (la preuve).

## Les deux connection strings (à ne JAMAIS confondre)

| Usage | Port | Où elle vit | Garde-fou |
|---|---|---|---|
| **Migrations** (drizzle-kit, CI) | **5432** direct | Secret GitHub `SUPABASE_DB_URL_DIRECT` (Environment `production-db`) | le job migrate REFUSE une URL :6543 |
| **Runtime** (fonctions Netlify) | **6543** pooler transaction | Env Netlify `SUPABASE_DB_URL` | `_lib/db.ts` REFUSE une URL :5432, `prepare: false` en dur |

## Fichiers

- `migrations/0000_extensions.sql` — citext.
- `migrations/0001_schema_initial.sql` — 14 tables, enums, contraintes (généré).
- `migrations/0002_garde_fous.sql` — triggers updated_at + etat_depuis + audit_log,
  RLS partout (portée réelle : [docs/supabase-evaluation/rls-portee.md](../docs/supabase-evaluation/rls-portee.md)),
  vues soft-delete `*_actifs`, vue des plafonds `project_counts` (règle v2).
- `migrations/meta/` — snapshots drizzle-kit (ne pas éditer à la main).
