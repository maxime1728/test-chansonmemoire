// generate-lyrics-background.js — Génération des paroles EN ARRIÈRE-PLAN.
//
// Fonction « background » (le suffixe -background le dit à Netlify) : jusqu'à 15 min d'exécution,
// JAMAIS de timeout (≠ fonction synchrone ~10-26s). Déclenchée par soumettre-survey (fire-and-forget)
// après création du Projet. Génère les paroles via Anthropic et écrit elle-même la Generation.
//
// Le client n'attend PAS : /revision sonde lire-projet et affiche les paroles dès qu'elles arrivent
// (~20s, spinner branding). Après ~2 min sans paroles, /revision montre « problème » + recovery-cron
// relance/envoie le lien par courriel — ce background, lui, continue jusqu'à 15 min.
//
// Réutilise toute la logique de generate-lyrics (prompts, appel Anthropic, parsing tolérant, écriture).

const {
  callAnthropic, langOf, systemCreate, systemCreateGift, parseModel, normSuggestions,
  findProjectByToken, findLastGeneration, createGeneration, updateProject
} = require('./generate-lyrics');
const { capture } = require('./_lib/sentry');

const GENERATE_LYRICS_SECRET = process.env.GENERATE_LYRICS_SECRET || '';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  // Les fonctions background renvoient 202 immédiatement ; le corps de réponse est ignoré.
  let d; try { d = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400 }; }
  if (GENERATE_LYRICS_SECRET && d.secret !== GENERATE_LYRICS_SECRET) return { statusCode: 401 };

  const token = (d.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400 };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { await capture(new Error('generate-lyrics-background: ANTHROPIC_API_KEY manquante')); return { statusCode: 500 }; }

  try {
    const projet = await findProjectByToken(token);
    if (!projet) { await capture(new Error('generate-lyrics-background: projet introuvable'), { token }); return { statusCode: 404 }; }

    // Anti-doublon : si une Generation valide existe déjà (ex. /revision a relancé entre-temps), on s'arrête.
    const derniere = await findLastGeneration(projet.fields.project);
    const dejaValide = derniere && derniere.fields.lyrics && String(derniere.fields.lyrics).trim()
      && !String(derniere.fields.lyrics).includes('"invalid_input"');
    if (dejaValide) return { statusCode: 200 };

    const p = projet.fields;
    const userPrompt =
`Provided information:
- In memory of: ${p.deceased_name || 'cette personne'}
- Relationship to the person ordering: ${p.relationship || ''}
- Musical style: ${p.music_style || ''}
- Mood: ${p.mood || ''}
- What made them unique: ${p.what_made_unique || ''}
- Shared memories: ${p.memories || ''}
- What we want to keep and pass on: ${p.memory_to_keep || ''}`;

    const sys = (p.song_type === 'cadeau') ? systemCreateGift(langOf(p.language)) : systemCreate(langOf(p.language));
    const r = await callAnthropic(sys, userPrompt, apiKey);
    if (!r.ok) { await capture(new Error('generate-lyrics-background: Anthropic KO'), { token, status: r.status, detail: r.data }); return { statusCode: 502 }; }

    const parsed = parseModel(r.data);
    if (!parsed || parsed.error === 'invalid_input' || !parsed.lyrics || !String(parsed.lyrics).trim()) {
      await capture(new Error('generate-lyrics-background: pas de paroles exploitables'), { token, parsed: !!parsed });
      return { statusCode: 422 };   // /revision (retry) + recovery-cron prennent le relais
    }

    const suggestions = normSuggestions(parsed.suggestions);
    const titre = parsed.title || `Pour ${p.deceased_name || 'cette personne'}`;
    const dernierNo = derniere ? (Number(derniere.fields.generation_no) || 0) : 0;
    const type = dernierNo > 0 ? 'lyrics_regeneration' : 'lyrics';

    const gen = await createGeneration({
      project:           [projet.id],
      generation_no:     dernierNo + 1,
      type,
      lyrics:            parsed.lyrics,
      song_title:        titre,
      generation_status: 'lyrics_generated',
      suggestions:       JSON.stringify(suggestions)
    });
    if (!gen.ok) { await capture(new Error('generate-lyrics-background: ecriture Generation KO'), { token }); return { statusCode: 502 }; }
    await updateProject(projet.id, { funnel_step: 'lyrics_generated' });
    return { statusCode: 200 };
  } catch (e) {
    await capture(e, { where: 'generate-lyrics-background', token });
    return { statusCode: 500 };
  }
};
