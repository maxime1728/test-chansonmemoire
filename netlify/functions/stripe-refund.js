// netlify/functions/stripe-refund.js
//
// Webhook Stripe REMBOURSEMENT -> révoque l'accès. Sur un événement `charge.refunded`, retrouve le
// Project par `stripe_payment_intent` et passe `commercial_status` à `refunded` -> les gardes
// `purchased` (lire-projet, telecharger, add-ons) coupent automatiquement l'accès.
//
// SÉCURITÉ : on VÉRIFIE la signature Stripe (Stripe-Signature + STRIPE_WEBHOOK_SECRET) sur le corps
// brut — sinon n'importe qui pourrait révoquer un accès en postant un faux remboursement. Tolérance
// d'horodatage 5 min (anti-rejeu). Répond 200 après vérification (Stripe ne réessaie pas).
//
// Env : STRIPE_WEBHOOK_SECRET (whsec_… du endpoint Stripe), AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const crypto = require('crypto');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const TOLERANCE = 300;   // secondes (anti-rejeu)

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Vérifie la signature Stripe (HMAC-SHA256 de `${t}.${rawBody}`). Renvoie true/false.
function verifyStripe(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  let t = '', v1 = '';
  sigHeader.split(',').forEach(part => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim(), val = part.slice(i + 1).trim();
    if (k === 't' && !t) t = val;
    if (k === 'v1' && !v1) v1 = val;
  });
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > TOLERANCE) return false;   // anti-rejeu
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  try {
    const a = Buffer.from(expected), b = Buffer.from(v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  if (!WH_SECRET) { console.error('[stripe-refund] STRIPE_WEBHOOK_SECRET manquant'); return { statusCode: 500, body: '{}' }; }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';
  if (!verifyStripe(rawBody, sig, WH_SECRET)) {
    return { statusCode: 400, body: '{}' };   // signature invalide -> on refuse
  }

  let evt;
  try { evt = JSON.parse(rawBody); } catch (_) { return { statusCode: 400, body: '{}' }; }

  // On n'agit que sur un remboursement de charge.
  if (evt.type !== 'charge.refunded') return { statusCode: 200, body: '{}' };

  const charge = (evt.data && evt.data.object) || {};
  const pi = (charge.payment_intent || '').toString().trim();
  if (!pi) return { statusCode: 200, body: '{}' };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    const lit = formulaLiteral(pi);
    if (lit === null) return { statusCode: 200, body: '{}' };
    const r = await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{stripe_payment_intent}=${lit}`)}&maxRecords=1`, { headers });
    const d = await r.json();
    const projet = d.records && d.records[0];
    if (!projet) { console.error('[stripe-refund] Project introuvable pour PI', pi); return { statusCode: 200, body: '{}' }; }

    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { commercial_status: 'refunded' } })
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[stripe-refund]', err && err.message);
    return { statusCode: 200, body: '{}' };   // ne pas faire réessayer Stripe en boucle
  }
};
