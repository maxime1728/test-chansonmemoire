// _lib/mailgun.ts — envoi courriel v2 (Supabase) : Mailgun + journal table `courriels`.
//
// Port minimal des conventions du Lot 6 (_lib/courriel.js) : From racine affiché,
// envoi par sous-domaine transactionnel ; notifications machine -> notifications@,
// réponses humaines -> nathalie@. Best-effort : no-op EXPLICITE si env absente
// (résultat journalisable, jamais d'exception).
//
// Le journal en base (table courriels) alimente les 4 signaux de réception
// (evenements_livraison) ; les webhooks Mailgun (delivered/opened) suivront.
import { db, schema } from './db';
import { journaliser } from './journal';

const FROM_NOTIF = 'Chanson Mémoire <notifications@chansonmemoire.ca>';

export interface ParamsCourriel {
  type: 'apercu' | 'interne';
  to: string;
  subject: string;
  html: string;
  projetId?: string;
  clientId?: string;
}

export interface ResultatCourriel {
  sent: boolean;
  summary: string;
  courrielId?: string;
}

function gabarit(contenu: { intro: string; corps: string; lien?: string; cta?: string }): string {
  const postal = process.env.CM_POSTAL_ADDRESS || '';
  return `<!doctype html><html lang="fr-CA"><body style="margin:0;background:#F7F3EE;font-family:Arial,Helvetica,sans-serif;color:#2B2530">
  <div style="max-width:540px;margin:0 auto;padding:28px 20px">
    <div style="background:#FDFBF8;border:1px solid #EAE2E6;border-radius:16px;padding:26px 24px">
      <p style="font-size:17px;font-weight:bold;margin:0 0 12px">${contenu.intro}</p>
      <p style="font-size:14.5px;line-height:1.6;margin:0">${contenu.corps}</p>
      ${contenu.lien && contenu.cta ? `<p style="margin:22px 0 4px"><a href="${contenu.lien}" style="background:#7C6591;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:12px;display:inline-block;font-weight:bold">${contenu.cta}</a></p>` : ''}
    </div>
    <p style="font-size:11.5px;color:#8A7F88;line-height:1.6;margin:16px 6px 0">Tu reçois ce courriel parce qu'une chanson a été créée sur chansonmemoire.ca.${postal ? `<br>${postal}` : ''}</p>
  </div>
</body></html>`;
}

export { gabarit };

export async function envoyerCourriel(p: ParamsCourriel): Promise<ResultatCourriel> {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) return { sent: false, summary: 'mailgun-off (env manquante)' };

  const from = process.env.MAILGUN_FROM_NOTIF || FROM_NOTIF;
  let sent = false;
  let summary = '';
  let messageId: string | null = null;
  try {
    const form = new FormData();
    form.append('from', from);
    form.append('to', p.to);
    form.append('subject', p.subject);
    form.append('html', p.html);
    form.append('h:Reply-To', 'nathalie@chansonmemoire.ca');
    const r = await fetch(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64') },
      body: form,
    });
    const d = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
    sent = r.ok;
    messageId = d.id || null;
    summary = `${r.status} ${d.message || d.id || ''}`.trim();
  } catch (e) {
    summary = 'fetch-error ' + (e instanceof Error ? e.message : String(e));
  }

  // Journal en base : 1 ligne par tentative (statut envoye/failed). Best-effort aussi.
  let courrielId: string | undefined;
  try {
    const { courriels } = schema;
    const [ligne] = await db()
      .insert(courriels)
      .values({
        type: p.type,
        destinataire: p.to,
        sujet: p.subject,
        statut: sent ? 'envoye' : 'failed',
        mailgunMessageId: messageId,
        erreur: sent ? null : summary,
        projectId: p.projetId ?? null,
        clientId: p.clientId ?? null,
      })
      .returning({ id: courriels.id });
    courrielId = ligne?.id;
  } catch (e) {
    journaliser({
      niveau: 'P2',
      fonction: 'mailgun',
      message: `journalisation courriel échouée: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  return { sent, summary, courrielId };
}
