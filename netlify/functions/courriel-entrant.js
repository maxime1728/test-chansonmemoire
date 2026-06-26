// netlify/functions/courriel-entrant.js
//
// SUPPORT ENTRANT — RÉCEPTION (capture seule, fiable). Reçoit un courriel client et le STOCKE dans la
// file « Conversations ». Le BROUILLON IA est rédigé séparément par brouillon-cron -> ainsi un courriel
// n'est JAMAIS perdu si Anthropic est lent/en panne (la réception ne dépend que d'Airtable).
//
// DEUX entrées selon le Content-Type :
//  - application/json     : voie interne (tests) -> gate MAKE_WEBHOOK_SECRET.
//  - multipart/form-data  : voie DIRECTE Mailgun (Route -> ici, SANS Make) -> gate SIGNATURE Mailgun.
//    Parse natif via Response().formData() (Node 20/undici, zéro dépendance).
//
// FIABILITÉ (ne rien perdre) : on répond 200 SEULEMENT si le courriel est bien enregistré ; en cas
// d'échec d'écriture ou d'erreur, on répond 5xx -> Mailgun RÉESSAIE (plusieurs heures). Les cas filtrés
// volontairement (nos adresses, auto-réponses) répondent 200 (ce ne sont pas des pertes).
//
// FIL : courriels d'un même échange (expéditeur + sujet normalisé, 30 j) regroupés (thread_key) ; on
// vide alors brouillon_ia pour que le cron re-rédige sur le fil complet. PLUSIEURS PROJETS : tous liés.
//
// Voix/garde-fous (CLAUDE.md) : appliqués côté brouillon-cron (rédaction). Env : MAILGUN_SIGNING_KEY,
// MAKE_WEBHOOK_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const crypto = require('crypto');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.MAKE_WEBHOOK_SECRET;
const MG_SIGNING_KEY = process.env.MAILGUN_SIGNING_KEY;   // clé de signature webhook Mailgun (voie DIRECTE)

const CLIENTS  = 'tblQbF1OlE3uRxFra';
const CONVOS   = 'tbl3KBgXthCPromxF';
const CLIENT_PROJECTS_LINK = 'fldayFzM1PdALeWKL';   // lien Clients -> Projects (lu par returnFieldsByFieldId)

const FENETRE_FIL_MS = 30 * 24 * 60 * 60 * 1000;     // au-delà de 30 j, un même sujet = nouvelle conversation
const MAX_TEXTE      = 90000;                          // garde-fou longueur (champ long text)

// Échappe une valeur pour un littéral filterByFormula. null si ambigu (' et ").
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

// Vérifie la signature d'un POST Mailgun entrant : HMAC-SHA256(timestamp+token) == signature.
// Ferme l'endpoint à tout sauf Mailgun.
function verifierMailgun(timestamp, token, signature) {
  if (!MG_SIGNING_KEY || !timestamp || !token || !signature) return false;
  const attendu = crypto.createHmac('sha256', MG_SIGNING_KEY).update(String(timestamp) + String(token)).digest('hex');
  try {
    const a = Buffer.from(attendu), b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  let from = '', subject = '', message = '', msgId = '', recipient = '';

  if (ct.includes('application/json')) {
    if (!SECRET) { console.error('[courriel-entrant] MAKE_WEBHOOK_SECRET manquant'); return { statusCode: 500, body: '{}' }; }
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return { statusCode: 400, body: '{}' }; }
    if ((body.secret || '') !== SECRET) return { statusCode: 403, body: '{}' };
    from = (body.from || '').toString().trim();
    subject = (body.subject || '').toString().trim();
    message = (body.body || '').toString().trim();
    msgId = (body.message_id || '').toString().trim();
    recipient = (body.recipient || '').toString().trim();
  } else {
    // Mailgun poste en multipart/form-data -> parsé NATIVEMENT (Node 20, undici) via Response().formData().
    if (!MG_SIGNING_KEY) { console.error('[courriel-entrant] MAILGUN_SIGNING_KEY manquant'); return { statusCode: 500, body: '{}' }; }
    let form;
    try {
      const buf = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
      form = await new Response(buf, { headers: { 'content-type': ct } }).formData();
    } catch (e) { console.error('[courriel-entrant] parse multipart', e && e.message); return { statusCode: 400, body: '{}' }; }
    if (!verifierMailgun(form.get('timestamp'), form.get('token'), form.get('signature'))) {
      return { statusCode: 403, body: '{}' };   // pas Mailgun -> refusé
    }
    from = (form.get('sender') || '').toString().trim();
    subject = (form.get('subject') || '').toString().trim();
    message = (form.get('stripped-text') || form.get('body-plain') || '').toString().trim();   // texte sans l'historique cité
    msgId = (form.get('Message-Id') || form.get('message-id') || '').toString().trim();
    recipient = (form.get('recipient') || '').toString().trim();
  }

  if (!from) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no_sender' }) };
  if (estAdresseInterne(from)) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'internal' }) };
  if (estAutoReponse(subject)) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'auto_reply' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  const now = new Date();
  const threadKey = `${from.toLowerCase()}|${normaliserSujet(subject).toLowerCase()}`.slice(0, 250);

  try {
    // 1. MATCH : Client par email -> TOUS ses projets (best-effort ; non bloquant pour la capture).
    let projectIds = [];
    const litEmail = formulaLiteral(from);
    if (litEmail !== null) {
      const fC = encodeURIComponent(`LOWER({email})=LOWER(${litEmail})`);
      const rC = await fetch(`${API}/${CLIENTS}?filterByFormula=${fC}&maxRecords=1&returnFieldsByFieldId=true`, { headers });
      const dC = await rC.json().catch(() => ({}));
      const client = dC.records && dC.records[0];
      const projs = client && client.fields && client.fields[CLIENT_PROJECTS_LINK];
      if (Array.isArray(projs)) projectIds = projs.slice();
    }

    // 2. FIL : conversation existante (même thread_key, récente) ?
    let existing = null;
    const litThread = formulaLiteral(threadKey);
    if (litThread !== null) {
      const fT = encodeURIComponent(`{thread_key}=${litThread}`);
      const rT = await fetch(`${API}/${CONVOS}?filterByFormula=${fT}&sort%5B0%5D%5Bfield%5D=recu_le&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
      const dT = await rT.json().catch(() => ({}));
      const cand = dT.records && dT.records[0];
      if (cand) {
        const prev = cand.fields && cand.fields.recu_le ? new Date(cand.fields.recu_le).getTime() : 0;
        if (now.getTime() - prev <= FENETRE_FIL_MS) existing = cand;
      }
    }

    // 3. Texte du fil (accumulé si on regroupe).
    const sep = `\n\n──────── ${now.toISOString().slice(0, 16).replace('T', ' ')} ────────\n`;
    const threadText = existing ? ((existing.fields.message || '') + sep + message).slice(-MAX_TEXTE) : message;

    const liensExistants = (existing && Array.isArray(existing.fields.Projet)) ? existing.fields.Projet : [];
    const liens = [...new Set([...liensExistants, ...projectIds])];

    // 4. STORE — étape critique. PAS de brouillon ici (découplé -> brouillon-cron) : la capture ne dépend
    //    pas d'Anthropic. brouillon_ia vide + statut a_verifier => apparaît en file, le cron le rédige.
    const champs = {
      expediteur: from,
      sujet: subject.slice(0, 250),
      message: threadText,
      recu_le: now.toISOString(),
      statut: 'a_verifier',
      message_id: msgId.slice(0, 250),
      thread_key: threadKey
    };
    if (liens.length) champs.Projet = liens;
    if (existing) {
      champs.brouillon_ia = '';   // nouveau message dans le fil -> le cron re-rédige sur le fil complet
    } else {
      if (recipient) champs.destinataire = recipient;
      champs.repondre_de = recipient;   // « De » par défaut = l'adresse à laquelle le client a écrit
    }

    const url    = existing ? `${API}/${CONVOS}/${existing.id}` : `${API}/${CONVOS}`;
    const method = existing ? 'PATCH' : 'POST';
    const rStore = await fetch(url, {
      method, headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: champs, typecast: true })   // typecast : repondre_de est un menu deroulant (singleSelect) -> une nouvelle adresse d'arrivee cree le choix au lieu d'un 422 qui ferait perdre le courriel
    });
    if (!rStore.ok) {
      console.error('[courriel-entrant] store', rStore.status, await rStore.text().catch(() => ''));
      return { statusCode: 500, body: JSON.stringify({ error: 'store_failed' }) };   // -> Mailgun réessaie (pas de perte)
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, regroupe: !!existing, projets: liens.length }) };
  } catch (err) {
    console.error('[courriel-entrant]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'server_error' }) };   // -> Mailgun réessaie (pas de perte)
  }
};
