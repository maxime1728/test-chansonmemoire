// netlify/functions/cockpit-data.js
//
// COCKPIT WEB (interne) — lecture des conversations de correction pour la vue cote-a-cote avant/apres.
// GATE: header `x-cockpit-key` (ou ?key=) == COCKPIT_SECRET. Le token Airtable reste TOUJOURS cote serveur,
// jamais expose au navigateur. GET sans id -> file des conversations a traiter ; GET avec id -> detail.
// Lecture seule (Phase 1). Env: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, COCKPIT_SECRET.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET  = process.env.COCKPIT_SECRET;
const CONVOS  = 'tbl3KBgXthCPromxF';
const REC_ID  = /^rec[A-Za-z0-9]{14}$/;

// Les lookups (paroles_actuelles, voix, prompt_style_actuel) arrivent en tableau -> aplatis en texte.
function str(v) { return Array.isArray(v) ? v.filter(Boolean).join('\n') : (v == null ? '' : String(v)); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'Methode non permise' }) };
  if (!SECRET) { console.error('[cockpit-data] COCKPIT_SECRET manquant'); return { statusCode: 500, body: JSON.stringify({ error: 'Configuration manquante' }) }; }

  const q = event.queryStringParameters || {};
  const key = (event.headers['x-cockpit-key'] || event.headers['X-Cockpit-Key'] || q.key || '').toString();
  if (key !== SECRET) return { statusCode: 401, body: JSON.stringify({ error: 'Non autorise' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };
  const id = (q.id || '').toString().trim();

  try {
    // FILE : conversations a traiter (statut=a_verifier), les plus recentes d'abord.
    if (!id) {
      const f = encodeURIComponent(`AND({statut}!="repondu", {statut}!="archive")`);
      const r = await fetch(`${API}/${CONVOS}?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=recu_le&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=50`, { headers });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[cockpit-data] Airtable list', r.status, JSON.stringify(d).slice(0, 300));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'airtable', status: r.status, detail: (d.error && (d.error.type || d.error.message)) || '' }) };
      }
      const liste = (d.records || []).map((rec) => ({
        id: rec.id,
        expediteur: str(rec.fields.expediteur),
        sujet: str(rec.fields.sujet),
        type_correction: str(rec.fields.type_correction),
        recu_le: str(rec.fields.recu_le)
      }));
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, liste }) };
    }

    // DETAIL : avant/apres d'une conversation.
    if (!REC_ID.test(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id invalide' }) };
    const r = await fetch(`${API}/${CONVOS}/${id}`, { headers });
    if (!r.ok) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const f = (await r.json()).fields || {};
    const detail = {
      id,
      expediteur:          str(f.expediteur),
      sujet:               str(f.sujet),
      message:             str(f.message),
      type_correction:     str(f.type_correction),
      paroles_actuelles:   str(f.paroles_actuelles),
      paroles_corrigees:   str(f.paroles_corrigees),
      prompt_style_actuel: str(f.prompt_style_actuel),
      prompt_style:        str(f.prompt_style),
      voix:                str(f.voix),
      brouillon_ia:        str(f.brouillon_ia),
      action_modif:        str(f.action_modif),
      envoi_reponse:       str(f.envoi_reponse)
    };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, detail }) };
  } catch (err) {
    console.error('[cockpit-data]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
