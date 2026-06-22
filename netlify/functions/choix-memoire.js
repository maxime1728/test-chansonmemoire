// netlify/functions/choix-memoire.js
// Enregistre les choix de la page-memoire : modèle PDF + modèle signet + texte du signet,
// et les inscriptions waitlist (Mémoire vivante / vidéo). Écriture ponctuelle, champs dédiés.
// Le FULFILLMENT (génération Canva des cadeaux) est déclenché séparément (Phase D).
// Sécurité : POST, UUID v4 strict, gaté `purchased`, secrets en env.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };   // 404 nu
    }
    const projet = dP.records[0];
    // Page de livraison = post-achat uniquement.
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };
    }

    // On n'écrit QUE les champs présents (l'appel sert pour les cadeaux OU pour une waitlist).
    const fields = {};
    if (typeof body.pdf_template    === 'string' && body.pdf_template)    fields.pdf_template    = body.pdf_template.slice(0, 60);
    if (typeof body.signet_template === 'string' && body.signet_template) fields.signet_template = body.signet_template.slice(0, 60);
    if (typeof body.signet_text     === 'string')                          fields.signet_text     = body.signet_text.slice(0, 2000);
    if (body.waitlist_memoire === true) fields.waitlist_memoire = true;
    if (body.waitlist_video   === true) fields.waitlist_video   = true;

    if (!Object.keys(fields).length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Rien à enregistrer' }) };
    }

    const r = await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!r.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Écriture impossible' }) };
    }

    // Demande de cadeaux (PDF + signet choisis) -> déclenche le fulfillment Canva (best-effort).
    // On ne fait que SIGNALER le token à Make, qui relit le Project, génère les cadeaux et pose
    // pdf_url/signet_url. N'écrit AUCUN nouveau champ ici et ne bloque jamais la réponse au client.
    if (fields.pdf_template && fields.signet_template && process.env.MAKE_CADEAUX_WEBHOOK_URL) {
      try {
        await fetch(process.env.MAKE_CADEAUX_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
      } catch (_) { /* le déclenchement ne doit jamais bloquer l'enregistrement */ }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
