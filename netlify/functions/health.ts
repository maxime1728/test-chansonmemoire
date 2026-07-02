// /api/health — sonde de santé (plan v2 §5) : connexion pooler + SELECT trivial.
// 200 = vert ; toute panne DB = exception -> wrapper -> 500 + P1 + Sentry.
// Pingé par le monitoring externe (Healthchecks) ; la profondeur de file s'ajoutera
// quand la file existera (Phase 2+). Aucune donnée sensible exposée.
import { avecErreurs } from './_lib/http';
import { sqlClient } from './_lib/db';

export const handler = avecErreurs('health', async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'GET seulement' }) };
  }
  const debut = Date.now();
  const [ligne] = await sqlClient()`select 1 as ok`;
  const ok = ligne?.ok === 1;
  if (!ok) throw new Error('SELECT 1 a renvoyé une valeur inattendue');
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      ok: true,
      db: 'ok',
      latence_ms: Date.now() - debut,
      version: (process.env.COMMIT_REF ?? '').slice(0, 7) || null,
    }),
  };
});
