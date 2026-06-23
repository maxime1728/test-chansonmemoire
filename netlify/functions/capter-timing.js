// netlify/functions/capter-timing.js
//
// CAPTURE PRÉCOCE du timing des paroles, dès qu'une chanson est ACHETÉE.
// Suno ne garde les données d'une génération que ~15 jours -> si la vidéo « paroles vivantes » est
// achetée plus tard, l'horodatage serait perdu. On le sauvegarde ICI (à l'achat), dans Airtable
// (Generations.lyrics_timing), de façon PERMANENTE -> la vidéo reste synchronisée même des mois après.
//
// Appelé par MAKE D sur l'achat principal (HTTP POST { token }). Best-effort : ne casse jamais l'achat.
// - Idempotent : si lyrics_timing déjà présent -> ne refait rien.
// - Sécurité : POST, UUID v4 strict, gaté Project 'purchased'. Clé Suno en env (SUNO_API_KEY).

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!SUNO_API_KEY) return { statusCode: 200, body: JSON.stringify({ ok: true, captured: false, reason: 'no_key' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // 1. Project par token — doit être acheté.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // 2. Generation achetée (paroles, ids Suno, timing déjà capté ?).
    const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
    if (!Number.isInteger(purchasedNo)) return { statusCode: 409, body: JSON.stringify({ error: 'Version achetée inconnue' }) };
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = dG.records && dG.records[0];
    if (!gen) return { statusCode: 404, body: JSON.stringify({ error: 'Version introuvable' }) };

    // 3. Idempotence : déjà capté.
    if (gen.fields.lyrics_timing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, captured: true, already: true }) };
    }

    const taskId  = gen.fields.suno_task_id || '';
    const audioId = gen.fields.song_id || '';
    if (!taskId || !audioId) return { statusCode: 200, body: JSON.stringify({ ok: true, captured: false, reason: 'no_ids' }) };

    // 4. Paroles horodatées Suno.
    const rS = await fetch('https://api.sunoapi.org/api/v1/generate/get-timestamped-lyrics', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUNO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, audioId })
    });
    const dS = await rS.json();
    const words = dS && dS.data && dS.data.alignedWords;
    if (!rS.ok || !Array.isArray(words) || words.length === 0) {
      console.error('[capter-timing] horodatage indisponible:', (dS && dS.msg) || `HTTP ${rS.status}`);
      return { statusCode: 200, body: JSON.stringify({ ok: true, captured: false, reason: 'no_words' }) };
    }

    // 5. Stocke le JSON (compact : on ne garde que word/startS/endS) sur la Generation.
    const compact = words
      .filter(w => w && Number.isFinite(w.startS) && Number.isFinite(w.endS))
      .map(w => ({ word: w.word, startS: w.startS, endS: w.endS }));

    await fetch(`${API}/Generations/${gen.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { lyrics_timing: JSON.stringify(compact) } })
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, captured: true, words: compact.length }) };
  } catch (err) {
    console.error('[capter-timing]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: true, captured: false, reason: 'error' }) };  // ne casse jamais l'achat
  }
};
