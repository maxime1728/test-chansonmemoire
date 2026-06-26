// netlify/functions/modif-cron.js
//
// PRE-GENERATION des paroles + prompt style pour les demandes de MODIFICATION qui ne sont PAS passees par
// decortique (pre-achat via prononciation/apercu, ou courriels de modification). Fonction planifiee (chaque
// minute), meme philosophie que brouillon-cron : decouplee, auto-reparante si Anthropic est en panne.
//
// Cible : conversations categorie_ia="modification" pas encore pre-generees (modif_pregeneree non coche) avec
// un projet lie. Pour chacune : analyse partagee (_lib/analyse-modif) a partir de la demande (message) + des
// paroles actuelles du projet -> ecrit paroles_corrigees + prompt_style (editables), pose mode_correction sur
// le Projet, coche modif_pregeneree. La REPONSE client (brouillon_ia) reste redigee par brouillon-cron. Maxime
// relit, ajuste, applique (coche appliquer) ou regenere, et envoie (coche envoyer).
//
// Best-effort : jamais d'exception qui casse le cron. Env : ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const { analyserModif } = require('./_lib/analyse-modif');
const { styleFor, cataloguePourAmbiance } = require('./_lib/style');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CONVOS   = 'tbl3KBgXthCPromxF';
const PROJECTS = 'Projects', GENERATIONS = 'Generations';
const MAX_PER_RUN = 5;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

async function patch(table, id, fields) {
  return fetch(`${API}/${table}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

exports.handler = async () => {
  if (!ANTHROPIC_KEY) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_key' }) };
  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  let faits = 0, echecs = 0;

  try {
    // Demandes de modification pas encore pre-generees.
    const formula = encodeURIComponent('AND({categorie_ia}="modification", NOT({modif_pregeneree}))');
    const r = await fetch(`${API}/${CONVOS}?filterByFormula=${formula}&maxRecords=${MAX_PER_RUN}`, { headers });
    const d = await r.json().catch(() => ({}));
    const recs = (d && d.records) || [];

    for (const rec of recs) {
      const f = rec.fields || {};
      // Projet cible : projet_a_travailler sinon le 1er lie. Sans projet lie, on ne peut pas analyser -> on
      // coche quand meme pour ne pas boucler indefiniment (l'equipe traitera a la main).
      const projetId = (Array.isArray(f.projet_a_travailler) && f.projet_a_travailler[0])
                    || (Array.isArray(f.Projet) && f.Projet[0]) || null;
      if (!projetId) { try { await patch(CONVOS, rec.id, { modif_pregeneree: true }); } catch (_) {} continue; }

      try {
        // Projet + Generation de reference (version achetee si connue, sinon la plus recente).
        const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
        if (!rP.ok) { echecs++; continue; }
        const p = (await rP.json()).fields || {};

        const projLit  = formulaLiteral(p.project);
        const boughtNo = parseInt(p.purchased_generation_no, 10);
        let genRec = null, gen = {};
        if (projLit !== null) {
          const fG  = Number.isInteger(boughtNo)
            ? encodeURIComponent(`AND({project}=${projLit}, {generation_no}=${boughtNo})`)
            : encodeURIComponent(`{project}=${projLit}`);
          const triG = Number.isInteger(boughtNo) ? '' : '&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc';
          const rG  = await fetch(`${API}/${GENERATIONS}?filterByFormula=${fG}${triG}&maxRecords=1`, { headers });
          genRec = ((((await rG.json()).records) || [])[0]) || null;
          gen = (genRec && genRec.fields) || {};
        }

        // Prompt de style de reference : gen_style_prompt de la version, sinon le prompt cure (styleFor).
        const styleActuel = (gen.gen_style_prompt && gen.gen_style_prompt.trim())
          || await styleFor({ music_style: gen.gen_music_style || p.music_style, mood: gen.gen_mood || p.mood, cadeau: p.song_type === 'cadeau', language: p.language });
        const catalogue = await cataloguePourAmbiance({ mood: gen.gen_mood || p.mood, cadeau: p.song_type === 'cadeau', language: p.language });

        // Analyse partagee : la demande = le message du fil.
        const demande = (f.message || '').toString().trim().slice(0, 4000);
        const res = await analyserModif({ apiKey: ANTHROPIC_KEY, demande, p, gen, styleActuel, catalogue });
        if (!res.ok) { echecs++; continue; }   // Anthropic indispo -> on reessaiera (auto-reparation), ne pas marquer

        // Versions editables + version de reference pre-remplie sur la Conversation ; mode sur le Projet.
        const champs = { paroles_corrigees: res.adjLyrics, prompt_style: res.adjStyle, modif_pregeneree: true };
        if (genRec) champs.generation_a_travailler = [genRec.id];
        await patch(CONVOS, rec.id, champs);
        try { await patch(PROJECTS, projetId, { mode_correction: res.mode }); } catch (_) {}
        faits++;
      } catch (e) { echecs++; console.error('[modif-cron]', e && e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, trouve: recs.length, faits, echecs }) };
  } catch (err) {
    console.error('[modif-cron]', err && err.message);
    return { statusCode: 200, body: '{}' };
  }
};
