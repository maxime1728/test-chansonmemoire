// netlify/functions/watchdog-cron.js
//
// FILET ANTI-BUG-SILENCIEUX des livrables add-on (PAYANTS) : instrumentale (Suno vocal-removal),
// vidéo mémoire + paroles vivantes (Creatomate). Avant, un échec de ces rendus était SILENCIEUX
// (le callback ne gère que le succès, aucun cron ne surveille). Ici, toutes les ~15 min, pour chaque
// Generation où un add-on est LANCÉ (task_id posé) mais NON LIVRÉ (url vide), on interroge le
// fournisseur (statut = lecture, 0 crédit) :
//   - prêt (callback perdu)            -> on RÉCUPÈRE (ré-héberge + écrit l'URL), 0 crédit ;
//   - en cours                         -> on attend ;
//   - vrai échec (critiques)           -> on RELANCE le lanceur, plafonné (instrumentale, vidéo mémoire) ;
//   - vrai échec (paroles vivantes)    -> ALERTE (pas de relance auto) ;
//   - plafond atteint                  -> ALERTE.
// Alerte = _lib/alerte (courriel équipe + Sentry), dédupliquée par *_incident_at (anti-spam).
//
// Best-effort : jamais d'exception qui casse le cron. Env : SUNO_API_KEY, CREATOMATE_API_KEY,
// CREATOMATE_API_VERSION, AIRTABLE_*, SITE_URL, MAILGUN_*/TEAM_NOTIFY_EMAIL (alerte), ADDON_MAX_RETRIES.

const { rehost } = require('./_lib/cloudinary-rehost');
const { alerte } = require('./_lib/alerte');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const GENS     = 'tblfrHFe1zH9apNlp';

const SUNO_API_KEY       = process.env.SUNO_API_KEY;
const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_VERSION = process.env.CREATOMATE_API_VERSION || 'v1';
const SITE = process.env.SITE_URL || 'https://chansonmemoire.ca';
const CAP  = parseInt(process.env.ADDON_MAX_RETRIES, 10) || 5;   // add-ons : rendus coûteux -> plafond plus bas que les chansons
const MAX_PER_RUN = 15;

async function atList(formula) {
  const r = await fetch(`${API}/${GENS}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${MAX_PER_RUN}`, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
  const d = await r.json().catch(() => ({}));
  return (d && d.records) || [];
}
async function atPatch(id, fields) {
  return fetch(`${API}/${GENS}/${id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}
// Token du Projet lié (pour relancer le lanceur, qui est token-gaté).
async function tokenDe(g) {
  try {
    const pid = Array.isArray(g.project) ? g.project[0] : null;
    if (!pid) return '';
    const r = await fetch(`${API}/Projects/${pid}`, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    if (!r.ok) return '';
    return ((await r.json()).fields || {}).token || '';
  } catch (_) { return ''; }
}
async function relancer(path, token) {
  try { await fetch(`${SITE}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); return true; }
  catch (_) { return false; }
}

// ── Creatomate : statut d'un rendu (lecture). -> { status, url }
async function creatomateRender(renderId) {
  if (!CREATOMATE_API_KEY || !renderId) return { status: '', url: '' };
  try {
    const r = await fetch(`https://api.creatomate.com/${CREATOMATE_VERSION}/renders/${encodeURIComponent(renderId)}`, { headers: { Authorization: `Bearer ${CREATOMATE_API_KEY}` } });
    const d = await r.json().catch(() => ({}));
    const render = Array.isArray(d) ? d[0] : d;
    return { status: ((render && render.status) || '').toString().toLowerCase(), url: (render && render.url) || '' };
  } catch (_) { return { status: '', url: '' }; }
}
// ── Suno vocal-removal : statut (lecture). -> { status, instrumentalUrl, vocalUrl }
async function sunoVocalRemoval(taskId) {
  if (!SUNO_API_KEY || !taskId) return { status: '', instrumentalUrl: '', vocalUrl: '' };
  try {
    const r = await fetch(`https://api.sunoapi.org/api/v1/vocal-removal/record-info?taskId=${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${SUNO_API_KEY}` } });
    const d = await r.json().catch(() => ({}));
    const data = (d && d.data) || {};
    const info = data.vocal_removal_info || (data.response && data.response.vocal_removal_info) || {};
    return { status: (data.status || '').toString().toUpperCase(), instrumentalUrl: info.instrumental_url || '', vocalUrl: info.vocal_url || '' };
  } catch (_) { return { status: '', instrumentalUrl: '', vocalUrl: '' }; }
}

const CREATO_FINI    = ['succeeded'];
const CREATO_ECHEC   = ['failed'];
const SUNO_EN_COURS  = ['PENDING', 'PROCESSING', 'RUNNING', 'TEXT_SUCCESS', 'FIRST_SUCCESS', 'GENERATING'];
const SUNO_ECHEC     = ['GENERATE_AUDIO_FAILED', 'CREATE_TASK_FAILED', 'CALLBACK_EXCEPTION', 'SENSITIVE_WORD_ERROR', 'FAILED'];

exports.handler = async () => {
  const now = new Date().toISOString();
  let rescued = 0, relaunched = 0, alerted = 0, waiting = 0;

  // ════ A. INSTRUMENTALE (Suno vocal-removal) — CRITIQUE : retry plafonné ════
  try {
    const recs = await atList(`AND({instrumental_task_id}!="", {instrumental_url}="", {instrumental_incident_at}="")`);
    for (const rec of recs) {
      const g = rec.fields; const taskId = g.instrumental_task_id;
      const s = await sunoVocalRemoval(taskId);

      if (s.instrumentalUrl) {   // prêt (callback perdu) -> récupère
        const fields = { instrumental_url: (await rehost(s.instrumentalUrl, { folder: 'instrumentales', publicId: `instrumental_${taskId}`, resourceType: 'video' })) || s.instrumentalUrl };
        if (s.vocalUrl) { try { fields.vocal_url = (await rehost(s.vocalUrl, { folder: 'vocals', publicId: `vocal_${taskId}`, resourceType: 'video' })) || s.vocalUrl; } catch (_) {} }
        try { await atPatch(rec.id, fields); rescued++; } catch (_) {}
        continue;
      }
      if (SUNO_EN_COURS.includes(s.status) || !s.status) { waiting++; continue; }   // en cours / statut indéterminé -> on attend (pas d'alerte prématurée)

      const retries = Number(g.instrumental_retries) || 0;
      const token = await tokenDe(g);
      if (SUNO_ECHEC.includes(s.status) && s.status !== 'SENSITIVE_WORD_ERROR' && retries < CAP && token) {
        try { await atPatch(rec.id, { instrumental_task_id: '', instrumental_retries: retries + 1 }); await relancer('lancer-instrumentale', token); relaunched++; } catch (_) {}
        continue;
      }
      // mot sensible (régé inutile), plafond atteint, ou sans token -> alerte (dédup via incident_at)
      try { await atPatch(rec.id, { instrumental_incident_at: now }); } catch (_) {}
      try { await alerte('watchdog', `Instrumentale bloquée (Suno ${s.status || 'inconnu'}, relances x${retries}). Intervention manuelle.`, { generation: rec.id, taskId, token }); alerted++; } catch (_) {}
    }
  } catch (e) { console.error('[watchdog] instrumentale', e && e.message); }

  // ════ B. VIDÉO MÉMOIRE (Creatomate) — CRITIQUE : retry plafonné ════
  try {
    const recs = await atList(`AND({video_memoire_task_id}!="", {video_memoire_url}="", {video_memoire_incident_at}="")`);
    for (const rec of recs) {
      const g = rec.fields; const renderId = g.video_memoire_task_id;
      const s = await creatomateRender(renderId);

      if (CREATO_FINI.includes(s.status) && s.url) {   // prêt (callback perdu) -> récupère
        const hosted = (await rehost(s.url, { folder: 'video-memoire', publicId: `memoire_${renderId}`, resourceType: 'video' })) || s.url;
        try { await atPatch(rec.id, { video_memoire_url: hosted }); rescued++; } catch (_) {}
        continue;
      }
      if (!CREATO_ECHEC.includes(s.status)) { waiting++; continue; }   // en cours / indéterminé -> on attend

      const retries = Number(g.video_memoire_retries) || 0;
      const token = await tokenDe(g);
      if (retries < CAP && token) {
        try { await atPatch(rec.id, { video_memoire_task_id: '', video_memoire_retries: retries + 1 }); await relancer('lancer-video-memoire', token); relaunched++; } catch (_) {}
        continue;
      }
      try { await atPatch(rec.id, { video_memoire_incident_at: now }); } catch (_) {}
      try { await alerte('watchdog', `Vidéo mémoire bloquée (Creatomate ${s.status || 'échec'}, relances x${retries}). Intervention manuelle.`, { generation: rec.id, renderId, token }); alerted++; } catch (_) {}
    }
  } catch (e) { console.error('[watchdog] video-memoire', e && e.message); }

  // ════ C. PAROLES VIVANTES (Creatomate) — récupère le callback perdu, ALERTE sur échec (pas de retry auto) ════
  try {
    const recs = await atList(`AND({video_task_id}!="", {video_url}="", {video_incident_at}="")`);
    for (const rec of recs) {
      const g = rec.fields; const renderId = g.video_task_id;
      const s = await creatomateRender(renderId);

      if (CREATO_FINI.includes(s.status) && s.url) {   // prêt (callback perdu) -> récupère
        const hosted = (await rehost(s.url, { folder: 'paroles-vivantes', publicId: `paroles_${renderId}`, resourceType: 'video' })) || s.url;
        try { await atPatch(rec.id, { video_url: hosted }); rescued++; } catch (_) {}
        continue;
      }
      if (!CREATO_ECHEC.includes(s.status)) { waiting++; continue; }   // en cours / indéterminé -> on attend

      try { await atPatch(rec.id, { video_incident_at: now }); } catch (_) {}
      try { await alerte('watchdog', `Paroles vivantes bloquées (Creatomate ${s.status || 'échec'}). Relance manuelle requise.`, { generation: rec.id, renderId, token: await tokenDe(g) }); alerted++; } catch (_) {}
    }
  } catch (e) { console.error('[watchdog] paroles-vivantes', e && e.message); }

  return { statusCode: 200, body: JSON.stringify({ ok: true, rescued, relaunched, alerted, waiting }) };
};

// Observabilite : heartbeat Healthchecks (dead man's switch) + capture Sentry. Voir _lib/cron.js.
const { withCron } = require('./_lib/cron');
exports.handler = withCron('watchdog-cron', exports.handler);
