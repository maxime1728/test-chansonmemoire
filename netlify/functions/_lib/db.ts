// _lib/db.ts — LE point d'accès Supabase du runtime (fonctions Netlify).
//
// RÈGLES DURES (plan v2 §4, non négociables) :
//   - Pooler TRANSACTION port 6543 UNIQUEMENT. Jamais de connexion directe (5432)
//     depuis une fonction : épuisement de connexions garanti en serverless.
//     Le module REFUSE de démarrer sur une URL port 5432 (échec bruyant, pas silencieux).
//   - prepare: false OBLIGATOIRE : postgres.js casse en silence sur le pooler
//     transaction avec des prepared statements. Non configurable, en dur ici.
//   - Aucune requête brute non paramétrée : Drizzle (typé) ou le tag sql`` de
//     postgres.js (paramétré). Jamais de concaténation de chaînes SQL.
//   - Soft-delete : toute lecture applicative filtre deleted_at IS NULL via le
//     helper actif() ci-dessous ou les vues *_actifs (migration 0002).
//
// L'argent (numeric) revient en STRING : interdiction de parseFloat dessus.
import { drizzle } from 'drizzle-orm/postgres-js';
import { isNull, type Column } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../../../db/schema';

function urlRuntime(): string {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      '[db] SUPABASE_DB_URL manquante (env Netlify). Attendu : connection string du POOLER TRANSACTION (port 6543).',
    );
  }
  if (/:5432\b/.test(url)) {
    throw new Error(
      '[db] SUPABASE_DB_URL pointe vers le port 5432 (connexion directe). Le runtime doit utiliser le POOLER TRANSACTION port 6543 ; la connexion directe est réservée aux migrations CI.',
    );
  }
  return url;
}

// Singleton au niveau du module : réutilisé entre invocations d'un même conteneur.
let clientSql: ReturnType<typeof postgres> | undefined;

export function sqlClient(): ReturnType<typeof postgres> {
  if (!clientSql) {
    clientSql = postgres(urlRuntime(), {
      prepare: false, // OBLIGATOIRE sur le pooler transaction — ne jamais rendre configurable
      max: Number(process.env.DB_POOL_MAX ?? 1), // serverless : 1 connexion par conteneur
      idle_timeout: 20,
      connect_timeout: 10,
      connection: { application_name: 'cm-netlify-functions' },
    });
  }
  return clientSql;
}

let dbInstance: ReturnType<typeof creerDb> | undefined;
function creerDb() {
  return drizzle(sqlClient(), { schema });
}

// L'instance Drizzle typée depuis db/schema.ts : une colonne renommée casse à la
// compilation, pas en prod en silence.
export function db() {
  if (!dbInstance) dbInstance = creerDb();
  return dbInstance;
}

// Filtre soft-delete impossible à oublier : .where(actif(projects)) — ou combiné
// avec and(). Les nouvelles requêtes DOIVENT passer par actif() ou les vues *_actifs.
export function actif(table: { deletedAt: Column }) {
  return isNull(table.deletedAt);
}

export { schema };
