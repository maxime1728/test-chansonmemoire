// netlify/functions/sequences-cron.js
//
// MOTEUR GÉNÉRIQUE multi-séquences (fonction planifiée, horaire). Pour CHAQUE séquence du registre
// (_lib/sequences.js), via la table Inscriptions :
//   1. INSCRIT les Projets éligibles (enrollFormula) qui n'ont pas déjà une inscription pour la séquence.
//      Jamais un client désabonné (nurture_optout, #13).
//   2. ENVOIE le courriel dû (next_at <= maintenant), avance l'étape, ou termine.
//   3. SORT ceux qui ne doivent plus y être : désinscription globale (nurture_status=unsubscribed),
//      désabonnement client (nurture_optout, #13) ou condition de sortie de la séquence (ex. remboursé).
//   4. RÉCONCILIE le champ sequence_active du Projet (séquence(s) en cours, lisible d'un coup d'œil, #10).
//
// La relance « rattrapage » (non-acheteurs) reste sur nurture-cron. Ce moteur gère les séquences
// déclarées dans le registre (Bienvenue, parrainage, cross-sell, Noël).
//
// Best-effort : jamais d'exception qui casse le cron ; on n'avance que si l'envoi a réussi.
// Env : MAILGUN_API_KEY + MAILGUN_DOMAIN_MARKETING + MAILGUN_FROM_MARKETING + CM_POSTAL_ADDRESS.

const { SEQUENCES } = require('./_lib/sequences');
const { etiquetteSequenceActive, clientDesabonne } = require('./_lib/nurture-state');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';

const INSCRIPTIONS = 'tbl8vjfRMzbbAmDO4';
const PROJECTS     = 'tblh7O8eoog7RyTMJ';
const CLIENTS      = 'tblQbF1OlE3uRxFra';

const MG_KEY    = process.env.MAILGUN_API_KEY;
const { envoyerCourriel: mgEnvoyer } = require('./_lib/courriel');   // sequence = marketing -> From racine affiché, envoi via sous-domaine info. (Lot 6)
const POSTAL    = process.env.CM_POSTAL_ADDRESS || '';

const MAX_PER_RUN = 40;
const auth = () => 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const H = () => ({ Authorization: `Bearer ${AT_TOKEN}` });

async function atSearch(table, formula, max) {
  const r = await fetch(`${API}/${table}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${max}`, { headers: H() });
  const d = await r.json().catch(() => ({}));
  return (d && d.records) || [];
}
async function atCreate(table, fields) {
  // typecast: true -> crée au besoin le choix de `sequence` (ex. 'parrainage') sans config manuelle.
  return fetch(`${API}/${table}`, { method: 'POST', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields, typecast: true }) });
}
async function atPatch(table, id, fields) {
  return fetch(`${API}/${table}/${id}`, { method: 'PATCH', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
}
async function fetchProject(id) {
  try { const r = await fetch(`${API}/${PROJECTS}/${id}`, { headers: H() }); return r.ok ? await r.json() : null; } catch (_) { return null; }
}
// Email + désabonnement marketing du client lié (1 GET). Best-effort : valeurs vides si indisponible.
async function clientInfo(project) {
  try {
    const link = project && project.fields && project.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return { email: '', optout: false };
    const r = await fetch(`${API}/${CLIENTS}/${recId}`, { headers: H() });
    if (!r.ok) return { email: '', optout: false };
    const f = (await r.json()).fields || {};
    return { email: f.email || '', optout: clientDesabonne(f) };
  } catch (_) { return { email: '', optout: false }; }
}
// Envoi Mailgun marketing via le wrapper central (_lib/courriel) : POST + journalisation Courriels
// (type 'sequence') + en-têtes de désabonnement (livrabilité + 1-clic).
async function envoyer(to, subject, html, unsub, projetId) {
  const { ok } = await mgEnvoyer({
    to, subject, html, type: 'sequence', projetId,
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  });
  return ok;
}

// #10 RÉCONCILIATION de sequence_active : champ lisible sur le Projet = séquence(s) active(s), rattrapage
// (état porté par le Projet) + registre (table Inscriptions). Source UNIQUE pour éviter deux écrivains ;
// n'écrit que les projets dont le libellé change. Best-effort, plafonné.
async function reconcilierSequenceActive() {
  const desired = new Map();   // projectId -> [libellés]
  const courant = new Map();   // projectId -> sequence_active connu (pour n'écrire que les changements)
  const add = (id, label) => { if (id && label) { const a = desired.get(id) || []; a.push(label); desired.set(id, a); } };

  // Registre : inscriptions actives -> séquence(s) par projet.
  const insActives = await atSearch(INSCRIPTIONS, `{statut}='active'`, 1000);
  for (const ins of insActives) {
    const pj = Array.isArray(ins.fields.Projet) ? ins.fields.Projet[0] : null;
    add(pj, ins.fields.sequence);
  }
  // Rattrapage : projets en relance active (état porté par le Projet, hors Inscriptions).
  const enRelance = await atSearch(PROJECTS, `{nurture_status}='active'`, 1000);
  for (const p of enRelance) { add(p.id, 'rattrapage'); courant.set(p.id, p.fields.sequence_active || ''); }
  // Projets déjà étiquetés : connaître leur valeur courante + repérer ceux à vider.
  const etiquetes = await atSearch(PROJECTS, `NOT({sequence_active}='')`, 1000);
  for (const p of etiquetes) { courant.set(p.id, p.fields.sequence_active || ''); if (!desired.has(p.id)) desired.set(p.id, []); }

  let n = 0;
  for (const [id, arr] of desired) {
    const val = etiquetteSequenceActive(arr);
    const cur = courant.has(id) ? courant.get(id) : '';
    if (val === cur) continue;          // aucun changement -> pas d'écriture
    if (n >= 200) break;                // plafond de sécurité
    try { await atPatch(PROJECTS, id, { sequence_active: val }); n++; } catch (_) {}
  }
  return n;
}

exports.handler = async () => {
  const out = {};
  try {
    for (const seq of SEQUENCES) {
      let enrolled = 0, sent = 0;

      // 1. INSCRIPTION : Projets éligibles pas déjà inscrits à CETTE séquence.
      const eligibles = await atSearch(PROJECTS, seq.enrollFormula, MAX_PER_RUN);
      if (eligibles.length) {
        const existantes = await atSearch(INSCRIPTIONS, `{sequence}='${seq.id}'`, 1000);
        const inscrits = new Set();
        for (const ins of existantes) { const pj = ins.fields.Projet; if (Array.isArray(pj)) pj.forEach((id) => inscrits.add(id)); }
        const firstGap = (seq.emails[0] && seq.emails[0].gapBeforeH) || 24;
        for (const p of eligibles) {
          if (inscrits.has(p.id)) continue;
          const { email, optout } = await clientInfo(p);
          if (optout) continue;   // #13 LCAP : client désabonné -> jamais (ré)inscrit.
          try {
            await atCreate(INSCRIPTIONS, {
              client: email || '', Projet: [p.id], sequence: seq.id, step: 0,
              statut: 'active', next_at: hoursFromNow(firstGap), enrolled_at: new Date().toISOString()
            });
            inscrits.add(p.id); enrolled++;
          } catch (_) {}
        }
      }

      // 2. ENVOI des courriels dus + sorties.
      const dues = await atSearch(INSCRIPTIONS, `AND({sequence}='${seq.id}', {statut}='active', IS_BEFORE({next_at}, NOW()))`, MAX_PER_RUN);
      for (const ins of dues) {
        const f = ins.fields;
        const projId = Array.isArray(f.Projet) ? f.Projet[0] : null;
        const project = projId ? await fetchProject(projId) : null;
        const pf = (project && project.fields) || {};

        // Sortie : désinscription globale (projet) ou condition de la séquence (ex. remboursé).
        if (!project || pf.nurture_status === 'unsubscribed' || (seq.exit && seq.exit(pf))) {
          try { await atPatch(INSCRIPTIONS, ins.id, { statut: pf.nurture_status === 'unsubscribed' ? 'unsubscribed' : 'done' }); } catch (_) {}
          continue;
        }

        // Sortie LCAP : désabonnement au niveau CLIENT (vaut pour TOUS ses projets, #13).
        const info = await clientInfo(project);
        if (info.optout) { try { await atPatch(INSCRIPTIONS, ins.id, { statut: 'unsubscribed' }); } catch (_) {} continue; }

        const step = Number(f.step) || 0;
        if (step >= seq.emails.length) { try { await atPatch(INSCRIPTIONS, ins.id, { statut: 'done' }); } catch (_) {} continue; }

        const to = f.client || info.email;
        if (!to) { try { await atPatch(INSCRIPTIONS, ins.id, { statut: 'done' }); } catch (_) {} continue; }

        const token = pf.token || '';
        const unsub = `${SITE}/api/desabonnement?id=${encodeURIComponent(token)}`;
        const ctx = { prenom: pf.deceased_name || '', token, song_type: pf.song_type || 'hommage', lien: `${SITE}/espace-client?id=${encodeURIComponent(token)}`, unsub, postal: POSTAL };
        const mail = seq.emails[step];

        const ok = await envoyer(to, mail.subject, mail.html(ctx), unsub, project && project.id);
        if (!ok) continue;   // Mailgun pas prêt -> on réessaie au prochain passage (sans avancer)
        sent++;

        const newStep = step + 1;
        const champs = (newStep >= seq.emails.length)
          ? { step: newStep, statut: 'done' }
          : { step: newStep, next_at: hoursFromNow(seq.emails[newStep].gapBeforeH) };
        try { await atPatch(INSCRIPTIONS, ins.id, champs); } catch (_) {}
      }

      out[seq.id] = { enrolled, sent };
    }
    const sequence_active_maj = await reconcilierSequenceActive();   // #10
    return { statusCode: 200, body: JSON.stringify({ ok: true, sequences: out, sequence_active_maj }) };
  } catch (err) {
    console.error('[sequences-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};

// Observabilite : heartbeat Healthchecks (dead man's switch) + capture Sentry. Voir _lib/cron.js.
const { withCron } = require('./_lib/cron');
exports.handler = withCron('sequences-cron', exports.handler);
