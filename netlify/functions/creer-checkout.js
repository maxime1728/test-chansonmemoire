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

    // 2. Récupère TOUTES les Generations (comme lire-versions) pour calculer le RANG affiché
    //    (V1, V2…) parmi les versions JOUABLES — et valider que la version demandée existe (anti-tamper).
    //    Le menu de l'aperçu numérote par rang, pas par generation_no -> on aligne le libellé Stripe.
    const fG = encodeURIComponent(`{project}=${projLit}`);
    const rG = await fetch(
      `${API}/Generations?filterByFormula=${fG}` +
      `&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=asc`,
      { headers }
    );
    const dG = await rG.json();
    let rang = 0, gen = null;
    for (const rec of (dG.records || [])) {
      const f = rec.fields;
      if (!f.cloudinary_audio_url) continue;                              // versions jouables seulement
      rang += 1;
      if (Number(f.generation_no) === generationNo) { gen = f; break; }   // rang = numéro affiché (V{rang})
    }
    if (!gen) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Version introuvable' }) };
    }

    // 3. Libellé dynamique affiché dans Stripe = MÊME rang que le menu (jamais le prix : fixé serveur).
    const bits     = [gen.gen_music_style, gen.gen_mood].filter(Boolean);
    const lineName = `Chanson Mémoire — V${rang}` + (bits.length ? ` · ${bits.join(' · ')}` : '');
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

    // Order bumps (cases INDÉPENDANTES) — prix FIXÉS serveur. Livraison NON immédiate : la metadata
    // est lue à l'ACCEPTATION (signature) pour fulfillment depuis la version acceptée (couche B).
    const bumps = body.bumps || {};
    let li = 1;
    if (bumps.instrumental) {
      params.append(`line_items[${li}][quantity]`, '1');
      params.append(`line_items[${li}][price_data][currency]`, CURRENCY);
      params.append(`line_items[${li}][price_data][unit_amount]`, '1999');   // 19,99 $
      params.append(`line_items[${li}][price_data][product_data][name]`, 'Version instrumentale');
      li += 1;
    }
    if (bumps.paroles_vivantes) {
      params.append(`line_items[${li}][quantity]`, '1');
      params.append(`line_items[${li}][price_data][currency]`, CURRENCY);
      params.append(`line_items[${li}][price_data][unit_amount]`, '1399');   // 13,99 $
      params.append(`line_items[${li}][price_data][product_data][name]`, 'Paroles vivantes');
      li += 1;
    }
    params.append('metadata[bump_instrumental]',     bumps.instrumental ? '1' : '0');
    params.append('metadata[bump_paroles_vivantes]', bumps.paroles_vivantes ? '1' : '0');

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
