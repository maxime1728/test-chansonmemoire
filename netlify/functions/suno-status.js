// netlify/functions/suno-status.js
// LECTURE seule. Renvoie l'ÉTAPE de génération Suno en cours pour piloter les 3 pastilles de la
// page d'attente (paroles écrites -> première version -> prête). Suno n'expose pas de %, mais des
// statuts d'étape (PENDING / TEXT_SUCCESS / FIRST_SUCCESS / SUCCESS). On les mappe en 0/1/2/done.
// Pas de crédit consommé (record-info est une lecture). Calqué sur sentinelle-cron.js.
// Sécurité : POST, UUID v4 strict, formule échappée, secrets en env. N'expose QUE l'étape.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUNO_API_KEY = process.env.SUNO_API_KEY;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Statut Suno -> étape pour la page (3 pastilles + done).
function mapStage(status) {
  switch (status) {
    case 'SUCCESS':        return 'done';    // chanson prête (le polling lire-projet redirige)
    case 'FIRST_SUCCESS':  return 'first';   // première version chantée -> pastille 3
    case 'TEXT_SUCCESS':   return 'lyrics';  // paroles écrites -> pastille 2
    default:               return 'pending'; // PENDING / inconnu / erreur -> pastille 1
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const p = dP.records[0].fields;

    // 2. Generation la plus récente -> suno_task_id.
    const projLit = formulaLiteral(p.project);
    if (projLit === null) return { statusCode: 200, body: JSON.stringify({ stage: 'pending' }) };
    const fG = encodeURIComponent(`{project}=${projLit}`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = (dG.records && dG.records[0]) ? dG.records[0].fields : {};

    // Audio déjà là -> done (le polling lire-projet prend le relais pour rediriger).
    if (gen.cloudinary_audio_url) return { statusCode: 200, body: JSON.stringify({ stage: 'done' }) };

    const taskId = gen.suno_task_id || '';
    if (!taskId || !SUNO_API_KEY) return { statusCode: 200, body: JSON.stringify({ stage: 'pending' }) };

    // 3. Statut Suno (record-info = lecture, 0 crédit). Échec -> 'pending' (jamais alarmant).
    let stage = 'pending';
    try {
      const rS = await fetch(`https://api.sunoapi.org/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${SUNO_API_KEY}` }
      });
      const dS = await rS.json();
      stage = mapStage((dS && dS.data && dS.data.status) || '');
    } catch (_) { /* on garde 'pending' */ }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ stage: 'pending' }) };   // jamais bloquer l'UI d'attente
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
