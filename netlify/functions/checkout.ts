// POST /api/checkout — { token, bumps? } : crée la session Stripe Checkout (v2).
//
// PORTAGE de creer-checkout.js : mêmes Price IDs (STRIPE_PRICE_SONG + bumps whitelist),
// repli price_data 139,97 $ CAD si le Price n'est pas posé, client_reference_id = token,
// metadata.generation_no = LA VERSION ÉCOUTÉE à l'aperçu (le webhook posera
// purchased_generation_no : on sait toujours quelle version a été achetée).
// Anti-rachat : projet déjà acheté = 409 (règle « liens = étape courante »).
// v2 : success -> /espace-client (post-achat nouveau design), cancel -> /apercu.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, type EvenementHttp } from './_lib/http';
import { BUMP_KEYS } from './_lib/stripe';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SITE = 'https://chansonmemoire.ca';

export const handler = avecErreurs('checkout', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) throw new Error('STRIPE_SECRET_KEY manquante'); // wrapper -> P1 + 500

  let d: { token?: string; bumps?: unknown };
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  }
  const token = (d.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  // Bumps cochés sur NOTRE page (clés connues uniquement : anti-tamper, prix côté Stripe).
  const bumps = Array.isArray(d.bumps)
    ? (d.bumps as unknown[]).map(String).filter((b): b is (typeof BUMP_KEYS)[number] => (BUMP_KEYS as readonly string[]).includes(b))
    : [];

  const { projects, generations, clients } = schema;
  const [projet] = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
  if (projet.commercialStatus !== 'preview_only') {
    return { statusCode: 409, body: JSON.stringify({ error: 'already_purchased' }) };
  }
  // La version que le client vient d'écouter (metadata -> purchased_generation_no).
  const [chanson] = await db()
    .select({ generationNo: generations.generationNo })
    .from(generations)
    .where(
      and(
        eq(generations.projectId, projet.id),
        inArray(generations.type, ['song', 'song_regeneration', 'cover']),
        inArray(generations.status, ['audio_generated', 'validated']),
        eq(generations.postPurchase, false),
        actif(generations),
      ),
    )
    .orderBy(desc(generations.generationNo))
    .limit(1);
  if (!chanson) return { statusCode: 409, body: JSON.stringify({ error: 'apercu_manquant' }) };

  const [client] = await db().select({ email: clients.email }).from(clients).where(eq(clients.id, projet.clientId)).limit(1);

  const p = new URLSearchParams();
  p.append('mode', 'payment');
  p.append('client_reference_id', token);
  p.append('success_url', `${SITE}/espace-client?id=${encodeURIComponent(token)}`);
  p.append('cancel_url', `${SITE}/apercu?id=${encodeURIComponent(token)}`);
  p.append('metadata[generation_no]', String(chanson.generationNo));
  if (bumps.length) p.append('metadata[bumps]', bumps.join(','));
  if (client?.email) p.append('customer_email', client.email);

  const SONG_PRICE = process.env.STRIPE_PRICE_SONG;
  if (SONG_PRICE) {
    // Chemin A — Prix Stripe : chanson + bumps choisis (une seule transaction).
    p.append('line_items[0][price]', SONG_PRICE);
    p.append('line_items[0][quantity]', '1');
    const bumpMap: Record<string, string | undefined> = {
      instrumental: process.env.STRIPE_PRICE_INSTRUMENTAL,
      paroles_vivantes: process.env.STRIPE_PRICE_PAROLES_VIVANTES,
      pdf_paroles: process.env.STRIPE_PRICE_PDF,
    };
    let i = 1;
    for (const b of bumps) {
      const prix = bumpMap[b];
      if (prix) {
        p.append(`line_items[${i}][price]`, prix);
        p.append(`line_items[${i}][quantity]`, '1');
        i++;
      }
    }
  } else {
    // Chemin B — repli price_data (aucun Price configuré) : chanson seule, 139,97 $ CAD.
    p.append('line_items[0][price_data][currency]', 'cad');
    p.append('line_items[0][price_data][unit_amount]', '13997');
    p.append('line_items[0][price_data][product_data][name]', 'Chanson Mémoire · chanson complète');
    p.append('line_items[0][quantity]', '1');
  }

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p.toString(),
  });
  const sess = (await r.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
  if (!r.ok || !sess.url) {
    throw new Error(`Stripe session KO: ${sess.error?.message || `HTTP ${r.status}`}`); // P1 + 500
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: sess.url }),
  };
});
