// Configuration drizzle-kit — migrations versionnées dans supabase/migrations/.
//
// RÈGLE DURE (plan v2) : deux connection strings, jamais une seule.
//   - `drizzle-kit generate` / `check`   : hors-ligne, aucune connexion requise.
//   - `drizzle-kit migrate`              : connexion DIRECTE port 5432 (jamais le pooler
//     transaction 6543 : le DDL n'y est pas fiable). En CI : secret SUPABASE_DB_URL_DIRECT.
//   - Le runtime (fonctions Netlify) utilise le pooler 6543 via _lib/db.ts, JAMAIS ce fichier.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema.ts',
  out: './supabase/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Posée uniquement au moment de `migrate` (CI). generate/check n'en ont pas besoin.
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
