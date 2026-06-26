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

const { analyserModif } = require('./_lib/analyse-modif');
const { piedAuto } = require('./_lib/pied-courriel');

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

// SYSTEM + appel Claude d'analyse : centralises dans _lib/analyse-modif.js (partages avec modif-cron).

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

    // 2. Analyse partagee (Claude) : categories + compte-rendu + prompt style + paroles ajustees. Best-effort.
    const { categories, mode, compteRendu: crIA, adjStyle, adjLyrics } = await analyserModif({ apiKey, demande, p, gen });
    const compteRendu = crIA || '(analyse automatique indisponible, a traiter manuellement)';

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
      // Ton ACCOMPLI (le courriel part apres que l'equipe a applique la modif) + pied visible (salutation + signature).
      // Lien en markdown -> rendu cliquable a l'envoi par repondre-courriel.
      const brouillon =
`Bonjour,

Bonne nouvelle${surNom} : votre nouvelle version est prête. Vous pouvez l'écouter ici : [votre page Chanson Mémoire](${lien}).

${piedAuto()}`;
      // paroles_corrigees / prompt_style : versions EDITABLES visibles dans la vue Modifications (l'equipe ajuste
      // puis coche `appliquer` -> appliquer-modification les pousse sur le Projet). Brouillon = reponse client.
      try { await patch(CONVOS, convoId, { brouillon_ia: brouillon, confiance_ia: 'basse', paroles_corrigees: adjLyrics, prompt_style: adjStyle, modif_pregeneree: true }); } catch (_) {}
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[decortique-background]', err && err.message);
    return { statusCode: 200, body: '{}' };   // best-effort : la demande brute est deja enregistree par decortique
  }
};
