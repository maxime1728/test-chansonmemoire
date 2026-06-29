// stripe-webhook.js — Webhook Stripe EN CODE (remplace MAKE D, scénario 4793505).
//
// Écoute `checkout.session.completed`. Vérifie la SIGNATURE Stripe (anti-forge), récupère la session,
// puis route ACHAT PRINCIPAL vs UPSELL (selon metadata.kind), comme MAKE D :
//   - Achat principal : Projet -> purchased (idempotent via stripe_payment_intent) + suivi-funnel
//     (Purchase CAPI) + capter-timing + courriel-achat(kind:purchase).
//   - Upsell : crée l'Upsell + lancer-instrumentale / lancer-paroles-vivantes (selon type) +
//     courriel-achat(kind:upsell).
//
// Sécurité : signature HMAC vérifiée (STRIPE_WEBHOOK_SECRET). Prix/état lus chez Stripe, jamais du client.
// Déploiement SANS risque : Stripe n'appelle cette URL que lorsque tu as créé l'endpoint dans le dashboard
// Stripe + posé STRIPE_WEBHOOK_SECRET. Tant que ce n'est pas fait, MAKE D reste la source (à éteindre APRÈS test).

const crypto   = require('crypto');
const { withSentry, capture } = require('./_lib/sentry');

const BASE_ID    = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN   = process.env.AIRTABLE_TOKEN;
const API        = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE       = 'https://chansonmemoire.ca';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const WH_SECRET  = process.env.STRIPE_WEBHOOK_SECRET || '';

const PROJECTS = 'tblh7O8eoog7RyTMJ', UPSELLS = 'tbl0Z52D8l4555Has';
// Projects
const P = { token:'fldqBcPOplqI7pmTh', commercial:'fldLFpeLNHU0ewF7A', funnel:'fldepcYRBoQsGoVkJ',
  purchase_date:'fldeh0MKHnUvgV4Wo', amount:'fld4qP6Vt9U1Hygcb', stripe_session:'fldrp48w47JknP0P3',
  stripe_pi:'fldsGvEeBhuv6p8zO', purchased_gen_no:'fld6eCLXNbuMzMw1h' };
// Upsells
const U = { price:'fldJoXqpwDjsLVhNg', type:'fldLcJfOQyAnH0uyB', status:'fldUYpFPzKft1YAZL',
  date:'fldZecCcKwrJCbqdr', project:'fldlPqxt6COxeuBgT' };

function formulaLiteral(v) { const s = String(v); if (!s.includes('"')) return `"${s}"`; if (!s.includes("'")) return `'${s}'`; return null; }
const atHeaders = () => ({ Authorization: `Bearer ${AT_TOKEN}` });

// Vérifie la signature Stripe (schéma t=...,v1=...). Compare en temps constant + fenêtre 5 min.
function signatureValide(rawBody, sigHeader) {
  if (!WH_SECRET || !sigHeader) return false;
  const parts = {};
  for (const kv of String(sigHeader).split(',')) { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i)] = kv.slice(i + 1); }
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t)) > 300) return false;   // anti-rejeu
  const expected = crypto.createHmac('sha256', WH_SECRET).update(`${parts.t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Appel POST best-effort vers une de nos fonctions (courriel/CAPI/timing/fulfillment). Ne jette jamais.
async function appel(path, body) {
  try { await fetch(`${SITE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { await capture(e, { where: 'stripe-webhook appel ' + path }); }
}

async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  if (!WH_SECRET || !STRIPE_KEY || !BASE_ID || !AT_TOKEN) {
    // Pas encore configuré -> on n'agit pas (MAKE D reste la source). 200 pour ne pas faire retenter Stripe.
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'webhook-non-configure' }) };
  }

  // 1. Corps BRUT (indispensable pour la signature) + vérification.
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!signatureValide(raw, sig)) return { statusCode: 400, body: 'signature invalide' };

  let evt; try { evt = JSON.parse(raw); } catch { return { statusCode: 400, body: 'json invalide' }; }
  if (evt.type !== 'checkout.session.completed') return { statusCode: 200, body: 'ignore' };

  try {
    // 2. Récupère la session complète chez Stripe (source de vérité : payment_status, metadata, email).
    const sessId = evt.data && evt.data.object && evt.data.object.id;
    const rs = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessId)}`,
      { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
    const sess = await rs.json();
    if (!rs.ok || sess.payment_status !== 'paid') return { statusCode: 200, body: 'non-paye' };

    const token = sess.client_reference_id;
    const md    = sess.metadata || {};
    const email = (sess.customer_details && sess.customer_details.email) || '';
    const montant = (Number(sess.amount_total) || 0) / 100;

    // 3. Projet par token.
    const lit = formulaLiteral(token);
    if (!lit) return { statusCode: 200, body: 'token-invalide' };
    const rp = await fetch(`${API}/${PROJECTS}?filterByFormula=${encodeURIComponent(`{token}=${lit}`)}&maxRecords=1&returnFieldsByFieldId=true`, { headers: atHeaders() });
    const projet = (((await rp.json()).records) || [])[0];
    if (!projet) { await capture(new Error('stripe-webhook: projet introuvable'), { token, sessId }); return { statusCode: 200, body: 'projet-introuvable' }; }

    if (md.kind === 'upsell') {
      // ── ROUTE UPSELL ──
      const uf = {};
      uf[U.price] = montant; uf[U.type] = md.upsell_type || ''; uf[U.status] = 'paid';
      uf[U.date] = new Date().toISOString().slice(0, 10); uf[U.project] = [projet.id];
      await fetch(`${API}/${UPSELLS}`, { method: 'POST', headers: { ...atHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: uf, typecast: true }) });
      if (md.upsell_type === 'instrumental')     await appel('/api/lancer-instrumentale', { token });
      if (md.upsell_type === 'paroles_vivantes') await appel('/api/lancer-paroles-vivantes', { token });
      await appel('/api/courriel-achat', { token, kind: 'upsell', upsell_type: md.upsell_type, email });
      return { statusCode: 200, body: JSON.stringify({ ok: true, kind: 'upsell' }) };
    }

    // ── ROUTE ACHAT PRINCIPAL ──
    // Idempotence anti double-webhook : si stripe_payment_intent deja pose, on ne retraite pas.
    if (projet.fields[P.stripe_pi]) return { statusCode: 200, body: 'deja-traite' };

    const pf = {};
    pf[P.commercial] = 'purchased'; pf[P.funnel] = 'purchased';
    pf[P.purchase_date] = new Date().toISOString().slice(0, 10);
    pf[P.amount] = montant;
    pf[P.stripe_session] = sess.id;
    pf[P.stripe_pi] = sess.payment_intent || '';
    if (md.generation_no) pf[P.purchased_gen_no] = Number(md.generation_no);
    const ru = await fetch(`${API}/${PROJECTS}/${projet.id}`, { method: 'PATCH', headers: { ...atHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: pf, typecast: true }) });
    if (!ru.ok) { await capture(new Error('stripe-webhook: update Projet KO'), { token, status: ru.status }); return { statusCode: 500, body: 'maj-projet-ko' }; }   // 500 -> Stripe retentera (idempotence protege)

    // Best-effort (leur échec ne doit pas faire retenter Stripe -> on reste en 200) :
    await appel('/api/suivi-funnel', { token, event: 'purchase' });   // Purchase CAPI (dédup pixel page-chanson)
    await appel('/api/capter-timing', { token });                     // timing Suno pour la vidéo paroles vivantes
    await appel('/api/courriel-achat', { token, kind: 'purchase', email });
    return { statusCode: 200, body: JSON.stringify({ ok: true, kind: 'purchase' }) };
  } catch (e) {
    await capture(e, { where: 'stripe-webhook' });
    return { statusCode: 500, body: 'erreur' };   // Stripe retentera ; idempotence protège du double-traitement
  }
}

exports.handler = withSentry(handler);
exports.signatureValide = signatureValide;   // exporte pour les tests CI
