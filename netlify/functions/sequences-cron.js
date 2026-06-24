// netlify/functions/sequences-cron.js
//
// MOTEUR GÉNÉRIQUE multi-séquences (fonction planifiée, horaire). Pour CHAQUE séquence du registre
// (_lib/sequences.js), via la table Inscriptions :
//   1. INSCRIT les Projets éligibles (enrollFormula) qui n'ont pas déjà une inscription pour la séquence.
//   2. ENVOIE le courriel dû (next_at <= maintenant), avance l'étape, ou termine.
//   3. SORT ceux qui ne doivent plus y être : désinscription globale (nurture_status=unsubscribed) ou
//      condition de sortie de la séquence (ex. remboursé).
//
// La relance « rattrapage » (non-acheteurs) reste sur nurture-cron — intacte. Ce moteur gère les
// séquences déclarées dans le registre (Bienvenue, puis parrainage / cross-sell).
//
// Best-effort : jamais d'exception qui casse le cron ; on n'avance que si l'envoi a réussi.
// Env : MAILGUN_API_KEY + MAILGUN_DOMAIN_MARKETING + MAILGUN_FROM_MARKETING + CM_POSTAL_ADDRESS.

const { SEQUENCES } = require('./_lib/sequences');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';

const INSCRIPTIONS = 'tbl8vjfRMzbbAmDO4';
const PROJECTS     = 'tblh7O8eoog7RyTMJ';
const CLIENTS      = 'tblQbF1OlE3uRxFra';

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_MARKETING;
const MG_FROM   = process.env.MAILGUN_FROM_MARKETING || 'Chanson Mémoire <info@chansonmemoire.ca>';
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
async function emailOf(project) {
  try {
    const link = project && project.fields && project.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/${CLIENTS}/${recId}`, { headers: H() });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}
async function envoyer(to, subject, html, unsub) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM); form.append('to', to);
  form.append('subject', subject); form.append('html', html);
  form.append('h:List-Unsubscribe', `<${unsub}>`);
  form.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
  try {
    const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth() }, body: form });
    if (!r.ok) console.error('[sequences-cron] Mailgun', r.status, (await r.text().catch(() => '')).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('[sequences-cron] envoi', e && e.message); return false; }
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
          const email = await emailOf(p);
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

        // Sortie : désinscription globale ou condition de la séquence.
        if (!project || pf.nurture_status === 'unsubscribed' || (seq.exit && seq.exit(pf))) {
          try { await atPatch(INSCRIPTIONS, ins.id, { statut: pf.nurture_status === 'unsubscribed' ? 'unsubscribed' : 'done' }); } catch (_) {}
          continue;
        }

        const step = Number(f.step) || 0;
        if (step >= seq.emails.length) { try { await atPatch(INSCRIPTIONS, ins.id, { statut: 'done' }); } catch (_) {} continue; }

        const to = f.client || await emailOf(project);
        if (!to) { try { await atPatch(INSCRIPTIONS, ins.id, { statut: 'done' }); } catch (_) {} continue; }

        const token = pf.token || '';
        const unsub = `${SITE}/api/desabonnement?id=${encodeURIComponent(token)}`;
        const ctx = { prenom: pf.deceased_name || '', token, lien: `${SITE}/page-memoire?id=${encodeURIComponent(token)}`, unsub, postal: POSTAL };
        const mail = seq.emails[step];

        const ok = await envoyer(to, mail.subject, mail.html(ctx), unsub);
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
    return { statusCode: 200, body: JSON.stringify({ ok: true, sequences: out }) };
  } catch (err) {
    console.error('[sequences-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
