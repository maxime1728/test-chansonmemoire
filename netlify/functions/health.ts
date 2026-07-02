// /api/health — sonde de santé (plan v2 §5) : connexion pooler + SELECT trivial
// + GARDE-FOU DE DÉCALAGE CODE/SCHÉMA. 200 = vert ; toute panne = 500 + P1 + Sentry.
//
// Le garde-fou vient d'un incident réel (2026-07-02) : Netlify déploie le code à la
// seconde du merge, mais la migration attend l'approbation du workflow GitHub. Dans
// cette fenêtre, le code utilise des colonnes qui n'existent pas encore et le funnel
// casse en silence. Ici : le nombre de migrations EMBARQUÉES dans ce déploiement est
// comparé aux migrations APPLIQUÉES en base. En retard = /health ROUGE immédiatement.
import { avecErreurs } from './_lib/http';
import { sqlClient } from './_lib/db';
import journal from '../../supabase/migrations/meta/_journal.json';

export const handler = avecErreurs('health', async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'GET seulement' }) };
  }
  const debut = Date.now();
  const [ligne] = await sqlClient()`select 1 as ok`;
  if (ligne?.ok !== 1) throw new Error('SELECT 1 a renvoyé une valeur inattendue');

  const attendues = Array.isArray(journal.entries) ? journal.entries.length : 0;
  let appliquees = 0;
  try {
    const [m] = await sqlClient()`select count(*)::int as n from drizzle.__drizzle_migrations`;
    appliquees = Number(m?.n ?? 0);
  } catch {
    // Table de journal absente = base jamais migrée : même diagnostic qu'un retard.
    appliquees = 0;
  }
  if (appliquees < attendues) {
    // wrapper -> P1 + Sentry + 500 : visible par Healthchecks ET par le premier curl venu.
    throw new Error(
      `migrations en retard : ${appliquees}/${attendues} appliquées. Approuver le workflow « Migrations Supabase (prod) » dans GitHub Actions.`,
    );
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      ok: true,
      db: 'ok',
      migrations: `${appliquees}/${attendues}`,
      latence_ms: Date.now() - debut,
      version: (process.env.COMMIT_REF ?? '').slice(0, 7) || null,
    }),
  };
});
