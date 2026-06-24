// netlify/functions/cover-cron.js
//
// RELANCE COVER (remplace le scénario Make « Relance cover ») — fonction PLANIFIÉE (CHAQUE MINUTE,
// netlify.toml -> refaire le cover/régénérer quasi instantané). Trouve les corrections APPROUVÉES + le
// dropdown `refaire`, et déclenche la cover en
// appelant la fonction existante /api/lancer-cover (qui fait la vraie cover Suno + livraison).
// Best-effort : jamais d'exception qui casse le cron.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const SITE     = 'https://chansonmemoire.ca';

exports.handler = async () => {
  let launched = 0;
  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    // 0. REFAIRE LA CHANSON (1-clic via le dropdown `refaire`) : « Refaire le cover » = même mélodie ;
    //    « Régénérer » = nouvelle mélodie (regenerate=true). On réarme (approved + champs cover vidés),
    //    on vide `refaire`, puis on relance lancer-cover (qui utilise adjusted_lyrics/adjusted_style_prompt).
    const rRefaire = await fetch(`${API}/${PROJECTS}?filterByFormula=${encodeURIComponent("{refaire}!=''")}&maxRecords=20`, { headers });
    const dRefaire = await rRefaire.json().catch(() => ({}));
    for (const rec of (dRefaire.records || [])) {
      const tok = rec.fields.token;
      const regenerate = rec.fields.refaire === 'Régénérer';
      try {
        await fetch(`${API}/${PROJECTS}/${rec.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { approval_status: 'approved', cover_task_id: '', cover_launched_at: '', refaire: null } })
        });
        if (tok) { await fetch(`${SITE}/api/lancer-cover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, regenerate }) }); launched++; }
      } catch (_) {}
    }

    const r = await fetch(`${API}/${PROJECTS}?filterByFormula=${encodeURIComponent(
      `AND({approval_status}="approved", {cover_launched_at}="")`
    )}&maxRecords=20`, { headers });
    const d = await r.json();
    const recs = (d && d.records) || [];

    for (const rec of recs) {
      const token = rec.fields.token;
      if (!token) continue;
      try {
        // lancer-cover gate purchased + approved + idempotence (pose cover_task_id/cover_launched_at).
        await fetch(`${SITE}/api/lancer-cover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        launched++;
      } catch (_) {}
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, launched }) };
  } catch (err) {
    console.error('[cover-cron]', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
