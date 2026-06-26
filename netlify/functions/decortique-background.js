// netlify/functions/decortique-background.js
//
// ANALYSE EN ARRIERE-PLAN d'une demande de modification post-achat (Phase 1 du flux « corrections »).
// Invoquee par decortique.js, qui a DEJA enregistre la demande BRUTE sur le Projet + cree une ligne
// Conversations -> rien n'est jamais perdu, meme si Claude rame ou echoue ici. Comme c'est une « background
// function » Netlify (suffixe -background), on a jusqu'a 15 min : plus de timeout 10 s.
//
// Ce worker PROPOSE seulement : Claude categorise la demande, propose des paroles ajustees + un prompt style
// + un compte-rendu, et redige un BROUILLON de courriel de reponse au client dans la Conversation. Tout reste
// EDITABLE par l'equipe avant approbation. RIEN n'est envoye ni regenere ici : l'equipe approuve manuellement
// (approval_status='approved' sur le Projet) -> cover-cron lance la regeneration. (Auto-approbation IA : plus tard.)
//
// Securite : secret partage DECORTIQUE_SECRET (optionnel : repli sur re-verif purchased) + token UUID v4.
// Env : ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID, DECORTIQUE_SECRET.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE    = 'https://chansonmemoire.ca';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET  = process.env.DECORTIQUE_SECRET || '';

const PROJECTS = 'Projects', GENERATIONS = 'Generations', CONVOS = 'tbl3KBgXthCPromxF';

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

async function patch(table, id, fields) {
  return fetch(`${API}/${table}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

const SYSTEM = `Tu prepares une DEMANDE DE MODIFICATION post-achat pour une chanson hommage (Chanson Memoire, Quebec). Tu N'EXECUTES pas tout : tu analyses la demande et prepares le travail pour l'equipe.

CATEGORISE la demande dans une ou plusieurs des 5 categories EXACTES : "paroles", "style_ambiance", "prononciation", "souvenirs", "titre".

MODE : "cover" par defaut (garde la melodie existante, ajuste les paroles). "regeneration" UNIQUEMENT si le client veut une autre musique / melodie / style.

PROMPT STYLE AJUSTE (en anglais, directives musicales courtes) — REGLES DURES, non negociables :
- JAMAIS de noms d'artistes ni de titres de chansons existantes.
- TOUJOURS inclure "Quebec French accent, Canadian French".
- NE mentionne JAMAIS le genre de la voix ("male voice" / "female voice", "homme", "femme") : la voix est DEJA choisie par le client et geree separement (vocalGender Suno). N'inclus rien sur la voix dans le prompt style.
- Ne contredis PAS le style/ambiance existants, sauf demande explicite du client.
- Format : genre, instrumentation, tempo, langue/accent (PAS de voix).

PAROLES AJUSTEES (en francais quebecois) — UNIQUEMENT si la demande touche paroles/souvenirs/prononciation :
- Garde TOUT ce qui fonctionne ; applique SEULEMENT la demande. N'invente AUCUN fait, nom ni lieu.
- Sinon, renvoie une chaine vide "".

VOIX DE MARQUE : solution-first, digne, jamais ouvrir sur le deuil ; pas de cliches.

TYPOGRAPHIE : n'utilise JAMAIS le tiret cadratin/long (—) dans tes textes (compte_rendu, paroles) ; mets une virgule, un deux-points, une parenthese ou un point a la place.

SORTIE — reponds UNIQUEMENT avec un objet JSON valide, sans texte autour, guillemets droits :
{"categories":["..."],"mode":"cover","compte_rendu":"<resume clair pour l'equipe, en francais>","adjusted_style_prompt":"<prompt style en anglais respectant les regles dures>","adjusted_lyrics":"<paroles ajustees en quebecois OU chaine vide>"}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('[decortique-background] ANTHROPIC_API_KEY manquant'); return { statusCode: 200, body: '{}' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return { statusCode: 400, body: '{}' }; }
  if (SECRET && (body.secret || '') !== SECRET) return { statusCode: 403, body: '{}' };

  const token   = (body.token || '').toString().trim();
  const demande = (body.demande || '').toString().trim().slice(0, 4000);
  const convoId = (body.convoId || '').toString().trim();
  if (!UUID_V4.test(token) || !demande) return { statusCode: 400, body: '{}' };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token + Generation de reference (version achetee si connue, sinon la plus recente).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/${PROJECTS}?filterByFormula=${fP}&maxRecords=1`, { headers });
    const projet = (((await rP.json()).records) || [])[0];
    if (!projet) return { statusCode: 404, body: '{}' };
    const p = projet.fields;
    if (p.commercial_status !== 'purchased') return { statusCode: 403, body: '{}' };

    const projLit  = formulaLiteral(p.project);
    const boughtNo = parseInt(p.purchased_generation_no, 10);
    const fG  = Number.isInteger(boughtNo)
      ? encodeURIComponent(`AND({project}=${projLit}, {generation_no}=${boughtNo})`)
      : encodeURIComponent(`{project}=${projLit}`);
    const triG = Number.isInteger(boughtNo) ? '' : '&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc';
    const rG  = await fetch(`${API}/${GENERATIONS}?filterByFormula=${fG}${triG}&maxRecords=1`, { headers });
    const gen = ((((await rG.json()).records) || [])[0] || {}).fields || {};

    // 2. Claude : categorise + compte-rendu + prompt style ajuste + paroles ajustees (si pertinent). Best-effort.
    const userPrompt =
`Details du projet :
- Personne honoree : ${p.deceased_name || ''}
- Style actuel : ${gen.gen_music_style || p.music_style || ''}
- Ambiance actuelle : ${gen.gen_mood || p.mood || ''}
- Voix : ${gen.gen_voice || p.voice || ''}
- Titre actuel : ${gen.song_title || ''}

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

    const categories  = (parsed && Array.isArray(parsed.categories)) ? parsed.categories.join(', ') : '';
    const mode        = (parsed && parsed.mode === 'regeneration') ? 'regeneration' : 'cover';
    const compteRendu = (((parsed && parsed.compte_rendu) || '').toString().slice(0, 3000)) || '(analyse automatique indisponible — a traiter manuellement)';
    const adjStyle    = ((parsed && parsed.adjusted_style_prompt) || '').toString().slice(0, 2000);
    const adjLyrics   = ((parsed && parsed.adjusted_lyrics) || '').toString().slice(0, 6000);

    // 3. Enrichit le Projet : paroles/style PROPOSES (editables). approval_status reste 'pending' (approbation
    //    manuelle de l'equipe -> cover-cron). Aucune regeneration declenchee ici.
    await patch(PROJECTS, projet.id, {
      correction_request:    `CATEGORIES : ${categories}\n\nDEMANDE CLIENT :\n${demande}\n\nANALYSE (proposition IA, a ajuster au besoin) :\n${compteRendu}`,
      adjusted_style_prompt: adjStyle,
      adjusted_lyrics:       adjLyrics,
      mode_correction:       mode
    });

    // 4. Brouillon de reponse client dans la Conversation (editable, a envoyer apres approbation). Template
    //    simple et personnalisable ; pas l'analyse technique (qui est pour l'equipe, sur le Projet).
    if (convoId) {
      const lien    = p.page_url || `${SITE}/page-chanson?id=${encodeURIComponent(token)}`;
      const surNom  = p.deceased_name ? ` concernant la chanson de ${p.deceased_name}` : '';
      // Corps seulement : la salutation du moment + la signature (Nathalie, L'equipe Chanson Memoire) sont
      // ajoutees automatiquement a l'envoi par repondre-courriel. Lien en markdown -> cliquable, courriel plus propre.
      const brouillon =
`Bonjour,

C'est bien noté pour votre demande${surNom}. On s'en occupe avec soin.

Dès que votre nouvelle version sera prête, vous pourrez l'écouter ici : [votre page Chanson Mémoire](${lien}).`;
      // paroles_corrigees / prompt_style : versions EDITABLES visibles dans la vue Modifications (l'equipe ajuste
      // puis coche `appliquer` -> appliquer-modification les pousse sur le Projet). Brouillon = reponse client.
      try { await patch(CONVOS, convoId, { brouillon_ia: brouillon, confiance_ia: 'basse', paroles_corrigees: adjLyrics, prompt_style: adjStyle }); } catch (_) {}
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[decortique-background]', err && err.message);
    return { statusCode: 200, body: '{}' };   // best-effort : la demande brute est deja enregistree par decortique
  }
};
