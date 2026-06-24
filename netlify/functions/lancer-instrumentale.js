// netlify/functions/lancer-instrumentale.js
//
// Enclenche la génération de l'INSTRUMENTALE (add-on payant) via Suno vocal-removal, à partir de
// la version ACHETÉE. Appelé par MAKE D quand l'add-on est payé (token en paramètre), ou manuellement.
// - Idempotent : si déjà lancé (instrumental_task_id présent), ne relance pas.
// - Suno répond en async -> callback-instrumentale.js stockera l'URL.
// - Sécurité : POST, UUID v4, gaté Project 'purchased'. Clé Suno en env (SUNO_API_KEY).
//
// Doc Suno : POST /api/v1/vocal-removal/generate { taskId, audioId, type:"separate_vocal", callBackUrl }.
//   taskId = suno_task_id de la Generation ; audioId = song_id de la Generation.

const BASE_ID      = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN     = process.env.AIRTABLE_TOKEN;
const API          = `https://api.airtable.com/v0/${BASE_ID}`;
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const SITE         = 'https://chansonmemoire.ca';
const UUID_V4      = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!SUNO_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration Suno manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

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

    // 2. Idempotence : déjà lancé -> on ne refait rien.
    if (projet.fields.instrumental_task_id) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };
    }

    // 3. Version achetée -> sa Generation -> suno_task_id (taskId) + song_id (audioId).
    const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
    if (!Number.isInteger(purchasedNo)) return { statusCode: 409, body: JSON.stringify({ error: 'Version achetée inconnue' }) };

    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = dG.records && dG.records[0];
    if (!gen) return { statusCode: 404, body: JSON.stringify({ error: 'Version introuvable' }) };

    const taskId  = gen.fields.suno_task_id || '';
    const audioId = gen.fields.song_id || '';
    if (!taskId || !audioId) return { statusCode: 409, body: JSON.stringify({ error: 'Audio source incomplet' }) };

    // 4. Suno vocal-removal (callback async).
    const rS = await fetch('https://api.sunoapi.org/api/v1/vocal-removal/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUNO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        audioId,
        type: 'separate_vocal',
        callBackUrl: `${SITE}/api/callback-instrumentale${process.env.CALLBACK_SECRET ? '?s=' + encodeURIComponent(process.env.CALLBACK_SECRET) : ''}`
      })
    });
    const dS = await rS.json();
    const vrTask = dS && dS.data && (dS.data.taskId || dS.data.task_id);
    if (!rS.ok || !vrTask) {
      console.error('[lancer-instrumentale] Suno a refusé. Détail:', (dS && dS.msg) || `HTTP ${rS.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Lancement instrumentale échoué' }) };
    }

    // 5. Stocke le taskId vocal-removal -> le callback matchera le Project par ce champ.
    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { instrumental_task_id: String(vrTask) } })
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
