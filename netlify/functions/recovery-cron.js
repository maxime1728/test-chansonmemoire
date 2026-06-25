// netlify/functions/recovery-cron.js
//
// #4/#7 — Courriels de RÉCUPÉRATION. Quand le client a vu un message d'échec (paroles ou chanson),
// /api/signaler-echec a posé recovery_pending sur le Projet. Ce cron (toutes les 5 min) :
//   - 'lyrics' : (re)lance la génération des paroles (retry, anti-doublon serveur), plafonné à 6
//                tentatives ; dès que les paroles existent -> courriel avec le lien /revision.
//   - 'song'   : dès que la chanson est audio_generated (relancée par la sentinelle ou livrée par
//                le callback) -> courriel avec le lien /apercu.
// Anti-doublon : recovery_email_sent_at. Best-effort : jamais d'exception qui casse le cron.
// Courriels via Mailgun MARKETING (nathalie@info.chansonmemoire.ca).

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const GENS     = 'tblfrHFe1zH9apNlp';
const MAX_PER_RUN  = 20;
const MAX_RETRIES  = 6;   // plafond de relances paroles (anti-coût)

// Mailgun MARKETING. No-op si non configuré (ne casse jamais le cron).
const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_MARKETING;
const MG_FROM   = process.env.MAILGUN_FROM_MARKETING || 'Chanson Mémoire <nathalie@info.chansonmemoire.ca>';

function headers() { return { Authorization: `Bearer ${AT_TOKEN}` }; }
function formulaLiteral(v) { const s = String(v); if (!s.includes('"')) return `"${s}"`; if (!s.includes("'")) return `'${s}'`; return null; }

async function envoyerCourriel(to, subject, html) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM); form.append('to', to); form.append('subject', subject); form.append('html', html);
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form });
  return r.ok;
}

async function emailDuClient(p) {
  try {
    const link = Array.isArray(p.Client) ? p.Client[0] : null;
    if (!link) return '';
    const r = await fetch(`${API}/Clients/${link}`, { headers: headers() });
    if (!r.ok) return '';
    return (((await r.json()).fields) || {}).email || '';
  } catch (_) { return ''; }
}

async function patchProjet(id, fields) {
  return fetch(`${API}/${PROJECTS}/${id}`, { method: 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
}

// Paroles utilisables présentes ?
async function parolesPretes(projPrimary) {
  const lit = formulaLiteral(projPrimary); if (lit === null) return false;
  const f = encodeURIComponent(`{project}=${lit}`);
  const r = await fetch(`${API}/${GENS}?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers: headers() });
  if (!r.ok) return false;
  const g = (((await r.json()).records) || [])[0];
  const ly = g && g.fields && g.fields.lyrics;
  return !!(ly && String(ly).trim() && !String(ly).includes('"invalid_input"'));
}

// Une chanson audio_generated existe ?
async function chansonPrete(projPrimary) {
  const lit = formulaLiteral(projPrimary); if (lit === null) return false;
  const f = encodeURIComponent(`AND({project}=${lit},{generation_status}="audio_generated")`);
  const r = await fetch(`${API}/${GENS}?filterByFormula=${f}&maxRecords=1`, { headers: headers() });
  if (!r.ok) return false;
  return ((((await r.json()).records) || []).length > 0);
}

const wrap   = (inner) => `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;">${inner}<p style="color:#7A6070;margin-top:18px;">— L'équipe Chanson Mémoire</p></div>`;
const bouton = (href, txt) => `<p style="margin:22px 0;"><a href="${href}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;">${txt}</a></p>`;
const spam   = `<p style="color:#7A6070;">Astuce : si tu ne trouves pas ce courriel, pense à vérifier tes courriels indésirables.</p>`;

exports.handler = async () => {
  if (!AT_TOKEN) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_airtable' }) };
  let sent = 0, retried = 0, waiting = 0, gaveUp = 0;
  try {
    const f = encodeURIComponent(`AND({recovery_pending}!="", {recovery_email_sent_at}=BLANK())`);
    const r = await fetch(`${API}/${PROJECTS}?filterByFormula=${f}&maxRecords=${MAX_PER_RUN}`, { headers: headers() });
    const recs = (((await r.json()) || {}).records) || [];
    const now = new Date().toISOString();

    for (const rec of recs) {
      const p = rec.fields;
      const token = p.token;
      if (!token) continue;

      if (p.recovery_pending === 'lyrics') {
        let pret = await parolesPretes(p.project);
        if (!pret) {
          const att = Number(p.recovery_attempts) || 0;
          if (att >= MAX_RETRIES) { await patchProjet(rec.id, { recovery_pending: '' }); gaveUp++; continue; }  // abandon auto -> humain
          try {
            const rr = await fetch(`${SITE}/api/generate-lyrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'retry', token }) });
            const d = await rr.json().catch(() => ({}));
            pret = !!(rr.ok && d && d.paroles);
          } catch (_) {}
          await patchProjet(rec.id, { recovery_attempts: att + 1 });
          retried++;
        }
        if (pret) {
          const to = await emailDuClient(p);
          const ok = await envoyerCourriel(to, 'Tes paroles sont prêtes',
            wrap(`<p>Bonne nouvelle : les paroles de ta chanson sont prêtes !</p><p>Tu peux les relire, les ajuster si tu veux, puis lancer la création de la chanson.</p>${bouton(`${SITE}/revision?id=${encodeURIComponent(token)}`, 'Voir mes paroles')}${spam}`));
          if (ok) { await patchProjet(rec.id, { recovery_email_sent_at: now, recovery_pending: '' }); sent++; } else { waiting++; }
        } else { waiting++; }
      }

      else if (p.recovery_pending === 'song') {
        if (await chansonPrete(p.project)) {
          const to = await emailDuClient(p);
          const ok = await envoyerCourriel(to, 'Sa chanson est prête',
            wrap(`<p>Sa chanson est prête à écouter !</p>${bouton(`${SITE}/apercu?id=${encodeURIComponent(token)}`, 'Écouter sa chanson')}${spam}`));
          if (ok) { await patchProjet(rec.id, { recovery_email_sent_at: now, recovery_pending: '' }); sent++; } else { waiting++; }
        } else { waiting++; }
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, found: recs.length, sent, retried, waiting, gaveUp }) };
  } catch (err) {
    console.error('[recovery-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
