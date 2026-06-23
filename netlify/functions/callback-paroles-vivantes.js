// netlify/functions/callback-paroles-vivantes.js
//
// Reçoit le webhook Creatomate en fin de rendu -> écrit l'URL de la vidéo sur le Project.
// Matching : par `metadata` (= token, posé par lancer-paroles-vivantes) en priorité ;
//   sinon par `video_task_id` (= id de rendu Creatomate). Webhook public -> on ne fait que poser video_url.
// Répond TOUJOURS 200 (un webhook ne doit jamais renvoyer d'erreur au fournisseur).
//
// ⚠️ v1 = on stocke l'URL Creatomate directement. Elle est conservée ~30 j puis supprimée.
//    À DURCIR avant le live : ré-héberger sur Cloudinary (comme la chanson). [voir callback-instrumentale]
//
// Payload Creatomate : { id, status:"succeeded"|"failed"|…, url, metadata, … }

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, body: '{}' }; }

  const renderId = (body.id || '').trim();
  const status   = (body.status || '').trim();
  const videoUrl = (body.url || '').trim();
  const meta     = (body.metadata || '').toString().trim();

  if (status !== 'succeeded' || !videoUrl) {
    if (status === 'failed') console.error('[callback-paroles-vivantes] Creatomate échec:', renderId, body.error || '');
    return { statusCode: 200, body: '{}' };   // pas prêt / échec -> on n'écrit rien
  }

  // Filtre de matching : token (metadata) si c'est un UUID valide, sinon id de rendu.
  let formule;
  if (UUID_V4.test(meta)) {
    formule = `{token}=${formulaLiteral(meta)}`;
  } else if (renderId) {
    const lit = formulaLiteral(renderId);
    if (lit === null) return { statusCode: 200, body: '{}' };
    formule = `{video_task_id}=${lit}`;
  } else {
    return { statusCode: 200, body: '{}' };
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const r = await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(formule)}&maxRecords=1`, { headers });
    const d = await r.json();
    const projet = d.records && d.records[0];
    if (!projet) return { statusCode: 200, body: '{}' };   // rien à matcher (inconnu / déjà nettoyé)

    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { video_url: videoUrl } })
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 200, body: '{}' };   // un callback ne renvoie jamais d'erreur au fournisseur
  }
};
