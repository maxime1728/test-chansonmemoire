// apercu-revision-background — analyse IA d'une demande de révision (background).
//
// recue -> analyse (pipeline porté de analyse-modif) -> routage :
//   - nouvelle_chanson OU prononciation OU rien à proposer -> en_validation (FILE
//     MANUELLE Maxime + courriel interne ; décisions 2026-07-02) ;
//   - sinon -> analysee_ia + paroles_proposees : le client approuve sur l'aperçu.
// Chaque analyse est historisée dans demande_analyses (unique(demande_id, version)) :
// c'est le jeu d'entraînement de Maxime qui se construit tout seul.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { journaliser } from './_lib/journal';
import { analyserRevision } from './_lib/analyse';
import { cataloguePourAmbiance } from './_lib/style';
import { courrielInterneRevision } from './apercu-revision';

export const handler = avecErreurs('apercu-revision-background', async (event: EvenementHttp) => {
  let d: { demande_id?: string; secret?: string };
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: '{}' };
  }
  const SECRET = process.env.GENERATE_LYRICS_SECRET || '';
  if (SECRET && d.secret !== SECRET) return { statusCode: 401, body: '{}' };
  const demandeId = (d.demande_id || '').trim();
  if (!demandeId) return { statusCode: 400, body: '{}' };

  const { demandes, demandeAnalyses, projects, generations } = schema;
  const [demande] = await db()
    .select()
    .from(demandes)
    .where(and(eq(demandes.id, demandeId), actif(demandes)))
    .limit(1);
  if (!demande || demande.etat !== 'recue') return { statusCode: 200, body: '{}' }; // déjà traitée (idempotent)

  const [projet] = await db().select().from(projects).where(eq(projects.id, demande.projectId)).limit(1);
  if (!projet) {
    journaliser({ niveau: 'P1', fonction: 'apercu-revision-background', message: 'projet introuvable' });
    return { statusCode: 404, body: '{}' };
  }
  const [gen] = await db()
    .select()
    .from(generations)
    .where(
      and(
        eq(generations.projectId, projet.id),
        inArray(generations.type, ['song', 'song_regeneration', 'cover']),
        actif(generations),
      ),
    )
    .orderBy(desc(generations.generationNo))
    .limit(1);

  const estCadeau = projet.songType === 'cadeau';
  const analyse = await analyserRevision({
    demande: demande.demandeBrute,
    projet: {
      deceased_name: projet.deceasedName,
      music_style: projet.musicStyle,
      mood: projet.mood,
      voice: projet.voice,
    },
    gen: {
      gen_music_style: gen?.genMusicStyle,
      gen_mood: gen?.genMood,
      gen_voice: gen?.genVoice,
      song_title: gen?.songTitle,
      lyrics: gen?.lyrics,
    },
    styleActuel: gen?.stylePrompt || '',
    catalogue: await cataloguePourAmbiance({ mood: projet.mood, cadeau: estCadeau, language: projet.language }),
  });

  if (!analyse.ok) {
    // Échec d'analyse : la demande RESTE en recue (jamais perdue entre deux états),
    // P2 + retour ; un re-déclenchement (page ou watchdog) la reprendra.
    journaliser({ niveau: 'P2', fonction: 'apercu-revision-background', message: 'analyse retombée en recue' });
    return { statusCode: 502, body: '{}' };
  }

  // Historisation (le futur jeu d'entraînement) : idempotente par contrainte.
  await db()
    .insert(demandeAnalyses)
    .values({
      demandeId: demande.id,
      versionAnalyse: 1,
      analyseIa: analyse.brut ?? {},
      promptVersion: analyse.promptVersion,
      modele: 'claude-sonnet-4-6',
    })
    .onConflictDoNothing({ target: [demandeAnalyses.demandeId, demandeAnalyses.versionAnalyse] });

  const toucheProno = analyse.categories.includes('prononciation') || !!analyse.phonetique.trim();
  const rienAProposer = !analyse.adjLyrics.trim();
  const versEquipe = analyse.nouvelleChanson || toucheProno || rienAProposer;

  await db()
    .update(demandes)
    .set({
      etat: versEquipe ? 'en_validation' : 'analysee_ia',
      analyseIa: analyse.brut ?? {},
      versionAnalyse: 1,
      promptVersion: analyse.promptVersion,
      mode: analyse.mode,
      nouvelleChanson: analyse.nouvelleChanson,
      parolesProposees: versEquipe ? null : analyse.adjLyrics,
      parolesPhonetiques: versEquipe ? null : analyse.phonetique || null,
    })
    .where(eq(demandes.id, demande.id));

  if (versEquipe) {
    const raison = analyse.nouvelleChanson
      ? 'nouvelle chanson demandée'
      : toucheProno
        ? 'prononciation (passe par toi avant, décision)'
        : 'rien à proposer automatiquement';
    await courrielInterneRevision(
      `Demande de révision à traiter (${raison})`,
      `Projet « ${projet.deceasedName || ''} ».<br><br>Demande du client :<br><em>${demande.demandeBrute.replace(/</g, '&lt;')}</em>` +
        (analyse.compteRendu ? `<br><br>Compte rendu IA :<br>${analyse.compteRendu.replace(/</g, '&lt;')}` : '') +
        `<br><br>demande_id : ${demande.id}`,
      projet.id,
    );
  }

  return { statusCode: 200, body: '{}' };
});
