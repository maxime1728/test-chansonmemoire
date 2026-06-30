// netlify/functions/lire-modifications.js
// LECTURE seule. Liste les DEMANDES DE MODIFICATION faites APRÈS l'achat pour un projet (token-gaté),
// pour le menu déroulant de page-chanson. On ne renvoie QUE les modifications « apres_achat » (champ
// phase_achat posé à l'écriture par decortique / demander-modif-client) -> jamais les essais d'aperçu
// faits AVANT l'achat. Réponse minimale : date + statut lisible (pas le texte de la demande).
//
// Sécurité : POST, UUID v4 strict, gate purchased, formule échappée, secrets en env. Best-effort.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const CONVOS  = 'tbl3KBgXthCPromxF';   // table Conversations

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Statut interne (a_verifier / repondu / archive) -> libellé client digne.
const STATUT_LABEL = {
  a_verifier: 'En traitement',
  repondu:    'Traitée',
  archive:    'Traitée'
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
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Projet par token (UUID validé -> littéral sûr). Gate purchased (réservé post-achat).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // 2. Version achetée : titre + style + ambiance (le « contexte » de toutes ces modifications).
    const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };

    let version = { titre: '', style: '', ambiance: '', numero: Number.isInteger(purchasedNo) ? purchasedNo : null };
    if (Number.isInteger(purchasedNo)) {
      const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
      const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
      const g  = (((await rG.json()).records) || [])[0];
      if (g && g.fields) {
        version.titre    = g.fields.song_title    || '';
        version.style    = g.fields.gen_music_style || projet.fields.music_style || '';
        version.ambiance = g.fields.gen_mood        || projet.fields.mood        || '';
      }
    }

    // 3. Modifications POST-achat (phase_achat='apres_achat'), plus récentes d'abord. On filtre par
    //    phase_achat en formule (singleSelect = compare fiable) PUIS par projet EN CODE via les record IDs
    //    du lien Projet (filtrer un champ LIEN en formule Airtable est piégeux -> on l'évite).
    const fC = encodeURIComponent(`{phase_achat}="apres_achat"`);
    const rC = await fetch(`${API}/${CONVOS}?filterByFormula=${fC}&sort%5B0%5D%5Bfield%5D=recu_le&sort%5B0%5D%5Bdirection%5D=desc&pageSize=100`, { headers });
    const dC = await rC.json();
    const modifications = ((dC.records) || [])
      .filter((r) => (r.fields && Array.isArray(r.fields.Projet) ? r.fields.Projet : []).includes(projet.id))
      .map((r) => {
        const f = r.fields || {};
        const brut = (f.statut || '').toString();
        return { recu_le: f.recu_le || '', statut: STATUT_LABEL[brut] || 'En traitement' };
      });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, version, modifications })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
