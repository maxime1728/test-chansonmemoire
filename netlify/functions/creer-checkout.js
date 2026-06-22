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

    // 3. Articles. Pour des ORDER BUMPS natifs (optional_items, ajoutables sur la PAGE STRIPE), les
    //    articles doivent être des Prix Stripe : Stripe interdit optional_items avec un montant
    //    personnalisé (price_data). Donc si STRIPE_PRICE_SONG est défini -> chemin Price IDs + bumps ;
    //    sinon repli price_data (libellé dynamique, sans bumps natifs) pour ne rien casser avant config.
    const songId = gen.song_id || '';
    const email  = (body.email || '').trim();

    const SONG_PRICE    = process.env.STRIPE_PRICE_SONG;             // Prix Stripe one-time 139,97 $ CAD
    const PRICE_INSTRU  = process.env.STRIPE_PRICE_INSTRUMENTAL;     // Prix Stripe 19,99 $
    const PRICE_PAROLES = process.env.STRIPE_PRICE_PAROLES_VIVANTES; // Prix Stripe 13,99 $

    // 4. Construit les paramètres communs à toute session Checkout.
    function paramsBase() {
      const p = new URLSearchParams();
      p.append('mode', 'payment');
      p.append('client_reference_id', token);                  // MAKE D / fulfillment retrouvent le Project
      p.append('metadata[token]', token);
      p.append('metadata[generation_no]', String(generationNo));
      if (songId) p.append('metadata[song_id]', songId);
      p.append('success_url', `${SITE}/page-chanson?id=${encodeURIComponent(token)}`);
      p.append('cancel_url',  `${SITE}/apercu?id=${encodeURIComponent(token)}`);
      if (email && email.includes('@')) p.append('customer_email', email);
      return p;
    }

    // Chemin A — Prix Stripe + order bumps (optional_items, ajoutables d'un clic sur la page Stripe).
    function paramsAvecPrix() {
      const p = paramsBase();
      p.append('line_items[0][price]', SONG_PRICE);
      p.append('line_items[0][quantity]', '1');
      let oi = 0;
      for (const pid of [PRICE_INSTRU, PRICE_PAROLES]) {
        if (!pid) continue;
        p.append(`optional_items[${oi}][price]`, pid);
        p.append(`optional_items[${oi}][quantity]`, '1');
        p.append(`optional_items[${oi}][adjustable_quantity][enabled]`, 'true');
        p.append(`optional_items[${oi}][adjustable_quantity][minimum]`, '0');
        p.append(`optional_items[${oi}][adjustable_quantity][maximum]`, '1');
        oi += 1;
      }
      return p;
    }

    // Chemin B (repli PROUVÉ) — prix fixé serveur via price_data, libellé « V{rang} », sans bumps.
    function paramsPriceData() {
      const p = paramsBase();
      const bits     = [gen.gen_music_style, gen.gen_mood].filter(Boolean);
      const lineName = `Chanson Mémoire — V${rang}` + (bits.length ? ` · ${bits.join(' · ')}` : '');
      p.append('line_items[0][quantity]', '1');
      p.append('line_items[0][price_data][currency]', CURRENCY);
      p.append('line_items[0][price_data][unit_amount]', String(PRICE_CENTS));
      p.append('line_items[0][price_data][product_data][name]', lineName);
      return p;
    }

    // Appelle Stripe ; renvoie {ok, url} ou {ok:false, err}.
    async function creerSession(params) {
      const rS = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const session = await rS.json();
      if (rS.ok && session.url) return { ok: true, url: session.url };
      return { ok: false, err: (session && session.error && session.error.message) || `HTTP ${rS.status}` };
    }

    // 5. Tente le chemin Prix+bumps si configuré. Si Stripe le REFUSE (Prix manquant, mauvais mode
    //    test/live, paramètre non supporté…), REPLI AUTOMATIQUE sur price_data : le bouton ne doit
    //    JAMAIS rester cassé à cause d'une config de Prix incomplète. L'erreur Stripe est journalisée.
    let resultat;
    let diagPrix = null;   // DIAGNOSTIC TEMPORAIRE : raison Stripe du refus du chemin Prix/bumps
    if (SONG_PRICE) {
      resultat = await creerSession(paramsAvecPrix());
      if (!resultat.ok) {
        diagPrix = resultat.err;
        console.error('[creer-checkout] Chemin Prix/bumps refusé par Stripe → repli price_data. Détail:', resultat.err);
        resultat = await creerSession(paramsPriceData());
      }
    } else {
      diagPrix = 'STRIPE_PRICE_SONG non défini → chemin price_data (sans bumps).';
      resultat = await creerSession(paramsPriceData());
    }

    if (!resultat.ok) {
      console.error('[creer-checkout] Stripe a refusé la session (repli inclus). Détail:', resultat.err);
      return { statusCode: 502, body: JSON.stringify({ error: 'Création du paiement échouée', _diag: resultat.err }) };
    }

    // _diag = TEMPORAIRE : pourquoi les bumps n'apparaissent pas (visible dans l'onglet Réseau → réponse
    // de /api/creer-checkout). À RETIRER une fois le chemin Prix/bumps validé.
    const out = { url: resultat.url };
    if (diagPrix) out._diag = diagPrix;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
