// netlify/functions/diag-suno.js
// DIAGNOSTIC TEMPORAIRE (à retirer avant merge). Interroge Suno record-info (lecture, 0 crédit) sur le
// cover_task_id d'un Projet (et sur le suno_task_id de la dernière Generation) pour comprendre pourquoi
// un cover n'est pas livré (Suno a-t-il réussi -> callback perdu ? ou échoué ?). Token-gaté (UUID v4).
// Sécurité : POST, UUID v4 strict, formule échappée, secrets en env. N'expose QUE le statut Suno.

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

async function sunoInfo(taskId) {
  if (!taskId || !SUNO_API_KEY) return { taskId: taskId || null, queried: false };
  try {
    const r = await fetch(`https://api.sunoapi.org/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${SUNO_API_KEY}` }
    });
    const d = await r.json().catch(() => ({}));
    const data = (d && d.data) || {};
    // On renvoie l'essentiel (statut + msg + présence d'audio), pas tout le payload.
    const tracks = Array.isArray(data.data) ? data.data : (Array.isArray(data.response && data.response.sunoData) ? data.response.sunoData : []);
    return {
      taskId,
      queried: true,
      http: r.status,
      code: d && d.code,
      msg: d && d.msg,
      status: data.status || data.callbackType || null,
      errorCode: data.errorCode || null,
      errorMessage: data.errorMessage || null,
      nbTracks: tracks.length,
      firstAudio: (tracks[0] && (tracks[0].audio_url || tracks[0].audioUrl)) ? 'present' : 'absent'
    };
  } catch (e) {
    return { taskId, queried: true, error: String(e && e.message) };
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
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const p = dP.records[0].fields;

    // Dernière Generation (pour son suno_task_id, comparaison).
    let lastGen = {};
    const projLit = formulaLiteral(p.project);
    if (projLit !== null) {
      const fG = encodeURIComponent(`{project}=${projLit}`);
      const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
      lastGen = ((((await rG.json()).records) || [])[0] || {}).fields || {};
    }

    const out = {
      project: {
        approval_status:   p.approval_status || null,
        refaire:           p.refaire || null,
        cover_task_id:     p.cover_task_id || null,
        cover_launched_at: p.cover_launched_at || null,
        purchased_generation_no: p.purchased_generation_no || null
      },
      lastGeneration: {
        generation_no:  lastGen.generation_no || null,
        type:           lastGen.type || null,
        status:         lastGen.generation_status || null,
        suno_task_id:   lastGen.suno_task_id || null
      },
      coverTask: await sunoInfo(p.cover_task_id || ''),
      lastGenTask: await sunoInfo(lastGen.suno_task_id || '')
    };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur', detail: String(err && err.message) }) };
  }
};

const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
