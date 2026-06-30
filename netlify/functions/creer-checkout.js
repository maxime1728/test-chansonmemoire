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
const { lierPub } = require('./_lib/pub-join');   // jointure last_pub en code (ex-Make « Jointure Pub »)
const { withSentry } = require('./_lib/sentry');  // capture des exceptions non gerees

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

  // Order bumps cochés sur la page de confirmation (clés connues uniquement → anti-tamper).
  const BUMP_KEYS = ['instrumental', 'paroles_vivantes', 'pdf_paroles'];
  const bumpsRequested = Array.isArray(body.bumps)
    ? body.bumps.filter(b => BUMP_KEYS.includes(b))
    : [];

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

    // LAST-TOUCH a la conversion : le creatif qui a (re)amene le client jusqu'a l'achat. Met a jour
    // last_utm_* du Projet (distinct du first-touch). Best-effort, jamais bloquant pour le paiement.
    try {
      const lt = body.last_touch || {};
      if (lt.utm_source || lt.utm_campaign || lt.utm_content || lt.fbclid) {
        const lf = {
          fldAs0LwECqTSxOgF: String(lt.utm_source   || ''),   // last_utm_source
          fld8e6vKwG3lI74Yq: String(lt.utm_medium   || ''),   // last_utm_medium
          fldsifC3yx55b561h: String(lt.utm_campaign || ''),   // last_utm_campaign
          fldK7yie7Vc3dqVux: String(lt.utm_content  || ''),   // last_utm_content (cle jointure last_pub)
          fldhcXo9zrM34STzG: String(lt.utm_term     || ''),   // last_utm_term
          fldZQdydtpwXKCxyu: String(lt.landing_page || '')    // last_landing_page
        };
        if (lt.at) lf.fldMUwpw5ivyjXggZ = lt.at;              // last_touch_at
        // Refresh fbclid/fbc avec le CLIC DE CONVERSION (le plus recent) -> la CAPI Purchase porte le
        // bon clic pour les achats tardifs via reciblage. On n'ecrase PAS si absent (preserve le 1er clic).
        if (lt.fbclid) lf.fldACzVAZnXIg8Y6F = String(lt.fbclid);   // fbclid
        if (lt.fbc)    lf.fldH7NqGl1x4iYNUT = String(lt.fbc);      // fbc (cookie = timestamp clic correct)
        await fetch(`${API}/Projects/${projet.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: lf, typecast: true })
        });
        // LAST-touch : lie le creatif de conversion (last_pub = Pub dont ad_name = last utm_content).
        await lierPub(API, headers, projet.id, lt.utm_content, 'fld3BBWOYqlkMYec9');
      }
    } catch (_) { /* l'attribution ne doit jamais casser le checkout */ }

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

    // 3. Articles. Les ORDER BUMPS sont choisis sur NOTRE page de confirmation (layout maîtrisé) et
    //    deviennent des line_items Stripe (1 transaction). Ça exige des Prix Stripe (price IDs). Donc si
    //    STRIPE_PRICE_SONG est défini -> chemin Price IDs (chanson + bumps cochés) ; sinon repli price_data
    //    (chanson seule, libellé « V{rang} ») pour que le bouton marche même avant config des Prix.
    const songId = gen.song_id || '';

    // Courriel de l'acheteur : récupéré CÔTÉ SERVEUR sur le Client lié — jamais reçu du client ni
    // de l'URL (Loi 25, minimisation). Préremplit le checkout ; Stripe le collecte de toute façon si absent.
    let clientEmail = '';
    try {
      const link  = projet.fields.Client;
      const recId = Array.isArray(link) ? link[0] : null;
      if (recId) {
        const rC = await fetch(`${API}/Clients/${recId}`, { headers });
        if (rC.ok) { const dC = await rC.json(); clientEmail = (dC.fields && dC.fields.email) || ''; }
      }
    } catch (_) { /* best-effort : Stripe demandera l'email sinon */ }

    const SONG_PRICE    = process.env.STRIPE_PRICE_SONG;             // Prix Stripe one-time 139,97 $ CAD
    const PRICE_INSTRU  = process.env.STRIPE_PRICE_INSTRUMENTAL;     // Prix Stripe 19,99 $
    const PRICE_PAROLES = process.env.STRIPE_PRICE_PAROLES_VIVANTES; // Prix Stripe 13,99 $
    const PRICE_PDF     = process.env.STRIPE_PRICE_PDF;              // Prix Stripe 7,99 $ (PDF des paroles)

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
      if (clientEmail && clientEmail.includes('@')) p.append('customer_email', clientEmail);
      return p;
    }

    // Chemin A — Prix Stripe : chanson + bumps CHOISIS sur la page de confirmation (line_items,
    //  une seule transaction). Les bumps sont décidés sur notre page (layout maîtrisé), pas sur Stripe.
    function paramsAvecPrix() {
      const p = paramsBase();
      p.append('line_items[0][price]', SONG_PRICE);
      p.append('line_items[0][quantity]', '1');
      const bumpMap = { instrumental: PRICE_INSTRU, paroles_vivantes: PRICE_PAROLES, pdf_paroles: PRICE_PDF };
      let li = 1;
      const bumpsFactures = [];
      for (const key of bumpsRequested) {
        const pid = bumpMap[key];
        if (!pid) continue;                       // env de prix manquante -> on saute (le repli protège)
        p.append(`line_items[${li}][price]`, pid);
        p.append(`line_items[${li}][quantity]`, '1');
        bumpsFactures.push(key);
        li += 1;
      }
      // Trace des bumps RÉELLEMENT facturés -> le webhook les enregistre (extra_* = achete, à commander).
      if (bumpsFactures.length) p.append('metadata[bumps]', bumpsFactures.join(','));
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
    //    test/live…), REPLI AUTOMATIQUE sur price_data (chanson seule) : le bouton ne doit JAMAIS
    //    rester cassé à cause d'une config de Prix incomplète. L'erreur Stripe est journalisée.
    let resultat;
    if (SONG_PRICE) {
      resultat = await creerSession(paramsAvecPrix());
      if (!resultat.ok) {
        console.error('[creer-checkout] Chemin Prix/bumps refusé par Stripe → repli price_data. Détail:', resultat.err);
        resultat = await creerSession(paramsPriceData());
      }
    } else {
      resultat = await creerSession(paramsPriceData());
    }

    if (!resultat.ok) {
      console.error('[creer-checkout] Stripe a refusé la session (repli inclus). Détail:', resultat.err);
      return { statusCode: 502, body: JSON.stringify({ error: 'Création du paiement échouée' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: resultat.url })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Toute exception non geree -> Sentry, puis relancee (comportement inchange).
exports.handler = withSentry(exports.handler);
