// netlify/functions/accepter-livraison.js
// ÉCRITURE de preuve d'acceptation/livraison (signature + horodatages) sur le Project.
// EXCEPTION ASSUMÉE à « Make écrit, Netlify lit » (décision lockée §6) : écriture ponctuelle,
// champs dédiés, sans concurrence avec la génération. Approuvée explicitement.
//
// ⚠️ LÉGAL : ce code ne fait que CAPTURER la preuve. La portée juridique (remboursement /
// droit de résolution LPC Québec) du texte d'acceptation est à FAIRE VALIDER, jamais un avis.

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

  const token         = (body.token || '').trim();
  const signatureName = (body.signature_name || '').trim();
  const textVersion   = (body.text_version || '').trim();
  const acceptedNo    = parseInt(body.generation_no, 10);   // version choisie/acceptée (devient celle livrée)

  if (!token)         return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!signatureName) return { statusCode: 400, body: JSON.stringify({ error: 'Signature requise' }) };

  // Métadonnées de preuve (best-effort).
  const ip = (event.headers['x-nf-client-connection-ip']
           || event.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ua = event.headers['user-agent'] || '';
  const now = new Date().toISOString();

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Trouver le Project par token.
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }
    const projet = dP.records[0];

    // 2. Garde-fou : on n'enregistre une acceptation que pour un projet PAYÉ (vérif serveur).
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };
    }

    // 3. Écrire la preuve sur le Project (PATCH).
    const fields = {
      delivery_signature_name:         signatureName,
      delivery_signature_at:           now,
      delivery_accessed_at:            now,
      delivery_acceptance_text_version: textVersion,
      acceptance_ip:                   ip,
      acceptance_user_agent:           ua
    };
    // recevoir_clicked_at : ne pas écraser si déjà posé (1re intention).
    if (!projet.fields.recevoir_clicked_at) fields.recevoir_clicked_at = now;
    // Version acceptée = celle qui sera livrée/téléchargée (lire-projet/telecharger servent purchased_generation_no).
    if (Number.isInteger(acceptedNo) && acceptedNo >= 1) fields.purchased_generation_no = acceptedNo;

    const rPatch = await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!rPatch.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Écriture impossible' }) };
    }

    // 3b. Suivi du parcours (best-effort, PATCH SÉPARÉ) : ne jamais coupler la preuve de
    //     livraison à l'option single-select funnel_step (un 422 ici n'empêche pas la révélation).
    try {
      await fetch(`${API}/Projects/${projet.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { funnel_step: 'delivery_accepted' } })
      });
    } catch (_) { /* le suivi ne doit jamais bloquer la livraison */ }

    // 4. Succès → la page peut se révéler.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, accepted_at: now })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
