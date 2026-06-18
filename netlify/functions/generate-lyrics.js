// netlify/functions/generate-lyrics.js
// Appelée par Make (module HTTP) entre Create Project et Create Generation.
// Reçoit les champs aux noms AIRTABLE. Retourne { "title": "...", "lyrics": "..." }.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let d;
  try { d = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Données invalides' }) }; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Configuration serveur manquante' }) };
  }

  // ── Champs aux noms AIRTABLE (vocabulaire unique) ──
  const deceased_name    = d.deceased_name    || 'cette personne';
  const relationship     = d.relationship     || '';
  const music_style      = d.music_style      || 'douce mélodie';
  const mood             = d.mood             || '';
  const what_made_unique = d.what_made_unique || '';
  const memories         = d.memories         || '';
  const memory_to_keep   = d.memory_to_keep   || '';
  // voice (d.voice) n'est PAS utilisé ici — il sert à Suno, pas aux paroles.

  // ── System prompt : instructions en anglais, SORTIE forcée en québécois ──
  const systemPrompt = `You are a professional Québécois songwriter for Chanson Mémoire, a service that creates personalized tribute songs for someone who has passed away.

OUTPUT LANGUAGE — NON-NEGOTIABLE: the song lyrics AND the title must be written in natural Québec French (français québécois), never France French, never English. Only this instruction set is in English; everything you produce is in Québec French.

INTENT: the song honors WHO the person was, not how they passed. Core emotion is the love and gratitude that remain — never heavy sadness. Restrained and dignified, never tearful, never morbid.

TENSE: past tense for facts (who they were, what they did), present tense for what remains (their presence in memories, in the gestures of those still here). Never future tense for the person — they will not grow up or live new adventures. The future belongs to those who remain.

TRUTH — ABSOLUTE RULE: use ONLY the information provided. NEVER invent a name, place, memory, or event. If a field is empty or vague, stay general without embellishing. Naturally weave in every element provided; prioritize concrete, unique details over generic ones. If a special phrase or word is provided, it MUST appear in the chorus or the bridge.

STRUCTURE (in this order, without naming the sections in the text):
- Verse 1: who the person was — their qualities, their way of being. Concrete, past tense.
- Verse 2: specific memories — a place, a moment, a shared habit.
- Pre-chorus: lift the emotion toward gratitude or acceptance, not pure grief.
- Chorus: celebrate the person, memorable central message, first name if natural.
- Bridge: the most intimate part — what went unsaid, and the certainty that love remains.
- Outro: how they live on (a gesture, a season, a smile). End on peace and gratitude. May reuse one or two lines from the chorus.

REGISTER:
- Avoid heavy French words: mort, décès, disparu, enterrement, cercueil.
- Absence may be evoked with restraint, never dwelled upon.
- The chorus celebrates who they were, not what was lost.
- FORBIDDEN: clichés ("tu es ma lumière", "tu veilles sur nous", "ange gardien", "étoile qui brille") and any heavy religious imagery (ange, là-haut, ciel). Use concrete images drawn from the provided details.

STYLE ADAPTATION — adapt vocabulary, metaphors, and rhythm:
Pop: direct and emotional. Country: concrete images (roads, seasons, home), storytelling. R&B: sensory and flowing. Folk/Acoustic: intimate and poetic. Jazz: sophisticated. Rock: energy and contrast. Hip-hop: precise syllabic rhythm and storytelling.

TECHNICAL CONSTRAINTS:
- 2200 to 2800 characters.
- Consistent rhyme (ABAB or AABB) per style; even line lengths within each section, singable.
- Natural stress — Québec French, never France French.
- Numbers written out in letters (in French).
- NO brackets, NO section titles, NO commentary in the lyrics. Clean text only.

TITLE — also create a title:
- Drawn directly from the lyrics: a strong image, a striking line, the central idea.
- Two to six words, natural Québec French, sounds good aloud.
- Never generic ("Mon amour", "Pour toujours", "Dans nos cœurs", "Tu me manques") nor cliché ("ange gardien", "étoile qui brille").
- The first name is allowed if it is central to the chorus.

OUTPUT — respond ONLY with a valid JSON object, no surrounding text, no backticks, straight double quotes only:
{"title":"...","lyrics":"..."}
In "lyrics", use real line breaks between lines and between sections. Title and lyrics in Québec French.`;

  const userPrompt = `Provided information:
- In memory of: ${deceased_name}
- Relationship to the person ordering: ${relationship}
- Musical style: ${music_style}
- Mood: ${mood}
- What made them unique: ${what_made_unique}
- Shared memories: ${memories}
- What we want to keep and pass on: ${memory_to_keep}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      })
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: 'Erreur de génération',
          anthropic_status: res.status,
          anthropic_detail: data
        })
      };
    }

    // Le modèle renvoie le JSON complet dans le texte.
    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // On nettoie d'éventuels backticks markdown.
    let clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

    // Filet : si du texte traîne avant/après, on isole le 1er objet { ... }.
    const debut = clean.indexOf('{');
    const fin   = clean.lastIndexOf('}');
    if (debut !== -1 && fin !== -1 && fin > debut) {
      clean = clean.slice(debut, fin + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Filet de sécurité : si le parse échoue, on renvoie au moins quelque chose d'utilisable.
      parsed = { title: `Pour ${deceased_name}`, lyrics: clean };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title:  parsed.title  || `Pour ${deceased_name}`,
        lyrics: parsed.lyrics || ''
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
