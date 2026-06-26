// netlify/functions/decortique.js
// DEMANDE DE MODIFICATION post-achat — ENREGISTREMENT RAPIDE (front du flux « corrections »).
//
// But : la demande doit apparaitre dans Airtable A TOUS LES COUPS. L'ancien code appelait Claude AVANT
// d'ecrire -> le timeout Netlify (10 s) coupait la fonction pendant Claude et l'ecriture n'avait jamais
// lieu (demande perdue). Ici on INVERSE : on ecrit d'abord, on analyse ensuite.
//   1. Valide (POST, UUID v4, demande, gate purchased).
//   2. ENREGISTRE TOUT DE SUITE : la demande brute sur le Projet (correction_request + approval_status=pending)
//      ET une ligne dans Conversations (la file de l'equipe), liee au Projet.
//   3. Repond « Demande recue » au client (rapide).
//   4. Lance l'analyse Claude en ARRIERE-PLAN (decortique-background) : elle propose paroles/style + un
//      brouillon de reponse client, tout EDITABLE. L'equipe approuve manuellement -> cover-cron regenere.
//
// Securite : POST, UUID v4 strict, formule echappee, gate purchased, secret partage pour le worker.
// Env : AIRTABLE_TOKEN, AIRTABLE_BASE_ID, DECORTIQUE_SECRET.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE    = 'https://chansonmemoire.ca';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET  = process.env.DECORTIQUE_SECRET || '';

const PROJECTS = 'Projects', CLIENTS = 'Clients', CONVOS = 'tbl3KBgXthCPromxF';

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// Courriel de l'acheteur (sur le Client lie) — pour la ligne Conversations (jamais expose au navigateur).
async function emailClient(projet, headers) {
  try {
    const link  = projet.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/${CLIENTS}/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Methode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requete invalide' }) }; }

  const token   = (body.token || '').trim();
  const demande = (body.demande || '').toString().trim().slice(0, 4000);
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!demande)             return { statusCode: 400, body: JSON.stringify({ error: 'Demande vide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token (UUID valide -> litteral sur). Gate purchased.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/${PROJECTS}?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }
    const projet = dP.records[0];
    const p = projet.fields;
    if (p.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Non autorise' }) };
    }

    const refId = `${token.slice(0, 8)}·V${p.purchased_generation_no || ''}`;

    // 2. ENREGISTREMENT IMMEDIAT (l'imperatif : rien ne doit etre perdu, meme si la suite echoue).
    //    a) Demande brute sur le Projet -> visible + base de l'approbation manuelle (cover-cron).
    await fetch(`${API}/${PROJECTS}/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        correction_request: `DEMANDE CLIENT (analyse en cours) :\n${demande}`,
        approval_status: 'pending',
        ref_id: refId,
        cover_task_id: null,        // re-arme le cover : ton approbation future relancera lancer-cover
        cover_launched_at: null     // null et JAMAIS '' ('' = 422 sur ce champ date)
      } })
    });

    //    b) Ligne Conversations (file de l'equipe), liee au Projet. typecast cree le choix 'modification'.
    let convoId = '';
    try {
      const to = await emailClient(projet, headers);
      const rConvo = await fetch(`${API}/${CONVOS}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ typecast: true, fields: {
          expediteur:   to || '',
          sujet:        `Demande de modification${p.deceased_name ? ' : ' + p.deceased_name : ''}`,
          message:      demande,
          recu_le:      new Date().toISOString(),
          statut:       'a_verifier',
          categorie_ia: 'modification',
          Projet:       [projet.id]
        } })
      });
      if (rConvo.ok) convoId = (await rConvo.json()).id || '';
    } catch (_) { /* la demande est deja sur le Projet : on ne bloque pas */ }

    // 3. Lance l'analyse en ARRIERE-PLAN (background function -> 202 immediat, pas de timeout). Best-effort :
    //    si l'invocation rate, la demande brute reste enregistree et l'equipe la voit quand meme.
    try {
      await fetch(`${SITE}/.netlify/functions/decortique-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SECRET, token, demande, convoId })
      });
    } catch (_) {}

    // 4. Reponse rapide au client. auto:false + paroles vides -> la page affiche « Demande recue, par courriel ».
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, auto: false, paroles: '' })
    };
  } catch (err) {
    console.error('[decortique]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
