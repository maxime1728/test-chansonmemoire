// netlify/functions/suivi-funnel.js
// Suivi de parcours (funnel) + CAPI Meta (serveur) pour les événements du parcours.
//   - preview_played   : le client a écouté l'aperçu (≠ aperçu seulement généré)   [navigateur]
//   - checkout_started : le client a cliqué « payer » (intention) avant Stripe       [navigateur]
//   - lead             : le projet vient d'être créé (survey)                         [MAKE A, serveur]
//   - purchase         : achat confirmé                                               [MAKE D + page-chanson]
//
// EXCEPTION ASSUMÉE à « Make écrit, Netlify lit » (écriture ponctuelle, champs dédiés, best-effort).
// PRINCIPE : le suivi NE DOIT JAMAIS casser l'UX → tout est best-effort, on répond 200 quoi qu'il arrive.
//
// ⚠️ funnel_step est écrit dans un PATCH SÉPARÉ : si l'option single-select n'existe pas encore
//    dans Airtable (422), les horodatages (preview_played_at, checkout_started_at) sont quand même écrits.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Événements acceptés (front + serveur). Le nom de l'event Meta correspondant est dans CAPI_EVENT (plus bas).
// preview_played / checkout_started = appelés par le navigateur (apercu) ; purchase = MAKE D + page-chanson ; lead = MAKE A.

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

async function patchProject(id, fields, headers) {
  return fetch(`${API}/Projects/${id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

/* ── Meta CAPI (serveur, best-effort) ──────────────────────────────────────────────
   ⚠️ TOKEN-SAFE (Loi 25) : on n'envoie JAMAIS le token client à Meta — ni dans l'URL
   source, ni dans event_id (haché). Secrets en env (jamais en dur) ; no-op si absents. */
const crypto       = require('crypto');
const { withSentry } = require('./_lib/sentry');  // capture des exceptions non gerees
const CAPI_TOKEN   = process.env.META_CAPI_TOKEN;     // secret — var d'env Netlify, JAMAIS en dur
const CAPI_DATASET = process.env.META_DATASET_ID;     // ex. 909919758755200 — var d'env Netlify
const CAPI_EVENT   = { preview_played: 'PreviewPlayed', checkout_started: 'InitiateCheckout', purchase: 'Purchase', lead: 'Lead' };
// Drapeau d'idempotence par event (observabilité + anti-double-compte). preview_played n'a pas de drapeau (dédup gérée par event_id).
const CAPI_SENT_FIELD = { lead: 'capi_lead_sent', checkout_started: 'capi_checkout_sent', purchase: 'capi_purchase_sent' };

function sha256(v) { return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex'); }

// Lit le courriel du Client lié (best-effort), pour la qualité de matching (haché ensuite). Jamais exposé.
async function clientEmailOf(projet, headers) {
  try {
    const link  = projet.fields.Client;   // champ lien « Client » (majuscule) — sinon email vide -> matching Meta dégradé
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/Clients/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

// Envoi best-effort d'un événement CAPI. Ne lève jamais. No-op si token/dataset/événement absents.
// Retourne { sent, summary } pour l'observabilité (capi_last_response) + l'idempotence (drapeau si sent).
async function sendCapi(evt, projet, clientEmail, ip, ua, token) {
  if (!CAPI_TOKEN || !CAPI_DATASET || !CAPI_EVENT[evt]) return { sent: false, summary: 'capi-off (env manquante)' };
  const f = projet.fields || {};
  const user_data = {};
  if (clientEmail && clientEmail.includes('@')) user_data.em = [sha256(clientEmail)];  // email HACHÉ
  // fbc : cookie si présent, sinon RECONSTRUIT depuis fbclid (fb.1.<timestamp_ms>.<fbclid>)
  // -> récupère l'attribution des clics payants quand le cookie _fbc manque (souvent le cas server-to-server).
  let fbc = f.fbc;
  if (!fbc && f.fbclid) {
    const ts = Date.parse(f.created_date || '') || Date.now();
    fbc = `fb.1.${ts}.${f.fbclid}`;
  }
  if (fbc)   user_data.fbc = fbc;                  // fbc/fbp/IP/UA : NON hachés (spec Meta)
  if (f.fbp) user_data.fbp = f.fbp;
  if (ip)    user_data.client_ip_address = ip;
  if (ua)    user_data.client_user_agent = ua;
  // Page source générique selon l'event — SANS token (token-safe).
  const SRC = { preview_played: '/apercu', checkout_started: '/apercu', purchase: '/page-chanson', lead: '/souvenirs' };
  const data0 = {
    event_name:       CAPI_EVENT[evt],
    event_time:       Math.floor(Date.now() / 1000),
    action_source:    'website',
    event_id:         sha256(`${token}.${evt}`),   // dédup — basé sur le TOKEN (reproductible navigateur+serveur), haché, jamais brut
    event_source_url: 'https://chansonmemoire.ca' + (SRC[evt] || ''),  // SANS token
    user_data:        user_data
  };
  // Purchase : montant payé + devise (depuis Airtable) pour la valeur de conversion Meta.
  if (evt === 'purchase') data0.custom_data = { currency: 'CAD', value: Number(f.amount) || 0 };
  const payload = { data: [data0] };
  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${CAPI_DATASET}/events?access_token=${encodeURIComponent(CAPI_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const txt = await resp.text().catch(() => '');
    return { sent: resp.ok, summary: `${resp.status} ${String(txt).slice(0, 300)}` };
  } catch (e) {
    return { sent: false, summary: 'fetch-error ' + (e && e.message ? e.message : '') };  // la CAPI ne casse jamais l'UX
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: '{}' }; }

  const token = (body.token || '').trim();
  const evt   = (body.event || '').trim();
  if (!UUID_V4.test(token) || !CAPI_EVENT[evt]) return { statusCode: 400, body: '{}' };

  const headers = { Authorization: `Bearer ${TOKEN}` };
  const now = new Date().toISOString();

  try {
    // Project par token.
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: '{}' };
    const projet = dP.records[0];
    const f = projet.fields;

    // 1+2. Horodatages + funnel_step : UNIQUEMENT pour les events front (preview/checkout).
    //      Pour purchase/lead, MAKE D / MAKE A possèdent déjà funnel_step + les champs achat -> on ne fait que la CAPI.
    if (evt === 'preview_played' || evt === 'checkout_started') {
      const stamp = {};
      if (evt === 'preview_played') {
        if (!f.preview_played_at) stamp.preview_played_at = now;       // 1er play seulement
        stamp.preview_play_count = (Number(f.preview_play_count) || 0) + 1;
      } else {
        if (!f.checkout_started_at) stamp.checkout_started_at = now;   // 1re intention seulement
      }
      if (Object.keys(stamp).length) await patchProject(projet.id, stamp, headers);
      // funnel_step — PATCH séparé best-effort (un 422 « option inexistante » n'impacte pas les horodatages).
      try { await patchProject(projet.id, { funnel_step: evt }, headers); } catch (_) {}
    }

    // 3. Meta CAPI (serveur, best-effort, token-safe). Ne bloque jamais la réponse.
    try {
      const sentField = CAPI_SENT_FIELD[evt];          // lead/checkout/purchase ont un drapeau d'idempotence
      if (!sentField || f[sentField] !== true) {       // pas encore envoyé (ou event sans drapeau = preview)
        // IP/UA : priorité au body (appel serveur MAKE A/D = vrai client) sinon headers (appel navigateur).
        const ip = (body.client_ip_address || '').trim()
          || (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const ua = (body.client_user_agent || '').trim() || event.headers['user-agent'] || '';
        const email = await clientEmailOf(projet, headers);
        const res = await sendCapi(evt, projet, email, ip, ua, token);
        // Observabilité + idempotence : drapeau posé SEULEMENT si Meta a accepté (permet le réessai si échec).
        if (sentField) {
          const upd = { capi_last_response: res.summary };
          if (res.sent) upd[sentField] = true;
          try { await patchProject(projet.id, upd, headers); } catch (_) {}
        }
      }
    } catch (_) { /* CAPI best-effort */ }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (_) {
    // Le suivi ne casse jamais l'UX.
    return { statusCode: 200, body: '{}' };
  }
};

// Toute exception non geree -> Sentry, puis relancee (comportement inchange).
exports.handler = withSentry(exports.handler);
