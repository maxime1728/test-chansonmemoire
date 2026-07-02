// POST /api/revision-paroles — { token, modifications? } : ajuster les paroles (funnel).
//
// PORTAGE du mode regenerate de generate-lyrics.js, en ASYNCHRONE : la génération part
// dans survey-paroles-background (jamais de timeout de fonction synchrone, le legacy
// jouait avec la limite ~20 s d'Anthropic), et la page sonde GET /api/projet jusqu'à
// voir generation_no augmenter. Sans modifications = RETRY idempotent (paroles jamais
// arrivées : le background no-op si des paroles valides existent déjà).
//
// Ici, un échec de déclenchement est BRUYANT (502 + P1) : contrairement à la soumission
// du sondage (données déjà sauvées), le client a explicitement demandé une action.
import { and, eq } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, urlBaseDeploy, type EvenementHttp } from './_lib/http';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODIFS_MAX = 4000; // garde-fou taille (le champ client est un textarea court)

export const handler = avecErreurs('revision-paroles', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }
  let d: { token?: string; modifications?: string };
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  }
  const token = (d.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  const modifications = typeof d.modifications === 'string' ? d.modifications.trim().slice(0, MODIFS_MAX) : '';

  const { projects } = schema;
  const [projet] = await db()
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };

  const base = urlBaseDeploy();
  const secret = process.env.GENERATE_LYRICS_SECRET || '';
  const r = await fetch(`${base}/.netlify/functions/survey-paroles-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, secret, modifications }),
  });
  if (!r.ok && r.status !== 202) {
    // wrapper -> journal P1 ; le client voit un échec clair au lieu d'attendre pour rien
    throw new Error(`déclenchement régénération: HTTP ${r.status}`);
  }

  return {
    statusCode: 202,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, en_cours: true }),
  };
});
