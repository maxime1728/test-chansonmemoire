// GET /api/projet?id=<token> — état du projet pour les pages funnel (attente, révision).
//
// PORTAGE de lire-survey/lire-projet (lecture par token), en UNE requête jointe au lieu
// de N fetchs. RÉPONSES FILTRÉES (audit sécurité) : on n'expose QUE ce que les pages
// affichent ; jamais le courriel, jamais les souvenirs bruts, jamais d'id interne.
import { and, desc, eq } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { stripSectionTags } from './_lib/lyrics';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = avecErreurs('projet', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'GET seulement' }) };
  }
  const token = (event.queryStringParameters?.id || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };

  const { projects, generations } = schema;
  const [projet] = await db()
    .select({
      id: projects.id,
      deceasedName: projects.deceasedName,
      songType: projects.songType,
      language: projects.language,
      musicStyle: projects.musicStyle,
      voice: projects.voice,
      mood: projects.mood,
      funnelStep: projects.funnelStep,
      commercialStatus: projects.commercialStatus,
    })
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };

  const [g] = await db()
    .select({
      generationNo: generations.generationNo,
      lyrics: generations.lyrics,
      songTitle: generations.songTitle,
      status: generations.status,
      suggestions: generations.suggestions,
    })
    .from(generations)
    .where(and(eq(generations.projectId, projet.id), actif(generations)))
    .orderBy(desc(generations.generationNo))
    .limit(1);

  const parolesValides = !!g?.lyrics && !!String(g.lyrics).trim() && !String(g.lyrics).includes('"invalid_input"');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      prenom: projet.deceasedName || '',
      song_type: projet.songType,
      langue: projet.language,
      style: projet.musicStyle || '',
      voix: projet.voice || '',
      ambiance: projet.mood || '',
      etape: projet.funnelStep || '',
      statut_commercial: projet.commercialStatus,
      generation_no: g?.generationNo ?? 0,
      a_paroles: parolesValides,
      titre: parolesValides ? g?.songTitle || '' : '',
      paroles: parolesValides ? stripSectionTags(g?.lyrics ?? '') : '',
      suggestions: parolesValides && Array.isArray(g?.suggestions) ? g.suggestions : [],
      statut_generation: g?.status ?? null,
    }),
  };
});
