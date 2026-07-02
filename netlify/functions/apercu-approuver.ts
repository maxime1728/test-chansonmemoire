// POST /api/apercu-approuver — { token, demande_id } : le client approuve les paroles
// proposées ; la nouvelle chanson part (décision 2026-07-02 : approbation AVANT
// régénération, jamais l'inverse).
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { lancerChansonAuto, SEUIL_REVISION_EQUIPE, compterAppelsClientPre } from './_lib/chanson';
import { courrielInterneRevision } from './apercu-revision';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = avecErreurs('apercu-approuver', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  let d: { token?: string; demande_id?: string };
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  }
  const token = (d.token || '').trim();
  const demandeId = (d.demande_id || '').trim();
  if (!UUID_V4.test(token) || !demandeId) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };

  const { projects, demandes, generations } = schema;
  const [projet] = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };

  // La demande doit appartenir AU projet du token (jamais d'accès croisé).
  const [demande] = await db()
    .select()
    .from(demandes)
    .where(and(eq(demandes.id, demandeId), eq(demandes.projectId, projet.id), actif(demandes)))
    .limit(1);
  if (!demande) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
  if (demande.etat !== 'analysee_ia' || !demande.parolesProposees) {
    return { statusCode: 409, body: JSON.stringify({ statut: demande.etat }) };
  }

  // Re-contrôle du seuil (course possible entre proposition et approbation).
  const appels = await compterAppelsClientPre(projet.id);
  if (appels >= SEUIL_REVISION_EQUIPE) {
    await db().update(demandes).set({ etat: 'en_validation' }).where(eq(demandes.id, demande.id));
    await courrielInterneRevision(
      'Demande approuvée par le client, plafond atteint (à traiter)',
      `Projet « ${projet.deceasedName || '' } » : ${appels} appels utilisés. demande_id : ${demande.id}`,
      projet.id,
    );
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statut: 'equipe' }) };
  }

  // Nouvelle génération de PAROLES approuvées (le client a validé la proposition telle
  // quelle en v1 ; l'édition inline viendra avec le diff modifications_humaines).
  const [derniere] = await db()
    .select({ generationNo: generations.generationNo, songTitle: generations.songTitle })
    .from(generations)
    .where(and(eq(generations.projectId, projet.id), actif(generations)))
    .orderBy(desc(generations.generationNo))
    .limit(1);
  const inseres = await db()
    .insert(generations)
    .values({
      projectId: projet.id,
      generationNo: (derniere ? Number(derniere.generationNo) : 0) + 1,
      type: 'lyrics_regeneration',
      lyrics: demande.parolesProposees,
      lyricsPhonetique: demande.parolesPhonetiques || null,
      songTitle: derniere?.songTitle || `Pour ${projet.deceasedName || 'cette personne'}`, // titre stable
      requestedChanges: demande.demandeBrute,
      status: 'lyrics_generated',
    })
    .onConflictDoNothing({ target: [generations.projectId, generations.generationNo] })
    .returning({ id: generations.id });
  if (!inseres.length) return { statusCode: 409, body: JSON.stringify({ statut: 'course' }) };

  await db().update(demandes).set({ etat: 'approuvee' }).where(eq(demandes.id, demande.id));

  const lancement = await lancerChansonAuto(projet);
  if (!lancement.ok) {
    if (lancement.raison === 'plafond') {
      await db().update(demandes).set({ etat: 'en_validation' }).where(eq(demandes.id, demande.id));
      await courrielInterneRevision(
        'Demande approuvée, plafond dur atteint (à traiter)',
        `Projet « ${projet.deceasedName || ''} ». demande_id : ${demande.id}`,
        projet.id,
      );
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statut: 'equipe' }) };
    }
    // Échec technique déjà journalisé P1 : la demande reste approuvee, la page réessaie.
    return { statusCode: 502, body: JSON.stringify({ error: 'Relance échouée, réessaie dans un instant.' }) };
  }

  await db().update(demandes).set({ etat: 'en_generation' }).where(eq(demandes.id, demande.id));
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ statut: 'relance' }),
  };
});
