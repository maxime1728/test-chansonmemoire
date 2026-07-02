// _lib/stripe.ts — paiement v2 (Supabase) : vérification de signature + traitement
// d'une session payée, FACTORISÉ pour être testé en intégration sans réseau Stripe.
//
// PORTAGE de stripe-webhook.js, renforcé par le plan v2 :
//   - idempotence PAR CONTRAINTE : chaque event Stripe est inséré dans stripe_events
//     (stripe_event_id UNIQUE) AVANT traitement ; rejoué = no-op SI déjà traité,
//     REPRISE si un traitement précédent a échoué (traite=false) ;
//   - achat = TRANSACTION SQL (projet purchased + bumps upsells, tout ou rien) ;
//   - argent : amount_total (cents entiers) -> numeric en dollars, JAMAIS de parseFloat ;
//   - la version achetée est TRACÉE (purchased_generation_no, metadata du checkout).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, actif, schema } from './db';
import { journaliser } from './journal';
import { envoyerCourriel, gabarit } from './mailgun';
import { envoyerPurchaseCapi } from './meta-capi';

export const BUMP_KEYS = ['instrumental', 'paroles_vivantes', 'pdf_paroles'] as const;

// Vérifie la signature Stripe (schéma t=...,v1=...). Temps constant + fenêtre 5 min.
// Portage exact de stripe-webhook.js.
export function signatureValide(rawBody: string, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader || !secret) return false;
  const parts: Record<string, string> = {};
  for (const kv of sigHeader.split(',')) {
    const [k, v] = kv.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // fenêtre 5 min
  const attendu = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(attendu, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SessionPayee {
  id: string;
  payment_status?: string;
  payment_intent?: string | null;
  client_reference_id?: string | null;
  amount_total?: number | null;
  customer_details?: { email?: string | null } | null;
  metadata?: Record<string, string> | null;
}

// Marque l'event reçu ; renvoie 'nouveau' | 'deja_traite' | 'reprise'.
export async function enregistrerEvent(stripeEventId: string, type: string): Promise<'nouveau' | 'deja_traite' | 'reprise'> {
  const { stripeEvents } = schema;
  const inseres = await db()
    .insert(stripeEvents)
    .values({ stripeEventId, type })
    .onConflictDoNothing({ target: stripeEvents.stripeEventId })
    .returning({ id: stripeEvents.id });
  if (inseres.length) return 'nouveau';
  const [existant] = await db()
    .select({ traite: stripeEvents.traite })
    .from(stripeEvents)
    .where(eq(stripeEvents.stripeEventId, stripeEventId))
    .limit(1);
  return existant?.traite ? 'deja_traite' : 'reprise'; // échec précédent -> on RETENTE (Stripe a rejoué)
}

export async function marquerEventTraite(stripeEventId: string, erreur?: string): Promise<void> {
  const { stripeEvents } = schema;
  await db()
    .update(stripeEvents)
    .set({ traite: !erreur, traiteAt: new Date().toISOString(), erreur: erreur ?? null })
    .where(eq(stripeEvents.stripeEventId, stripeEventId));
}

// Traite une session PAYÉE (achat principal + bumps). Idempotent aussi par
// stripe_payment_intent UNIQUE (2e ceinture naturelle du schéma).
export async function traiterSessionPayee(sess: SessionPayee): Promise<{ ok: boolean; detail: string }> {
  const token = (sess.client_reference_id || '').trim();
  if (!token) return { ok: false, detail: 'token-absent' };
  const md = sess.metadata || {};
  // Argent : cents ENTIERS -> dollars en chaîne décimale (numeric), zéro parseFloat.
  const cents = Number.isFinite(Number(sess.amount_total)) ? Number(sess.amount_total) : 0;
  const montant = (cents / 100).toFixed(2);

  const { projects, upsells, clients } = schema;
  const [projet] = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.token, token), actif(projects)))
    .limit(1);
  if (!projet) return { ok: false, detail: 'projet-introuvable' };
  if (projet.stripePaymentIntent) return { ok: true, detail: 'deja-traite' }; // anti double-achat

  const generationNo = md.generation_no ? Number(md.generation_no) : null;
  const bumps = (md.bumps || '')
    .split(',')
    .map((s) => s.trim())
    .filter((b): b is (typeof BUMP_KEYS)[number] => (BUMP_KEYS as readonly string[]).includes(b));

  await db().transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        commercialStatus: 'purchased',
        funnelStep: 'purchased',
        purchaseDate: new Date().toISOString(),
        amount: montant,
        stripeSessionId: sess.id,
        stripePaymentIntent: sess.payment_intent || null,
        purchasedGenerationNo: generationNo && generationNo > 0 ? generationNo : null,
      })
      .where(eq(projects.id, projet.id));
    // Bumps cochés au checkout : achetés, production À COMMANDER par le client
    // (décision produit existante : jamais lancée ici).
    for (const type of bumps) {
      await tx.insert(upsells).values({ projectId: projet.id, type, status: 'purchased', price: null });
    }
  });

  // Best-effort après la transaction (leur échec ne remet jamais l'achat en cause).
  const [client] = await db().select({ email: clients.email }).from(clients).where(eq(clients.id, projet.clientId)).limit(1);
  const email = (sess.customer_details?.email || client?.email || '').trim();

  try {
    const lien = `https://chansonmemoire.ca/espace-client?id=${encodeURIComponent(token)}`;
    if (email.includes('@')) {
      const r = await envoyerCourriel({
        type: 'apercu',
        to: email,
        subject: 'Merci. Ta chanson complète est prête.',
        html: gabarit({
          intro: 'Merci du fond du cœur.',
          corps:
            'Ta chanson complète est prête : tu peux l’écouter, la télécharger et la partager avec la famille depuis ton espace. Si un détail mérite d’être ajusté, dis-le nous : on s’en occupe.',
          lien,
          cta: 'Ouvrir mon espace',
        }),
        projetId: projet.id,
      });
      journaliser({ niveau: r.sent ? 'P3' : 'P2', fonction: 'stripe', message: `courriel achat: ${r.summary}` });
    }
  } catch (e) {
    journaliser({ niveau: 'P2', fonction: 'stripe', message: `courriel achat échoué: ${e instanceof Error ? e.message : String(e)}` });
  }

  const capi = await envoyerPurchaseCapi({ token, email, montant: cents / 100 });
  journaliser({
    niveau: capi.sent || capi.summary.startsWith('capi-off') || capi.summary === 'skip-interne' ? 'P3' : 'P2',
    fonction: 'stripe',
    message: `purchase CAPI: ${capi.summary}`,
  });

  return { ok: true, detail: 'achat' };
}
