// netlify/functions/courriel-entrant.js
//
// SUPPORT ENTRANT — reçoit une réponse client (courriel) et la dépose dans la file « Conversations »
// d'Airtable avec un BROUILLON DE RÉPONSE rédigé par Claude. Maxime relit, ajuste, répond (Phase 1).
// Plus tard : auto-réponse des cas à haute confiance (Phase 2).
//
// CHEMIN : Route Mailgun (achat/info) -> petit webhook Make (décortique le multipart) -> POST ici en
// JSON PROPRE { secret, from, subject, body, message_id }. On évite ainsi de parser du multipart brut.
//
// FIL DE CONVERSATION : plusieurs courriels d'un même échange (même expéditeur + même sujet) sont
// REGROUPÉS dans UNE seule conversation (thread_key). On accumule les messages et on re-rédige le
// brouillon avec TOUT le contexte -> réponse personnalisée même si le client écrit en 3 fois.
//
// PLUSIEURS PROJETS : si le client a plusieurs chansons, on lie TOUS ses projets et on donne leur
// contexte à Claude, qui identifie laquelle concerne le message (ou demande de préciser).
//
// SÉCURITÉ : gate par `secret` == MAKE_WEBHOOK_SECRET. On ignore nos propres adresses + auto-réponses.
// Garde-fou légal (CLAUDE.md §2) : remboursement / allégation = JAMAIS auto -> confiance basse + escalade.
// Voix de marque (§1) : SOLUTION-FIRST, jamais ouvrir sur le deuil ; sobre, digne, québécois.
// Best-effort : on répond toujours 200 (sauf secret invalide) pour ne pas faire boucler Make.
//
// Env : MAKE_WEBHOOK_SECRET, ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.MAKE_WEBHOOK_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CLIENTS  = 'tblQbF1OlE3uRxFra';
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const CONVOS   = 'tbl3KBgXthCPromxF';
const CLIENT_PROJECTS_LINK = 'fldayFzM1PdALeWKL';   // champ lien Clients -> Projects (lu par returnFieldsByFieldId)
const SITE     = 'https://chansonmemoire.ca';       // lien page client (= courriel d'achat / nouvelle version)

const MAX_PROJETS    = 3;                            // contexte donné à l'IA (les clients en ont ~1)
const FENETRE_FIL_MS = 30 * 24 * 60 * 60 * 1000;     // au-delà de 30 j, un même sujet = nouvelle conversation
const MAX_TEXTE      = 90000;                          // garde-fou longueur (champ long text)

// Échappe une valeur pour un littéral filterByFormula (cf. lire-projet). null si ambigu (' et ").
function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Sujet normalisé : retire les préfixes de réponse/transfert répétés (Re:, Ré:, Fwd:, Tr:…).
function normaliserSujet(subject) {
  return String(subject || '')
    .replace(/^(\s*(re|ré|fwd|fw|tr|tr\.|réf)\s*:\s*)+/i, '')
    .trim() || '(sans sujet)';
}

// Adresses qui ne doivent JAMAIS créer de conversation (nos propres envois, no-reply, notifications).
function estAdresseInterne(addr) {
  const a = (addr || '').toLowerCase();
  return /@([a-z0-9-]+\.)*chansonmemoire\.ca$/.test(a)   // racine + tout sous-domaine = nous (jamais un client)
      || /\bno-?reply@/.test(a)
      || /(mailer-daemon|postmaster)@/.test(a);
}
// Sujets d'auto-réponse à ignorer (absences, accusés, rapports de non-remise).
function estAutoReponse(subject) {
  return /^(re:\s*)?(out of office|absence|automatic reply|réponse automatique|delivery status|undeliverable|mail delivery|échec de remise)/i.test(subject || '');
}

// Extrait le premier objet JSON d'un texte (le modèle peut emballer dans de la prose).
function extraireJson(txt) {
  if (!txt) return null;
  const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  try { return JSON.parse(txt.slice(i, j + 1)); } catch (_) { return null; }
}

const SYSTEM = `Tu es l'assistant du SERVICE CLIENT de Chanson Mémoire (chansons hommage et cadeau personnalisées, marché québécois francophone).

Ta tâche : à partir de l'échange reçu d'un client et du contexte de ses projets, rédiger un BROUILLON de réponse que l'équipe relira avant envoi.

LE FIL PEUT CONTENIR PLUSIEURS MESSAGES : le client a parfois écrit en plusieurs courriels successifs. Lis TOUT le fil et réponds au besoin global (en priorité ce qui est resté sans réponse / le plus récent).

PLUSIEURS PROJETS : si le contexte contient plus d'un projet, identifie DE QUELLE chanson le client parle grâce au prénom de la personne ou au contenu. Si c'est ambigu, demande-lui poliment de préciser — n'invente pas.

LIEN DE LA PAGE : si le client veut accéder à sa chanson / la réécouter, suivre l'avancement, ou demande une modification, INCLUS le lien de sa page (le champ "lien_page" du contexte du bon projet) dans ta réponse — c'est là qu'il écoute, télécharge et demande ses modifications. N'invente JAMAIS d'autre lien ; si "lien_page" est vide, n'en mets aucun.

VOIX DE MARQUE — IMPÉRATIF :
- Français QUÉBÉCOIS, naturel, chaleureux, sobre et digne. Vouvoiement.
- SOLUTION-FIRST : n'ouvre JAMAIS sur le deuil ou la douleur. Entre par ce qu'on offre / ce qu'on peut faire.
- Pas larmoyant, pas de clichés. Concis et humain.
- Signe « L'équipe Chanson Mémoire ».

GARDE-FOUS — NE JAMAIS faire de façon autonome (mets alors confiance="basse") :
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

async function redigerBrouillon(from, subject, threadText, contexts) {
  if (!ANTHROPIC_KEY) return null;
  const userPrompt =
    `ÉCHANGE REÇU\nDe : ${from}\nSujet : ${subject || '(aucun)'}\n\nFil (du plus ancien au plus récent) :\n${(threadText || '').slice(-MAX_TEXTE)}\n\n` +
    `CONTEXTE DES PROJETS DU CLIENT (peut être vide si client non retrouvé) :\n${JSON.stringify(contexts || [])}`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('[courriel-entrant] Anthropic', res.status); return null; }
    const txt = (data.content && data.content[0] && data.content[0].text) || '';
    return extraireJson(txt);
  } catch (e) { console.error('[courriel-entrant] Anthropic', e && e.message); return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  if (!SECRET) { console.error('[courriel-entrant] MAKE_WEBHOOK_SECRET manquant'); return { statusCode: 500, body: '{}' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return { statusCode: 400, body: '{}' }; }
  if ((body.secret || '') !== SECRET) return { statusCode: 403, body: '{}' };

  const from    = (body.from || '').toString().trim();
  const subject = (body.subject || '').toString().trim();
  const message = (body.body || '').toString().trim();
  const msgId   = (body.message_id || '').toString().trim();

  if (!from) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no_sender' }) };
  if (estAdresseInterne(from)) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'internal' }) };
  if (estAutoReponse(subject)) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'auto_reply' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  const now = new Date();
  const threadKey = `${from.toLowerCase()}|${normaliserSujet(subject).toLowerCase()}`.slice(0, 250);

  try {
    // 1. MATCH : Client par email (insensible à la casse) -> TOUS ses projets.
    let projectIds = [];
    const litEmail = formulaLiteral(from);
    if (litEmail !== null) {
      const fC = encodeURIComponent(`LOWER({email})=LOWER(${litEmail})`);
      const rC = await fetch(`${API}/${CLIENTS}?filterByFormula=${fC}&maxRecords=1&returnFieldsByFieldId=true`, { headers });
      const dC = await rC.json().catch(() => ({}));
      const client = dC.records && dC.records[0];
      const projs = client && client.fields && client.fields[CLIENT_PROJECTS_LINK];
      if (Array.isArray(projs)) projectIds = projs.slice();   // ids de record
    }

    // 2. Contexte de chaque projet (cap MAX_PROJETS) pour aider l'IA à savoir DE QUELLE chanson on parle.
    const contexts = [];
    for (const pid of projectIds.slice(-MAX_PROJETS)) {
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
            lien_page: p.token ? `${SITE}/page-memoire?id=${encodeURIComponent(p.token)}` : ''
          });
        }
      } catch (_) {}
    }

    // 3. FIL : conversation existante (même thread_key, récente) ?
    let existing = null;
    const litThread = formulaLiteral(threadKey);
    if (litThread !== null) {
      const fT = encodeURIComponent(`{thread_key}=${litThread}`);
      const rT = await fetch(`${API}/${CONVOS}?filterByFormula=${fT}&sort%5B0%5D%5Bfield%5D=recu_le&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
      const dT = await rT.json().catch(() => ({}));
      const cand = dT.records && dT.records[0];
      if (cand) {
        const prev = cand.fields && cand.fields.recu_le ? new Date(cand.fields.recu_le).getTime() : 0;
        if (now.getTime() - prev <= FENETRE_FIL_MS) existing = cand;   // assez récent -> on regroupe
      }
    }

    // 4. Texte du fil (accumulé si on regroupe) + brouillon IA sur tout le fil.
    const sep = `\n\n──────── ${now.toISOString().slice(0, 16).replace('T', ' ')} ────────\n`;
    const threadText = existing
      ? ((existing.fields.message || '') + sep + message).slice(-MAX_TEXTE)
      : message;

    const ia = await redigerBrouillon(from, subject, threadText, contexts) || {};
    const conf = ['haute', 'moyenne', 'basse'].includes(ia.confiance) ? ia.confiance : 'basse';
    const cat  = ['question', 'modification', 'remboursement', 'remerciement', 'autre'].includes(ia.categorie) ? ia.categorie : 'autre';

    // Union des liens projet (existants + nouveaux), dédupliqués.
    const liensExistants = (existing && Array.isArray(existing.fields.Projet)) ? existing.fields.Projet : [];
    const liens = [...new Set([...liensExistants, ...projectIds])];

    const champs = {
      expediteur: from,
      sujet: subject.slice(0, 250),
      message: threadText,
      recu_le: now.toISOString(),
      brouillon_ia: (ia.brouillon || '').slice(0, MAX_TEXTE),
      confiance_ia: conf,
      categorie_ia: cat,
      statut: 'a_verifier',                 // (re)mettre en file même si déjà répondu
      message_id: msgId.slice(0, 250),
      thread_key: threadKey
    };
    if (liens.length) champs.Projet = liens;

    if (existing) {
      const rU = await fetch(`${API}/${CONVOS}/${existing.id}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: champs })
      });
      if (!rU.ok) console.error('[courriel-entrant] update', rU.status, await rU.text().catch(() => ''));
    } else {
      const rC2 = await fetch(`${API}/${CONVOS}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: champs })
      });
      if (!rC2.ok) console.error('[courriel-entrant] create', rC2.status, await rC2.text().catch(() => ''));
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, regroupe: !!existing, projets: liens.length, confiance: conf }) };
  } catch (err) {
    console.error('[courriel-entrant]', err && err.message);
    return { statusCode: 200, body: '{}' };   // best-effort
  }
};
