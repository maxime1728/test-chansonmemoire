// netlify/functions/creer-upsell.js
//
// UPSELL POST-ACHAT (page de livraison = pic émotionnel) : crée une session Stripe Checkout pour
// UN add-on (instrumentale / paroles vivantes), au moment où le client vient de recevoir sa chanson.
// - Prix FIXÉ SERVEUR via Prix Stripe (env) — jamais reçu du client.
// - GATÉ : le Project doit être 'purchased' (l'upsell est réservé aux acheteurs).
// - Token UUID v4 strict + formulaLiteral (anti-injection). Pas de SDK (fetch form-encodé).
//
// Suite (hors de ce endpoint) :
//   - Enregistrement de l'achat : branche MAKE D sur la session Stripe (metadata kind=upsell,
//     upsell_type) -> écrit une ligne dans la table Upsells.
//   - Livraison de l'add-on (instrumentale Suno stem-sep / vidéo) : fulfillment « couche B ».

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SITE     = 'https://chansonmemoire.ca';

const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Add-ons proposés -> variable d'env du Prix Stripe (price_…) correspondant.
const UPSELLS = {
  instrumental:     'STRIPE_PRICE_INSTRUMENTAL',
  paroles_vivantes: 'STRIPE_PRICE_PAROLES_VIVANTES'
};

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
  if (!STRIPE_SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Configuration paiement manquante' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const type = (body.upsell_type || '').trim();
  if (!UPSELLS[type]) return { statusCode: 400, body: JSON.stringify({ error: 'Option invalide' }) };

  const priceId = process.env[UPSELLS[type]];
  if (!priceId) return { statusCode: 503, body: JSON.stringify({ error: 'Option indisponible pour le moment' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // Project par token — DOIT être acheté (l'upsell est réservé aux acheteurs).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // Courriel de l'acheteur (sur le Client lié) : préremplit le checkout ET rend l'adresse fiable
    // dans MAKE D via {{2.data.customer_details.email}} pour le courriel de confirmation de l'upsell.
    let clientEmail = '';
    try {
      const link  = projet.fields.Client;
      const recId = Array.isArray(link) ? link[0] : null;
      if (recId) {
        const rC = await fetch(`${API}/Clients/${recId}`, { headers });
        if (rC.ok) { const dC = await rC.json(); clientEmail = (dC.fields && dC.fields.email) || ''; }
      }
    } catch (_) { /* best-effort : Stripe demandera l'email sinon */ }

    // Session Checkout : add-on seul, prix Stripe fixe. metadata -> MAKE D enregistre (kind=upsell).
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('client_reference_id', token);
    params.append('metadata[token]', token);
    params.append('metadata[kind]', 'upsell');
    params.append('metadata[upsell_type]', type);
    if (clientEmail && clientEmail.includes('@')) params.append('customer_email', clientEmail);
    params.append('success_url', `${SITE}/page-memoire?id=${encodeURIComponent(token)}&upsell_ok=1`);
    params.append('cancel_url',  `${SITE}/page-memoire?id=${encodeURIComponent(token)}`);

    const rS = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const session = await rS.json();
    if (!rS.ok || !session.url) {
      console.error('[creer-upsell] Stripe a refusé la session. Détail:',
        (session && session.error && session.error.message) || `HTTP ${rS.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Paiement indisponible pour le moment' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
