// netlify/functions/signaler-echec.js
//
// Pose recovery_pending sur le Projet quand le client a vu un message d'ÉCHEC :
//   - 'lyrics' : la génération des paroles a raté (même après le bouton « Réessayer ») ;
//   - 'song'   : la chanson met trop de temps / pépin technique (popup délai de l'attente).
// Le courriel de récupération (avec le lien) est ensuite envoyé par recovery-cron dès que c'est prêt.
// Idempotent + bot-safe : POST, token UUID v4, no-op si un courriel de récup a déjà été envoyé.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  const kind  = (body.kind === 'song') ? 'song' : (body.kind === 'lyrics' ? 'lyrics' : '');
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!kind)                return { statusCode: 400, body: JSON.stringify({ error: 'Type invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || !dP.records.length) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];

    // Déjà géré (courriel de récup envoyé) -> ne rien re-déclencher.
    if (projet.fields.recovery_email_sent_at) return { statusCode: 200, body: JSON.stringify({ ok: true, already: true }) };

    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { recovery_pending: kind } })
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[signaler-echec]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
