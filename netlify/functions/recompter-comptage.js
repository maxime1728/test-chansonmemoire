// netlify/functions/recompter-comptage.js
//
// Recalcule les compteurs de chansons réussies d'un projet (sans rollup) et les écrit sur le Projet.
// But : comptage TEMPS RÉEL. Appelé par MAKE C-cb juste après la livraison de l'audio
// (POST { project_id }), pour que chansons_reussies_avant bouge à la seconde où la chanson arrive.
// La logique de comptage vit dans _lib/comptage.js (source unique, partagée avec lancer-chanson).
//
// Idempotent : recompte depuis la source (pas un +1), donc aucun risque de double-comptage si le
// callback est rejoué. Sécurité : POST, project_id = format Airtable strict, secret OPTIONNEL
// (RECOMPTE_SECRET) inerte tant que la variable d'env n'est pas posée -> déploiement sans risque.

const { recomputerProjet } = require('./_lib/comptage');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.RECOMPTE_SECRET || '';
const REC_ID   = /^rec[A-Za-z0-9]{14}$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  if (SECRET && body.secret !== SECRET) return { statusCode: 401, body: JSON.stringify({ error: 'Non autorisé' }) };

  const projectId = (body.project_id || '').trim();
  if (!REC_ID.test(projectId)) return { statusCode: 400, body: JSON.stringify({ error: 'project_id invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };
  try {
    // On a besoin du « project » (champ formule = primaire) pour filtrer ses Generations.
    const rp = await fetch(`${API}/Projects/${projectId}`, { headers });
    if (!rp.ok) return { statusCode: 404, body: JSON.stringify({ error: 'Projet introuvable' }) };
    const pf = ((await rp.json()).fields) || {};
    const out = await recomputerProjet(API, headers, projectId, pf.project);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...out }) };
  } catch (err) {
    console.error('[recompter-comptage]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
