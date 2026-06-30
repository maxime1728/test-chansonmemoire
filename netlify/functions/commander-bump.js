// netlify/functions/commander-bump.js
//
// COMMANDE d'un order bump DÉJÀ ACHETÉ (au checkout). Le client a payé l'extra (instrumentale / vidéo des
// paroles) au moment de l'achat -> il le COMMANDE ensuite sur sa page-mémoire, quand il est prêt (décision
// Maxime : commande explicite, pas de lancement auto). On lance alors la production et on passe le statut
// extra_* de 'achete' à 'commande'. La livraison (callback) le passera à 'livre'.
//
// Sécurité : POST, UUID v4 strict, gate purchased, on N'AUTORISE que les bumps réellement 'achete' (anti
// double-déclenchement / anti-resquille : on ne lance jamais un extra non payé). Best-effort sur le lanceur.
// Env : AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE    = 'https://chansonmemoire.ca';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// type client -> { champ statut Projet, lanceur }. Seuls ces types sont acceptés (anti-tamper).
const EXTRAS = {
  instrumental:     { champ: 'extra_instrumental',     lanceur: '/api/lancer-instrumentale' },
  paroles_vivantes: { champ: 'extra_paroles_vivantes', lanceur: '/api/lancer-paroles-vivantes' },
  pdf_paroles:      { champ: 'extra_pdf',              lanceur: '/api/lancer-cadeau' }
  // Note : la vidéo souvenir n'est PAS ici (elle exige des photos -> produite au clic « Générer »,
  // pas « Commander ». Voir lancer-video-memoire + page-memoire initVideoMemoire).
};

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  const type  = (body.type || '').toString().trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  const extra = EXTRAS[type];
  if (!extra) return { statusCode: 400, body: JSON.stringify({ error: 'Type invalide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Projet par token. Gate purchased.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    const statut = (projet.fields[extra.champ] || '').toString();
    // Déjà commandé / livré -> idempotent (on ne relance pas).
    if (statut === 'commande' || statut === 'livre') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, statut, already: true }) };
    }
    // Pas acheté -> on refuse (jamais lancer un extra non payé).
    if (statut !== 'achete') {
      return { statusCode: 409, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: 'non_achete' }) };
    }

    // 2. Passe à 'commande' AVANT le lancement (le statut reflète la commande client ; le watchdog couvre un
    //    lanceur raté). typecast : extra_* est un singleSelect.
    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typecast: true, fields: { [extra.champ]: 'commande' } })
    });

    // 3. Lance la production (best-effort : le statut est posé, le watchdog rattrape si le lanceur échoue).
    try { await fetch(`${SITE}${extra.lanceur}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); } catch (_) {}

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, statut: 'commande' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
