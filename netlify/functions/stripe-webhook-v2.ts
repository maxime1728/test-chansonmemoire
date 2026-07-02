// POST /api/stripe-webhook-v2 — webhook Stripe du NOUVEAU système (Supabase).
//
// Endpoint SÉPARÉ du legacy (stripe-webhook reste pour l'ancien flux Airtable jusqu'à
// son retrait) : à enregistrer dans le dashboard Stripe (mode test) avec SON secret de
// signature -> env STRIPE_WEBHOOK_SECRET_V2 (action Maxime, notée dans la PR).
//
// Sécurité et robustesse (plan v2) :
//   - signature HMAC vérifiée (portage exact), signature invalide = 400 + P1 ;
//   - idempotence PAR CONTRAINTE stripe_events : rejoué+traité = no-op ; rejoué après
//     un échec = REPRISE (Stripe retente sur nos 500, rien ne se perd) ;
//   - la session est relue CHEZ STRIPE (source de vérité payment_status/montant),
//     jamais depuis le corps du webhook.
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { journaliser } from './_lib/journal';
import { enregistrerEvent, marquerEventTraite, signatureValide, traiterSessionPayee, type SessionPayee } from './_lib/stripe';

export const handler = avecErreurs('stripe-webhook-v2', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  const WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET_V2 || '';
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
  if (!WH_SECRET || !STRIPE_KEY) {
    // Pas encore configuré : 200 pour ne pas faire retenter Stripe, mais VISIBLE.
    journaliser({ niveau: 'P2', fonction: 'stripe-webhook-v2', message: 'webhook non configuré (secrets manquants)' });
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'webhook-non-configure' }) };
  }

  // Corps BRUT (indispensable pour la signature).
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!signatureValide(raw, sig, WH_SECRET)) {
    journaliser({ niveau: 'P1', fonction: 'stripe-webhook-v2', message: 'signature invalide' });
    return { statusCode: 400, body: 'signature invalide' };
  }

  let evt: { id?: string; type?: string; data?: { object?: { id?: string } } };
  try {
    evt = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: 'json invalide' };
  }
  if (!evt.id) return { statusCode: 400, body: 'event sans id' };
  if (evt.type !== 'checkout.session.completed') return { statusCode: 200, body: 'ignore' };

  const statut = await enregistrerEvent(evt.id, evt.type);
  if (statut === 'deja_traite') {
    journaliser({ niveau: 'P3', fonction: 'stripe-webhook-v2', message: `event rejoué (no-op): ${evt.id}` });
    return { statusCode: 200, body: 'deja-recu' };
  }

  try {
    // Session relue chez Stripe : source de vérité.
    const sessId = evt.data?.object?.id;
    if (!sessId) throw new Error('session id absent');
    const rs = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessId)}`, {
      headers: { Authorization: `Bearer ${STRIPE_KEY}` },
    });
    const sess = (await rs.json()) as SessionPayee & { payment_status?: string };
    if (!rs.ok) throw new Error(`retrieve session HTTP ${rs.status}`);
    if (sess.payment_status !== 'paid') {
      await marquerEventTraite(evt.id);
      return { statusCode: 200, body: 'non-paye' };
    }

    const resultat = await traiterSessionPayee(sess);
    if (!resultat.ok) {
      // projet introuvable etc. : P1, event marqué en erreur, 500 -> Stripe retentera
      // (la REPRISE ci-dessus reprendra le traitement).
      journaliser({ niveau: 'P1', fonction: 'stripe-webhook-v2', message: `achat non appliqué: ${resultat.detail}` });
      await marquerEventTraite(evt.id, resultat.detail);
      return { statusCode: 500, body: resultat.detail };
    }
    await marquerEventTraite(evt.id);
    journaliser({ niveau: 'P3', fonction: 'stripe-webhook-v2', message: `achat appliqué (${resultat.detail})` });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await marquerEventTraite(evt.id, message).catch(() => {});
    journaliser({ niveau: 'P1', fonction: 'stripe-webhook-v2', message });
    return { statusCode: 500, body: 'erreur' }; // Stripe retente ; l'idempotence protège
  }
});
