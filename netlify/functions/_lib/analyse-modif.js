// netlify/functions/_lib/analyse-modif.js
//
// ANALYSE PARTAGEE d'une DEMANDE DE MODIFICATION (chanson hommage Chanson Memoire). Categorise la demande,
// AJUSTE le prompt de style ACTUEL (jamais plus court) en s'inspirant du CATALOGUE de la base si le client
// veut un autre style, + propose des paroles ajustees + un compte-rendu. Utilisee par decortique-background
// (post-achat) ET modif-cron (pre-achat / courriels). Best-effort : ok:false + style actuel si Claude echoue.

const SYSTEM = `Tu prepares une DEMANDE DE MODIFICATION pour une chanson hommage (Chanson Memoire, Quebec). Tu N'EXECUTES pas tout : tu analyses la demande et prepares le travail pour l'equipe.

CATEGORISE la demande dans une ou plusieurs des 5 categories EXACTES : "paroles", "style_ambiance", "prononciation", "souvenirs", "titre".

MODE : "cover" par defaut (garde la melodie existante, ajuste les paroles). "regeneration" UNIQUEMENT si le client veut une autre musique / melodie / style.

NOUVELLE CHANSON (a distinguer d'une simple retouche) : si la demande n'est PAS une modification de CETTE chanson mais une demande de chanson COMPLETEMENT NOUVELLE (une AUTRE personne honoree, un autre sujet, ou explicitement "je veux une nouvelle chanson / une autre chanson"), mets "nouvelle_chanson": true et n'ajuste RIEN (categories: [], adjusted_lyrics: "", lyrics_phonetique: ""). Dans le DOUTE (ca pourrait etre une retouche de la chanson actuelle), mets false. Par defaut false.

PROMPT STYLE (adjusted_style_prompt, en anglais) : tu recois le PROMPT DE STYLE ACTUEL (deja riche) et un CATALOGUE de styles de reference. Regles :
- Par defaut, si la demande NE touche PAS le style/l'ambiance, renvoie le prompt actuel TEL QUEL.
- Si le client veut un AUTRE style musical ou une AUTRE ambiance : inspire-toi du CATALOGUE pour le style qui s'en rapproche, et ecris un prompt SUR MESURE dans le meme niveau de detail.
- Si le client NOMME une chanson ou un artiste : ne l'ecris JAMAIS dans le prompt. Sers-toi de ta connaissance du genre de cette chanson/cet artiste pour ecrire un style qui s'en rapproche.
- Si le client donne des indications precises (ex. "moins de criage", "voix plus calme") : ajuste sur mesure en consequence, inspire-toi du catalogue au besoin.
- Le prompt final ne doit JAMAIS etre plus court que l'actuel (il PEUT etre plus long). Garde un niveau de detail riche (instrumentation, tempo, etc.).
- Garde TOUJOURS l'accent present a la fin du prompt actuel ("Quebec French accent, Canadian French" ou l'accent de la langue). Ne le retire jamais.
- JAMAIS de noms d'artistes ni de titres de chansons existantes dans le prompt. NE mentionne JAMAIS le genre de la voix ("male voice" / "female voice", "homme", "femme") : la voix est geree separement.

PRONONCIATION (si la categorie "prononciation" s'applique) : le chanteur est une IA (Suno) qui ne lit QUE le TEXTE des paroles, on ne peut PAS lui donner une consigne orale comme a un humain. Le SEUL moyen de corriger un mot mal prononce = le REECRIRE phonetiquement dans les paroles, pour qu'il sonne juste en etant lu a voix haute selon les regles du francais (ex. "Roxanne" mal dit -> "Rocksane" ; "Ghislaine" -> "Jislaine" ; "juin" souvent chante "joint" -> "ju-un"). Pieges : "ou" se lit toujours "ou" ; "ch" se lit "ch" (jamais "tch") ; "g" devant e/i se lit "j" (pour un g dur, ecris "gu"). Dans compte_rendu, decris la REECRITURE phonetique proposee, JAMAIS "dire au chanteur de...". DEUX sorties distinctes : (1) adjusted_lyrics = les paroles AFFICHEES au client, en mots CLAIRS et lisibles (PAS de reecriture phonetique ; si la demande ne change pas le texte affiche, renvoie les paroles actuelles inchangees). (2) lyrics_phonetique = les MEMES paroles mais avec le/les mot(s) mal prononce(s) reecrits phonetiquement (ce qui est envoye a Suno) ; garde tout le reste intact. Si AUCUNE prononciation a corriger, lyrics_phonetique = chaine vide "". LISTE AUSSI chaque mot corrige dans le champ "prononciations" : un tableau d'objets {mot, phonetique} = le mot TEL QU'ECRIT dans les paroles claires + sa reecriture. Tableau vide [] si aucune prononciation a corriger.

PAROLES AJUSTEES (en francais quebecois), UNIQUEMENT si la demande touche paroles/souvenirs/prononciation :
- Garde TOUT ce qui fonctionne ; applique SEULEMENT la demande. N'invente AUCUN fait, nom ni lieu.
- Sinon, renvoie une chaine vide "".

VOIX DE MARQUE : solution-first, digne, jamais ouvrir sur le deuil ; pas de cliches.

TYPOGRAPHIE : n'utilise JAMAIS le tiret cadratin/long (—) dans tes textes (compte_rendu, paroles) ; mets une virgule, un deux-points, une parenthese ou un point a la place.

SORTIE, reponds UNIQUEMENT avec un objet JSON valide, sans texte autour, guillemets droits :
{"nouvelle_chanson":false,"categories":["..."],"mode":"cover","compte_rendu":"<resume clair pour l'equipe, en francais>","adjusted_style_prompt":"<prompt actuel inchange, OU ajuste/sur mesure selon la demande, jamais plus court>","adjusted_lyrics":"<paroles AFFICHEES ajustees, mots clairs, en quebecois OU chaine vide>","lyrics_phonetique":"<memes paroles avec les mots mal prononces reecrits phonetiquement pour Suno ; vide si aucune prononciation>","prononciations":[{"mot":"<mot tel qu'ecrit>","phonetique":"<sa reecriture pour Suno>"}]}`;

// p = champs du Projet ; gen = champs de la Generation de reference ; demande = texte client ;
// styleActuel = prompt de style riche de la version de reference ; catalogue = [{style, prompt}] de l'ambiance.
// Renvoie { ok, categories, mode, compteRendu, adjStyle, adjLyrics }. adjStyle retombe TOUJOURS sur styleActuel
// si Claude echoue ou renvoie vide (on ne perd jamais le prompt riche).
async function analyserModif({ apiKey, demande, p = {}, gen = {}, styleActuel = '', catalogue = [] }) {
  const defaut = { ok: false, nouvelleChanson: false, categories: '', mode: 'cover', compteRendu: '', adjStyle: styleActuel || '', adjLyrics: '', prononciations: [] };
  if (!apiKey || !demande) return defaut;

  const cat = (Array.isArray(catalogue) ? catalogue : [])
    .map((c) => `- ${c.style} : ${c.prompt}`).join('\n');

  const userPrompt =
`Details du projet :
- Personne honoree : ${p.deceased_name || ''}
- Style actuel : ${gen.gen_music_style || p.music_style || ''}
- Ambiance actuelle : ${gen.gen_mood || p.mood || ''}
- Voix : ${gen.gen_voice || p.voice || ''}
- Titre actuel : ${gen.song_title || ''}

PROMPT DE STYLE ACTUEL (a renvoyer TEL QUEL, ou ajuster SEULEMENT si la demande touche le style) :
${styleActuel || '(non disponible)'}

CATALOGUE DE STYLES DE REFERENCE (pour t'inspirer si le client veut un autre style ; meme niveau de detail attendu) :
${cat || '(aucun)'}

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
    ok:              true,
    nouvelleChanson: parsed.nouvelle_chanson === true,   // demande de chanson COMPLÈTEMENT neuve (pas une retouche)
    categories:  Array.isArray(parsed.categories) ? parsed.categories.join(', ') : '',
    mode:        parsed.mode === 'regeneration' ? 'regeneration' : 'cover',
    compteRendu: (parsed.compte_rendu || '').toString().slice(0, 3000),
    adjStyle:    ((parsed.adjusted_style_prompt || '').toString().slice(0, 2500)) || styleActuel || '',
    adjLyrics:   (parsed.adjusted_lyrics || '').toString().slice(0, 6000),
    phonetique:  (parsed.lyrics_phonetique || '').toString().slice(0, 6000),   // paroles pour Suno (mots réécrits) ; vide si pas de prononciation
    // Liste des mots corrigés en prononciation {mot, phonetique} -> alimente le dictionnaire (étape 2).
    prononciations: Array.isArray(parsed.prononciations)
      ? parsed.prononciations
          .filter((x) => x && x.mot && x.phonetique)
          .map((x) => ({ mot: String(x.mot).trim().slice(0, 80), phonetique: String(x.phonetique).trim().slice(0, 80) }))
          .slice(0, 20)
      : []
  };
}

// Libelle « type de correction » pour le cockpit (#18, lecture seule), derive de l'analyse partagee.
// regeneration -> nouvelle chanson ; cover + style/ambiance touche -> cover ; sinon paroles seules.
// Valeurs EXACTES = options du singleSelect Conversations.type_correction (fldg1TDQ7grDQQVZw).
function typeCorrection({ mode, categories } = {}) {
  if (mode === 'regeneration') return 'nouvelle chanson (régé)';
  if (/style|ambiance/.test((categories || '').toLowerCase())) return 'cover (mélodie gardée)';
  return 'paroles seules';
}

module.exports = { SYSTEM, analyserModif, typeCorrection };
