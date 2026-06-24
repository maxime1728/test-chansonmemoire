// netlify/functions/alerte-cron.js
//
// ALERTE 10h (remplace le scénario Make) — fonction PLANIFIÉE (toutes les heures, netlify.toml).
// Trouve les chansons toujours bloquées >10h (audio absent malgré la sentinelle) et NON encore
// alertées -> courriel interne (Mailgun transactionnel) -> marque incident_status="alerté"
// (anti-répétition). Best-effort : jamais d'exception qui casse le cron.
// Env : MAILGUN_API_KEY, MAILGUN_DOMAIN (transac), MAILGUN_FROM, TEAM_NOTIFY_EMAIL.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const GENS     = 'tblfrHFe1zH9apNlp';

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;
const MG_FROM   = process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';
const TEAM      = process.env.TEAM_NOTIFY_EMAIL;

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

async function envoyer(subject, html) {
  if (!MG_KEY || !MG_DOMAIN || !TEAM || !TEAM.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM); form.append('to', TEAM);
  form.append('subject', subject); form.append('html', html);
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  try { const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form }); return r.ok; }
  catch (_) { return false; }
}

exports.handler = async () => {
  const now = new Date().toISOString();
  let alerted = 0;
  try {
    const r = await fetch(`${API}/${GENS}?filterByFormula=${encodeURIComponent(
      `AND({generation_status}="audio_pending", {cloudinary_audio_url}="", ` +
      `IS_BEFORE({created_date}, DATEADD(NOW(),-600,'minutes')), {incident_status}!="alerté")`
    )}&maxRecords=20`, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    const d = await r.json();
    const recs = (d && d.records) || [];

    for (const rec of recs) {
      const g = rec.fields;
      const html = `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.6;">` +
        `<p>Une chanson est restée bloquée plus de 10 h (audio absent malgré les relances de la sentinelle).</p>` +
        `<p><strong>Génération :</strong> ${esc(rec.id)}<br><strong>Titre :</strong> ${esc(g.song_title || '')}<br>` +
        `<strong>Créée :</strong> ${esc(g.created_date || '')}<br><strong>Task Suno :</strong> ${esc(g.suno_task_id || '')}</p>` +
        `<p>Intervention manuelle requise.</p></div>`;
      const sent = await envoyer('ALERTE 10h — chanson toujours bloquée (Chanson Mémoire)', html);
      // On marque "alerté" même si l'envoi échoue, pour éviter le spam ; le détail note l'état d'envoi.
      try {
        await fetch(`${API}/${GENS}/${rec.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            incident_status: 'alerté',
            incident_detail: `Audio absent après 10h — relances sentinelle épuisées. Intervention manuelle requise.${sent ? '' : ' (courriel non envoyé : vérifier Mailgun)'}`,
            incident_at: now
          } })
        });
        alerted++;
      } catch (_) {}
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, alerted }) };
  } catch (err) {
    console.error('[alerte-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
