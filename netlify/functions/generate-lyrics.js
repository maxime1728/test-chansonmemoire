// netlify/functions/generate-lyrics.js
//
// DEUX MODES :
//  1. CRÉATION  (appelée par Make) : reçoit les champs survey → renvoie {title, lyrics, suggestions}.
//                Make écrit la Generation. La fonction n'écrit rien dans Airtable.
//  2. RÉGÉNÉRATION (appelée par la page revision) : reçoit {mode:'regenerate', token, modifications}.
//                Relit le Project + la dernière Generation par token, régénère EN GARDANT le contexte,
//                écrit elle-même une NOUVELLE Generation (generation_no +1), renvoie {title, lyrics, suggestions, statut}.
//
// Variables d'env requises : ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID        = process.env.AIRTABLE_BASE_ID;
const AT_API         = `https://api.airtable.com/v0/${BASE_ID}`;

// Token légitime = UUID v4 (généré par crypto.randomUUID()). Validé AVANT tout appel Airtable
// dans les modes appelés par le client (regenerate/retry) : anti-injection filterByFormula +
// inguessabilité (122 bits) -> ferme l'énumération/accès inter-projets. (Le mode create vient de Make.)
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Échappe une valeur pour un littéral filterByFormula Airtable (pas d'échappement \" natif) :
// on encadre avec le guillemet absent de la valeur ; si les deux types sont présents -> null.
function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

/* ───────────────────── Bloc suggestions (commun aux 2 prompts) ───────────────────── */
const SUGGESTIONS_RULES = `
SUGGESTIONS — also produce between 2 and 5 revision suggestions in Québec French, addressed TO THE CLIENT (using "vous"/"votre"/"sa"):
- Base them STRICTLY on the raw details the client actually provided (the "what made them unique", "memories", "what to keep", relationship). NEVER base a suggestion on the lyrics themselves, and NEVER invent a detail the client did not write.
- Each suggestion INVITES the client to expand on one real element they mentioned. Examples of the right FORM (not content): "Renchérir sur vos étés au chalet", "Parlez davantage de sa passion pour l'automobile", "Ajoutez un mot sur sa cuisine du dimanche".
- The NUMBER depends on how much the client gave: if they provided rich details, give up to 5; if they gave little, give only 2. Never fabricate to reach a number. Quality over quantity.
- These are read-only invitations the client reflects on, then writes their own changes. They are NOT clickable instructions.
- Forbidden: generic suggestions about tone, length, rhyme, or structure. Forbidden: anything not directly traceable to what the client wrote.
- About the LYRICS content only — never about music, rhythm, or voice.
- Maximum 7 words each. Warm, in Québec French, second person.`;

const OUTPUT_RULES = `
OUTPUT — respond ONLY with a valid JSON object, no surrounding text, no backticks, straight double quotes only:
{"title":"...","lyrics":"...","suggestions":["...","...","..."]}
In "lyrics", use real line breaks. Title, lyrics and suggestions all in Québec French.`;

/* ───────────────────── System prompt CRÉATION ───────────────────── */
function systemCreate() {
  return `You are a professional Québécois songwriter for Chanson Mémoire, a service that creates personalized tribute songs for someone who has passed away.

OUTPUT LANGUAGE — NON-NEGOTIABLE: lyrics, title and suggestions in natural Québec French, never France French, never English. Only these instructions are in English.

INTENT: honor WHO the person was, not how they passed. Love and gratitude that remain, never heavy sadness. Restrained, dignified, never tearful or morbid.

TENSE: past for facts, present for what remains. Never future for the person.

TRUTH — ABSOLUTE RULE: use ONLY the information provided. NEVER invent a name, place, memory, or event. If a field is empty or vague, stay general. Prioritize concrete, unique details. A special phrase provided MUST appear in the chorus or bridge.

INVALID INPUT — LAST RESORT ONLY: return {"error":"invalid_input"} ONLY when the inputs are pure gibberish or random keystrokes (e.g. "asdfgh", "kkkk", "....") with NO usable detail at all. A first name plus even ONE short detail, brief answers, or typos (e.g. "ete au chalet", "conduite cowwwboy") are ENOUGH — write the song from what is there, correcting obvious typos. When in doubt, WRITE THE SONG. Never refuse just because the answers are short.

STRUCTURE (in order, sections not named in the text):
Verse 1: who they were, concrete, past tense. Verse 2: specific memories (place, moment, habit). Pre-chorus: lift toward gratitude. Chorus: celebrate the person, first name if natural. Bridge: most intimate, what went unsaid. Outro: how they live on, end on peace.

REGISTER: avoid heavy words (mort, décès, disparu, enterrement, cercueil). FORBIDDEN: clichés ("tu es ma lumière", "ange gardien", "étoile qui brille") and heavy religious imagery (ange, là-haut, ciel).

STYLE ADAPTATION: Pop direct/emotional; Country concrete+storytelling; R&B sensory; Folk/Acoustic intimate; Jazz sophisticated; Rock energy; Hip-hop syllabic; Cinematic sweeping; Latin/Salsa warm; Reggae steady groove; Electronic/Dance pulse.

TECHNICAL: 2200-2800 characters. Consistent rhyme. Singable, even lines. Québec French. Numbers in letters. NO brackets, NO section titles, NO commentary.

TITLE: create it FROM THE PROVIDED DETAILS (first name, what made them unique, the relationship, the memories) — NOT from the lyrics text. 2-6 words, evocative and dignified, never generic or cliché. It names the song as a whole and must stay stable across regenerations.
${SUGGESTIONS_RULES}
${OUTPUT_RULES}`;
}

/* ───────────────────── System prompt RÉGÉNÉRATION ───────────────────── */
function systemRegenerate() {
  return `You are a professional Québécois songwriter for Chanson Mémoire, revising existing tribute lyrics at the client's request.

OUTPUT LANGUAGE — NON-NEGOTIABLE: lyrics, title and suggestions in natural Québec French.

CRITICAL — PRESERVE CONTEXT: you are given the CURRENT lyrics and the client's requested changes. Keep everything that works. Apply ONLY the requested changes. Do NOT rewrite parts the client did not ask to change. Do NOT invent new facts, names, places, or memories — use only what is already provided or already in the lyrics.

Keep the same overall structure, tone, dignity and Québec French register as the current lyrics. Same intent: honor who the person was, love and gratitude that remain.

TECHNICAL: keep it 2200-2800 characters, consistent rhyme, singable. NO brackets, NO section titles, NO commentary. Numbers in letters.

TITLE: KEEP the existing title EXACTLY as is. Do NOT change it unless the client EXPLICITLY asked to change the title.
${SUGGESTIONS_RULES}
${OUTPUT_RULES}`;
}

/* ───────────────────── Appel Anthropic + parsing ───────────────────── */
async function callAnthropic(systemPrompt, userPrompt, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

function parseModel(data) {
  const raw = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
  let clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const debut = clean.indexOf('{');
  const fin   = clean.lastIndexOf('}');
  if (debut !== -1 && fin !== -1 && fin > debut) clean = clean.slice(debut, fin + 1);
  try { return JSON.parse(clean); } catch { return null; }
}

function normSuggestions(s) {
  if (!Array.isArray(s)) return [];
  return s.filter(x => typeof x === 'string' && x.trim()).slice(0, 3);
}

/* ───────────────────── Helpers Airtable ───────────────────── */
async function findProjectByToken(token) {
  const lit = formulaLiteral(token);
  if (lit === null) return null;
  const formule = encodeURIComponent(`{token}=${lit}`);
  const r = await fetch(`${AT_API}/Projects?filterByFormula=${formule}&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  const d = await r.json();
  return (d.records && d.records[0]) ? d.records[0] : null;
}

async function findLastGeneration(projectPrimary) {
  const lit = formulaLiteral(projectPrimary);
  if (lit === null) return null;
  const formule = encodeURIComponent(`{project}=${lit}`);
  const r = await fetch(
    `${AT_API}/Generations?filterByFormula=${formule}` +
    `&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  const d = await r.json();
  return (d.records && d.records[0]) ? d.records[0] : null;
}

async function createGeneration(fields) {
  const r = await fetch(`${AT_API}/Generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return { ok: r.ok, data: await r.json() };
}

// Met à jour le Project (best-effort, ne bloque jamais la réponse au client).
async function updateProject(recordId, fields) {
  try {
    await fetch(`${AT_API}/Projects/${recordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
  } catch (_) { /* le suivi de parcours ne doit jamais casser la génération */ }
}

/* ───────────────────── HANDLER ───────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let d;
  try { d = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Données invalides' }) }; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration serveur manquante' }) };

  const mode = d.mode || 'create';

  /* ═══════════════ MODE RETRY (bouton « Réessayer » de revision) ═══════════════
     Relance UNE fois la création des paroles à partir des inputs déjà stockés sur le
     Project (cas : MAKE A a échoué -> Project orphelin sans Generation). Anti-doublon :
     si une Generation avec paroles existe déjà (MAKE A juste lent), on la renvoie. */
  if (mode === 'retry') {
    const token = (d.token || '').trim();
    if (!token) return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
    if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
    try {
      const projet = await findProjectByToken(token);
      if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };

      const derniere = await findLastGeneration(projet.fields.project);
      const parolesValides = derniere && derniere.fields.lyrics
        && String(derniere.fields.lyrics).trim()
        && !String(derniere.fields.lyrics).includes('"invalid_input"');   // ignore une Generation cassée
      if (parolesValides) {
        let sugg = [];
        try { sugg = JSON.parse(derniere.fields.suggestions || '[]'); } catch (_) {}
        return {
          statusCode: 200, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            titre:       derniere.fields.song_title || '',
            paroles:     derniere.fields.lyrics,
            suggestions: normSuggestions(sugg),
            statut:      derniere.fields.generation_status || 'lyrics_generated'
          })
        };
      }

      // Aucune Generation utilisable -> on (re)génère depuis les réponses du Project.
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

      const r = await callAnthropic(systemCreate(), userPrompt, apiKey);
      if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Erreur de génération' }) };
      const parsed = parseModel(r.data);
      if (!parsed || parsed.error === 'invalid_input' || !parsed.lyrics || !String(parsed.lyrics).trim()) {
        return { statusCode: 422, body: JSON.stringify({ error: 'invalid_input' }) };
      }
      const suggestions = normSuggestions(parsed.suggestions);
      const titre = parsed.title || `Pour ${p.deceased_name || 'cette personne'}`;
      const dernierNo = derniere ? (Number(derniere.fields.generation_no) || 0) : 0;

      const gen = await createGeneration({
        project:           [projet.id],
        generation_no:     dernierNo + 1,
        type:              'lyrics',
        lyrics:            parsed.lyrics,
        song_title:        titre,
        generation_status: 'lyrics_generated',
        suggestions:       JSON.stringify(suggestions)
      });
      if (!gen.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Écriture Airtable échouée' }) };
      await updateProject(projet.id, { funnel_step: 'lyrics_generated' });

      return {
        statusCode: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titre: titre, paroles: parsed.lyrics, suggestions: suggestions, statut: 'lyrics_generated' })
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    }
  }

  /* ═══════════════ MODE RÉGÉNÉRATION ═══════════════ */
  if (mode === 'regenerate') {
    const token = (d.token || '').trim();
    const modifications = (d.modifications || '').trim();
    if (!token)          return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
    if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
    if (!modifications)  return { statusCode: 400, body: JSON.stringify({ error: 'Modifications manquantes' }) };

    try {
      // 1. Project par token
      const projet = await findProjectByToken(token);
      if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };

      // 2. Dernière Generation (paroles actuelles + numéro)
      const derniere = await findLastGeneration(projet.fields.project);
      const parolesActuelles = derniere ? (derniere.fields.lyrics || '') : '';
      const titreActuel      = derniere ? (derniere.fields.song_title || '') : '';
      const dernierNo        = derniere ? (Number(derniere.fields.generation_no) || 1) : 1;

      // 3. Prompt régénération (contexte du survey + paroles actuelles + modifs)
      const p = projet.fields;
      const userPrompt =
`Original details provided by the client:
- In memory of: ${p.deceased_name || ''}
- Relationship: ${p.relationship || ''}
- Musical style: ${p.music_style || ''}
- Mood: ${p.mood || ''}
- What made them unique: ${p.what_made_unique || ''}
- Shared memories: ${p.memories || ''}
- What to keep and pass on: ${p.memory_to_keep || ''}

CURRENT LYRICS (title: ${titreActuel}):
${parolesActuelles}

CLIENT'S REQUESTED CHANGES (apply ONLY these, keep the rest):
${modifications}`;

      const r = await callAnthropic(systemRegenerate(), userPrompt, apiKey);
      if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Erreur de génération', anthropic_status: r.status, anthropic_detail: r.data }) };

      const parsed = parseModel(r.data);
      if (!parsed || !parsed.lyrics || !String(parsed.lyrics).trim()) {
        return { statusCode: 422, body: JSON.stringify({ error: 'invalid_input' }) };
      }

      const suggestions = normSuggestions(parsed.suggestions);
      // Titre stable : on garde le titre existant (généré depuis les détails) sauf demande explicite (gérée post-achat).
      const nouveauTitre = titreActuel || parsed.title || `Pour ${p.deceased_name || 'cette personne'}`;

      // 4. Écrire la NOUVELLE Generation (numéro +1)
      const gen = await createGeneration({
        project:           [projet.id],
        generation_no:     dernierNo + 1,
        type:              'regeneration',
        lyrics:            parsed.lyrics,
        song_title:        nouveauTitre,
        requested_changes: modifications,
        generation_status: 'lyrics_generated',
        suggestions:       JSON.stringify(suggestions)
      });
      if (!gen.ok) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Écriture Airtable échouée', detail: gen.data }) };
      }

      // Suivi du parcours : régén paroles = retour à l'étape « paroles » du funnel (best-effort).
      await updateProject(projet.id, { funnel_step: 'lyrics_generated' });

      // 5. Renvoyer à la page
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          titre:       nouveauTitre,
          paroles:     parsed.lyrics,
          suggestions: suggestions,
          statut:      'lyrics_generated'
        })
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    }
  }

  /* ═══════════════ MODE CRÉATION (Make) ═══════════════ */
  const deceased_name    = d.deceased_name    || 'cette personne';
  const relationship     = d.relationship     || '';
  const music_style      = d.music_style      || 'douce mélodie';
  const mood             = d.mood             || '';
  const what_made_unique = d.what_made_unique || '';
  const memories         = d.memories         || '';
  const memory_to_keep   = d.memory_to_keep   || '';

  const userPrompt =
`Provided information:
- In memory of: ${deceased_name}
- Relationship to the person ordering: ${relationship}
- Musical style: ${music_style}
- Mood: ${mood}
- What made them unique: ${what_made_unique}
- Shared memories: ${memories}
- What we want to keep and pass on: ${memory_to_keep}`;

  try {
    const r = await callAnthropic(systemCreate(), userPrompt, apiKey);
    if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Erreur de génération', anthropic_status: r.status, anthropic_detail: r.data }) };

    const parsed = parseModel(r.data);
    if (!parsed)                       return { statusCode: 422, body: JSON.stringify({ error: 'invalid_input' }) };
    if (parsed.error === 'invalid_input') return { statusCode: 422, body: JSON.stringify({ error: 'invalid_input' }) };
    if (!parsed.lyrics || !String(parsed.lyrics).trim()) return { statusCode: 422, body: JSON.stringify({ error: 'invalid_input' }) };

    const suggestions = normSuggestions(parsed.suggestions);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title:       parsed.title || `Pour ${deceased_name}`,
        lyrics:      parsed.lyrics,
        suggestions: JSON.stringify(suggestions)   // stocké tel quel par Make dans le champ texte
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
