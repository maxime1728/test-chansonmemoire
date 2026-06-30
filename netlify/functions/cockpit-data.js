// netlify/functions/cockpit-data.js
//
// COCKPIT WEB (interne) — lecture ET actions sur les conversations de correction.
// GATE : header `x-cockpit-key` (ou ?key=) == COCKPIT_SECRET. Le token Airtable reste TOUJOURS côté
// serveur, jamais exposé au navigateur.
//
//   GET                -> file des conversations à traiter
//   GET ?id=rec…       -> détail (avant/après paroles+style, voix, brouillon, version régénérée à revoir)
//   POST {id, action}  -> écritures (Phase 2) :
//       action:'save'      { paroles_corrigees?, prompt_style?, reponse? }   -> enregistre les champs édités
//       action:'appliquer' { methode:'cover'|'rege', paroles_corrigees?, prompt_style? }
//                          -> enregistre puis pose `action_modif` (appliquer-cron relance Suno)
//       action:'envoyer'   { reponse? }   -> enregistre la réponse puis pose `envoi_reponse`
//                          (envoyer-cron envoie le courriel). Refusé si une version est encore en régé (#3/#19).
//
// On NE fait que poser les MÊMES champs déclencheurs que Maxime cochait à la main dans Airtable : les crons
// existants (appliquer-cron / envoyer-cron) prennent le relais. Aucune logique métier dupliquée ici.
// Env : AIRTABLE_TOKEN, AIRTABLE_BASE_ID, COCKPIT_SECRET (+ CLOUDINARY_API_SECRET pour signer l'audio).

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const TOKEN    = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.COCKPIT_SECRET;
const CONVOS   = 'tbl3KBgXthCPromxF';
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const REC_ID   = /^rec[A-Za-z0-9]{14}$/;

const { fullAudioUrl } = require('./_lib/cover');

// action_modif : valeurs EXACTES attendues par appliquer-cron / appliquer-modification.
const ACTION_MODIF = { cover: 'Refaire le cover (même mélodie)', rege: 'Régénérer (nouvelle mélodie)' };
const ENVOI_VAL    = 'Envoyer la réponse';

// Les lookups (paroles_actuelles, voix, prompt_style_actuel) arrivent en tableau -> aplatis en texte.
function str(v) { return Array.isArray(v) ? v.filter(Boolean).join('\n') : (v == null ? '' : String(v)); }
function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

const HJSON = { 'Content-Type': 'application/json' };
const ok   = (obj) => ({ statusCode: 200, headers: HJSON, body: JSON.stringify(obj) });
const fail = (code, obj) => ({ statusCode: code, headers: HJSON, body: JSON.stringify(obj) });

// Projet ciblé d'une conversation : override manuel `projet_a_travailler`, sinon le 1er lié.
function projetDe(f) {
  return (Array.isArray(f.projet_a_travailler) && f.projet_a_travailler[0])
      || (Array.isArray(f.Projet) && f.Projet[0]) || null;
}

// #19 — Version régénérée À REVOIR pour ce projet : la Generation la plus récente en `en_production`
// (régé en cours -> envoi en pause) ou `prête` (audio prêt à écouter avant envoi). Renvoie null sinon.
async function versionRegen(headers, convoFields) {
  const projetId = projetDe(convoFields);
  if (!projetId) return null;
  const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
  if (!rP.ok) return null;
  const pf = (await rP.json()).fields || {};
  const lit = formulaLiteral(pf.project);
  if (lit === null) return null;
  const f = encodeURIComponent(`AND({project}=${lit}, OR({version_status}="en_production", {version_status}="prête"))`);
  const r = await fetch(`${API}/Generations?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
  if (!r.ok) return null;
  const g = (((await r.json().catch(() => ({}))).records) || [])[0];
  if (!g) return null;
  const gf = g.fields || {};
  const prete = gf.version_status === 'prête';
  return {
    statut: gf.version_status,                                   // 'en_production' | 'prête'
    titre: str(gf.song_title),
    no: gf.generation_no || null,
    audio_url: prete ? fullAudioUrl(gf.cloudinary_audio_url) : ''  // signé/complet seulement quand prête
  };
}

// Une régé est-elle EN COURS pour ce projet ? (garde-fou d'envoi #3 : on ne notifie pas « version prête »
// pendant que Suno régénère encore.)
async function regeEnCours(headers, convoFields) {
  const projetId = projetDe(convoFields);
  if (!projetId) return false;
  const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
  if (!rP.ok) return false;
  const lit = formulaLiteral(((await rP.json()).fields || {}).project);
  if (lit === null) return false;
  const f = encodeURIComponent(`AND({project}=${lit}, {version_status}="en_production")`);
  const r = await fetch(`${API}/Generations?filterByFormula=${f}&maxRecords=1`, { headers });
  if (!r.ok) return false;
  return !!((((await r.json().catch(() => ({}))).records) || []).length);
}

async function lireConvo(headers, id) {
  const r = await fetch(`${API}/${CONVOS}/${id}`, { headers });
  if (!r.ok) return null;
  return (await r.json()).fields || {};
}

// PATCH Conversations avec typecast (les menus action_modif/envoi_reponse sont des singleSelect).
async function patchConvo(headers, id, fields) {
  return fetch(`${API}/${CONVOS}/${id}`, {
    method: 'PATCH', headers: { ...headers, ...HJSON },
    body: JSON.stringify({ typecast: true, fields })
  });
}

exports.handler = async (event) => {
  if (!SECRET) { console.error('[cockpit-data] COCKPIT_SECRET manquant'); return fail(500, { error: 'Configuration manquante' }); }

  const q = event.queryStringParameters || {};
  const key = (event.headers['x-cockpit-key'] || event.headers['X-Cockpit-Key'] || q.key || '').toString();
  if (key !== SECRET) return fail(401, { error: 'Non autorisé' });

  const headers = { Authorization: `Bearer ${TOKEN}` };

  // ── ACTIONS (Phase 2) ───────────────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return fail(400, { error: 'Requête invalide' }); }
    const id = (body.id || '').toString().trim();
    if (!REC_ID.test(id)) return fail(400, { error: 'id invalide' });
    const action = (body.action || '').toString();

    // Champs édités à enregistrer (présents seulement s'ils sont fournis -> n'écrase jamais avec du vide par accident).
    const edits = {};
    if (typeof body.paroles_corrigees === 'string') edits.paroles_corrigees = body.paroles_corrigees;
    if (typeof body.prompt_style === 'string')      edits.prompt_style      = body.prompt_style;
    if (typeof body.reponse === 'string')           edits.reponse           = body.reponse;

    try {
      if (action === 'save') {
        if (!Object.keys(edits).length) return ok({ ok: true, noop: true });
        const r = await patchConvo(headers, id, edits);
        if (!r.ok) return fail(502, { error: 'Enregistrement échoué', detail: await r.text().catch(() => '') });
        return ok({ ok: true, saved: Object.keys(edits) });
      }

      if (action === 'appliquer') {
        const methode = (body.methode || '').toString();
        const valeur = ACTION_MODIF[methode];
        if (!valeur) return fail(400, { error: 'methode invalide (cover|rege)' });
        // Enregistre les éditions ET arme le déclencheur en un seul PATCH (appliquer-modification relit ces champs).
        const r = await patchConvo(headers, id, { ...edits, action_modif: valeur });
        if (!r.ok) return fail(502, { error: 'Application échouée', detail: await r.text().catch(() => '') });
        return ok({ ok: true, applied: methode });
      }

      if (action === 'envoyer') {
        // Garde-fou #3/#19 : pas d'envoi pendant qu'une version se régénère encore.
        const convo = await lireConvo(headers, id);
        if (!convo) return fail(404, { error: 'Conversation introuvable' });
        if (await regeEnCours(headers, convo)) return fail(409, { error: 'rege_en_cours' });
        const r = await patchConvo(headers, id, { ...edits, envoi_reponse: ENVOI_VAL });
        if (!r.ok) return fail(502, { error: 'Envoi échoué', detail: await r.text().catch(() => '') });
        return ok({ ok: true, queued: true });
      }

      return fail(400, { error: 'action inconnue' });
    } catch (err) {
      console.error('[cockpit-data] action', err && err.message);
      return fail(500, { error: 'Erreur serveur' });
    }
  }

  if (event.httpMethod !== 'GET') return fail(405, { error: 'Méthode non permise' });

  const id = (q.id || '').toString().trim();

  try {
    // ── FILE : conversations à traiter (les plus récentes d'abord). ────────────────────────────────
    if (!id) {
      const f = encodeURIComponent(`AND({statut}!="repondu", {statut}!="archive")`);
      const r = await fetch(`${API}/${CONVOS}?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=recu_le&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=50`, { headers });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[cockpit-data] Airtable list', r.status, JSON.stringify(d).slice(0, 300));
        return ok({ ok: false, error: 'airtable', status: r.status, detail: (d.error && (d.error.type || d.error.message)) || '' });
      }
      const liste = (d.records || []).map((rec) => ({
        id: rec.id,
        expediteur: str(rec.fields.expediteur),
        sujet: str(rec.fields.sujet),
        type_correction: str(rec.fields.type_correction),
        categorie_ia: str(rec.fields.categorie_ia),
        recu_le: str(rec.fields.recu_le)
      }));
      return ok({ ok: true, liste });
    }

    // ── DÉTAIL : avant/après + brouillon + version régénérée à revoir. ──────────────────────────────
    if (!REC_ID.test(id)) return fail(400, { error: 'id invalide' });
    const f = await lireConvo(headers, id);
    if (!f) return fail(404, { error: 'Introuvable' });

    const regen = await versionRegen(headers, f).catch(() => null);

    const detail = {
      id,
      expediteur:          str(f.expediteur),
      sujet:               str(f.sujet),
      message:             str(f.message),
      categorie_ia:        str(f.categorie_ia),
      type_correction:     str(f.type_correction),
      paroles_actuelles:   str(f.paroles_actuelles),
      paroles_corrigees:   str(f.paroles_corrigees),
      prompt_style_actuel: str(f.prompt_style_actuel),
      prompt_style:        str(f.prompt_style),
      voix:                str(f.voix),
      brouillon_ia:        str(f.brouillon_ia),
      reponse:             str(f.reponse),
      action_modif:        str(f.action_modif),
      envoi_reponse:       str(f.envoi_reponse),
      // mode 'modification' = avant/apres (cover/rege/prononciation) ; 'message' = juste valider+envoyer la reponse IA.
      mode: (str(f.categorie_ia) === 'modification') ? 'modification' : 'message',
      regen   // null, ou { statut, titre, no, audio_url }
    };
    return ok({ ok: true, detail });
  } catch (err) {
    console.error('[cockpit-data]', err && err.message);
    return fail(500, { error: 'Erreur serveur' });
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
