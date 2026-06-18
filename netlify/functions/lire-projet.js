// netlify/functions/lire-projet.js
// LECTURE seule. Trouve le Project par token, puis sa Generation la plus récente.
// Ne renvoie au navigateur QUE ce que la page affiche — jamais email, Stripe, attribution.

const BASE_ID = process.env.AIRTABLE_BASE_ID;   // variable d'environnement Netlify
const TOKEN   = process.env.AIRTABLE_TOKEN;     // variable d'environnement Netlify
const API     = `https://api.airtable.com/v0/${BASE_ID}`;

exports.handler = async (event) => {
  // On accepte seulement le POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }

  // Lire le token envoyé par la page
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token manquant' }) };
  }

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Trouver le Project par token
    const formule = encodeURIComponent(`{token}="${token}"`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();

    if (!dP.records || dP.records.length === 0) {
      // 404 nu : on ne révèle jamais pourquoi (sécurité)
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }

    const projet  = dP.records[0];
    const projetId = projet.id;

    // 2. Trouver la Generation la plus récente de ce projet (tri par generation_no desc)
    const formuleG = encodeURIComponent(`{project}="${projet.fields.project}"`);
    const rG = await fetch(
      `${API}/Generations?filterByFormula=${formuleG}` +
      `&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`,
      { headers }
    );
    const dG = await rG.json();
    const gen = (dG.records && dG.records[0]) ? dG.records[0].fields : {};

    // 3. Réponse FILTRÉE — uniquement l'utile pour l'affichage
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titre:             gen.song_title || '',
        paroles:           gen.lyrics || '',
        statut:            gen.generation_status || '',     // lyrics_generated / audio_generated / validated
        audio_url:         gen.suno_audio_url || '',
        commercial_status: projet.fields.commercial_status || 'preview_only'
        // PAS d'email, PAS de stripe_*, PAS d'attribution. Volontaire.
      })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
