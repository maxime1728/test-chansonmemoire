// POST /api/chanson-callback — callback Suno de génération de chanson (v2 Supabase).
//
// PORTAGE de callback-chanson.js : mêmes règles éprouvées.
//   - Répond TOUJOURS 200 (on ne renvoie jamais d'erreur à Suno) ; les anomalies sont
//     journalisées (P1 si échec Suno explicite).
//   - Piste retenue : data.data[1] puis [0] (comportement C-cb historique).
//   - Ré-héberge l'audio sur Cloudinary en `authenticated` (aperçu protégé) ; repli
//     sur l'URL Suno si Cloudinary échoue.
//   - Idempotent : déjà audio_generated = no-op. Match par suno_task_id UNIQUE
//     (fini le scan filterByFormula : la course entre deux callbacks est impossible).
//   - Projet -> funnel_step 'preview_ready'. (Plus de recompteur : les comptes sont
//     une vue SQL. Le courriel « aperçu prêt » arrive dans le commit courriels.)
import { and, eq } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { journaliser } from './_lib/journal';
import { rehost } from './_lib/cloudinary-rehost';

interface CorpsSuno {
  code?: number | string;
  msg?: string;
  data?: {
    task_id?: string;
    callbackType?: string;
    data?: Array<{ id?: string; audio_url?: string; source_audio_url?: string }>;
  };
}

export const handler = avecErreurs('chanson-callback', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  // Sécurité optionnelle : si CALLBACK_SECRET est posé, exiger ?s=<secret>. 200 muet sinon
  // (on ne donne aucun signal à un appelant non autorisé).
  const s = event.queryStringParameters?.s || '';
  if (process.env.CALLBACK_SECRET && s !== process.env.CALLBACK_SECRET) {
    journaliser({ niveau: 'P2', fonction: 'chanson-callback', message: 'callback refusé (secret invalide)' });
    return { statusCode: 200, body: '{}' };
  }

  let body: CorpsSuno;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 200, body: '{}' };
  }

  const data = body.data || {};
  const taskId = (data.task_id || '').trim();
  const arr = Array.isArray(data.data) ? data.data : [];
  const track = arr[1] || arr[0] || {}; // C-cb utilisait data.data[1]
  const audioUrl = (track.source_audio_url || track.audio_url || '').trim();

  if (!taskId) return { statusCode: 200, body: '{}' };
  if (Number(body.code) !== 200 || data.callbackType !== 'complete' || !audioUrl) {
    if (body.code && Number(body.code) !== 200) {
      journaliser({ niveau: 'P1', fonction: 'chanson-callback', message: `Suno échec: ${body.code} ${body.msg || ''}` });
    }
    return { statusCode: 200, body: '{}' };
  }

  const { generations, projects } = schema;
  const [gen] = await db()
    .select()
    .from(generations)
    .where(and(eq(generations.sunoTaskId, taskId), actif(generations)))
    .limit(1);
  if (!gen) {
    journaliser({ niveau: 'P2', fonction: 'chanson-callback', message: 'task_id inconnu (rien à matcher)' });
    return { statusCode: 200, body: '{}' };
  }
  if (gen.status === 'audio_generated' || gen.status === 'validated') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };
  }

  // 1. Ré-héberge en authenticated (aperçu protégé). Repli : URL Suno.
  let hosted = audioUrl;
  try {
    hosted = (await rehost(audioUrl, { publicId: `cm_${taskId}`, resourceType: 'video', type: 'authenticated' })) || audioUrl;
  } catch {
    journaliser({ niveau: 'P2', fonction: 'chanson-callback', message: 'rehost Cloudinary échoué, URL Suno conservée' });
  }

  // 2. Génération -> audio_generated.
  await db()
    .update(generations)
    .set({
      status: 'audio_generated',
      cloudinaryAudioUrl: hosted,
      songId: track.id || gen.songId || null,
    })
    .where(eq(generations.id, gen.id));

  // 3. Projet -> preview_ready (les comptes sont une vue SQL, rien à recalculer).
  await db().update(projects).set({ funnelStep: 'preview_ready' }).where(eq(projects.id, gen.projectId));

  journaliser({ niveau: 'P3', fonction: 'chanson-callback', message: `aperçu prêt (génération n°${gen.generationNo})` });
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
