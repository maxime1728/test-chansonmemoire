// netlify/functions/_lib/comptage.js
//
// SOURCE UNIQUE de la règle de comptage des chansons (sans rollup Airtable).
// Utilisé par lancer-chanson (plafond + stat) et sentinelle-cron (recalcul après livraison).
//
// Règle (validée avec Maxime) : une Generation compte comme « chanson réussie » seulement si
// l'audio Suno a été LIVRÉ. Donc :
//   - les paroles (lyrics / lyrics_regeneration) ne comptent jamais (pas de Suno) ;
//   - les échecs ne comptent jamais (generation_status n'atteint pas audio_generated) ;
//   - ce que l'équipe déclenche (admin_triggered) ne compte jamais.
// On distingue AVANT achat (post_purchase faux) et APRÈS achat (post_purchase vrai).

const SONG_TYPES = ['song', 'song_regeneration', 'cover'];

function estChansonLivree(g) {
  return !!g
    && g.generation_status === 'audio_generated'
    && SONG_TYPES.includes(g.type)
    && !g.admin_triggered;
}

// Compte AVANT achat (plafond 4/projet + cumul client) : chanson livrée, client, pré-achat.
function compteAvantAchat(g) {
  return estChansonLivree(g) && !g.post_purchase;
}

// Compte APRÈS achat (plafond 4/projet) : chanson livrée, client, post-achat, hors « paroles seules ».
// (correction_paroles_seules = cover déclenché par une demande de PAROLES uniquement -> exempté.)
function compteApresAchat(g) {
  return estChansonLivree(g) && !!g.post_purchase && !g.correction_paroles_seules;
}

// Recalcule les compteurs d'un projet à partir de SES Generations, et les écrit (best-effort).
// `api` = base URL Airtable, `headers` = { Authorization }. Renvoie { avant, apres }.
async function recomputerProjet(api, headers, projetId, projetPrimary) {
  const out = { avant: 0, apres: 0 };
  try {
    const lit = (() => { const s = String(projetPrimary); return s.includes('"') ? (s.includes("'") ? null : `'${s}'`) : `"${s}"`; })();
    if (lit === null) return out;
    const f = encodeURIComponent(`{project}=${lit}`);
    const r = await fetch(`${api}/Generations?filterByFormula=${f}`, { headers });
    if (!r.ok) return out;
    const recs = ((await r.json()).records) || [];
    for (const rec of recs) {
      if (compteAvantAchat(rec.fields)) out.avant++;
      if (compteApresAchat(rec.fields)) out.apres++;
    }
    await fetch(`${api}/Projects/${projetId}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { chansons_reussies_avant: out.avant } })
    });
  } catch (_) { /* best-effort : ne bloque jamais l'appelant */ }
  return out;
}

module.exports = { SONG_TYPES, estChansonLivree, compteAvantAchat, compteApresAchat, recomputerProjet };
