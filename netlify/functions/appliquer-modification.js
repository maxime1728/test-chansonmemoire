// netlify/functions/appliquer-modification.js
//
// APPROBATION d'une demande de modification post-achat (Phase 2, vue « Modifications » de Conversations).
// Déclenché par la coche `appliquer` -> Automation Make/Airtable -> POST ici { id, secret }.
//
// Pousse les versions ÉDITÉES par l'équipe (paroles_corrigees + prompt_style de la Conversation) vers le Projet
// lié (adjusted_lyrics + adjusted_style_prompt), puis ARME la relance Suno via `refaire` : cover-cron (chaque
// minute) lit `refaire`, met approval_status=approved, vide les champs cover et appelle lancer-cover (qui
// utilise adjusted_lyrics/adjusted_style_prompt). Mélodie gardée (« Refaire le cover ») ou nouvelle musique
// (« Régénérer ») selon mode_correction posé par decortique-background.
//
// N'ENVOIE PAS le courriel : c'est l'action séparée (coche `envoyer` -> repondre-courriel). Idempotent : décoche
// `appliquer` après coup. SÉCURITÉ : gate `secret` == MAKE_WEBHOOK_SECRET ; id = recordId Conversations valide.
// Env : MAKE_WEBHOOK_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SECRET   = process.env.MAKE_WEBHOOK_SECRET;

const CONVOS   = 'tbl3KBgXthCPromxF';
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const REC_ID   = /^rec[A-Za-z0-9]{14}$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!SECRET) { console.error('[appliquer-modification] MAKE_WEBHOOK_SECRET manquant'); return { statusCode: 500, body: JSON.stringify({ error: 'Configuration manquante' }) }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }
  if ((body.secret || '') !== SECRET) return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };

  const id = (body.id || '').toString().trim();
  if (!REC_ID.test(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // 1. Lire la Conversation : versions éditées + Projet lié.
    const rC = await fetch(`${API}/${CONVOS}/${id}`, { headers });
    if (!rC.ok) return { statusCode: 404, body: JSON.stringify({ error: 'Conversation introuvable' }) };
    const f = (await rC.json()).fields || {};

    const projetId = Array.isArray(f.Projet) ? f.Projet[0] : null;
    if (!projetId) return { statusCode: 409, body: JSON.stringify({ error: 'Aucun projet lié à cette conversation' }) };

    const paroles = (f.paroles_corrigees || '').toString().trim();
    const style   = (f.prompt_style || '').toString().trim();

    // 2. Mode (cover vs régénération) depuis le Projet (mode_correction posé par decortique-background).
    const rP = await fetch(`${API}/${PROJECTS}/${projetId}`, { headers });
    if (!rP.ok) return { statusCode: 404, body: JSON.stringify({ error: 'Projet introuvable' }) };
    const pf = (await rP.json()).fields || {};
    const refaire = (pf.mode_correction === 'regeneration') ? 'Régénérer' : 'Refaire le cover';

    // 3. Pousse les versions éditées sur le Projet + arme la relance (cover-cron prend le relais). On n'écrase
    //    PAS les paroles/style si l'équipe les a laissés vides (demande qui ne touche pas ce volet).
    const champs = { refaire };
    if (paroles) champs.adjusted_lyrics = paroles;
    if (style)   champs.adjusted_style_prompt = style;
    const rPatch = await fetch(`${API}/${PROJECTS}/${projetId}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typecast: true, fields: champs })   // typecast : `refaire` est un singleSelect, valeurs exactes existantes
    });
    if (!rPatch.ok) {
      const detail = await rPatch.text().catch(() => '');
      console.error('[appliquer-modification] patch projet', rPatch.status, detail);
      return { statusCode: 502, body: JSON.stringify({ error: 'Mise à jour du projet échouée', detail }) };
    }

    // 4. Décoche `appliquer` (idempotence : pas de relance en boucle).
    await fetch(`${API}/${CONVOS}/${id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { appliquer: false } })
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, projet: projetId, refaire, paroles: !!paroles, style: !!style }) };
  } catch (err) {
    console.error('[appliquer-modification]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
