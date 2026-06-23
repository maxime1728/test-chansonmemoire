// netlify/functions/sentinelle-cron.js
//
// SENTINELLE (remplace le scénario Make) — fonction PLANIFIÉE (toutes les 30 min, netlify.toml).
// Stratégie « interroger d'abord, régénérer seulement si vrai échec » -> résout les chansons bloquées
// SANS brûler de crédits Suno inutilement :
//   Pour chaque chanson encore en `audio_pending` (audio absent) avec un suno_task_id :
//     1. GET Suno record-info (GRATUIT) pour connaître l'état réel de la tâche.
//     2. Audio prêt (callback perdu) -> on RÉCUPÈRE l'audio (ré-héberge Cloudinary) -> 0 crédit.
//     3. En cours -> on attend le prochain passage -> 0 crédit.
//     4. Vrai échec -> on régénère (1 crédit), PLAFONNÉ (SENTINELLE_MAX_RETRIES) ; mots sensibles =
//        jamais réessayé (même paroles = même échec) -> escalade incident pour l'alerte 10h.
//
// Best-effort : jamais d'exception qui casse le cron. Env : SUNO_API_KEY, CLOUDINARY_*, MAKE_CCB_WEBHOOK_URL.

const { rehost } = require('./_lib/cloudinary-rehost');
const { accentFor } = require('./_lib/lyrics');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const GENS     = 'tblfrHFe1zH9apNlp';
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const CCB_HOOK     = process.env.MAKE_CCB_WEBHOOK_URL;          // webhook C-cb (pour le callback des régénérations)
const CAP          = parseInt(process.env.SENTINELLE_MAX_RETRIES, 10) || 5;
const MODEL        = 'V5_5';
const MAX_PER_RUN  = 20;

const IN_PROGRESS = ['PENDING', 'TEXT_SUCCESS', 'FIRST_SUCCESS'];

async function atList(formula) {
  const r = await fetch(`${API}/${GENS}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${MAX_PER_RUN}`, {
    headers: { Authorization: `Bearer ${AT_TOKEN}` }
  });
  const d = await r.json();
  return (d && d.records) || [];
}
async function atPatch(id, fields) {
  return fetch(`${API}/${GENS}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}
function styleOf(g, lang) {
  return [g.gen_music_style, g.gen_mood, accentFor(lang)].filter(Boolean).join(', ');
}

exports.handler = async () => {
  if (!SUNO_API_KEY) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_suno_key' }) };
  const now = new Date().toISOString();
  let rescued = 0, regenerated = 0, waiting = 0, escalated = 0;

  try {
    // Chansons en attente d'audio : 10 min à 24 h après création, avec un task_id à interroger.
    const recs = await atList(
      `AND({generation_status}="audio_pending", {cloudinary_audio_url}="", {suno_task_id}!="", ` +
      `IS_BEFORE({created_date}, DATEADD(NOW(),-10,'minutes')), IS_AFTER({created_date}, DATEADD(NOW(),-1440,'minutes')))`
    );

    for (const rec of recs) {
      const g = rec.fields;
      const taskId = g.suno_task_id;
      let dS;
      try {
        const rS = await fetch(`https://api.sunoapi.org/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${SUNO_API_KEY}` }
        });
        dS = await rS.json();
      } catch (_) { continue; }   // interrogation ratée -> on retentera au prochain passage (0 crédit)

      const data   = (dS && dS.data) || {};
      const status = data.status || '';
      const track  = (data.response && Array.isArray(data.response.sunoData) && data.response.sunoData[0]) || {};
      const audioUrl = track.audioUrl || '';

      // 1. AUDIO PRÊT (souvent un callback perdu) -> on récupère, 0 crédit.
      if (audioUrl) {
        const hosted = await rehost(audioUrl, { folder: 'songs', publicId: `song_${taskId}`, resourceType: 'video' }) || audioUrl;
        try {
          await atPatch(rec.id, {
            cloudinary_audio_url: hosted,
            song_id: track.id || g.song_id || '',
            generation_status: 'audio_generated',
            incident_status: 'résolu'
          });
          rescued++;
        } catch (_) {}
        continue;
      }

      // 2. EN COURS -> on attend.
      if (IN_PROGRESS.includes(status)) { waiting++; continue; }

      // 3. MOTS SENSIBLES -> régénérer ne sert à rien -> escalade.
      if (status === 'SENSITIVE_WORD_ERROR') {
        try { await atPatch(rec.id, { incident_status: 'échec_permanent', incident_detail: 'Suno SENSITIVE_WORD_ERROR — régénération inutile (mêmes paroles).', incident_at: now }); escalated++; } catch (_) {}
        continue;
      }

      // 4. VRAI ÉCHEC -> régénérer (1 crédit), plafonné.
      const retries = Number(g.sentinelle_retries) || 0;
      if (retries >= CAP || !CCB_HOOK) {
        try { await atPatch(rec.id, { incident_status: 'échec_permanent', incident_detail: `Échec Suno x${retries} (${status || 'inconnu'})${CCB_HOOK ? '' : ' — MAKE_CCB_WEBHOOK_URL absent'}.`, incident_at: now }); escalated++; } catch (_) {}
        continue;
      }
      try {
        // Langue du Projet lié (accent Suno correct) — chemin rare (régénération), 1 fetch.
        let projLang = '';
        try {
          const pid = Array.isArray(g.project) ? g.project[0] : null;
          if (pid) {
            const rp = await fetch(`${API}/Projects/${pid}`, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
            if (rp.ok) { const dp = await rp.json(); projLang = (dp.fields && dp.fields.language) || ''; }
          }
        } catch (_) {}
        const rGen = await fetch('https://api.sunoapi.org/api/v1/generate', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SUNO_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customMode: true, instrumental: false, model: MODEL,
            prompt: (g.lyrics || '').slice(0, 5000),
            style: styleOf(g, projLang).slice(0, 1000),
            title: (g.song_title || 'Pour toujours').slice(0, 100),
            vocalGender: /Masculin/i.test(g.gen_voice || '') ? 'm' : 'f',
            callBackUrl: CCB_HOOK
          })
        });
        const dGen = await rGen.json();
        const newTask = dGen && dGen.data && dGen.data.taskId;
        if (rGen.ok && newTask) {
          await atPatch(rec.id, { suno_task_id: String(newTask), sentinelle_retries: retries + 1, incident_status: 'surveillance', incident_at: now });
          regenerated++;
        }
      } catch (_) {}
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, found: recs.length, rescued, regenerated, waiting, escalated }) };
  } catch (err) {
    console.error('[sentinelle-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
