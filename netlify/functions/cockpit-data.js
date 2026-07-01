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
const LEXIQUE  = 'Lexique_Phonetique';   // dictionnaire phonétique (étape 4)
const REC_ID   = /^rec[A-Za-z0-9]{14}$/;
const SITE     = process.env.SITE_URL || 'https://chansonmemoire.ca';

// FICHE jalon 2 — add-ons de génération (lus sur la Generation achetée) : url = livré, task = en cours,
// incident = échec, + lanceur token-gaté pour relancer. (PDF vient de la table Upsells, voir seulement.)
const ADDONS_GEN = [
  { type: 'instrumentale',    nom: 'Instrumentale',    url: 'instrumental_url',  task: 'instrumental_task_id',  inc: 'instrumental_incident_at',  lancer: 'lancer-instrumentale' },
  { type: 'video-memoire',    nom: 'Vidéo mémoire',    url: 'video_memoire_url', task: 'video_memoire_task_id', inc: 'video_memoire_incident_at', lancer: 'lancer-video-memoire' },
  { type: 'paroles-vivantes', nom: 'Paroles vivantes', url: 'video_url',         task: 'video_task_id',         inc: 'video_incident_at',         lancer: 'lancer-paroles-vivantes' }
];

const { fullAudioUrl } = require('./_lib/cover');
const { stripSectionTags } = require('./_lib/lyrics');   // masque les balises [Verse]/[Chorus] pour l'affichage

// action_modif : valeurs EXACTES attendues par appliquer-cron / appliquer-modification.
const ACTION_MODIF = { cover: 'Refaire le cover (même mélodie)', rege: 'Régénérer (nouvelle mélodie)', paroles: 'Refaire le cover (même mélodie)' };
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
    audio_url: prete ? fullAudioUrl(gf.cloudinary_audio_url) : '',  // signé/complet seulement quand prête
    paroles: prete ? stripSectionTags(str(gf.lyrics)) : ''         // paroles de la version régé (à relire avant envoi ; balises masquées)
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

// Étape 2b — sous-cas PRONONCIATION : le raisonnement IA (correction_request du Projet) + la version
// phonétique envoyée à Suno (lyrics_phonetique de la version liée). Un lyrics_phonetique présent = cas
// prononciation (les paroles AFFICHÉES restent claires ; Suno reçoit le phonétique). Best-effort.
async function detailsCorrection(headers, f) {
  let analyse_ia = '', lyrics_phonetique = '', gen_id = '', langue = '';
  const projetId = projetDe(f);
  if (projetId) {
    try {
      const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
      if (rP.ok) { const pf = (await rP.json()).fields || {}; analyse_ia = str(pf.correction_request); langue = str(pf.language); }
    } catch (_) {}
  }
  const genLink = (Array.isArray(f.generation_a_travailler) && f.generation_a_travailler[0]) || null;
  if (genLink) {
    gen_id = genLink;
    try {
      const rG = await fetch(`${API}/Generations/${genLink}`, { headers });
      if (rG.ok) lyrics_phonetique = str(((await rG.json()).fields || {}).lyrics_phonetique);
    } catch (_) {}
  }
  return { analyse_ia, lyrics_phonetique, gen_id, langue: langue || 'fr-CA', projetId };
}

// Audio de la VERSION ACTUELLE (en ligne) du projet — pour l'ÉCOUTER dans le cockpit (Maxime : « je veux
// une place pour écouter la chanson »). On prend la Generation la plus récente qui a un audio et n'est PAS
// en cours de rendu ('en_production'). URL signée/complète via fullAudioUrl. Best-effort (vide si rien).
async function audioVersionCourante(headers, projetId) {
  if (!projetId) return '';
  try {
    const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
    if (!rP.ok) return '';
    const lit = formulaLiteral(((await rP.json()).fields || {}).project);
    if (lit === null) return '';
    const url = `${API}/Generations?filterByFormula=${encodeURIComponent(`{project}=${lit}`)}` +
      `&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=5`;
    const r = await fetch(url, { headers });
    if (!r.ok) return '';
    const recs = (((await r.json().catch(() => ({}))).records) || []);
    for (const g of recs) {
      const gf = g.fields || {};
      if (gf.cloudinary_audio_url && gf.version_status !== 'en_production') return fullAudioUrl(gf.cloudinary_audio_url);
    }
    return '';
  } catch (_) { return ''; }
}

// Étape 4 — DICTIONNAIRE phonétique du projet : entrées globales de sa langue + overrides du projet (avec
// leur record id, pour l'édition dans le cockpit). Renvoie [] si pas de langue. Best-effort.
async function lireLexiqueBrut(headers, langue, projetId) {
  const lit = formulaLiteral(langue);
  if (lit === null) return [];
  try {
    const r = await fetch(`${API}/${LEXIQUE}?filterByFormula=${encodeURIComponent(`{langue}=${lit}`)}&maxRecords=1000`, { headers });
    if (!r.ok) return [];
    const recs = ((await r.json()).records) || [];
    return recs
      .filter((rec) => {
        const pr = (rec.fields || {}).projet;
        const sur = Array.isArray(pr) && pr.length ? pr : null;
        return !sur || (projetId && sur.includes(projetId));   // globales + overrides de CE projet
      })
      .map((rec) => ({
        id: rec.id,
        mot: str(rec.fields.mot),
        phonetique: str(rec.fields.phonetique),
        override: !!(Array.isArray(rec.fields.projet) && rec.fields.projet.length),
        desactive: !!rec.fields.desactive,
        attempts: rec.fields.attempts || 0,
        historique: str(rec.fields.historique)
      }))
      .sort((a, b) => a.mot.localeCompare(b.mot));
  } catch (_) { return []; }
}

// FICHE (jalon 2) : commande (statut commercial) + add-ons ACHETÉS avec leur statut. Best-effort (jamais
// bloquant). Add-ons de génération lus sur la Generation achetée ; PDF depuis la table Upsells (voir seulement).
async function ficheAddons(headers, projetId) {
  if (!projetId) return null;
  try {
    const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
    if (!rP.ok) return null;
    const p = (await rP.json()).fields || {};
    const commande = { statut: str(p.commercial_status) };
    const addons = [];
    const purchasedNo = parseInt(p.purchased_generation_no, 10);
    const lit = formulaLiteral(p.project);
    if (Number.isInteger(purchasedNo) && lit !== null) {
      const fG = encodeURIComponent(`AND({project}=${lit},{generation_no}=${purchasedNo})`);
      const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
      const g = ((((await rG.json().catch(() => ({}))).records) || [])[0] || {}).fields || {};
      for (const a of ADDONS_GEN) {
        const url = str(g[a.url]), task = str(g[a.task]), inc = str(g[a.inc]);
        if (!url && !task) continue;   // pas acheté / pas lancé -> non affiché
        const etat = url ? 'livre' : (inc ? 'echec' : 'en_cours');
        addons.push({ type: a.type, nom: a.nom, etat, url: url ? fullAudioUrl(url) : '', relance: true });
      }
    }
    const upIds = Array.isArray(p.upsells) ? p.upsells.slice(0, 12) : [];
    for (const uid of upIds) {
      try {
        const rU = await fetch(`${API}/Upsells/${uid}`, { headers });
        if (!rU.ok) continue;
        const uf = (await rU.json()).fields || {};
        if (str(uf.type) === 'lyrics_pdf') addons.push({ type: 'pdf', nom: 'PDF des paroles', etat: uf.delivery_url ? 'livre' : 'en_cours', url: str(uf.delivery_url), relance: false });
      } catch (_) {}
    }
    return { commande, addons };
  } catch (_) { return null; }
}

// VERSIONS du projet (jalon 3a) : liste des générations pour le sélecteur « version de référence »
// (au cas où le client parle d'une version précise). Best-effort. Plus récentes d'abord.
async function versionsProjet(headers, projetId) {
  if (!projetId) return [];
  try {
    const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
    if (!rP.ok) return [];
    const p = (await rP.json()).fields || {};
    const lit = formulaLiteral(p.project);
    if (lit === null) return [];
    const purchasedNo = parseInt(p.purchased_generation_no, 10);
    const url = `${API}/Generations?filterByFormula=${encodeURIComponent(`{project}=${lit}`)}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=25`;
    const r = await fetch(url, { headers });
    if (!r.ok) return [];
    const recs = (((await r.json().catch(() => ({}))).records) || []);
    return recs.map((g) => {
      const gf = g.fields || {};
      return {
        no: gf.generation_no,
        achetee: Number.isInteger(purchasedNo) && gf.generation_no === purchasedNo,
        type: str(gf.type),
        statut: str(gf.version_status),
        voix: str(gf.gen_voice),
        titre: str(gf.song_title),
        style_prompt: str(gf.gen_style_prompt),
        audio: gf.cloudinary_audio_url ? fullAudioUrl(gf.cloudinary_audio_url) : ''
      };
    }).filter((v) => v.no != null);
  } catch (_) { return []; }
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
        if (!valeur) return fail(400, { error: 'methode invalide (cover|rege|paroles)' });
        // Les éditions sont déjà sauvées (auto-save). « Paroles uniquement » = cover qui NE touche PAS le style :
        // on vide prompt_style -> appliquer-modification ne pousse pas adjusted_style_prompt (style inchangé).
        const champs = { ...edits, action_modif: valeur };
        if (methode === 'paroles') champs.prompt_style = '';
        const r = await patchConvo(headers, id, champs);
        if (!r.ok) return fail(502, { error: 'Application échouée', detail: await r.text().catch(() => '') });
        return ok({ ok: true, applied: methode });
      }

      // ── STUDIO A/B (jalon 3b) : générer une version avec son PROPRE prompt de style + voix. Séquentiel
      // (l'idempotence cover_task_id empêche 2 rendus en vol). Effet de bord = vraie génération (crédits Suno).
      if (action === 'generer_version') {
        const methode = (body.methode || '').toString();
        if (methode !== 'rege' && methode !== 'cover') return fail(400, { error: 'methode invalide (rege|cover)' });
        const champs = { action_modif: ACTION_MODIF[methode] };
        if (typeof body.prompt_style === 'string') champs.prompt_style = body.prompt_style;   // -> adjusted_style_prompt (appliquer-modification)
        const r = await patchConvo(headers, id, champs);
        if (!r.ok) return fail(502, { error: 'Génération échouée', detail: await r.text().catch(() => '') });
        // Override de voix sur le Projet (best-effort : le champ adjusted_voice peut ne pas exister encore ->
        // dans ce cas l'override est ignoré, le reste marche ; lancer-cover le consomme et le vide).
        const voix = (body.voix || '').toString().trim();
        if (voix) {
          try {
            const convo = await lireConvo(headers, id);
            const genId = (Array.isArray(convo && convo.generation_a_travailler) && convo.generation_a_travailler[0]) || null;
            if (genId) await fetch(`${API}/Generations/${genId}`, { method: 'PATCH', headers: { ...headers, ...HJSON }, body: JSON.stringify({ fields: { adjusted_voice: voix } }) });
          } catch (_) {}
        }
        return ok({ ok: true, generation: methode, voix: voix || null });
      }

      if (action === 'appliquer_prononciation') {
        // Prononciation : régénère en COVER mais SANS toucher paroles_corrigees -> appliquer-modification
        // ne pose pas adjusted_lyrics, et lancer-cover retombe sur lyrics_phonetique de la version source
        // (Suno reçoit le phonétique, les paroles AFFICHÉES au client restent claires). On enregistre
        // d'abord le phonétique éventuellement édité sur la version liée.
        const convo = await lireConvo(headers, id);
        if (!convo) return fail(404, { error: 'Conversation introuvable' });
        const genId = (Array.isArray(convo.generation_a_travailler) && convo.generation_a_travailler[0]) || null;
        if (genId && typeof body.lyrics_phonetique === 'string') {
          const rG = await fetch(`${API}/Generations/${genId}`, {
            method: 'PATCH', headers: { ...headers, ...HJSON },
            body: JSON.stringify({ fields: { lyrics_phonetique: body.lyrics_phonetique } })
          });
          if (!rG.ok) return fail(502, { error: 'Phonétique non enregistré', detail: await rG.text().catch(() => '') });
        }
        const r = await patchConvo(headers, id, { action_modif: ACTION_MODIF.cover });
        if (!r.ok) return fail(502, { error: 'Application échouée', detail: await r.text().catch(() => '') });
        return ok({ ok: true, applied: 'prononciation' });
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

      if (action === 'archiver') {
        // « Déjà réglé ailleurs » (ex. répondu depuis Gmail) : on sort la conversation de la file sans envoyer.
        // statut='archive' -> exclu de la liste (et de brouillon-cron). Réversible (remettre a_verifier à la main).
        const r = await patchConvo(headers, id, { statut: 'archive' });
        if (!r.ok) return fail(502, { error: 'Archivage échoué', detail: await r.text().catch(() => '') });
        return ok({ ok: true, archived: true });
      }

      // ── DICTIONNAIRE phonétique (étape 4) : gestion à la main depuis le cockpit. ──
      if (action === 'lex_save') {
        const convo = await lireConvo(headers, id);
        if (!convo) return fail(404, { error: 'Conversation introuvable' });
        const recId = (body.recId || '').toString();
        const phon  = (body.phonetique || '').toString().trim();
        const desactive = !!body.desactive;
        if (REC_ID.test(recId)) {
          // Édition d'une entrée existante : réécriture et/ou (dés)activation.
          const fields = {};
          if (typeof body.phonetique === 'string')  fields.phonetique = phon;
          if (typeof body.desactive !== 'undefined') fields.desactive = desactive;
          if (!Object.keys(fields).length) return ok({ ok: true, noop: true });
          const r = await fetch(`${API}/${LEXIQUE}/${recId}`, { method: 'PATCH', headers: { ...headers, ...HJSON }, body: JSON.stringify({ fields }) });
          if (!r.ok) return fail(502, { error: 'Maj lexique échouée', detail: await r.text().catch(() => '') });
          return ok({ ok: true, updated: recId });
        }
        // Création : mot + réécriture requis. Scope global (défaut) ou override du projet courant.
        const mot = (body.mot || '').toString().trim();
        if (!mot || !phon) return fail(400, { error: 'mot et phonetique requis' });
        const projetId = projetDe(convo);
        let langue = 'fr-CA';
        if (projetId) { try { const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers }); if (rP.ok) langue = str(((await rP.json()).fields || {}).language) || 'fr-CA'; } catch (_) {} }
        const fields = { mot, phonetique: phon, langue, source: 'cockpit' };
        if (body.scope === 'projet' && projetId) fields.projet = [projetId];
        if (desactive) fields.desactive = true;
        const r = await fetch(`${API}/${LEXIQUE}`, { method: 'POST', headers: { ...headers, ...HJSON }, body: JSON.stringify({ fields }) });
        if (!r.ok) return fail(502, { error: 'Ajout lexique échoué', detail: await r.text().catch(() => '') });
        return ok({ ok: true, created: true });
      }

      if (action === 'lex_delete') {
        const recId = (body.recId || '').toString();
        if (!REC_ID.test(recId)) return fail(400, { error: 'recId invalide' });
        const r = await fetch(`${API}/${LEXIQUE}/${recId}`, { method: 'DELETE', headers });
        if (!r.ok) return fail(502, { error: 'Suppression échouée', detail: await r.text().catch(() => '') });
        return ok({ ok: true, deleted: recId });
      }

      // ── ADD-ONS (jalon 2) : relancer un livrable (instrumentale / vidéo mémoire / paroles vivantes). ──
      // Effet de bord = vraie génération (crédits). Pattern watchdog : vider le *_task_id (le lanceur est
      // idempotent) puis POST le lanceur token-gaté (qui exige commercial_status='purchased').
      if (action === 'relancer_addon') {
        const a = ADDONS_GEN.find((x) => x.type === (body.type || '').toString());
        if (!a) return fail(400, { error: 'type add-on invalide' });
        const convo = await lireConvo(headers, id);
        if (!convo) return fail(404, { error: 'Conversation introuvable' });
        const projetId = projetDe(convo);
        if (!projetId) return fail(409, { error: 'Projet introuvable' });
        const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
        if (!rP.ok) return fail(502, { error: 'Projet illisible' });
        const p = (await rP.json()).fields || {};
        const token = str(p.token);
        if (!token) return fail(409, { error: 'Token introuvable' });
        const purchasedNo = parseInt(p.purchased_generation_no, 10);
        const lit = formulaLiteral(p.project);
        if (Number.isInteger(purchasedNo) && lit !== null) {
          const fG = encodeURIComponent(`AND({project}=${lit},{generation_no}=${purchasedNo})`);
          const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
          const gen = ((((await rG.json().catch(() => ({}))).records) || [])[0]) || null;
          if (gen) { try { await fetch(`${API}/Generations/${gen.id}`, { method: 'PATCH', headers: { ...headers, ...HJSON }, body: JSON.stringify({ fields: { [a.task]: '' } }) }); } catch (_) {} }
        }
        const rL = await fetch(`${SITE}/api/${a.lancer}`, { method: 'POST', headers: HJSON, body: JSON.stringify({ token }) });
        if (!rL.ok) return fail(502, { error: 'Relance échouée', detail: await rL.text().catch(() => '') });
        return ok({ ok: true, relance: a.type });
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
      // Hors file « à traiter » : répondu, archivé, ET 'auto' (traces self-serve auto-traitées -> le client
      // confirme ses paroles lui-même, l'équipe n'agit pas ; gardées pour l'historique, jamais affichées ici).
      const f = encodeURIComponent(`AND({statut}!="repondu", {statut}!="archive", {statut}!="auto")`);
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
    const corr  = await detailsCorrection(headers, f).catch(() => ({}));
    const estProno = !!(corr.lyrics_phonetique) || /prononciation/i.test(corr.analyse_ia || '');
    const estModif = str(f.categorie_ia) === 'modification';
    const lexique = await lireLexiqueBrut(headers, corr.langue, corr.projetId).catch(() => []);
    const audio_actuel = await audioVersionCourante(headers, corr.projetId).catch(() => '');   // lecteur « version actuelle »
    const fiche = await ficheAddons(headers, corr.projetId).catch(() => null);                 // commande + add-ons (jalon 2)
    const versions = await versionsProjet(headers, corr.projetId).catch(() => []);             // sélecteur version de référence (jalon 3a)

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
      // Sous-cas prononciation (étape 2b) : raisonnement IA + version phonétique envoyée à Suno.
      analyse_ia:          corr.analyse_ia || '',
      lyrics_phonetique:   corr.lyrics_phonetique || '',
      gen_id:              corr.gen_id || '',
      est_prononciation:   estModif && estProno,
      // Étape 4 : dictionnaire phonétique du projet (global langue + overrides) + langue pour les actions lex_*.
      lexique:             lexique,
      langue:              corr.langue || 'fr-CA',
      projetId:            corr.projetId || '',
      // mode : 'modification' (avant/après + bloc prononciation si pertinent) ou 'message' (valider+envoyer).
      // est_prononciation reste un FLAG (le bloc phonétique s'affiche DANS la vue modif, géré avec les paroles).
      mode: estModif ? 'modification' : 'message',
      audio_actuel,   // audio de la version en ligne -> lecteur « écouter la version actuelle » dans le cockpit
      fiche,          // jalon 2 : { commande:{statut}, addons:[{type,nom,etat,url,relance}] }
      versions,       // jalon 3a : [{no,achetee,type,statut,voix,titre,style_prompt,audio}]
      regen   // null, ou { statut, titre, no, audio_url, paroles }
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
