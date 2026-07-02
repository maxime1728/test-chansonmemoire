// GET /api/apercu?id=<token> — données de la page aperçu (v2, nouveau funnel).
//
// Sert : titre, prénom, paroles PROPRES, URL audio SIGNÉE 60 s (du_60 dans la
// signature : non contournable), compteur d'appels client (routage révision), et la
// demande de révision ACTIVE s'il y en a une (pour reprendre l'état du panneau au
// rechargement). RÉPONSES FILTRÉES : jamais courriel, souvenirs bruts, URL complète.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { buildAudioUrl } from './_lib/audio';
import { stripSectionTags } from './_lib/lyrics';
import { SEUIL_REVISION_EQUIPE, compterAppelsClientPre } from './_lib/chanson';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ETATS_ACTIFS = ['recue', 'analysee_ia', 'en_validation', 'approuvee', 'en_generation'] as const;

export const handler = avecErreurs('apercu', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'GET seulement' }) };
  const token = (event.queryStringParameters?.id || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };

  const { projects, generations, demandes } = schema;
  const [projet] = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
  if (projet.commercialStatus !== 'preview_only') {
    // Acheté (ou remboursé) : l'aperçu n'est plus la bonne étape.
    return { statusCode: 409, body: JSON.stringify({ etape: 'achete' }) };
  }

  const [chanson] = await db()
    .select()
    .from(generations)
    .where(
      and(
        eq(generations.projectId, projet.id),
        inArray(generations.type, ['song', 'song_regeneration', 'cover']),
        inArray(generations.status, ['audio_generated', 'validated']),
        eq(generations.postPurchase, false),
        actif(generations),
      ),
    )
    .orderBy(desc(generations.generationNo))
    .limit(1);
  if (!chanson?.cloudinaryAudioUrl) {
    // Pas encore d'aperçu écoutable : la page renvoie vers l'attente.
    return { statusCode: 409, body: JSON.stringify({ etape: projet.funnelStep || 'song_generating' }) };
  }

  const appels = await compterAppelsClientPre(projet.id);
  const [demande] = await db()
    .select({
      id: demandes.id,
      etat: demandes.etat,
      parolesProposees: demandes.parolesProposees,
      demandeBrute: demandes.demandeBrute,
    })
    .from(demandes)
    .where(and(eq(demandes.projectId, projet.id), inArray(demandes.etat, [...ETATS_ACTIFS]), actif(demandes)))
    .orderBy(desc(demandes.recueAt))
    .limit(1);

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      prenom: projet.deceasedName || '',
      song_type: projet.songType,
      titre: chanson.songTitle || '',
      generation_no: chanson.generationNo,
      paroles: stripSectionTags(chanson.lyrics ?? ''),
      audio_url: buildAudioUrl(chanson.cloudinaryAudioUrl, 'du_60'), // 60 s signées, jamais la complète
      appels_utilises: appels,
      revision_equipe: appels >= SEUIL_REVISION_EQUIPE,
      demande: demande
        ? {
            id: demande.id,
            etat: demande.etat,
            paroles_proposees: demande.parolesProposees ? stripSectionTags(demande.parolesProposees) : '',
            demande_brute: demande.demandeBrute,
          }
        : null,
    }),
  };
});
