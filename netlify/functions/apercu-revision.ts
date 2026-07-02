// POST /api/apercu-revision — { token, modifications } : demande de révision depuis
// l'aperçu (nouveau funnel : la révision vit APRÈS l'écoute).
//
// Routage (décisions Maxime 2026-07-02) :
//   - ≥ 3 appels Suno client sur le projet -> PAS d'auto : demande en FILE MANUELLE
//     (etat en_validation) + courriel interne, réponse « on te revient d'ici 24-48 h » ;
//   - sinon -> demande créée (recue) + analyse IA en arrière-plan ; le client APPROUVERA
//     les paroles proposées avant toute nouvelle chanson.
// Une seule demande ACTIVE à la fois par projet (409 sinon).
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, urlBaseDeploy, type EvenementHttp } from './_lib/http';
import { journaliser } from './_lib/journal';
import { SEUIL_REVISION_EQUIPE, compterAppelsClientPre } from './_lib/chanson';
import { envoyerCourriel, gabarit } from './_lib/mailgun';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ETATS_ACTIFS = ['recue', 'analysee_ia', 'en_validation', 'approuvee', 'en_generation'] as const;
const MODIFS_MAX = 4000;

export async function courrielInterneRevision(sujet: string, corps: string, projetId: string): Promise<void> {
  const to = process.env.COURRIEL_INTERNE || 'nathalie@chansonmemoire.ca';
  const r = await envoyerCourriel({
    type: 'interne',
    to,
    subject: sujet,
    html: gabarit({ intro: sujet, corps }),
    projetId,
  });
  journaliser({
    niveau: r.sent ? 'P3' : 'P1', // une demande en file SANS courriel interne = invisible : P1
    fonction: 'apercu-revision',
    message: `courriel interne: ${r.summary}`,
  });
}

export const handler = avecErreurs('apercu-revision', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  let d: { token?: string; modifications?: string };
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  }
  const token = (d.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  const modifications = typeof d.modifications === 'string' ? d.modifications.trim().slice(0, MODIFS_MAX) : '';
  if (modifications.length < 3) return { statusCode: 400, body: JSON.stringify({ error: 'Décris ce que tu aimerais changer.' }) };

  const { projects, demandes } = schema;
  const [projet] = await db()
    .select({ id: projects.id, commercialStatus: projects.commercialStatus, deceasedName: projects.deceasedName })
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
  if (projet.commercialStatus !== 'preview_only') return { statusCode: 409, body: JSON.stringify({ etape: 'achete' }) };

  const [active] = await db()
    .select({ id: demandes.id, etat: demandes.etat })
    .from(demandes)
    .where(and(eq(demandes.projectId, projet.id), inArray(demandes.etat, [...ETATS_ACTIFS]), actif(demandes)))
    .orderBy(desc(demandes.recueAt))
    .limit(1);
  if (active) return { statusCode: 409, body: JSON.stringify({ statut: 'deja_en_cours', demande_id: active.id, etat: active.etat }) };

  const appels = await compterAppelsClientPre(projet.id);
  const versEquipe = appels >= SEUIL_REVISION_EQUIPE;

  const [creee] = await db()
    .insert(demandes)
    .values({
      projectId: projet.id,
      type: 'chanson',
      canal: 'formulaire',
      demandeBrute: modifications,
      etat: versEquipe ? 'en_validation' : 'recue',
    })
    .returning({ id: demandes.id });
  if (!creee) throw new Error('création de la demande échouée');

  if (versEquipe) {
    await courrielInterneRevision(
      'Demande de révision à traiter (plafond client atteint)',
      `Projet « ${projet.deceasedName || ''} » : ${appels} appels Suno déjà utilisés.<br><br>Demande du client :<br><em>${modifications.replace(/</g, '&lt;')}</em><br><br>demande_id : ${creee.id}`,
      projet.id,
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statut: 'equipe', demande_id: creee.id }),
    };
  }

  // Analyse en arrière-plan ; échec de déclenchement = BRUYANT (le client attendrait pour rien).
  const secret = process.env.GENERATE_LYRICS_SECRET || '';
  const r = await fetch(`${urlBaseDeploy()}/.netlify/functions/apercu-revision-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ demande_id: creee.id, secret }),
  });
  if (!r.ok && r.status !== 202) throw new Error(`déclenchement analyse: HTTP ${r.status}`);

  return {
    statusCode: 202,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ statut: 'analyse', demande_id: creee.id }),
  };
});
