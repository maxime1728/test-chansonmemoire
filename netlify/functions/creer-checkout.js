// netlify/functions/creer-checkout.js
// Crée une session Stripe Checkout côté serveur pour acheter UNE version précise (generation_no).
// - Prix FIXÉ SERVEUR (139,97 $ CAD) — jamais reçu du client (Loi concurrence).
// - La version achetée voyage en metadata -> MAKE D la lit et la livre.
// - Valide que la version appartient au projet ET a un audio (anti-tamper).
// Sécurité : POST, UUID v4 strict, secrets en env (STRIPE_SECRET_KEY = clé restreinte TEST).
// Pas de SDK : appel form-encodé direct à l'API Stripe (aucune dépendance, aucun impact build).

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const UUID_V4     = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_CENTS = 13997;     // 139,97 $ CAD — prix fixé serveur
const CURRENCY    = 'cad';
const SITE        = 'https://chansonmemoire.ca';

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

  const generationNo = parseInt(body.generation_no, 10);
  if (!Number.isInteger(generationNo) || generationNo < 1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Version invalide' }) };
  }

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // 1. Project par token.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };   // 404 nu
    }
    const projet  = dP.records[0];
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };

    // 2. La version demandée appartient-elle au projet ET a-t-elle un audio ? (anti-tamper)
    const fG = encodeURIComponent(`AND({project}=${projLit}, {generation_no}=${generationNo})`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = (dG.records && dG.records[0]) ? dG.records[0].fields : null;
    if (!gen || !gen.cloudinary_audio_url) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Version introuvable' }) };
    }

    // 3. Libellé dynamique affiché dans Stripe (jamais le prix : fixé serveur).
    const bits     = [gen.gen_music_style, gen.gen_mood].filter(Boolean);
    const lineName = `Chanson Mémoire — V${generationNo}` + (bits.length ? ` · ${bits.join(' · ')}` : '');
    const songId   = gen.song_id || '';
    const email    = (body.email || '').trim();

    // 4. Crée la Checkout Session (form-encodé).
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', CURRENCY);
    params.append('line_items[0][price_data][unit_amount]', String(PRICE_CENTS));
    params.append('line_items[0][price_data][product_data][name]', lineName);
    params.append('client_reference_id', token);                 // MAKE D retrouve le Project
    params.append('metadata[token]', token);
    params.append('metadata[generation_no]', String(generationNo));
    if (songId) params.append('metadata[song_id]', songId);
    params.append('success_url', `${SITE}/page-chanson?id=${encodeURIComponent(token)}`);
    params.append('cancel_url',  `${SITE}/apercu?id=${encodeURIComponent(token)}`);
    if (email && email.includes('@')) params.append('customer_email', email);

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
      return { statusCode: 502, body: JSON.stringify({ error: 'Création du paiement échouée' }) };
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
