// _lib/alerte.js — Alerte interne centralisee : courriel equipe (Mailgun) + capture Sentry + log.
// A appeler dans les blocs critiques pour qu'un echec NE SOIT PLUS silencieux.
// Best-effort, ne jette jamais. Inerte (pas de courriel) si Mailgun/TEAM_NOTIFY_EMAIL absents.

const { capture } = require('./sentry');

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;
const MG_FROM   = process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';
const TEAM      = process.env.TEAM_NOTIFY_EMAIL;

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

async function emailEquipe(subject, html) {
  if (!MG_KEY || !MG_DOMAIN || !TEAM || !TEAM.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM); form.append('to', TEAM);
  form.append('subject', subject); form.append('html', html);
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  try { const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form }); return r.ok; }
  catch (_) { return false; }
}

// alerte(source, message, extra) : log console + Sentry + courriel equipe. Le trio anti-bug-silencieux.
async function alerte(source, message, extra) {
  const ligne = `[${source}] ${message}`;
  console.error('[ALERTE] ' + ligne, extra || '');
  try { await capture(new Error(ligne), extra); } catch (_) {}
  const html = `<p><strong>${esc(source)}</strong></p><p>${esc(message)}</p>`
    + (extra ? `<pre>${esc(JSON.stringify(extra, null, 2)).slice(0, 2000)}</pre>` : '');
  return emailEquipe(`⚠️ CM alerte : ${source}`, html);
}

module.exports = { alerte, emailEquipe };
