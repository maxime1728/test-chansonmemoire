// POST /api/survey — soumission du sondage (funnel pré-achat, v2 Supabase).
//
// PORTAGE de soumettre-survey.js (mode SURVEY_DIRECT), sans la branche Make (supprimée,
// décision étape 0) et sans flag : le direct EST le code. Différences documentées :
//   - upsert client PAR CONTRAINTE (citext unique) au lieu d'une recherche+patch : la
//     casse du courriel ne peut plus créer un doublon, c'est la base qui garantit.
//   - attribution first/last-touch en jsonb (plus de 20 colonnes plates).
//   - funnel_step démarre à 'survey_submitted' (le legacy écrivait 'lyrics_generated'
//     AVANT que les paroles existent) ; le background pose 'lyrics_generated' quand
//     c'est VRAI -> l'attente sans paroles devient détectable par le watchdog.
//   - le nettoyage retire les caractères de contrôle mais GARDE guillemets/antislashs :
//     tout est paramétré (Drizzle), la mutilation anti-Make n'a plus de raison d'être.
//
// Anti-bot : token UUID v4 exigé (généré par le formulaire), sinon 400 sec.
// Idempotent : re-soumission du même token = no-op qui redéclenche seulement les paroles.
import { and, eq } from 'drizzle-orm';
import { db, actif, schema } from './_lib/db';
import { avecErreurs, urlBaseDeploy, type EvenementHttp } from './_lib/http';
import { journaliser } from './_lib/journal';
import { envoyerLeadCapi } from './_lib/meta-capi';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CTRL = /[\x00-\x1F\x7F]+/g; // caractères de contrôle ASCII -> remplacés par une espace

function texte(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(CTRL, ' ').trim();
}

// Attribution first/last-touch -> jsonb. Mêmes clés d'entrée que cm-attrib.js (inchangé côté client).
function construireAttribution(d: Record<string, unknown>): Record<string, unknown> {
  const attribution: Record<string, unknown> = {};
  const first: Record<string, string> = {};
  const last: Record<string, string> = {};
  const F: Record<string, string> = {
    utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign',
    utm_content: 'content', utm_term: 'term', landing_page: 'landing_page', first_touch_at: 'at',
  };
  const L: Record<string, string> = {
    last_utm_source: 'source', last_utm_medium: 'medium', last_utm_campaign: 'campaign',
    last_utm_content: 'content', last_utm_term: 'term', last_landing_page: 'landing_page', last_touch_at: 'at',
  };
  for (const [entree, sortie] of Object.entries(F)) { const v = texte(d[entree]); if (v) first[sortie] = v; }
  for (const [entree, sortie] of Object.entries(L)) { const v = texte(d[entree]); if (v) last[sortie] = v; }
  if (Object.keys(first).length) attribution.first = first;
  if (Object.keys(last).length) attribution.last = last;
  for (const k of ['fbclid', 'fbc', 'fbp'] as const) { const v = texte(d[k]); if (v) attribution[k] = v; }
  return attribution;
}

// Fire-and-forget vers la fonction background (202 immédiat côté Netlify).
async function declencherParoles(token: string): Promise<void> {
  const base = urlBaseDeploy();
  const secret = process.env.GENERATE_LYRICS_SECRET || '';
  const r = await fetch(`${base}/.netlify/functions/survey-paroles-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, secret }),
  });
  if (!r.ok && r.status !== 202) throw new Error(`déclenchement background: HTTP ${r.status}`);
}

export const handler = avecErreurs('survey', async (event: EvenementHttp) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  }

  // Filtre anti-bot : un vrai sondage porte toujours un token UUID v4.
  const token = texte(d.token);
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };

  const email = texte(d.email).toLowerCase();
  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Courriel requis' }) };
  }
  const canari = d.canari === true;
  const { clients, projects } = schema;

  const { cree } = await db().transaction(async (tx) => {
    // 1. Client — upsert PAR CONTRAINTE (citext unique) : consent_date et
    //    first_contact_date d'un client existant ne sont JAMAIS écrasés.
    let clientId: string | null = null;
    if (email) {
      const [c] = await tx
        .insert(clients)
        .values({ email, consentStatus: 'received', consentDate: new Date().toISOString() })
        .onConflictDoUpdate({ target: clients.email, set: { lastActivityDate: new Date().toISOString() } })
        .returning({ id: clients.id });
      clientId = c?.id ?? null;
    }

    // 2. Projet — même token déjà soumis = idempotent (aucune double création possible,
    //    token UNIQUE ; on ne retouche pas le projet existant).
    const [existant] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.token, token), actif(projects)))
      .limit(1);
    if (existant) return { cree: false };

    if (!clientId) {
      // Un projet exige un client (FK NOT NULL) : sans courriel valide, la soumission
      // est refusée FORT plutôt qu'un projet orphelin silencieux.
      throw new Error('survey: courriel manquant ou invalide, projet non créé');
    }

    await tx.insert(projects).values({
      token,
      clientId: clientId,
      deceasedName: texte(d.deceased_name),
      relationship: texte(d.relationship),
      musicStyle: texte(d.music_style),
      voice: texte(d.voice),
      mood: texte(d.mood),
      language: texte(d.language) || 'fr-CA',
      songType: texte(d.song_type) === 'cadeau' ? 'cadeau' : 'hommage',
      whatMadeUnique: texte(d.what_made_unique),
      memories: texte(d.memories),
      memoryToKeep: texte(d.memory_to_keep),
      commercialStatus: 'preview_only',
      funnelStep: 'survey_submitted',
      cgvAccepteesAt: new Date().toISOString(), // preuve : CGV acceptées à la soumission (timestamp serveur)
      attribution: construireAttribution(d),
    });
    return { cree: true };
  });

  // 3. Paroles EN ARRIÈRE-PLAN (le client ne bloque jamais ~20 s). Échec de déclenchement =
  //    P1 journalisé, mais la soumission reste OK : les données sont sauvées et la page
  //    d'attente offre « réessayer » (POST /api/revision-paroles sans modifications).
  //    Canari e2e : pas de génération (il teste le pipeline, pas Anthropic).
  if (!canari) {
    try {
      await declencherParoles(token);
    } catch (e) {
      journaliser({
        niveau: 'P1',
        fonction: 'survey',
        message: `déclenchement des paroles échoué: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // 4. Lead CAPI serveur — SEULEMENT à la création (idempotence structurelle : une
  //    création = un Lead ; dédup navigateur via event_id = sha256(token.lead)).
  //    Best-effort : n'affecte jamais la réponse au client. Jamais pour le canari.
  if (cree && !canari) {
    const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '')
      .split(',')[0]!
      .trim();
    const resultat = await envoyerLeadCapi({
      token,
      email,
      fbclid: texte(d.fbclid),
      fbc: texte(d.fbc),
      fbp: texte(d.fbp),
      ip,
      ua: event.headers['user-agent'] || '',
    });
    journaliser({
      niveau: resultat.sent || resultat.summary.startsWith('capi-off') || resultat.summary === 'skip-interne' ? 'P3' : 'P2',
      fonction: 'survey',
      message: `lead CAPI: ${resultat.summary}`,
    });
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
});
