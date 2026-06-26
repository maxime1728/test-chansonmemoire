// netlify/functions/_lib/analyse-modif.js
//
// ANALYSE PARTAGEE d'une DEMANDE DE MODIFICATION (chanson hommage Chanson Memoire). Categorise la demande,
// AJUSTE le prompt de style ACTUEL (sans le raccourcir) + propose des paroles ajustees + un compte-rendu
// (mode cover/regeneration). Utilisee par decortique-background (post-achat) ET modif-cron (pre-achat /
// courriels). Best-effort : renvoie ok:false + le style actuel INCHANGE si Claude echoue (jamais d'exception).

const SYSTEM = `Tu prepares une DEMANDE DE MODIFICATION pour une chanson hommage (Chanson Memoire, Quebec). Tu N'EXECUTES pas tout : tu analyses la demande et prepares le travail pour l'equipe.

CATEGORISE la demande dans une ou plusieurs des 5 categories EXACTES : "paroles", "style_ambiance", "prononciation", "souvenirs", "titre".

MODE : "cover" par defaut (garde la melodie existante, ajuste les paroles). "regeneration" UNIQUEMENT si le client veut une autre musique / melodie / style.

PROMPT STYLE : tu recois le PROMPT DE STYLE ACTUEL (deja riche et cure, en anglais). Par defaut, renvoie-le TEL QUEL dans adjusted_style_prompt. Modifie-le UNIQUEMENT si la demande touche explicitement le style, l'ambiance ou la musique. Dans ce cas, PARS du prompt actuel et ajuste SEULEMENT ce que la demande exige, en gardant toute sa richesse (instrumentation, tempo, etc.). NE le raccourcis JAMAIS, ne le reecris pas de zero. REGLES DURES non negociables :
- JAMAIS de noms d'artistes ni de titres de chansons existantes.
- TOUJOURS garder "Quebec French accent, Canadian French" (ou l'accent deja present dans le prompt actuel).
- NE mentionne JAMAIS le genre de la voix ("male voice" / "female voice", "homme", "femme") : la voix est geree separement.

PAROLES AJUSTEES (en francais quebecois), UNIQUEMENT si la demande touche paroles/souvenirs/prononciation :
- Garde TOUT ce qui fonctionne ; applique SEULEMENT la demande. N'invente AUCUN fait, nom ni lieu.
- Sinon, renvoie une chaine vide "".

VOIX DE MARQUE : solution-first, digne, jamais ouvrir sur le deuil ; pas de cliches.

TYPOGRAPHIE : n'utilise JAMAIS le tiret cadratin/long (—) dans tes textes (compte_rendu, paroles) ; mets une virgule, un deux-points, une parenthese ou un point a la place.

SORTIE, reponds UNIQUEMENT avec un objet JSON valide, sans texte autour, guillemets droits :
{"categories":["..."],"mode":"cover","compte_rendu":"<resume clair pour l'equipe, en francais>","adjusted_style_prompt":"<le prompt de style actuel, INCHANGE sauf si la demande touche le style>","adjusted_lyrics":"<paroles ajustees en quebecois OU chaine vide>"}`;

// p = champs du Projet ; gen = champs de la Generation de reference ; demande = texte de la demande client ;
// styleActuel = prompt de style riche de la version de reference (gen_style_prompt, sinon styleFor).
// Renvoie { ok, categories, mode, compteRendu, adjStyle, adjLyrics }. adjStyle retombe TOUJOURS sur styleActuel
// si Claude echoue ou renvoie vide (on ne perd jamais le prompt riche).
async function analyserModif({ apiKey, demande, p = {}, gen = {}, styleActuel = '' }) {
  const defaut = { ok: false, categories: '', mode: 'cover', compteRendu: '', adjStyle: styleActuel || '', adjLyrics: '' };
  if (!apiKey || !demande) return defaut;

  const userPrompt =
`Details du projet :
- Personne honoree : ${p.deceased_name || ''}
- Style actuel : ${gen.gen_music_style || p.music_style || ''}
- Ambiance actuelle : ${gen.gen_mood || p.mood || ''}
- Voix : ${gen.gen_voice || p.voice || ''}
- Titre actuel : ${gen.song_title || ''}

PROMPT DE STYLE ACTUEL (a renvoyer TEL QUEL, ou ajuster SEULEMENT si la demande touche le style) :
${styleActuel || '(non disponible)'}

PAROLES ACTUELLES :
${gen.lyrics || ''}

DEMANDE DU CLIENT (a analyser) :
${demande}`;

  let parsed = null;
  try {
    const rC = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, system: SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
    });
    const data = await rC.json();
    if (rC.ok) {
      let txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
      const a = txt.indexOf('{'), z = txt.lastIndexOf('}');
      if (a !== -1 && z !== -1 && z > a) txt = txt.slice(a, z + 1);
      try { parsed = JSON.parse(txt); } catch (_) { parsed = null; }
    }
  } catch (_) { parsed = null; }
  if (!parsed) return defaut;

  return {
    ok:          true,
    categories:  Array.isArray(parsed.categories) ? parsed.categories.join(', ') : '',
    mode:        parsed.mode === 'regeneration' ? 'regeneration' : 'cover',
    compteRendu: (parsed.compte_rendu || '').toString().slice(0, 3000),
    adjStyle:    ((parsed.adjusted_style_prompt || '').toString().slice(0, 2000)) || styleActuel || '',
    adjLyrics:   (parsed.adjusted_lyrics || '').toString().slice(0, 6000)
  };
}

module.exports = { SYSTEM, analyserModif };
