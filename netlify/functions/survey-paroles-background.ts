// survey-paroles-background — génération des paroles EN ARRIÈRE-PLAN (v2 Supabase).
//
// Fonction « background » (suffixe -background = jusqu'à 15 min, jamais de timeout).
// PORTAGE de generate-lyrics-background.js + du mode regenerate de generate-lyrics.js,
// unifiés : SANS modifications = création (ou retry idempotent), AVEC modifications =
// régénération qui garde le contexte (paroles actuelles + titre stable).
//
// Anti-doublon PAR CONTRAINTE : unique(project_id, generation_no). Deux exécutions
// concurrentes ne peuvent pas écrire deux fois le même numéro : la seconde reçoit un
// conflit et s'arrête proprement (le legacy comptait sur la chance).
import { and, desc, eq } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { journaliser } from './_lib/journal';
import { callAnthropic, normSuggestions, parseModel } from './_lib/anthropic';
import {
  PROMPT_VERSION,
  langOf,
  systemCreate,
  systemCreateGift,
  systemRegenerate,
  userPromptCreation,
  userPromptRegeneration,
} from './_lib/prompts/paroles';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = avecErreurs('survey-paroles-background', async (event: EvenementHttp) => {
  // Netlify répond 202 immédiatement ; ces codes servent au journal et aux tests.
  let d: { token?: string; secret?: string; modifications?: string };
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: '{}' };
  }
  const SECRET = process.env.GENERATE_LYRICS_SECRET || '';
  if (SECRET && d.secret !== SECRET) return { statusCode: 401, body: '{}' };

  const token = (d.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: '{}' };
  const modifications = typeof d.modifications === 'string' ? d.modifications.trim() : '';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante'); // wrapper -> P1 + 500

  const { projects, generations } = schema;

  const [projet] = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) {
    journaliser({ niveau: 'P1', fonction: 'survey-paroles-background', message: 'projet introuvable' });
    return { statusCode: 404, body: '{}' };
  }

  const [derniere] = await db()
    .select()
    .from(generations)
    .where(and(eq(generations.projectId, projet.id), actif(generations)))
    .orderBy(desc(generations.generationNo))
    .limit(1);

  const parolesValides = (g: typeof derniere) =>
    !!g && !!g.lyrics && !!String(g.lyrics).trim() && !String(g.lyrics).includes('"invalid_input"');

  // CRÉATION/RETRY : si des paroles valides existent déjà, no-op (idempotent).
  if (!modifications && parolesValides(derniere)) return { statusCode: 200, body: '{}' };

  const lang = langOf(projet.language);
  const estCadeau = projet.songType === 'cadeau';
  let system: string;
  let userPrompt: string;
  if (modifications) {
    system = systemRegenerate(lang, estCadeau);
    userPrompt = userPromptRegeneration(projet, derniere?.songTitle ?? '', derniere?.lyrics ?? '', modifications);
  } else {
    system = estCadeau ? systemCreateGift(lang) : systemCreate(lang);
    userPrompt = userPromptCreation(projet);
  }

  const r = await callAnthropic(system, userPrompt, apiKey);
  if (!r.ok) {
    journaliser({
      niveau: 'P1',
      fonction: 'survey-paroles-background',
      message: `Anthropic KO (HTTP ${r.status})`,
      prompt_version: PROMPT_VERSION,
    });
    return { statusCode: 502, body: '{}' };
  }
  const parsed = parseModel(r.data);
  if (!parsed || parsed.error === 'invalid_input' || !parsed.lyrics || !String(parsed.lyrics).trim()) {
    // Entrées inutilisables ou réponse inexploitable : la page d'attente offrira
    // « réessayer » ; pas de retry infini ici (retries Anthropic déjà bornés).
    journaliser({
      niveau: 'P2',
      fonction: 'survey-paroles-background',
      message: parsed?.error === 'invalid_input' ? 'invalid_input (entrées inutilisables)' : 'paroles inexploitables',
    });
    return { statusCode: 422, body: '{}' };
  }

  const suggestions = normSuggestions(parsed.suggestions);
  const dernierNo = derniere ? Number(derniere.generationNo) || 0 : 0;
  // Titre stable : en régénération on GARDE le titre existant (règle produit).
  const titre = modifications
    ? derniere?.songTitle || parsed.title || `Pour ${projet.deceasedName || 'cette personne'}`
    : parsed.title || `Pour ${projet.deceasedName || 'cette personne'}`;

  const inseres = await db()
    .insert(generations)
    .values({
      projectId: projet.id,
      generationNo: dernierNo + 1,
      type: dernierNo > 0 ? 'lyrics_regeneration' : 'lyrics',
      lyrics: parsed.lyrics,
      songTitle: titre,
      requestedChanges: modifications || null,
      status: 'lyrics_generated',
      suggestions,
    })
    .onConflictDoNothing({ target: [generations.projectId, generations.generationNo] })
    .returning({ id: generations.id });
  if (!inseres.length) {
    // Course avec une exécution concurrente : l'autre a gagné, tout est cohérent.
    journaliser({ niveau: 'P3', fonction: 'survey-paroles-background', message: 'conflit generation_no: no-op (course)' });
    return { statusCode: 200, body: '{}' };
  }

  await db().update(projects).set({ funnelStep: 'lyrics_generated' }).where(eq(projects.id, projet.id));
  return { statusCode: 200, body: '{}' };
});
