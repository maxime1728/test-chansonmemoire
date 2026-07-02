// _lib/meta-capi.ts — Meta Conversions API côté serveur (v2 Supabase).
//
// PORTAGE de la mécanique CAPI de suivi-funnel.js. Phase 2a : événement Lead
// (soumission du sondage). Les autres événements (PreviewPlayed, InitiateCheckout,
// Purchase) arrivent en 2b avec l’aperçu et le paiement.
//
// Règles conservées du legacy :
//   - TOKEN-SAFE (Loi 25) : jamais le token client vers Meta — event_id = sha256,
//     event_source_url générique sans token ;
//   - dédup navigateur+serveur : event_id = sha256(`${token}.lead`), la MÊME
//     convention que cm-pixel.js côté navigateur ;
//   - anti-tracking interne : les courriels d’équipe/tests ne partent JAMAIS ;
//   - fbc reconstruit depuis fbclid si le cookie manque (fb.1.<ts>.<fbclid>) ;
//   - best-effort : ne lève JAMAIS (la CAPI ne casse pas l’UX) ; no-op si env absente.
//
// Idempotence v2 : le Lead n’est envoyé QUE lorsque le projet vient d’être CRÉÉ
// (le drapeau capi_lead_sent d’Airtable devient structurel : une création = un Lead).
import { createHash } from 'node:crypto';
import { estCourrielInterne } from './courriels-internes';

function sha256Meta(v: string): string {
  return createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

export interface ParamsLead {
  token: string;
  email?: string;
  fbclid?: string;
  fbc?: string;
  fbp?: string;
  ip?: string;
  ua?: string;
  creeA?: string; // horodatage de création (reconstruction fbc) ; défaut : maintenant
}

export interface ResultatCapi {
  sent: boolean;
  summary: string;
}

// Construit le fbc : cookie si présent, sinon reconstruit depuis fbclid.
export function construireFbc(fbc: string | undefined, fbclid: string | undefined, creeA?: string): string {
  if (fbc) return fbc;
  if (!fbclid) return '';
  const ts = (creeA && Date.parse(creeA)) || Date.now();
  return `fb.1.${ts}.${fbclid}`;
}

export function eventIdLead(token: string): string {
  return sha256Meta(`${token}.lead`);
}

// Purchase CAPI (dédup pixel : event_id = sha256(token.purchase), valeur en CAD).
export async function envoyerPurchaseCapi(p: {
  token: string;
  email?: string;
  montant: number;
  ip?: string;
  ua?: string;
}): Promise<ResultatCapi> {
  const CAPI_TOKEN = process.env.META_CAPI_TOKEN;
  const CAPI_DATASET = process.env.META_DATASET_ID;
  if (!CAPI_TOKEN || !CAPI_DATASET) return { sent: false, summary: 'capi-off (env manquante)' };
  if (p.email && estCourrielInterne(p.email)) return { sent: false, summary: 'skip-interne' };
  const user_data: Record<string, unknown> = {};
  if (p.email && p.email.includes('@')) user_data.em = [sha256Meta(p.email)];
  if (p.ip) user_data.client_ip_address = p.ip;
  if (p.ua) user_data.client_user_agent = p.ua;
  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_id: sha256Meta(`${p.token}.purchase`),
        event_source_url: 'https://chansonmemoire.ca/espace-client', // SANS token
        user_data,
        custom_data: { currency: 'CAD', value: p.montant },
      },
    ],
  };
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${CAPI_DATASET}/events?access_token=${encodeURIComponent(CAPI_TOKEN)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    );
    const txt = await resp.text().catch(() => '');
    return { sent: resp.ok, summary: `${resp.status} ${String(txt).slice(0, 300)}` };
  } catch (e) {
    return { sent: false, summary: 'fetch-error ' + (e instanceof Error ? e.message : String(e)) };
  }
}

export async function envoyerLeadCapi(p: ParamsLead): Promise<ResultatCapi> {
  const CAPI_TOKEN = process.env.META_CAPI_TOKEN;
  const CAPI_DATASET = process.env.META_DATASET_ID;
  if (!CAPI_TOKEN || !CAPI_DATASET) return { sent: false, summary: 'capi-off (env manquante)' };
  if (p.email && estCourrielInterne(p.email)) return { sent: false, summary: 'skip-interne' };

  const user_data: Record<string, unknown> = {};
  if (p.email && p.email.includes('@')) user_data.em = [sha256Meta(p.email)];
  const fbc = construireFbc(p.fbc, p.fbclid, p.creeA);
  if (fbc) user_data.fbc = fbc; // fbc/fbp/IP/UA : NON hachés (spec Meta)
  if (p.fbp) user_data.fbp = p.fbp;
  if (p.ip) user_data.client_ip_address = p.ip;
  if (p.ua) user_data.client_user_agent = p.ua;

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_id: eventIdLead(p.token),
        event_source_url: 'https://chansonmemoire.ca/souvenirs', // SANS token
        user_data,
      },
    ],
  };

  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${CAPI_DATASET}/events?access_token=${encodeURIComponent(CAPI_TOKEN)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    );
    const txt = await resp.text().catch(() => '');
    return { sent: resp.ok, summary: `${resp.status} ${String(txt).slice(0, 300)}` };
  } catch (e) {
    return { sent: false, summary: 'fetch-error ' + (e instanceof Error ? e.message : String(e)) };
  }
}
