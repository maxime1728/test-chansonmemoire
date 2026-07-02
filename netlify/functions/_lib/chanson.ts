// _lib/chanson.ts — lancement d'une génération de CHANSON Suno (v2 Supabase).
//
// PORTAGE de lancer-chanson.js, adapté au nouveau funnel (décision Maxime 2026-07-02) :
// la chanson se lance AUTOMATIQUEMENT dès que les paroles sont prêtes, sans clic.
//
// Conservé du legacy : payload Suno identique (customMode, model V5_5, style curé
// ≤1000, paroles ≤5000, titre ≤100, vocalGender m/f), la Generation est créée APRÈS
// le succès Suno (audio_pending + suno_task_id), funnel_step -> song_generating,
// Suno chante la version PHONÉTIQUE si elle existe, le client voit toujours les
// paroles propres. Plafonds pré-achat : max 4 chansons réussies/projet, et max
// 10·(1+achats) cumulées par client.
//
// Nouveau : le callback est TOUJOURS le nôtre (/api/chanson-callback du déploiement
// courant) : plus d'env CALLBACK_CHANSON, plus aucun fallback (décision étape 0).
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, actif, schema } from './db';
import { journaliser } from './journal';
import { urlBaseDeploy } from './http';
import { styleFor } from './style';
import type { Generation, Project } from '../../../db/schema';

export const PLAFOND_PROJET_PRE_ACHAT = 4;

export type ResultatLancement =
  | { ok: true; taskId: string; generationNo: number }
  | { ok: false; raison: 'plafond' | 'paroles_manquantes' | 'suno' | 'config'; detail?: string };

function compteChansonReussiePre(g: Pick<Generation, 'status' | 'type' | 'postPurchase' | 'adminTriggered'>): boolean {
  return (
    (g.status === 'audio_generated' || g.status === 'validated') &&
    ['song', 'song_regeneration', 'cover'].includes(g.type) &&
    !g.postPurchase &&
    !g.adminTriggered
  );
}

// Lance la chanson pour un projet dont les paroles existent. Idempotence appelant :
// ne pas appeler s'il y a déjà une génération de chanson en cours (audio_pending).
export async function lancerChansonAuto(projet: Project): Promise<ResultatLancement> {
  const SUNO_API_KEY = process.env.SUNO_API_KEY;
  if (!SUNO_API_KEY) {
    journaliser({ niveau: 'P1', fonction: 'chanson', message: 'SUNO_API_KEY manquante : chanson non lancée' });
    return { ok: false, raison: 'config' };
  }
  const { generations, projects, clients } = schema;

  const gens = await db()
    .select()
    .from(generations)
    .where(and(eq(generations.projectId, projet.id), actif(generations)))
    .orderBy(desc(generations.generationNo));
  const derniere = gens[0];

  // Plafond pré-achat (le post-achat a son propre pipeline, 2c).
  if (projet.commercialStatus !== 'purchased') {
    const preCount = gens.filter(compteChansonReussiePre).length;
    if (preCount >= PLAFOND_PROJET_PRE_ACHAT) return { ok: false, raison: 'plafond', detail: 'projet' };

    // Cumul CLIENT : max 10·(1+achats) chansons pré-achat, tous projets confondus.
    const projetsClient = await db()
      .select({ id: projects.id, commercialStatus: projects.commercialStatus })
      .from(projects)
      .where(and(eq(projects.clientId, projet.clientId), actif(projects)));
    const achats = projetsClient.filter((p) => p.commercialStatus === 'purchased').length;
    const ids = projetsClient.map((p) => p.id);
    const gensClient = ids.length
      ? await db()
          .select({
            status: generations.status,
            type: generations.type,
            postPurchase: generations.postPurchase,
            adminTriggered: generations.adminTriggered,
          })
          .from(generations)
          .where(and(inArray(generations.projectId, ids), actif(generations)))
      : [];
    const cumulClient = gensClient.filter(compteChansonReussiePre).length;
    if (cumulClient >= 10 * (1 + achats)) return { ok: false, raison: 'plafond', detail: 'client' };
  }

  // Paroles : propres pour l'affichage, phonétiques pour Suno si présentes.
  const lyricsClean = (derniere?.lyrics || '').trim();
  if (!lyricsClean || lyricsClean.includes('"invalid_input"')) return { ok: false, raison: 'paroles_manquantes' };
  const phon = (derniere?.lyricsPhonetique || '').trim();
  const lyricsSuno = phon || lyricsClean;

  const titre = (derniere?.songTitle || `Pour ${projet.deceasedName || 'toi'}`).slice(0, 100);
  const vocalGender = /Masculin/i.test(projet.voice || '') ? 'm' : 'f';
  const style = (
    await styleFor({
      music_style: projet.musicStyle,
      mood: projet.mood,
      cadeau: projet.songType === 'cadeau',
      language: projet.language,
    })
  ).slice(0, 1000);
  const preReussies = gens.filter(compteChansonReussiePre).length;
  const type = preReussies >= 1 ? 'song_regeneration' : 'song';

  // Callback : TOUJOURS le nôtre, sur le déploiement courant. CALLBACK_SECRET optionnel.
  const secret = process.env.CALLBACK_SECRET || '';
  const callBackUrl =
    `${urlBaseDeploy()}/.netlify/functions/chanson-callback` + (secret ? `?s=${encodeURIComponent(secret)}` : '');

  const rS = await fetch('https://api.sunoapi.org/api/v1/generate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUNO_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customMode: true,
      instrumental: false,
      model: process.env.SUNO_MODEL || 'V5_5',
      prompt: lyricsSuno.slice(0, 5000),
      style,
      title: titre,
      vocalGender,
      callBackUrl,
    }),
  });
  const dS = (await rS.json().catch(() => ({}))) as { data?: { taskId?: string }; msg?: string };
  const taskId = dS?.data?.taskId;
  if (!rS.ok || !taskId) {
    journaliser({
      niveau: 'P1',
      fonction: 'chanson',
      message: `Suno refusé: ${dS?.msg || `HTTP ${rS.status}`}`,
    });
    return { ok: false, raison: 'suno', detail: dS?.msg || `HTTP ${rS.status}` };
  }

  const generationNo = (derniere ? Number(derniere.generationNo) : 0) + 1;
  const inseres = await db()
    .insert(generations)
    .values({
      projectId: projet.id,
      generationNo,
      type,
      postPurchase: false,
      lyrics: lyricsClean,
      lyricsPhonetique: phon || null, // propage le fix phonétique à la nouvelle version
      songTitle: titre,
      status: 'audio_pending',
      sunoTaskId: String(taskId),
      genMusicStyle: projet.musicStyle,
      genMood: projet.mood,
      genVoice: projet.voice,
      stylePrompt: style, // prompt exact de cette version (historique)
    })
    .onConflictDoNothing({ target: [generations.projectId, generations.generationNo] })
    .returning({ id: generations.id });
  if (!inseres.length) {
    // Course : une autre exécution a écrit ce numéro. La tâche Suno orpheline sera
    // vue par le watchdog (spécifié) ; on journalise fort plutôt que d'ignorer.
    journaliser({ niveau: 'P1', fonction: 'chanson', message: `conflit generation_no ${generationNo}: tâche Suno ${String(taskId).slice(0, 8)}… orpheline` });
    return { ok: false, raison: 'suno', detail: 'conflit generation_no' };
  }

  await db().update(projects).set({ funnelStep: 'song_generating' }).where(eq(projects.id, projet.id));
  return { ok: true, taskId: String(taskId), generationNo };
}
