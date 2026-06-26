// netlify/functions/brouillon-cron.js
//
// SUPPORT — RÉDACTION des brouillons IA (découplée de la réception). Fonction planifiée (chaque minute).
// Trouve les conversations en file SANS brouillon et fait rédiger une réponse par Claude.
//
// POURQUOI séparé : la réception (courriel-entrant) ne fait que STOCKER -> aucun courriel n'est perdu
// si Anthropic est lent/en panne. Ce cron est AUTO-RÉPARANT : si Anthropic tombe, les courriels restent
// stockés sans brouillon et sont rédigés dès qu'Anthropic répond (au passage suivant). (Anthropic plante
// parfois plusieurs fois par mois -> cette résilience est volontaire.)
//
// Voix de marque (CLAUDE.md §1) : SOLUTION-FIRST, québécois, digne. Garde-fou légal (§2) : remboursement
// / allégation = confiance basse, jamais auto. Best-effort. Env : ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CONVOS   = 'tbl3KBgXthCPromxF';
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const SITE     = 'https://chansonmemoire.ca';
const MAX_PER_RUN = 5;
const MAX_PROJETS = 3;
const MAX_TEXTE   = 90000;
const TIMEOUT_MS  = 20000;

const { piedAuto } = require('./_lib/pied-courriel');

const SYSTEM = `Tu es l'assistant du SERVICE CLIENT de Chanson Mémoire (chansons hommage et cadeau personnalisées, marché québécois francophone).

Ta tâche : à partir de l'échange reçu d'un client et du contexte de ses projets, rédiger un BROUILLON de réponse que l'équipe relira avant envoi.

LE FIL PEUT CONTENIR PLUSIEURS MESSAGES : le client a parfois écrit en plusieurs courriels successifs. Lis TOUT le fil et réponds au besoin global (en priorité ce qui est resté sans réponse / le plus récent).

PLUSIEURS PROJETS : si le contexte contient plus d'un projet, identifie DE QUELLE chanson le client parle grâce au prénom de la personne ou au contenu. Si c'est ambigu, demande-lui poliment de préciser — n'invente pas.

LIEN DE LA PAGE : si le client veut accéder à sa chanson / la réécouter, suivre l'avancement, ou demande une modification, INCLUS le lien de sa page (le champ "lien_page" du contexte du bon projet). C'est là qu'il écoute, télécharge et demande ses modifications. N'invente JAMAIS d'autre lien ; si "lien_page" est vide, n'en mets aucun.

FORMAT DES LIENS (IMPÉRATIF) : écris TOUJOURS un lien en markdown [texte court et clair](url), JAMAIS l'URL nue. Exemple : [votre page Chanson Mémoire](URL). Si le client a plusieurs projets, nomme chaque lien par la personne, ex. [la chanson de Prénom](URL). Les liens deviennent cliquables dans le courriel envoyé.

TON POUR LES MODIFICATIONS (IMPÉRATIF) : si la demande est une modification de la chanson (paroles, style, prononciation, etc.), réponds comme si la correction est DÉJÀ APPLIQUÉE. Invite le client à réécouter sa version corrigée au lien MAINTENANT. N'écris JAMAIS au futur (« nous allons corriger », « dès que ce sera prêt », « nous vous ferons signe ») : la nouvelle version est déjà là.

VOIX DE MARQUE (IMPÉRATIF) :
- Français QUÉBÉCOIS, naturel, chaleureux, sobre et digne. Vouvoiement.
- SOLUTION-FIRST : n'ouvre JAMAIS sur le deuil ou la douleur. Entre par ce qu'on offre / ce qu'on peut faire.
- Pas larmoyant, pas de clichés. Concis et humain.
- N'utilise JAMAIS le tiret cadratin/long (—) : remplace-le par une virgule, un deux-points, une parenthèse ou un point.
- NE signe PAS et n'ajoute AUCUNE formule finale (bonne journée, au plaisir, cordialement...) : la salutation du moment et la signature (Nathalie, L'équipe Chanson Mémoire) sont ajoutées AUTOMATIQUEMENT à l'envoi. Termine sur ta dernière phrase utile.

GARDE-FOUS, NE JAMAIS faire de façon autonome (mets alors confiance="basse") :
- Promettre, confirmer ou refuser un REMBOURSEMENT.
- Avancer un prix, une promotion, une garantie de résultat ou une allégation.
- Toute question juridique, plainte, ou litige.
Dans ces cas, rédige un accusé de réception empathique qui dit qu'un membre de l'équipe revient personnellement — sans rien promettre.

CONFIANCE :
- "haute" : question simple répondable avec le contexte (état de la commande, accès à la chanson, délais).
- "moyenne" : demande de modification claire, ou question partiellement couverte, ou projet ambigu.
- "basse" : remboursement, plainte, sujet sensible/légal, ou contexte insuffisant.

CATÉGORIE : "question" | "modification" | "remboursement" | "remerciement" | "autre".

RÉPONDS UNIQUEMENT avec un objet JSON valide, sans texte autour :
{"brouillon":"<la réponse complète, prête à relire>","confiance":"haute|moyenne|basse","categorie":"question|modification|remboursement|remerciement|autre"}`;

function extraireJson(txt) {
  if (!txt) return null;
  const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  try { return JSON.parse(txt.slice(i, j + 1)); } catch (_) { return null; }
}

// Contexte de chaque projet lié (cap MAX_PROJETS) -> aide l'IA à savoir DE QUELLE chanson on parle + le lien.
async function construireContexts(projectIds, headers) {
  const contexts = [];
  for (const pid of (projectIds || []).slice(-MAX_PROJETS)) {
    try {
      const rP = await fetch(`${API}/${PROJECTS}/${pid}`, { headers });
      if (rP.ok) {
        const p = (await rP.json()).fields || {};
        contexts.push({
          prenom_personne: p.deceased_name || '',
          type: p.song_type || 'hommage',
          langue: p.language || 'fr-CA',
          statut_commande: p.commercial_status || 'preview_only',
          etape: p.approval_status || '',
          // Lien PAR PROJET : vendu -> page de livraison complète ; pré-achat -> page aperçu (jamais le lien complet).
          lien_page: !p.token ? ''
            : (p.commercial_status === 'purchased'
                ? (p.page_url || `${SITE}/page-memoire?id=${encodeURIComponent(p.token)}`)
                : `${SITE}/apercu?id=${encodeURIComponent(p.token)}`)
        });
      }
    } catch (_) {}
  }
  return contexts;
}

// Appel Anthropic AVEC timeout (jamais bloquer le cron). Renvoie {brouillon, confiance, categorie} ou null.
async function genererBrouillon(f, contexts) {
  if (!ANTHROPIC_KEY) return null;
  const userPrompt =
    `ÉCHANGE REÇU\nDe : ${f.expediteur || ''}\nSujet : ${f.sujet || '(aucun)'}\n\nFil (du plus ancien au plus récent) :\n${(f.message || '').slice(-MAX_TEXTE)}\n\n` +
    `CONTEXTE DES PROJETS DU CLIENT (peut être vide) :\n${JSON.stringify(contexts || [])}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
    });
    if (!res.ok) { console.error('[brouillon-cron] Anthropic', res.status); return null; }
    const data = await res.json().catch(() => ({}));
    const txt = (data.content && data.content[0] && data.content[0].text) || '';
    return extraireJson(txt);
  } catch (e) { console.error('[brouillon-cron] Anthropic', e && e.message); return null; }
  finally { clearTimeout(timer); }
}

exports.handler = async () => {
  if (!ANTHROPIC_KEY) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_key' }) };
  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  let rediges = 0, echecs = 0;

  try {
    // Conversations en file SANS brouillon (capturées par courriel-entrant, ou re-mises à vide au regroupement).
    const formula = encodeURIComponent('AND({statut}="a_verifier", {brouillon_ia}="")');
    const r = await fetch(`${API}/${CONVOS}?filterByFormula=${formula}&maxRecords=${MAX_PER_RUN}`, { headers });
    const d = await r.json().catch(() => ({}));
    const recs = (d && d.records) || [];

    for (const rec of recs) {
      const f = rec.fields || {};
      const contexts = await construireContexts(Array.isArray(f.Projet) ? f.Projet : [], headers);
      const ia = await genererBrouillon(f, contexts);
      if (!ia || !ia.brouillon) { echecs++; continue; }   // Anthropic indispo -> on réessaiera (auto-réparation)
      const conf = ['haute', 'moyenne', 'basse'].includes(ia.confiance) ? ia.confiance : 'basse';
      const cat  = ['question', 'modification', 'remboursement', 'remerciement', 'autre'].includes(ia.categorie) ? ia.categorie : 'autre';
      try {
        await fetch(`${API}/${CONVOS}/${rec.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { brouillon_ia: `${ia.brouillon.slice(0, MAX_TEXTE)}\n\n${piedAuto()}`, confiance_ia: conf, categorie_ia: cat } })
        });
        rediges++;
      } catch (_) { echecs++; }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, trouve: recs.length, rediges, echecs }) };
  } catch (err) {
    console.error('[brouillon-cron]', err && err.message);
    return { statusCode: 200, body: '{}' };
  }
};
